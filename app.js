import { gdb } from "https://cdn.jsdelivr.net/npm/genosdb@latest/dist/index.min.js"

// --- INITIALIZATION ---
let db
let currentCursor = null
let activeSubscription = null
let mapInstance = null
let mapMarkers = {}

const APP_ROLES = {
  superadmin: { can: ["assignRole", "deleteAny"], inherits: ["admin"] },
  admin: { can: ["delete"], inherits: ["manager"] },
  manager: { can: ["publish"], inherits: ["user"] },
  user: { can: ["write", "link", "sync"], inherits: ["guest"] },
  guest: { can: ["read", "sync", "write"] }, // Guests can read and receive syncs
}

async function initApp() {
  // Initialize GenosDB with RTC and Security Manager (ACLs enabled)
  db = await gdb("genos-estate-en-v1", {
    rtc: true,
    sm: {
      superAdmins: ["0xE5639DfE345F8ab845bEBE63a1C7322F9c6fF5c7"], // Placeholder
      customRoles: APP_ROLES,
      acls: true, // Enable ACLs for granular property ownership
    },
  })

  // Setup Security Listener
  db.sm.setSecurityStateChangeCallback(updateAuthUI)

  // Init Map
  initMap()

  // Initial Search
  performSearch()
}

// --- MAP LOGIC ---
function initMap() {
  mapInstance = L.map("map-container").setView([51.505, -0.09], 5)
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(mapInstance)
}

function updateMapMarker(property) {
  if (!property.lat || !property.lng) return

  // Remove logic
  if (property.status === "deleted") {
    if (mapMarkers[property.id]) {
      mapInstance.removeLayer(mapMarkers[property.id])
      delete mapMarkers[property.id]
    }
    return
  }

  // Define color marker based on status for the Popup (simple approach)
  const statusColorMap = {
    available: "green",
    reserved: "orange",
    sold: "red",
  }
  const color = statusColorMap[property.status] || "gray"

  const popupContent = `
                <div class="p-2 text-center">
                    <img src="${
                      property.imgUrl || "https://via.placeholder.com/150"
                    }" class="w-full h-24 object-cover rounded mb-2">
                    <h4 class="font-bold text-indigo-900">${property.title}</h4>
                    <p class="text-green-600 font-bold">${
                      property.currency === "EUR"
                        ? "€"
                        : property.currency === "GBP"
                        ? "£"
                        : "$"
                    }${property.price}</p>
                    <span style="color: ${color}; font-weight: bold; text-transform: uppercase; font-size: 12px;">${
    property.status
  }</span>
                </div>
            `

  if (mapMarkers[property.id]) {
    // Update existing
    mapMarkers[property.id]
      .setLatLng([property.lat, property.lng])
      .setPopupContent(popupContent)
  } else {
    // Create new
    const marker = L.marker([property.lat, property.lng])
      .addTo(mapInstance)
      .bindPopup(popupContent)
    mapMarkers[property.id] = marker
  }
}

// --- CORE LOGIC: SEARCH & RENDER ---

async function performSearch(isLoadMore = false) {
  if (!isLoadMore) {
    document.getElementById("property-grid").innerHTML = ""
    currentCursor = null
    if (activeSubscription) activeSubscription()
    Object.values(mapMarkers).forEach((m) => mapInstance.removeLayer(m))
    mapMarkers = {}
  }

  const formData = new FormData(document.getElementById("search-form"))
  const query = { type: "Property" }

  if (formData.get("operation")) query.operation = formData.get("operation")
  if (formData.get("type")) query.propertyType = formData.get("type")
  if (formData.get("city"))
    query.city = { $regex: new RegExp(formData.get("city"), "i") }

  if (formData.get("priceMin") || formData.get("priceMax")) {
    query.price = {}
    if (formData.get("priceMin"))
      query.price.$gte = Number(formData.get("priceMin"))
    if (formData.get("priceMax"))
      query.price.$lte = Number(formData.get("priceMax"))
  }

  const { unsubscribe, results } = await db.map(
    {
      query: query,
      realtime: true,
      $limit: 9,
      $after: currentCursor,
      order: "desc",
      field: "createdAt",
    },
    ({ id, value, action }) => {
      // --- REFACTORIZED REALTIME HANDLER ---
      handleRealtimeUpdate(id, value, action)
    }
  )

  activeSubscription = unsubscribe

  if (results.length > 0) {
    currentCursor = results[results.length - 1].id
    document.getElementById("btn-load-more").classList.remove("hidden")
  } else {
    document.getElementById("btn-load-more").classList.add("hidden")
  }
}

// --- CRITICAL REFACTORING FOR REALTIME STATUS CHANGE ---
function handleRealtimeUpdate(id, value, action) {
  const grid = document.getElementById("property-grid")
  const existingCard = document.getElementById(`card-${id}`)

  // 1. Handle Removal
  if (action === "removed") {
    if (existingCard) {
      // Add fade out effect
      existingCard.style.opacity = "0"
      setTimeout(() => existingCard.remove(), 300)
    }
    updateMapMarker({ id, status: "deleted" })
    return
  }

  const property = { id, ...value }

  // 2. Update Map (Always update, it handles create vs update internally)
  updateMapMarker(property)

  // 3. Generate NEW HTML
  const cardHTML = createCardHTML(property)

  // Convert string to DOM
  const tempDiv = document.createElement("div")
  tempDiv.innerHTML = cardHTML.trim()
  const newCardElement = tempDiv.firstElementChild

  // 4. Handle UI Update vs Insert
  if (existingCard) {
    // REPLACEMENT: This is what makes the status change visible instantly
    // We replace the OLD card with the NEW card containing the new Status Badge
    existingCard.replaceWith(newCardElement)

    // Optional: Highlight effect to show update
    newCardElement.classList.add("ring-2", "ring-indigo-400", "ring-opacity-50")
    setTimeout(
      () =>
        newCardElement.classList.remove(
          "ring-2",
          "ring-indigo-400",
          "ring-opacity-50"
        ),
      1000
    )
  } else {
    // INSERTION
    if (action === "added" || action === "initial") {
      grid.appendChild(newCardElement)
    }
  }
}

function createCardHTML(p) {
  const currentUser = db.sm.getActiveEthAddress()
  const isOwner = currentUser && p.owner === currentUser

  const statusConfig = {
    available: {
      color: "bg-green-100 text-green-800",
      icon: "fa-check-circle",
    },
    reserved: { color: "bg-yellow-100 text-yellow-800", icon: "fa-clock" },
    sold: { color: "bg-red-100 text-red-800", icon: "fa-ban" },
  }

  const config = statusConfig[p.status] || statusConfig["available"]
  const currencySymbol =
    p.currency === "EUR" ? "€" : p.currency === "GBP" ? "£" : "$"

  return `
            <div id="card-${
              p.id
            }" class="property-card bg-white rounded-lg shadow overflow-hidden border border-gray-100 relative transition-all duration-300">
                <div class="relative h-48">
                    <img src="${
                      p.imgUrl ||
                      "https://images.unsplash.com/photo-1564013799919-ab600027ffc6?auto=format&fit=crop&w=500&q=60"
                    }" class="w-full h-full object-cover" alt="${p.title}">
                    
                    <div class="absolute top-2 right-2 ${
                      config.color
                    } px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wide shadow-sm flex items-center gap-1">
                        <i class="fa-solid ${config.icon}"></i> ${p.status}
                    </div>

                    ${
                      isOwner
                        ? `
                    <div class="absolute bottom-2 right-2 flex gap-1 bg-black/30 p-1 rounded backdrop-blur-sm">
                         <button onclick="changeStatus('${p.id}', 'reserved')" class="bg-yellow-500 text-white text-xs w-8 h-8 rounded shadow hover:bg-yellow-600 flex items-center justify-center transition hover:scale-110" title="Mark as Reserved"><i class="fa-solid fa-clock"></i></button>
                         <button onclick="changeStatus('${p.id}', 'sold')" class="bg-red-600 text-white text-xs w-8 h-8 rounded shadow hover:bg-red-700 flex items-center justify-center transition hover:scale-110" title="Mark as Sold"><i class="fa-solid fa-hand-holding-dollar"></i></button>
                         <button onclick="changeStatus('${p.id}', 'available')" class="bg-green-500 text-white text-xs w-8 h-8 rounded shadow hover:bg-green-600 flex items-center justify-center transition hover:scale-110" title="Mark as Available"><i class="fa-solid fa-rotate-left"></i></button>
                    </div>`
                        : ""
                    }
                </div>
                <div class="p-4">
                    <div class="flex justify-between items-start">
                        <div>
                            <p class="text-xs text-indigo-600 font-bold uppercase tracking-wider">${
                              p.propertyType
                            } • ${p.operation}</p>
                            <h3 class="text-lg font-bold text-gray-900 truncate leading-tight mt-1" title="${
                              p.title
                            }">${p.title}</h3>
                        </div>
                        <p class="text-xl font-bold text-gray-900">${currencySymbol}${p.price.toLocaleString()}</p>
                    </div>
                    <div class="flex items-center text-gray-500 text-sm mt-3">
                        <i class="fa-solid fa-location-dot mr-2 text-indigo-400"></i> ${
                          p.city
                        }, ${p.country}
                    </div>
                    <p class="text-gray-400 text-xs mt-1 ml-5">${p.zone} ${
    p.address ? "- " + p.address : ""
  }</p>
                    
                    <div class="mt-4 pt-3 border-t border-gray-100 flex justify-between items-center">
                         <span class="text-xs text-gray-400 flex items-center"><i class="fa-regular fa-calendar mr-1"></i> ${new Date(
                           p.createdAt
                         ).toLocaleDateString("en-US")}</span>
                         <button class="text-indigo-600 hover:text-indigo-800 text-sm font-bold hover:underline">Details <i class="fa-solid fa-arrow-right ml-1"></i></button>
                    </div>
                </div>
            </div>
            `
}

// --- ACTION HANDLERS ---

// Pure Reactive Logic: Changes Data -> DB -> Listener -> UI
window.changeStatus = async (id, newStatus) => {
  try {
    const { result: node } = await db.get(id)
    if (!node) return

    // Update data package
    const updatedData = { ...node.value, status: newStatus }

    // Send to DB (ACLs protected)
    // This will trigger 'handleRealtimeUpdate' with action='updated'
    await db.sm.acls.set(updatedData, id)
  } catch (e) {
    alert("Error: You do not have permission to edit this property.")
    console.error(e)
  }
}

window.loadMore = () => {
  performSearch(true)
}

document.getElementById("search-form").addEventListener("submit", (e) => {
  e.preventDefault()
  performSearch(false)
})

// --- PUBLISHING LOGIC ---

window.checkAuthAndPublish = () => {
  if (!db.sm.isSecurityActive()) {
    modalLogin.show()
  } else {
    modalPublish.show()
  }
}

document
  .getElementById("publish-form")
  .addEventListener("submit", async (e) => {
    e.preventDefault()
    const fd = new FormData(e.target)
    const currentUser = db.sm.getActiveEthAddress()

    const newProperty = {
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
      status: "available",
      createdAt: Date.now(),
      owner: currentUser,
    }

    try {
      await db.sm.acls.set(newProperty)
      modalPublish.hide()
      e.target.reset()
    } catch (err) {
      console.error(err)
      alert("Error publishing. Please ensure you are logged in.")
    }
  })

window.getCurrentLocation = () => {
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        document.querySelector('input[name="lat"]').value =
          pos.coords.latitude.toFixed(4)
        document.querySelector('input[name="lng"]').value =
          pos.coords.longitude.toFixed(4)
      },
      () => alert("Permission denied for location.")
    )
  } else {
    alert("Geolocation is not supported by this browser.")
  }
}

// --- AUTHENTICATION LOGIC (GenosDB SM) ---

function updateAuthUI(state) {
  const actionsDiv = document.getElementById("auth-actions")
  const userInfoDiv = document.getElementById("user-info")
  const userAddrSpan = document.getElementById("user-address")

  if (state.isActive) {
    actionsDiv.classList.add("hidden")
    userInfoDiv.classList.remove("hidden")
    userInfoDiv.classList.add("flex")
    userAddrSpan.textContent = state.abbrAddr
    // Trigger search refresh to show edit buttons if I own properties
    performSearch(false)
  } else {
    actionsDiv.classList.remove("hidden")
    userInfoDiv.classList.add("hidden")
    userInfoDiv.classList.remove("flex")
    performSearch(false) // Refresh to hide edit buttons
  }
}

// Register Flow
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
    alert("Registration successful!")
  } catch (e) {
    alert(
      "Error protecting with WebAuthn. Ensure you are using HTTPS or localhost."
    )
  }
}

// Login Flow
window.loginWebAuthn = async () => {
  try {
    const addr = await db.sm.loginCurrentUserWithWebAuthn()
    if (addr) modalLogin.hide()
    else alert("No WebAuthn credential found on this device.")
  } catch (e) {
    console.error(e)
    alert("Login failed.")
  }
}

window.loginMnemonic = async () => {
  const phrase = document.getElementById("login-mnemonic").value.trim()
  if (!phrase) return alert("Please enter the phrase.")

  const id = await db.sm.loginOrRecoverUserWithMnemonic(phrase)
  if (id) {
    modalLogin.hide()
  } else {
    alert("Invalid phrase.")
  }
}

window.logout = async () => {
  await db.sm.clearSecurity()
}

// --- UI HELPERS ---
const toggleModal = (id, show) => {
  const el = document.getElementById(id)
  if (show) {
    el.classList.remove("hidden")
    el.classList.add("flex")
  } else {
    el.classList.add("hidden")
    el.classList.remove("flex")
  }
}

window.modalRegister = {
  show: () => toggleModal("modal-register", true),
  hide: () => toggleModal("modal-register", false),
}
window.modalLogin = {
  show: () => toggleModal("modal-login", true),
  hide: () => toggleModal("modal-login", false),
}
window.modalPublish = {
  show: () => toggleModal("modal-publish", true),
  hide: () => toggleModal("modal-publish", false),
}

window.switchView = (view) => {
  if (view === "list") {
    document.getElementById("view-list").classList.remove("hidden")
    document.getElementById("view-map").classList.add("hidden")
    document
      .getElementById("tab-list")
      .classList.add("border-indigo-600", "text-indigo-600")
    document
      .getElementById("tab-list")
      .classList.remove("border-transparent", "text-gray-500")
    document
      .getElementById("tab-map")
      .classList.remove("border-indigo-600", "text-indigo-600")
    document
      .getElementById("tab-map")
      .classList.add("border-transparent", "text-gray-500")
  } else {
    document.getElementById("view-list").classList.add("hidden")
    document.getElementById("view-map").classList.remove("hidden")
    document
      .getElementById("tab-map")
      .classList.add("border-indigo-600", "text-indigo-600")
    document
      .getElementById("tab-map")
      .classList.remove("border-transparent", "text-gray-500")
    document
      .getElementById("tab-list")
      .classList.remove("border-indigo-600", "text-indigo-600")
    document
      .getElementById("tab-list")
      .classList.add("border-transparent", "text-gray-500")
    setTimeout(() => mapInstance.invalidateSize(), 100)
  }
}

// Start App
initApp()
