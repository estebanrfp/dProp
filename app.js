// dProp — a decentralized, real-time P2P real-estate marketplace on GenosDB.
//
// What this example demonstrates, end to end:
//   • Zero-trust + Governance: visitors are read-only guests; public rules
//     promote them to `agent` (can publish) and `admin` (moderation) while a
//     superadmin is online to sign each promotion. No server involved.
//   • ACLs with collaboration: every property is owned by its creator, and
//     owners can GRANT write access to other addresses (Share Access).
//   • Live queries: filters, cursor pagination and realtime updates from one
//     db.map subscription; a Leaflet map mirrors the same data.
//   • The GenosDB Design Guide patterns: design tokens, dark default with a
//     sanctioned theme toggle, identity in a centered <dialog>, session
//     top-right as `0x… [role]`, toasts instead of alerts.
import { gdb } from "https://cdn.jsdelivr.net/npm/genosdb@latest/dist/index.min.js"

// ============================== Configuration ==============================

const DB_NAME = "dprop" // database name = P2P room name

// Demo superadmin — SHOWCASE ONLY. Its mnemonic is public so any visitor can
// run the governance engine. Replace with your own address (and keep the
// phrase private) for a real deployment.
const DEMO_SUPERADMIN = {
  address: "0xbfDe0eCEC5332Fd86D2570085571D6051Df098dA",
  mnemonic: "panic now afford carbon donate lecture drift excite collect essay stuff prosper",
}

// Custom RBAC roles for a marketplace. Writing must be EARNED (zero-trust).
const ROLES = {
  superadmin: { can: ["assignRole"], inherits: ["admin"] }, // signs promotions
  admin: { can: ["delete", "deleteAny"], inherits: ["agent"] }, // moderation
  agent: { can: ["write", "link", "sync"], inherits: ["guest"] }, // publishes listings
  guest: { can: ["read", "sync"] }, // browses only
}

// Public advancement rules, evaluated against `user:<address>` nodes while a
// superadmin is online. Last-match-wins; low thresholds so a visitor sees the
// full climb in minutes.
const MEMBER = { $in: ["agent", "admin"] }
const GOVERNANCE_RULES = [
  { if: { role: "guest" }, offsetTimestamp: 10000, then: { assignRole: "agent" } }, // onboarding gate
  { if: { role: MEMBER }, then: { assignRole: "agent" } }, // floor
  { if: { role: MEMBER, listingCount: { $gte: 3 } }, then: { assignRole: "admin" } }, // climb
]

// ================================ Database =================================

const db = await gdb(DB_NAME, {
  rtc: true, // required by the Security Manager
  sm: {
    superAdmins: [DEMO_SUPERADMIN.address],
    customRoles: ROLES,
    governanceRules: GOVERNANCE_RULES,
    acls: true, // node-level ownership + grantable permissions
  },
})
globalThis.db = db // console handle (matches the official examples)

// ================================ Helpers ==================================

const $ = (id) => document.getElementById(id)

/** Escape untrusted text before inserting it into HTML (P2P peers write it). */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))

const toast = (msg, isError = false) => {
  const el = $("toast")
  el.textContent = msg
  el.className = `toast show${isError ? " error" : ""}`
  clearTimeout(toast._t)
  toast._t = setTimeout(() => (el.className = "toast"), 3200)
}

const CURRENCY = { USD: "$", EUR: "€", GBP: "£" }
const PLACEHOLDER_IMG = "data:image/svg+xml;charset=UTF-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22500%22%20height%3D%22300%22%3E%3Crect%20width%3D%22500%22%20height%3D%22300%22%20fill%3D%22%231c2026%22%2F%3E%3Ctext%20x%3D%22250%22%20y%3D%22155%22%20fill%3D%22%235c6570%22%20text-anchor%3D%22middle%22%20font-family%3D%22sans-serif%22%3ENo%20image%3C%2Ftext%3E%3C%2Fsvg%3E"

// ============================== Theme toggle ===============================
// The Design Guide's sanctioned pattern: one icon button, [data-theme] swaps
// TOKENS ONLY, localStorage persists, prefers-color-scheme seeds first visit.

const applyTheme = (t) => {
  document.documentElement.dataset.theme = t
  localStorage.theme = t
  $("themeBtn").textContent = t === "dark" ? "☀️" : "🌙" // icon = mode you'll switch to
  if (mapInstance) setTimeout(() => mapInstance.invalidateSize(), 50)
}
$("themeBtn").onclick = () =>
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark")

// =============================== Identity ==================================
// SM state callback = single source of truth. We watch the `user:<address>`
// node so governance promotions update the UI live.

let myAddress = null
let myRole = null
let unsubRole = null

const can = (permission) => {
  let role = myRole
  while (role && ROLES[role]) {
    if (ROLES[role].can.includes(permission)) return true
    role = ROLES[role].inherits?.[0]
  }
  return false
}

const applyPermissionsToUI = () => {
  $("publishBtn").style.display = can("write") ? "block" : "none"
  $("publishHint").style.display = myAddress && !can("write") ? "block" : "none"
}

db.sm.setSecurityStateChangeCallback((state) => {
  if (state.isActive) {
    myAddress = state.activeAddress
    $("identityModal").close()
    $("identityPanel").style.display = "none"
    $("sessionBar").style.display = "flex"
    $("whoami").textContent = state.abbrAddr
    watchMyRole()
  } else {
    unsubRole?.(); unsubRole = null
    myAddress = myRole = null
    $("sessionBar").style.display = "none"
    $("identityPanel").style.display = "block"
    $("mnemonicBox").readOnly = false
    $("generateBtn").style.display = "inline-block"
    $("protectBtn").style.display = "none"
    $("webauthnLoginBtn").style.display = db.sm.hasExistingWebAuthnRegistration() ? "inline-block" : "none"
    queueMicrotask(() => { applyPermissionsToUI(); performSearch(false) })
  }
})

const watchMyRole = async () => {
  unsubRole?.()
  const { unsubscribe } = await db.get(`user:${myAddress}`, (node) => {
    const next = node?.value?.role ?? "guest"
    if (next !== myRole) {
      myRole = next
      $("myRole").textContent = myRole
      $("myRole").dataset.role = myRole
      applyPermissionsToUI()
      performSearch(false) // ownership/moderation affordances may change
    }
  })
  unsubRole = unsubscribe
}

// --- Identity modal (three-phase state machine, see the Design Guide) ---

$("openLoginBtn").onclick = () => $("identityModal").showModal()
$("closeModalBtn").onclick = () => $("identityModal").close()
$("identityModal").onclick = (e) => { if (e.target === $("identityModal")) $("identityModal").close() }

$("generateBtn").onclick = async () => {
  const identity = await db.sm.startNewUserRegistration()
  if (!identity) return toast("Could not generate an identity", true)
  const box = $("mnemonicBox")
  box.value = identity.mnemonic
  box.readOnly = true // protect the phrase until it is saved
  $("generateBtn").style.display = "none" // one identity at a time
  $("protectBtn").style.display = "inline-block"
  toast("SAVE THIS PHRASE — it is your only way back into this identity")
}

$("copyBtn").onclick = async () => {
  const phrase = $("mnemonicBox").value.trim()
  if (!phrase) return
  await navigator.clipboard.writeText(phrase)
  toast("Phrase copied to clipboard")
}

$("loginBtn").onclick = async () => {
  const phrase = $("mnemonicBox").value.trim()
  if (!phrase) return toast("Paste (or generate) a mnemonic first", true)
  const identity = await db.sm.loginOrRecoverUserWithMnemonic(phrase)
  identity ? toast(`Welcome ${db.sm.abbrAddr(identity.address)}`) : toast("Login failed", true)
}

$("protectBtn").onclick = async () => {
  const address = await db.sm.protectCurrentIdentityWithWebAuthn()
  address ? toast("Identity protected with a passkey") : toast("Passkey protection failed (HTTPS required)", true)
}

$("webauthnLoginBtn").onclick = async () => {
  const address = await db.sm.loginCurrentUserWithWebAuthn()
  if (!address) toast("Passkey login failed", true)
}

// One click makes THIS browser the superadmin: the governance engine runs
// here and signs promotions for every guest in the room.
$("superadminBtn").onclick = () => db.sm.loginOrRecoverUserWithMnemonic(DEMO_SUPERADMIN.mnemonic)

$("logoutBtn").onclick = () => db.sm.clearSecurity()

// ================================== Map ====================================

let mapInstance = null
let mapMarkers = {}

const initMap = () => {
  mapInstance = L.map("map-container").setView([51.505, -0.09], 4)
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OSM",
    className: "map-tiles", // dark mode dims/inverts tiles via CSS tokens
  }).addTo(mapInstance)
}

const STATUS_COLOR = { available: "#34c77b", reserved: "#f5a623", sold: "#ef5350" }

const updateMapMarker = (p) => {
  if (!p.lat || !p.lng) return
  if (p.status === "deleted") {
    if (mapMarkers[p.id]) { mapInstance.removeLayer(mapMarkers[p.id]); delete mapMarkers[p.id] }
    return
  }
  const color = STATUS_COLOR[p.status] || "#9aa3ad"
  const icon = L.divIcon({
    className: "custom-marker",
    html: `<div class="marker-dot" style="background-color:${color}"></div>`,
    iconSize: [14, 14],
  })
  const content = `
    <div class="map-popup">
      <img src="${esc(p.imgUrl) || PLACEHOLDER_IMG}" alt="">
      <strong>${esc(p.title)}</strong>
      <span style="color:${color}">${esc(p.status)}</span>
    </div>`
  if (mapMarkers[p.id]) mapMarkers[p.id].setLatLng([p.lat, p.lng]).setPopupContent(content).setIcon(icon)
  else mapMarkers[p.id] = L.marker([p.lat, p.lng], { icon }).addTo(mapInstance).bindPopup(content)
}

// ========================= Live search & rendering =========================
// One realtime subscription per search: filters build the query, the engine
// owns ordering (createdAt desc) and the cursor window ($limit/$after).

let currentCursor = null
let activeSubscription = null

async function performSearch(isLoadMore = false) {
  if (!isLoadMore) {
    $("property-grid").innerHTML = ""
    currentCursor = null
    activeSubscription?.()
    Object.values(mapMarkers).forEach((m) => mapInstance.removeLayer(m))
    mapMarkers = {}
  }

  const fd = new FormData($("search-form"))
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
    { query, realtime: true, $limit: 12, $after: currentCursor, order: "desc", field: "createdAt" },
    ({ id, value, action }) => handleRealtimeUpdate(id, value, action),
  )
  activeSubscription = unsubscribe

  $("results-count").textContent = `${results.length} properties found`
  $("btn-load-more").style.display = results.length < 12 ? "none" : "inline-block"
  if (results.length > 0) currentCursor = results[results.length - 1].id
}

function handleRealtimeUpdate(id, value, action) {
  const grid = $("property-grid")
  const existing = document.getElementById(`card-${id}`)

  switch (action) {
    case "removed": // deleted here or by a remote peer / moderator
      if (existing) { existing.style.opacity = "0"; setTimeout(() => existing.remove(), 300) }
      updateMapMarker({ id, status: "deleted" })
      return
    case "initial": // pre-existing listings, streamed once, already sorted
      grid.appendChild(buildCard(id, value))
      break
    case "added": // a brand-new listing — newest by definition, enters on top
      grid.prepend(buildCard(id, value))
      break
    case "updated": { // edits and status changes rebuild the card in place
      const card = buildCard(id, value)
      if (existing) { existing.replaceWith(card); card.classList.add("flash"); setTimeout(() => card.classList.remove("flash"), 900) }
      else grid.prepend(card)
      break
    }
  }
  updateMapMarker({ id, ...value })
}

function buildCard(id, p) {
  const isOwner = myAddress && p.owner === myAddress
  const isCollab = p.collaborators?.[myAddress] === "write" // Share Access grantee
  const canEdit = isOwner || isCollab
  const canModerate = can("deleteAny") && !isOwner // admins clean up spam

  const cur = CURRENCY[p.currency] ?? "$"
  const card = document.createElement("article")
  card.id = `card-${id}`
  card.className = "property-card"
  card.innerHTML = `
    <div class="card-media">
      <img src="${esc(p.imgUrl) || PLACEHOLDER_IMG}" alt="${esc(p.title)}" loading="lazy"
           onerror="this.src='${PLACEHOLDER_IMG}'">
      <span class="status-tag" data-status="${esc(p.status)}">${esc(p.status)}</span>
      <div class="card-tools">
        ${isOwner ? `<button data-share title="Share Access">👥</button>` : ""}
        ${canEdit ? `<button data-edit title="Edit details">✏️</button>` : ""}
        ${(isOwner || canModerate) ? `<button data-delete title="${canModerate ? "Moderate: delete listing" : "Delete listing"}">🗑️</button>` : ""}
      </div>
    </div>
    <div class="card-body">
      <p class="card-kicker">${esc(p.propertyType)} · ${esc(p.operation)}</p>
      <div class="card-title-row">
        <h3 title="${esc(p.title)}">${esc(p.title)}</h3>
        <strong class="card-price">${cur}${Number(p.price).toLocaleString()}</strong>
      </div>
      <p class="card-location">📍 ${esc(p.city)}, ${esc(p.country)}</p>
      ${canEdit ? `
      <div class="card-status-row">
        <button data-status-btn="available">Available</button>
        <button data-status-btn="reserved">Reserve</button>
        <button data-status-btn="sold">Sold</button>
      </div>` : `
      <div class="card-meta-row">
        <span>${new Date(p.createdAt).toLocaleDateString()}</span>
        ${p.owner ? `<span class="owner-tag" title="Owner">${esc(db.sm.abbrAddr(p.owner))}</span>` : ""}
      </div>`}
    </div>`

  card.querySelector("[data-share]")?.addEventListener("click", () => openShareModal(id))
  card.querySelector("[data-edit]")?.addEventListener("click", () => openEditModal(id))
  card.querySelector("[data-delete]")?.addEventListener("click", () => deleteListing(id))
  card.querySelectorAll("[data-status-btn]").forEach((b) =>
    b.addEventListener("click", () => changeStatus(id, b.dataset.statusBtn)))
  return card
}

// ======================= Actions: status / share / delete =================

const changeStatus = async (id, newStatus) => {
  try {
    const { result: node } = await db.get(id)
    if (!node) return
    await db.sm.acls.set({ ...node.value, status: newStatus }, id) // ACL-checked
  } catch {
    toast("Permission denied — you are not an owner or collaborator", true)
  }
}

const deleteListing = async (id) => {
  if (!confirm("Delete this listing?")) return
  try {
    await db.sm.executeWithPermission("delete")
    await db.remove(id)
    toast("Listing deleted")
  } catch (err) {
    toast(err.message, true)
  }
}

const openShareModal = (id) => {
  $("share-node-id").value = id
  $("share-address").value = ""
  $("shareModal").showModal()
}
$("closeShareBtn").onclick = () => $("shareModal").close()
$("shareModal").onclick = (e) => { if (e.target === $("shareModal")) $("shareModal").close() }

$("confirmShareBtn").onclick = async () => {
  const id = $("share-node-id").value
  const addr = $("share-address").value.trim()
  if (!addr.startsWith("0x")) return toast("Invalid ETH address", true)
  try {
    // 1. The real permission: grant write on this node via GenosDB ACLs.
    await db.sm.acls.grant(id, addr, "write")
    // 2. Mirror the grant into the node value so every peer's UI can show
    //    edit affordances to the collaborator without an async ACL lookup.
    const { result: node } = await db.get(id)
    const collaborators = { ...(node.value.collaborators || {}), [addr]: "write" }
    await db.sm.acls.set({ ...node.value, collaborators }, id)
    toast(`Access granted to ${db.sm.abbrAddr(addr)}`)
    $("shareModal").close()
  } catch {
    toast("Error granting access — only the owner can share", true)
  }
}

// ============================ Publish / edit ===============================

const openPublishModal = () => {
  if (!db.sm.isSecurityActive()) return $("identityModal").showModal()
  $("publish-form").reset()
  $("edit-node-id").value = ""
  $("modal-title").textContent = "Publish Property"
  $("btn-submit-property").textContent = "Publish Property"
  $("publishModal").showModal()
}
$("publishBtn").onclick = openPublishModal
$("closePublishBtn").onclick = () => $("publishModal").close()

const openEditModal = async (id) => {
  const { result: node } = await db.get(id)
  if (!node) return
  const p = node.value
  const f = $("publish-form")
  $("edit-node-id").value = id
  $("modal-title").textContent = "Edit Property"
  $("btn-submit-property").textContent = "Save Changes"
  for (const name of ["title", "operation", "propertyType", "price", "currency", "country", "city", "zone", "address", "imgUrl", "lat", "lng"]) {
    const field = f.querySelector(`[name=${name}]`)
    if (field) field.value = p[name] ?? ""
  }
  $("publishModal").showModal()
}

$("publish-form").addEventListener("submit", async (e) => {
  e.preventDefault()
  const fd = new FormData(e.target)
  const editId = $("edit-node-id").value

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
  }

  try {
    await db.sm.executeWithPermission("write") // fail fast: guests can't publish

    if (editId) {
      // UPDATE: preserve immutable fields (creation date, owner, collaborators)
      const { result: oldNode } = await db.get(editId)
      await db.sm.acls.set({ ...oldNode.value, ...propertyData, createdAt: oldNode.value.createdAt }, editId)
      toast("Property updated")
    } else {
      // CREATE: the ACL layer makes the caller the owner of the node
      await db.sm.acls.set({ ...propertyData, owner: myAddress, status: "available", collaborators: {}, createdAt: Date.now() })
      await bumpListingCount() // governance metric — rules read it from my user node
      toast("Property published")
    }
    $("publishModal").close()
    e.target.reset()
  } catch (err) {
    toast(err.message, true)
  }
})

/** Aggregate the governance metric into my user node (spread to keep `role`!). */
const bumpListingCount = async () => {
  const id = `user:${myAddress}`
  const { result } = await db.get(id)
  await db.put({ ...result.value, listingCount: (result.value.listingCount ?? 0) + 1 }, id)
}

$("geoBtn").onclick = () =>
  navigator.geolocation?.getCurrentPosition((pos) => {
    document.querySelector("[name=lat]").value = pos.coords.latitude.toFixed(4)
    document.querySelector("[name=lng]").value = pos.coords.longitude.toFixed(4)
  })

// ============================ Views & wiring ===============================

const switchView = (view) => {
  $("view-list").style.display = view === "list" ? "block" : "none"
  $("view-map").style.display = view === "map" ? "block" : "none"
  $("tab-list").classList.toggle("active", view === "list")
  $("tab-map").classList.toggle("active", view === "map")
  if (view === "map") setTimeout(() => mapInstance.invalidateSize(), 100)
}
$("tab-list").onclick = () => switchView("list")
$("tab-map").onclick = () => switchView("map")

$("btn-load-more").onclick = () => performSearch(true)
$("search-form").addEventListener("submit", (e) => { e.preventDefault(); performSearch(false) })

addEventListener("beforeunload", () => db.room?.leave?.()) // real unload only — never pagehide

// ================================= Boot ====================================

applyTheme(localStorage.theme ?? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"))
applyPermissionsToUI()
initMap()
performSearch(false)
