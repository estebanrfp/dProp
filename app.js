import { gdb } from "https://cdn.jsdelivr.net/npm/genosdb@latest/dist/index.min.js"

// --- STATE & CONFIG ---
let db
let currentCursor = null
let activeSubscription = null
let mapInstance = null
let mapMarkers = {}
let userCache = {} // Simple cache for permissions check context

const APP_ROLES = {
  admin: { can: ["deleteAny"], inherits: ["user"] },
  user: { can: ["write", "link"], inherits: ["guest"] },
  guest: { can: ["read", "sync", "write"] }, // Guests can read and receive syncs
}

// --- INIT ---
async function initApp() {
  initTheme() // Dark mode check

  db = await gdb("dprop-v2-acls", {
    rtc: true,
    sm: {
      superAdmins: ["0x0000000000000000000000000000000000000000"],
      customRoles: APP_ROLES,
      acls: true, // Enables node-level permissions
    },
  })

  db.sm.setSecurityStateChangeCallback(updateAuthUI)
  initMap()
  performSearch()
}

// --- THEME LOGIC ---
window.initTheme = () => {
  if (
    localStorage.getItem("theme") === "dark" ||
    (!("theme" in localStorage) &&
      window.matchMedia("(prefers-color-scheme: dark)").matches)
  ) {
    document.documentElement.classList.add("dark")
  } else {
    document.documentElement.classList.remove("dark")
  }
}

window.toggleTheme = () => {
  if (document.documentElement.classList.contains("dark")) {
    document.documentElement.classList.remove("dark")
    localStorage.setItem("theme", "light")
  } else {
    document.documentElement.classList.add("dark")
    localStorage.setItem("theme", "dark")
  }
}

// --- MAP LOGIC ---
function initMap() {
  mapInstance = L.map("map-container").setView([51.505, -0.09], 4)
  // Add custom class for dark mode filtering
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OSM",
    className: "map-tiles",
  }).addTo(mapInstance)
}

function updateMapMarker(p) {
  if (!p.lat || !p.lng) return
  if (p.status === "deleted") {
    if (mapMarkers[p.id]) {
      mapInstance.removeLayer(mapMarkers[p.id])
      delete mapMarkers[p.id]
    }
    return
  }

  const colors = { available: "#4ade80", reserved: "#facc15", sold: "#f87171" }
  const markerColor = colors[p.status] || "#94a3b8"

  // Simple custom marker div
  const icon = L.divIcon({
    className: "custom-marker",
    html: `<div style="background-color: ${markerColor}; width: 14px; height: 14px; border-radius: 50%; border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.3);"></div>`,
    iconSize: [14, 14],
  })

  const content = `
                <div class="text-center min-w-[150px]">
                    <img src="${
                      p.imgUrl || "https://via.placeholder.com/150"
                    }" class="w-full h-24 object-cover rounded mb-2">
                    <strong class="block text-gray-900">${p.title}</strong>
                    <span class="text-xs font-bold uppercase" style="color:${markerColor}">${
    p.status
  }</span>
                </div>
            `

  if (mapMarkers[p.id]) {
    mapMarkers[p.id]
      .setLatLng([p.lat, p.lng])
      .setPopupContent(content)
      .setIcon(icon)
  } else {
    const m = L.marker([p.lat, p.lng], { icon })
      .addTo(mapInstance)
      .bindPopup(content)
    mapMarkers[p.id] = m
  }
}

// --- CORE LOGIC ---
async function performSearch(isLoadMore = false) {
  if (!isLoadMore) {
    document.getElementById("property-grid").innerHTML = ""
    currentCursor = null
    if (activeSubscription) activeSubscription()
    Object.values(mapMarkers).forEach((m) => mapInstance.removeLayer(m))
    mapMarkers = {}
  }

  const fd = new FormData(document.getElementById("search-form"))
  const query = { type: "Property" }
  if (fd.get("operation")) query.operation = fd.get("operation")
  if (fd.get("type")) query.propertyType = fd.get("type")
  if (fd.get("city")) query.city = { $regex: new RegExp(fd.get("city"), "i") }
  if (fd.get("priceMin") || fd.get("priceMax")) {
    query.price = {}
    if (fd.get("priceMin")) query.price.$gte = Number(fd.get("priceMin"))
    if (fd.get("priceMax")) query.price.$lte = Number(fd.get("priceMax"))
  }

  const { unsubscribe, results } = await db.map(
    {
      query,
      realtime: true,
      $limit: 12,
      $after: currentCursor,
      order: "desc",
      field: "createdAt",
    },
    ({ id, value, action }) => handleRealtimeUpdate(id, value, action)
  )

  activeSubscription = unsubscribe

  document.getElementById(
    "results-count"
  ).innerText = `${results.length} properties found`
  document
    .getElementById("btn-load-more")
    .classList.toggle("hidden", results.length < 12)
  if (results.length > 0) currentCursor = results[results.length - 1].id
}

function handleRealtimeUpdate(id, value, action) {
  const grid = document.getElementById("property-grid")
  const cardId = `card-${id}`
  const existingCard = document.getElementById(cardId)

  if (action === "removed") {
    if (existingCard) {
      existingCard.style.opacity = "0"
      setTimeout(() => existingCard.remove(), 300)
    }
    updateMapMarker({ id, status: "deleted" })
    return
  }

  const p = { id, ...value }
  updateMapMarker(p)

  const cardHTML = createCardHTML(p)
  const tempDiv = document.createElement("div")
  tempDiv.innerHTML = cardHTML.trim()
  const newEl = tempDiv.firstElementChild

  if (existingCard) {
    existingCard.replaceWith(newEl)
    // Flash effect
    newEl.classList.add("ring-2", "ring-indigo-400")
    setTimeout(() => newEl.classList.remove("ring-2", "ring-indigo-400"), 1000)
  } else {
    if (action === "added" || action === "initial") grid.appendChild(newEl)
  }
}

function createCardHTML(p) {
  const currentUser = db.sm.getActiveEthAddress()

  // PERMISSIONS LOGIC:
  // 1. Owner: Created the node (p.owner === currentUser)
  // 2. Collaborator: Explicitly granted 'write' in ACLs.
  // Note: In a production list view, checking perms for every item via async call is heavy.
  // P2P/GenosDB allows implicit check: if I can't write, the operation fails.
  // For UI, we assume basic visibility. We show buttons if owner OR if known collaborator.
  // To be robust, we'll try to check if 'collaborators' exists in value (if synced) or just show for owner.
  // *Enhancement*: We'll assume if you are owner, you see Share/Edit.

  const isOwner = currentUser && p.owner === currentUser

  // We check if the current user is in the collaborators list stored in the node value
  // (Assuming the App saves collaborators list to the node value when granting, see grantAccess function)
  const isCollab = p.collaborators && p.collaborators[currentUser] === "write"
  const canEdit = isOwner || isCollab

  const statusConfig = {
    available: {
      bg: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
      icon: "fa-check",
    },
    reserved: {
      bg: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
      icon: "fa-clock",
    },
    sold: {
      bg: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
      icon: "fa-ban",
    },
  }
  const st = statusConfig[p.status] || statusConfig["available"]
  const cur = p.currency === "EUR" ? "€" : p.currency === "GBP" ? "£" : "$"

  return `
            <div id="card-${
              p.id
            }" class="property-card bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden relative group dark:bg-dark-800 dark:border-gray-700">
                <div class="relative h-56">
                    <img src="${
                      p.imgUrl || "https://via.placeholder.com/500x300"
                    }" class="w-full h-full object-cover transition duration-500 group-hover:scale-105" loading="lazy">
                    <div class="absolute top-3 right-3 ${
                      st.bg
                    } px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wide backdrop-blur-md shadow-sm">
                        <i class="fa-solid ${st.icon} mr-1"></i> ${p.status}
                    </div>
                    
                    ${
                      canEdit
                        ? `
                    <div class="absolute bottom-3 right-3 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                         ${
                           isOwner
                             ? `<button onclick="openShareModal('${p.id}')" class="bg-blue-600 text-white w-9 h-9 rounded-full shadow-lg flex items-center justify-center hover:bg-blue-700 hover:scale-110 transition" title="Share Access"><i class="fa-solid fa-user-plus text-xs"></i></button>`
                             : ""
                         }
                         
                         <button onclick="openEditModal('${
                           p.id
                         }')" class="bg-white text-gray-800 w-9 h-9 rounded-full shadow-lg flex items-center justify-center hover:bg-gray-100 hover:scale-110 transition dark:bg-dark-700 dark:text-white" title="Edit Details"><i class="fa-solid fa-pen text-xs"></i></button>
                    </div>`
                        : ""
                    }
                </div>
                
                <div class="p-5">
                    <div class="flex justify-between items-start mb-2">
                        <div>
                            <p class="text-xs font-bold text-indigo-600 uppercase tracking-wider dark:text-indigo-400">${
                              p.propertyType
                            } • ${p.operation}</p>
                            <h3 class="text-lg font-bold text-gray-900 leading-tight truncate w-56 dark:text-white" title="${
                              p.title
                            }">${p.title}</h3>
                        </div>
                        <p class="text-xl font-bold text-gray-900 dark:text-white">${cur}${p.price.toLocaleString()}</p>
                    </div>
                    
                    <div class="flex items-center text-gray-500 text-sm mb-4 dark:text-gray-400">
                        <i class="fa-solid fa-location-dot mr-2 text-indigo-400"></i> ${
                          p.city
                        }, ${p.country}
                    </div>

                    ${
                      canEdit
                        ? `
                    <div class="pt-4 border-t border-gray-100 dark:border-gray-700 flex justify-between gap-2">
                         <button onclick="changeStatus('${p.id}', 'available')" class="flex-1 py-2 text-xs font-bold rounded bg-gray-50 hover:bg-green-50 text-gray-600 hover:text-green-700 dark:bg-dark-900 dark:text-gray-300 dark:hover:text-green-400 transition">Available</button>
                         <button onclick="changeStatus('${p.id}', 'reserved')" class="flex-1 py-2 text-xs font-bold rounded bg-gray-50 hover:bg-yellow-50 text-gray-600 hover:text-yellow-700 dark:bg-dark-900 dark:text-gray-300 dark:hover:text-yellow-400 transition">Reserve</button>
                         <button onclick="changeStatus('${p.id}', 'sold')" class="flex-1 py-2 text-xs font-bold rounded bg-gray-50 hover:bg-red-50 text-gray-600 hover:text-red-700 dark:bg-dark-900 dark:text-gray-300 dark:hover:text-red-400 transition">Sold</button>
                    </div>`
                        : `
                    <div class="pt-4 border-t border-gray-100 dark:border-gray-700 flex justify-between items-center text-xs text-gray-400">
                        <span><i class="fa-regular fa-clock mr-1"></i> ${new Date(
                          p.createdAt
                        ).toLocaleDateString()}</span>
                        ${
                          p.owner
                            ? `<span class="font-mono bg-gray-100 px-2 py-0.5 rounded dark:bg-dark-900 text-gray-500" title="Owner">${p.owner.substr(
                                0,
                                6
                              )}...</span>`
                            : ""
                        }
                    </div>
                    `
                    }
                </div>
            </div>
            `
}

// --- ACTIONS: EDIT / STATUS / SHARE ---

// 1. Change Status (Atomic Update)
window.changeStatus = async (id, newStatus) => {
  try {
    const { result: node } = await db.get(id)
    if (!node) return
    const updatedData = { ...node.value, status: newStatus }
    await db.sm.acls.set(updatedData, id) // Auto-checks permissions
  } catch (e) {
    alert("Permission denied. You are not an owner or collaborator.")
  }
}

// 2. Open Edit Modal (Fill Form)
window.openEditModal = async (id) => {
  const { result: node } = await db.get(id)
  if (!node) return
  const p = node.value

  // Fill fields
  const f = document.getElementById("publish-form")
  document.getElementById("edit-node-id").value = id
  document.getElementById("modal-title").innerText = "Edit Property"
  document.getElementById("btn-submit-property").innerText = "Save Changes"

  f.querySelector("[name=title]").value = p.title || ""
  f.querySelector("[name=operation]").value = p.operation || "sale"
  f.querySelector("[name=propertyType]").value = p.propertyType || "apartment"
  f.querySelector("[name=price]").value = p.price || ""
  f.querySelector("[name=currency]").value = p.currency || "USD"
  f.querySelector("[name=country]").value = p.country || ""
  f.querySelector("[name=city]").value = p.city || ""
  f.querySelector("[name=zone]").value = p.zone || ""
  f.querySelector("[name=address]").value = p.address || ""
  f.querySelector("[name=imgUrl]").value = p.imgUrl || ""
  f.querySelector("[name=lat]").value = p.lat || ""
  f.querySelector("[name=lng]").value = p.lng || ""

  modalPublish.show()
}

// 3. Open Share Modal
window.openShareModal = (id) => {
  document.getElementById("share-node-id").value = id
  document.getElementById("share-address").value = ""
  modalShare.show()
}

// 4. Execute Share (Grant ACL)
window.confirmShare = async () => {
  const id = document.getElementById("share-node-id").value
  const addr = document.getElementById("share-address").value.trim()

  if (!addr.startsWith("0x")) return alert("Invalid ETH address")

  try {
    // 1. Grant Write Access via GenosDB ACLs
    await db.sm.acls.grant(id, addr, "write")

    // 2. Optional: Update the node value to include this collaborator
    // This allows the UI to react immediately (showing Edit buttons to the collaborator)
    // without waiting for a re-fetch of permissions.
    const { result: node } = await db.get(id)
    const currentCollaborators = node.value.collaborators || {}
    currentCollaborators[addr] = "write"

    const updatedData = { ...node.value, collaborators: currentCollaborators }
    await db.sm.acls.set(updatedData, id)

    alert(`Access granted to ${addr.substr(0, 6)}...`)
    modalShare.hide()
  } catch (e) {
    console.error(e)
    alert("Error granting access. Ensure you are the owner.")
  }
}

// --- PUBLISH / SAVE LOGIC ---
window.openPublishModal = () => {
  if (!db.sm.isSecurityActive()) return modalLogin.show()
  // Reset form for new entry
  document.getElementById("publish-form").reset()
  document.getElementById("edit-node-id").value = ""
  document.getElementById("modal-title").innerText = "Publish Property"
  document.getElementById("btn-submit-property").innerText = "Publish Property"
  modalPublish.show()
}

document
  .getElementById("publish-form")
  .addEventListener("submit", async (e) => {
    e.preventDefault()
    const fd = new FormData(e.target)
    const currentUser = db.sm.getActiveEthAddress()
    const editId = document.getElementById("edit-node-id").value // If present, we are editing

    // Construct Data Object
    const propertyData = {
      type: "Property",
      title: fd.get("title"),
      operation: fd.get("operation"),
      propertyType: fd.get("propertyType"),
      price: Number(fd.get("price")),
      currency: fd.get("currency"),
      country: fd.get("country"),
      city: fd.get("city"),
      zone: fd.get("zone"),
      address: fd.get("address"),
      imgUrl: fd.get("imgUrl"),
      lat: Number(fd.get("lat")),
      lng: Number(fd.get("lng")),
      // Preserve status/owner/date if editing, else default
      createdAt: editId ? undefined : Date.now(),
    }

    try {
      if (editId) {
        // --- UPDATE FLOW ---
        // Fetch original to preserve immutable fields (created date, original owner, collaborators)
        const { result: oldNode } = await db.get(editId)

        // Merge: Keep old meta, overwrite form data
        const finalData = {
          ...oldNode.value,
          ...propertyData,
          createdAt: oldNode.value.createdAt, // Ensure date doesn't change
        }

        await db.sm.acls.set(finalData, editId)
      } else {
        // --- CREATE FLOW ---
        propertyData.owner = currentUser
        propertyData.status = "available"
        propertyData.collaborators = {} // Init empty map

        await db.sm.acls.set(propertyData)
      }

      modalPublish.hide()
      e.target.reset()
    } catch (err) {
      console.error(err)
      alert("Error saving property. Permission denied?")
    }
  })

// --- AUTH & UI HELPERS ---
function updateAuthUI(state) {
  const actions = document.getElementById("auth-actions")
  const info = document.getElementById("user-info")

  if (state.isActive) {
    actions.classList.add("hidden")
    info.classList.remove("hidden")
    info.classList.add("flex")
    document.getElementById("user-address").textContent = state.abbrAddr
    // Refresh list to update edit button visibility based on new user
    performSearch(false)
  } else {
    actions.classList.remove("hidden")
    info.classList.add("hidden")
    info.classList.remove("flex")
    performSearch(false)
  }
}

// Identity Functions (Standard SM Wrappers)
window.generateIdentity = async () => {
  const id = await db.sm.startNewUserRegistration()
  if (id) {
    document.getElementById("mnemonic-container").classList.remove("hidden")
    document.getElementById("mnemonic-field").value = id.mnemonic
    document.getElementById("btn-gen-id").classList.add("hidden")
    document.getElementById("btn-protect-id").classList.remove("hidden")
  }
}
window.protectIdentity = async () => {
  try {
    await db.sm.protectCurrentIdentityWithWebAuthn()
    modalRegister.hide()
  } catch (e) {
    alert("Auth Error (HTTPS required)")
  }
}
window.loginWebAuthn = async () => {
  try {
    if (await db.sm.loginCurrentUserWithWebAuthn()) modalLogin.hide()
    else alert("No passkey found.")
  } catch (e) {
    console.error(e)
  }
}
window.loginMnemonic = async () => {
  const phrase = document.getElementById("login-mnemonic").value.trim()
  if (await db.sm.loginOrRecoverUserWithMnemonic(phrase)) modalLogin.hide()
  else alert("Invalid phrase")
}
window.logout = async () => {
  await db.sm.clearSecurity()
}
window.getCurrentLocation = () =>
  navigator.geolocation?.getCurrentPosition((p) => {
    document.querySelector("[name=lat]").value = p.coords.latitude.toFixed(4)
    document.querySelector("[name=lng]").value = p.coords.longitude.toFixed(4)
  })
window.loadMore = () => performSearch(true)
document.getElementById("search-form").addEventListener("submit", (e) => {
  e.preventDefault()
  performSearch(false)
})

// Modals & View
const toggle = (id, s) => {
  const el = document.getElementById(id)
  el.classList.toggle("hidden", !s)
  el.classList.toggle("flex", s)
}
window.modalRegister = {
  show: () => toggle("modal-register", 1),
  hide: () => toggle("modal-register", 0),
}
window.modalLogin = {
  show: () => toggle("modal-login", 1),
  hide: () => toggle("modal-login", 0),
}
window.modalPublish = {
  show: () => toggle("modal-publish", 1),
  hide: () => toggle("modal-publish", 0),
}
window.modalShare = {
  show: () => toggle("modal-share", 1),
  hide: () => toggle("modal-share", 0),
}

window.switchView = (v) => {
  const list = document.getElementById("view-list")
  const map = document.getElementById("view-map")
  const bList = document.getElementById("tab-list")
  const bMap = document.getElementById("tab-map")

  if (v === "list") {
    list.classList.remove("hidden")
    map.classList.add("hidden")
    bList.classList.add(
      "border-indigo-600",
      "text-indigo-600",
      "dark:text-indigo-400",
      "dark:border-indigo-400"
    )
    bList.classList.remove("border-transparent", "text-gray-500")
    bMap.classList.remove(
      "border-indigo-600",
      "text-indigo-600",
      "dark:text-indigo-400",
      "dark:border-indigo-400"
    )
    bMap.classList.add("border-transparent", "text-gray-500")
  } else {
    list.classList.add("hidden")
    map.classList.remove("hidden")
    bMap.classList.add(
      "border-indigo-600",
      "text-indigo-600",
      "dark:text-indigo-400",
      "dark:border-indigo-400"
    )
    bMap.classList.remove("border-transparent", "text-gray-500")
    bList.classList.remove(
      "border-indigo-600",
      "text-indigo-600",
      "dark:text-indigo-400",
      "dark:border-indigo-400"
    )
    bList.classList.add("border-transparent", "text-gray-500")
    setTimeout(() => mapInstance.invalidateSize(), 100)
  }
}

initApp()
