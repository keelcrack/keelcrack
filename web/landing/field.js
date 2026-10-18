// KEELCRACK landing · field.js — the 3D ice field (three + rapier through shared3d/ice.js).
//
// Layout (world units, y up, water at y = 0; the camera looks toward -z, so -z is "up" on screen):
//   x  time: one hour = one SLOT. The gate sheet sits left of x = 4; slot 0 (the oldest hour shown) starts at LEAD.
//   z  bands: back pack ice (z < Z.back) · question floes (Z.floe) · the ship's lane (Z.lane) · buoys (Z.buoy) · front pack ice.
// Every question is one floe = one rapier body (x, z, yaw; y locked). Thickness = live bounty. A cracked question is a set
// of pre-fractured pieces that drift apart on soft springs; an unsolved one is a flat grey slab; the current hour's next
// question is skim ice that freezes in as the hour passes. The ship (kinematic) follows the camera and pushes brash ice.
import * as THREE from 'three'
import {
  COLORS, rng, hashSeed, floeOutline, fracture, buildFloe, floeObject, mergeFloes, iceMaterial, lineMaterial,
  waterMaterial, thicknessFor, planarWorld, loadRapier, area, voronoiMosaic,
} from '/shared3d/ice.js'

export const HOUR = 3600000
export const SLOT = 6.5
export const LEAD = 15
export const Z = { back: -7.4, floe: -3.3, lane: 1.4, buoy: 4.4, front: 6.5 }
export const GATE = { x0: -23, x1: 2.5, ship: -26.4, view: -18.6, out: 8.5 }
const ELEV = THREE.MathUtils.degToRad(54)
const CAM_Z = 0.7
const SHIP_SCALE = 1.3
const MIN_SPAN = 9          // the field shows at least 10 hour slots (+ the skim ice), so the buoys have room

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const easeOutBack = (t) => { const c1 = 1.5, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2) }
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))

// ── a dynamic batch: many small moving prisms in ONE mesh + ONE outline, transformed on the CPU each frame ──
function dynBatch(items, { lineOpacity = 0.45 } = {}) {
  let nv = 0, nl = 0
  for (const it of items) { nv += it.pos.length; nl += it.lines.length }
  const pos = new Float32Array(nv), col = new Float32Array(nv), lin = new Float32Array(nl)
  let o = 0
  for (const it of items) { it.vo = o; col.set(it.col, o); o += it.pos.length }
  o = 0
  for (const it of items) { it.lo = o; o += it.lines.length }
  const g = new THREE.BufferGeometry()
  const pa = new THREE.BufferAttribute(pos, 3); pa.setUsage(THREE.DynamicDrawUsage)
  g.setAttribute('position', pa); g.setAttribute('color', new THREE.BufferAttribute(col, 3))
  const lg = new THREE.BufferGeometry()
  const la = new THREE.BufferAttribute(lin, 3); la.setUsage(THREE.DynamicDrawUsage)
  lg.setAttribute('position', la)
  const mesh = new THREE.Mesh(g, iceMaterial()); mesh.frustumCulled = false
  const outline = new THREE.LineSegments(lg, lineMaterial(COLORS.arctic, lineOpacity)); outline.frustumCulled = false; outline.renderOrder = 2
  const write = (src, dst, off, c, s, x, y, z) => {
    for (let i = 0; i < src.length; i += 3) {
      const px = src[i], pz = src[i + 2]
      dst[off + i] = px * c + pz * s + x; dst[off + i + 1] = src[i + 1] + y; dst[off + i + 2] = -px * s + pz * c + z
    }
  }
  return {
    mesh, outline,
    update() {
      for (const it of items) {
        const c = Math.cos(it.rot), s = Math.sin(it.rot)
        write(it.pos, pos, it.vo, c, s, it.x, it.y, it.z)
        write(it.lines, lin, it.lo, c, s, it.x, it.y, it.z)
      }
      pa.needsUpdate = true; la.needsUpdate = true
    },
  }
}

// ── the ship: a small low-poly icebreaker, bow toward +x ──
function shipObject() {
  const g = new THREE.Group()
  const lam = (c) => new THREE.MeshLambertMaterial({ color: c, flatShading: true })
  const ink = lineMaterial(COLORS.ink, 0.7)
  const deckR = [[2.3, 0], [1.55, 0.7], [0.3, 0.86], [-1.75, 0.86], [-2.1, 0.6], [-2.1, -0.6], [-1.75, -0.86], [0.3, -0.86], [1.55, -0.7]]
  const ring = (r, y, sx = 1, bow = 0) => r.map(([x, z], i) => [i === 0 ? x - bow : x > 1 ? x - bow * 0.6 : x, y, z * sx])
  const D = ring(deckR, 0.66), S = ring(deckR, 0.14, 0.985, 0.42), W = ring(deckR, 0.0, 0.975, 0.5), B = ring(deckR, -0.5, 0.82, 0.95)
  const pos = [], col = []
  const cHull = new THREE.Color(COLORS.hull), cInk = new THREE.Color(0x1a2a33), cDeck = new THREE.Color(0xD5E0E6)
  const push = (a, b, c, color, out) => {
    const u = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]), v = new THREE.Vector3(c[0] - a[0], c[1] - a[1], c[2] - a[2])
    const n = u.clone().cross(v)
    if (n.dot(out) < 0) { const t = b; b = c; c = t }
    pos.push(...a, ...b, ...c); for (let k = 0; k < 3; k++) col.push(color.r, color.g, color.b)
  }
  const n = deckR.length
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const out = new THREE.Vector3((D[i][0] + D[j][0]) / 2, 0, (D[i][2] + D[j][2]) / 2)
    push([-0.1, 0.66, 0], D[i], D[j], cDeck, new THREE.Vector3(0, 1, 0))
    push(D[i], S[i], S[j], cHull, out); push(D[i], S[j], D[j], cHull, out)
    push(S[i], W[i], W[j], cInk, out); push(S[i], W[j], S[j], cInk, out)
    push(W[i], B[i], B[j], cInk, out); push(W[i], B[j], W[j], cInk, out)
  }
  const hg = new THREE.BufferGeometry()
  hg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); hg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  hg.computeVertexNormals()
  const hullMesh = new THREE.Mesh(hg, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }))
  g.add(hullMesh)
  const L = []
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; L.push(...D[i], ...D[j], ...S[i], ...S[j]); if (i === 0 || i === 1 || i === n - 1) L.push(...D[i], ...S[i]) }
  const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(L, 3))
  g.add(new THREE.LineSegments(lg, ink))
  const box = (x0, x1, y0, y1, hz, color, lines = true) => {
    const geo = new THREE.BoxGeometry(x1 - x0, y1 - y0, hz * 2)
    geo.translate((x0 + x1) / 2, (y0 + y1) / 2, 0)
    const m = new THREE.Mesh(geo, lam(color)); g.add(m)
    if (lines) g.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), ink))
    return m
  }
  box(-1.75, 0.15, 0.66, 1.3, 0.62, 0xFFFFFF)           // superstructure
  box(-1.25, -0.05, 1.3, 1.78, 0.74, 0xFFFFFF)          // bridge (wings wider)
  box(-0.12, -0.04, 1.42, 1.66, 0.7, 0x16303e, false)   // bridge windows (front)
  box(-1.78, -1.38, 1.3, 2.05, 0.24, 0x1a2a33)          // funnel
  box(-0.72, -0.62, 1.78, 2.6, 0.04, 0x1a2a33, false)   // mast
  box(0.55, 1.35, 0.66, 0.78, 0.36, 0xC9D6DD)           // foredeck hatch
  g.scale.setScalar(SHIP_SCALE)
  const collider = [[2.35, 0], [1.55, 0.78], [0.3, 0.92], [-1.8, 0.92], [-2.15, 0.62], [-2.15, -0.62], [-1.8, -0.92], [0.3, -0.92], [1.55, -0.78]]
  return { group: g, collider: collider.map(([x, z]) => [x * SHIP_SCALE, z * SHIP_SCALE]) }
}

function buoyObject() {
  const g = new THREE.Group()
  const lam = (c) => new THREE.MeshLambertMaterial({ color: c, flatShading: true })
  const ink = lineMaterial(COLORS.arctic, 0.75)
  const add = (geo, color) => { const m = new THREE.Mesh(geo, lam(color)); g.add(m); g.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), ink)); return m }
  add(new THREE.CylinderGeometry(0.42, 0.5, 0.55, 7).translate(0, 0.0, 0), 0xFFFFFF)
  add(new THREE.CylinderGeometry(0.3, 0.38, 0.32, 7).translate(0, 0.43, 0), COLORS.arctic)
  add(new THREE.CylinderGeometry(0.06, 0.24, 0.62, 7).translate(0, 0.9, 0), 0xFFFFFF)
  add(new THREE.CylinderGeometry(0.13, 0.13, 0.16, 7).translate(0, 1.27, 0), COLORS.arctic)
  return g
}

export function createField({ canvas, reduced = false }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.setClearColor(COLORS.ice, 1)
  const scene = new THREE.Scene()
  scene.add(new THREE.HemisphereLight(0xFFFFFF, 0x6F9DB8, 1.75))
  const sun = new THREE.DirectionalLight(0xFFFFFF, 1.6)
  sun.position.set(-6, 12, 7)
  scene.add(sun)

  const cam = new THREE.OrthographicCamera(-10, 10, 10, -10, 1, 200)
  const view = { w: 1, h: 1, ppu: 30, insetRight: 0, insetBottom: 0, insetTop: 0, camZ: CAM_Z, x: GATE.view, shake: 0 }

  // ── water ──
  const water = waterMaterial({ reduced })
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(1400, 260).rotateX(-Math.PI / 2), water.material)
  sea.position.set(300, 0, 0)
  scene.add(sea)
  let ringI = 0
  function splash(x, z, strength = 1, delay = 0) {
    if (reduced) return
    const r = water.uniforms.uRings.value[ringI++ % 6]
    r.set(x, z, water.uniforms.uTime.value + delay, strength)
  }

  // ── physics ──
  let world = planarWorld(null)
  const physReady = reduced ? Promise.resolve(null) : loadRapier()

  // ── pack ice (static, merged in x-chunks) ──
  const packGroup = new THREE.Group(); scene.add(packGroup)
  function packBand(x0, x1, z0, z1, seed, opts = {}) {
    const CH = 40
    for (let cx = x0; cx < x1; cx += CH) {
      const list = voronoiMosaic(cx, Math.min(cx + CH, x1), z0, z1, seed + Math.round(cx * 7), opts)
      if (!list.length) continue
      const m = mergeFloes(list, { lineOpacity: opts.lineOpacity ?? 0.34 })
      packGroup.add(m.mesh, m.outline)
    }
  }
  const FIELD_MAX = LEAD + 62 * SLOT + 40
  packBand(-46, FIELD_MAX, -40, -19, 11, { cell: 4.6, gap: [0.06, 0.24] })
  packBand(-46, FIELD_MAX, -19, Z.back - 0.5, 12, { cell: 3.3, gap: [0.05, 0.2], drop: 0.015 })
  packBand(-46, FIELD_MAX, Z.front + 0.5, 17, 23, { cell: 3.3, gap: [0.05, 0.2], drop: 0.015 })
  packBand(-46, FIELD_MAX, 17, 34, 24, { cell: 4.6, gap: [0.06, 0.24] })
  // behind the ship at the gate: the channel it came through is open; above and below it, pack ice
  packBand(-46, GATE.x0 - 0.3, Z.back - 0.5, Z.front + 0.5, 37, { cell: 3.0, gap: [0.08, 0.34], keep: (x, z) => Math.abs(z - Z.lane) > 3.3 })

  // fill for hours without a question (rebuilt by setData)
  let fillGroup = new THREE.Group(); scene.add(fillGroup)

  // walls: keep floating ice in the water band
  const walls = (w) => {
    w.wall(300, Z.back - 0.45, 400, 0.5)
    w.wall(300, Z.front + 0.45, 400, 0.5)
    w.wall(GATE.x0 - 11, Z.lane, 0.5, 8)
  }

  // ── the ship ──
  const ship = shipObject()
  scene.add(ship.group)
  const shipState = { x: GATE.ship, z: Z.lane, heading: 0, target: GATE.ship, v: 0, bump: 0, mode: 'gate', body: null }
  ship.group.position.set(shipState.x, 0, shipState.z)

  // ── brash ice in the lane (one batch) ──
  const BRASH = Math.min(window.innerWidth, window.innerHeight) < 600 ? 18 : 26
  const brash = []
  {
    const R = rng(4242)
    for (let i = 0; i < BRASH; i++) {
      const r = 0.32 + R() * 0.38
      const poly = floeOutline(9000 + i, { r, n: 5 + Math.floor(R() * 2), stretch: 1 + R() * 0.4, jitter: 0.35 })
      const b = buildFloe(poly, { h: 0.12 + R() * 0.12, rim: 0.06, drop: 0.05, depth: 0.25, seed: 77 + i, facets: false, waterline: false })
      brash.push({ poly, pos: b.geometry.attributes.position.array, col: b.geometry.attributes.color.array, lines: b.lines, x: 0, y: 0, z: 0, rot: R() * 6, body: null, seed: R() * 10 })
    }
  }
  const brashBatch = dynBatch(brash, { lineOpacity: 0.4 })
  scene.add(brashBatch.mesh, brashBatch.outline)
  function placeBrash(it, x) {
    const z = Z.lane + (Math.random() - 0.5) * 3.4
    it.x = x; it.z = clamp(z, Z.floe + 2.6, Z.buoy - 1.2)
    if (it.body) it.body.place(it.x, it.z, Math.random() * 6)
  }

  // ── buoys ──
  const buoys = []
  for (let i = 0; i < 6; i++) {
    const o = buoyObject()
    scene.add(o)
    buoys.push({ i, obj: o, x: 0, z: Z.buoy, seed: i * 1.7 })
  }

  // ── the gate sheet: one frozen plate in front of the bow, pre-fractured ──
  const gate = { pieces: [], state: 'closed', t: 0 }
  {
    const zb = Z.back - 0.05, zf = Z.front - 0.05
    const rect = [[GATE.x0, zb], [GATE.x1, zb], [GATE.x1, zf], [GATE.x0, zf]]
    const R = rng(1863)
    const seeds = []
    for (let x = GATE.x0 + 0.7; x < GATE.x1; x += 1.45 + R() * 0.5) seeds.push([x, Z.lane + (seeds.length % 2 ? 1 : -1) * (0.45 + R() * 0.5)])
    for (let i = 0; i < 44; i++) seeds.push([GATE.x0 + R() * (GATE.x1 - GATE.x0), zb + R() * (zf - zb)])
    for (const p of fracture(rect, 1863, { seeds })) {
      const seed = hashSeed(p.cx.toFixed(2) + p.cz.toFixed(2))
      const o = floeObject(p.poly, { h: 0.42, rim: 0.07, drop: 0.06, seed, crack: p.crack.map(() => false), facets: false, lineOpacity: 0.32 })
      o.group.position.set(p.cx, 0, p.cz)
      scene.add(o.group)
      gate.pieces.push({ ...p, obj: o, body: null, x: p.cx, z: p.cz, rot: 0, released: false, seed })
    }
  }
  // after the gate: the broken plate settles back into pack ice with the ship's channel left open (the same look as the
  // pack behind the ship), so no big loose plates linger at the start of the field
  const gatePack = new THREE.Group()
  {
    const list = voronoiMosaic(GATE.x0 - 0.3, GATE.x1 + 0.4, Z.back - 0.5, Z.front + 0.5, 38, { cell: 3.0, gap: [0.08, 0.34], keep: (x, z) => Math.abs(z - Z.lane) > 3.3 })
    const m = mergeFloes(list, { lineOpacity: 0.34 })
    gatePack.add(m.mesh, m.outline)
    gatePack.visible = false
    scene.add(gatePack)
  }
  function dropGatePieces() {
    for (const p of gate.pieces) {
      scene.remove(p.obj.group)
      p.obj.mesh.geometry.dispose(); p.obj.outline.geometry.dispose()
      p.body?.remove?.()
    }
    gate.pieces = []
  }

  // ── question floes ──
  const floes = new Map()            // id → record
  const pickables = []
  let layout = { hour0: 0, nowHour: 0, n: 24, buoyX: [6, 20, 40, 60, 80, 100], minX: GATE.view, maxX: 200, skimX: 0 }
  const slotX = (hour) => LEAD + (hour - layout.hour0) * SLOT

  // skim ice for the next hour
  const skimMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, transparent: true, opacity: 0.6, depthWrite: false })
  const skimLine = new THREE.LineBasicMaterial({ color: COLORS.arctic, transparent: true, opacity: 0.35, depthWrite: false })
  let skim = null

  function makeFloe(q, opts = {}) {
    const seed = hashSeed('q' + q.id)
    const poly = floeOutline(seed, { r: 1.95 + (q.tier || 1) * 0.08, n: 9 + (seed % 3), stretch: 1.28 })
    const rec = { id: q.id, q, seed, poly, kind: null, parts: [], hCur: 0, hTarget: 0, x0: 0, z0: Z.floe, sel: false, appear: opts.appear ? 0 : 1, melt: 1 }
    floes.set(q.id, rec)
    return rec
  }
  function clearParts(rec) {
    for (const p of rec.parts) {
      scene.remove(p.obj.group)
      p.obj.mesh.geometry.dispose(); p.obj.outline.geometry.dispose()
      p.body?.remove()
      const i = pickables.indexOf(p.obj.mesh); if (i >= 0) pickables.splice(i, 1)
    }
    rec.parts = []
  }
  function lineFor(rec) {
    if (rec.sel) return lineMaterial(COLORS.hull, 0.95)
    if (rec.kind === 'slab') return lineMaterial(COLORS.dim, 0.55)
    if (rec.kind === 'practice') return lineMaterial(COLORS.arctic, 0.4)
    return lineMaterial(COLORS.arctic, rec.kind === 'pieces' ? 0.5 : 0.62)
  }
  function addPart(rec, poly, { x, z, rot = 0, h, kind = 'ice', crack = null, facets = true, home = null, seed }) {
    const obj = floeObject(poly, { h, seed, kind, crack, facets, lineMaterial: lineFor(rec) })
    obj.mesh.userData.id = rec.id
    obj.group.position.set(x, 0, z); obj.group.rotation.y = rot
    scene.add(obj.group)
    pickables.push(obj.mesh)
    const body = world.body(poly, { x, z, rot, density: 0.9, damping: 1.1, angularDamping: 1.6 })
    body.home = home
    const part = { obj, body, poly, h, kind, crack, seed, facets }
    rec.parts.push(part)
    return part
  }
  function buildWhole(rec, kind, h) {
    clearParts(rec)
    rec.kind = kind
    addPart(rec, rec.poly, { x: rec.x0, z: rec.z0, h, kind: kind === 'slab' ? 'slab' : kind === 'practice' ? 'practice' : 'ice', seed: rec.seed, home: { x: rec.x0, z: rec.z0, k: 2.4, rot: 0 } })
    rec.hCur = rec.hBuilt = h
  }
  function piecesOf(rec) { return fracture(rec.poly, rec.seed, { count: 5 + (rec.seed % 3), angle: ((rec.seed % 100) / 100 - 0.5) * 0.9 }) }
  function buildPieces(rec, h, { spread = 1, from = null } = {}) {
    const pieces = piecesOf(rec)
    const fx = from?.x ?? rec.x0, fz = from?.z ?? rec.z0, frot = from?.rot ?? 0
    clearParts(rec)
    rec.kind = 'pieces'
    const c = Math.cos(frot), s = Math.sin(frot)
    for (const p of pieces) {
      const lx = p.cx * c + p.cz * s, lz = -p.cx * s + p.cz * c
      const R = rng(rec.seed + Math.round(p.cx * 1000))
      const hx = rec.x0 + p.cx * 1.42 + (R() - 0.5) * 0.4, hz = rec.z0 + p.cz * 1.32 + (R() - 0.5) * 0.3
      const x = spread ? hx : fx + lx, z = spread ? hz : fz + lz
      const part = addPart(rec, p.poly, { x, z, rot: spread ? (R() - 0.5) * 0.7 : frot, h, crack: p.crack, facets: false, seed: rec.seed + Math.round(p.cx * 100), home: { x: hx, z: hz, k: 0.32, rot: null } })
      part.cell = p
    }
    rec.hCur = rec.hBuilt = h
  }
  function kindOf(q) {
    if (q.status === 'solved') return 'pieces'
    if (q.status === 'unsolved') return 'slab'
    if (q.status === 'practice') return 'practice'
    return 'ice'
  }
  const hFor = (q) => (q.status === 'unsolved' ? 0.13 : q.status === 'practice' ? 0.42 : thicknessFor(q.loadEth))

  // ── data → field ──
  function setData({ items, nowMs = Date.now(), hour0 = null }) {
    const nowHour = Math.floor(nowMs / HOUR)
    // the field starts one hour before the oldest question (at least MIN_SPAN hours back, at most 47): a handful of
    // pre-launch questions does not leave a day of empty pack ice. Older data arriving later (a slow first load) re-lays it.
    const hours = items.map((q) => q.hour).filter((h) => h >= nowHour - 47 && h <= nowHour + 1)
    let h0 = hour0 ?? Math.min(nowHour - MIN_SPAN, hours.length ? Math.min(...hours) - 1 : nowHour - MIN_SPAN)
    h0 = Math.max(h0, nowHour - 47)
    if (!layout.fixed || h0 < layout.hour0) {
      if (layout.fixed) { for (const rec of floes.values()) clearParts(rec); floes.clear(); layout.built = false }
      layout.hour0 = h0
      layout.fixed = true
    }
    layout.nowHour = nowHour
    layout.n = nowHour - layout.hour0 + 1
    const events = []
    const seen = new Set()
    for (const q of items) {
      if (q.hour < layout.hour0) continue
      seen.add(q.id)
      let rec = floes.get(q.id)
      const x = slotX(q.hour)
      if (!rec) {
        const fresh = layout.built && !reduced
        rec = makeFloe(q, { appear: fresh })
        rec.x0 = x; rec.z0 = Z.floe + ((q.hour % 2) ? 0.35 : -0.25)
        const k = kindOf(q)
        if (k === 'pieces') buildPieces(rec, thicknessFor(q.loadEth))
        else buildWhole(rec, k, hFor(q))
        rec.hTarget = rec.hCur
        if (fresh) { rec.appear = 0; events.push(['posted', rec]) }
        continue
      }
      const prev = rec.q
      rec.q = q
      const k = kindOf(q)
      if (rec.kind !== k) {
        if (k === 'pieces') events.push(['crack', rec])
        else if (k === 'slab') events.push(['melt', rec])
        else buildWhole(rec, k, hFor(q))
      } else if (k === 'ice') rec.hTarget = hFor(q)
      if (prev && (q.commits > (prev.commits || 0) || q.reveals > (prev.reveals || 0))) events.push(['pulse', rec])
    }
    for (const [id, rec] of floes) if (!seen.has(id)) { clearParts(rec); floes.delete(id) }
    rebuildLayout()
    layout.built = true
    return events
  }

  function rebuildLayout() {
    // fill empty hours with pack ice so the frozen sea reads as "no question yet"
    scene.remove(fillGroup)
    fillGroup.traverse((o) => { o.geometry?.dispose?.() })
    fillGroup = new THREE.Group()
    const used = new Set([...floes.values()].map((r) => Math.round((r.x0 - LEAD) / SLOT)))
    let list = []
    for (let i = 0; i < layout.n; i++) {
      if (used.has(i)) continue
      const x = LEAD + i * SLOT
      list = list.concat(voronoiMosaic(x - SLOT / 2 + 0.15, x + SLOT / 2 - 0.15, Z.back - 0.3, Z.floe + 2.4, 5150 + i * 31 + layout.hour0, { cell: 2.6, gap: [0.05, 0.2], h: [0.2, 0.34] }))
    }
    if (list.length) { const m = mergeFloes(list, { lineOpacity: 0.34 }); fillGroup.add(m.mesh, m.outline) }
    scene.add(fillGroup)
    // skim ice in the next slot
    const nx = LEAD + layout.n * SLOT
    layout.skimX = nx
    if (!skim || skim.slot !== layout.n) {
      if (skim) { scene.remove(skim.group); skim.mesh.geometry.dispose() }
      const poly = floeOutline(hashSeed('skim' + (layout.hour0 + layout.n)), { r: 2.05, n: 10, stretch: 1.28 })
      const o = floeObject(poly, { h: 0.07, rim: 0.05, drop: 0.03, seed: 3, kind: 'practice', facets: false, material: skimMat, lineMaterial: skimLine })
      o.group.position.set(nx, 0, Z.floe)
      scene.add(o.group)
      skim = { ...o, slot: layout.n }
    }
    // buoys: 1 at the start, 6 after the skim ice, 2–5 spread between (in the gaps between hours)
    const b0 = GATE.out - 2.5, b5 = nx + SLOT * 1.25
    layout.buoyX = [b0]
    for (let i = 1; i < 5; i++) {
      const raw = b0 + (b5 - b0) * (i / 5)
      layout.buoyX.push(LEAD + Math.round((raw - LEAD) / SLOT) * SLOT + SLOT / 2)
    }
    layout.buoyX.push(b5)
    buoys.forEach((b, i) => { b.x = layout.buoyX[i]; b.obj.position.set(b.x, 0, b.z) })
    layout.minX = GATE.view - 4
    layout.maxX = b5 + 4
  }

  // ── events with motion ──
  function crack(id, { from = 'keel' } = {}) {
    const rec = floes.get(id)
    if (!rec) return
    const whole = rec.parts[0]
    const h = rec.hCur || thicknessFor(rec.q.loadEth)
    const at = whole ? { x: whole.body.x, z: whole.body.z, rot: whole.body.rot } : { x: rec.x0, z: rec.z0, rot: 0 }
    buildPieces(rec, h, { spread: reduced ? 1 : 0, from: at })
    if (reduced) return
    splash(at.x, at.z, 1.2)
    splash(at.x, at.z, 0.7, 0.5)
    const ang = ((rec.seed % 100) / 100 - 0.5) * 0.9
    const nx = -Math.sin(ang), nz = Math.cos(ang)
    for (const p of rec.parts) {
      const dx = p.body.x - at.x, dz = p.body.z - at.z
      const side = Math.sign(dx * nx + dz * nz) || 1
      const m = Math.abs(area(p.poly))
      const k = (1.6 + Math.random() * 0.8) * m
      p.body.impulse((nx * side * 0.9 + dx * 0.35) * k, (nz * side * 0.9 + dz * 0.35) * k, p.body.x + (Math.random() - 0.5) * 0.4, p.body.z + (Math.random() - 0.5) * 0.4)
    }
    rec.crackT = 0
  }
  function melt(id) {
    const rec = floes.get(id)
    if (!rec) return
    if (reduced) { buildWhole(rec, 'slab', 0.13); return }
    rec.meltT = 0
  }
  function pulse(id) {
    const rec = floes.get(id)
    if (!rec) return
    const b = rec.parts[0]?.body
    splash(b ? b.x : rec.x0, b ? b.z : rec.z0, 0.6)
    rec.pulseT = 0
  }
  function replay(id) {
    const rec = floes.get(id)
    if (!rec || rec.kind !== 'pieces') return
    const h = rec.hCur
    buildWhole(rec, 'ice', h)
    rec.hTarget = h
    rec.appear = reduced ? 1 : 0.4
    if (reduced) { buildPieces(rec, h); return }
    setTimeout(() => crack(id), 900)
  }
  function freezeIn(rec) { rec.appear = 0; splash(rec.x0, rec.z0, 0.8) }

  function setSelected(id) {
    for (const rec of floes.values()) {
      const s = rec.id === id
      if (s === rec.sel) continue
      rec.sel = s
      for (const p of rec.parts) p.obj.outline.material = lineFor(rec)
    }
  }

  // ── gate ──
  function gateShake() {
    if (reduced) return
    shipState.bump = 0.0001
    view.shake = 0.35
    splash(GATE.ship + 2.3, Z.lane, 0.8)
    for (const p of gate.pieces) p.jig = 0.4 * Math.max(0, 1 - Math.abs(p.cx - GATE.x0) / 9)
  }
  function gateOpenInstant() {
    gate.state = 'open'
    shipState.mode = 'follow'
    dropGatePieces()
    gatePack.visible = true; gatePack.position.y = 0; gate.settle = null
    shipState.x = shipState.target = GATE.out
    view.x = GATE.out + 4
  }
  function gateCrack() {
    if (gate.state !== 'closed') return Promise.resolve()
    if (reduced) { gateOpenInstant(); return Promise.resolve() }
    gate.state = 'cracking'; gate.t = 0
    shipState.mode = 'gate-run'
    return new Promise((res) => { gate.done = res })
  }

  function attachPhysics(R) {
    if (!R) return
    const old = world
    world = planarWorld(R)
    walls(world)
    for (const rec of floes.values()) for (const p of rec.parts) {
      const b = p.body
      p.body = world.body(p.poly, { x: b.x, z: b.z, rot: b.rot, density: 0.9, damping: 1.1, angularDamping: 1.6 })
      p.body.home = b.home
    }
    for (const p of gate.pieces) {
      p.body = world.body(p.poly, { x: p.x, z: p.z, rot: p.rot, density: 0.8, damping: 1.4, angularDamping: 2, frozen: !p.released })
      if (p.home) p.body.home = { ...p.home, rot: null }
    }
    for (const it of brash) {
      it.body = world.body(it.poly, { x: it.x, z: it.z, rot: it.rot, density: 0.6, damping: 1.5, angularDamping: 1.8 })
    }
    shipState.body = world.kinematic(ship.collider, { x: shipState.x, z: shipState.z, rot: 0 })
    void old
  }
  // brash starts scattered behind the gate + along the start of the field
  brash.forEach((it, i) => placeBrash(it, GATE.x1 + 2 + (i / brash.length) * 40))
  // fallback bodies so the no-physics path still has positions
  for (const p of gate.pieces) p.body = null

  // ── camera ──
  function gateViewX() { return Math.min(GATE.view, GATE.ship + (view.w / view.ppu / 2) * 0.55) }
  function resize() {
    const w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight
    renderer.setSize(w, h, false)
    view.w = w; view.h = h
    let ppu = clamp(0.0105 * w + 21, 24, 44)
    ppu = Math.max(18, Math.min(ppu, h / 19))
    view.portrait = h > w * 1.2
    view.camZT = view.portrait ? (gate.state === 'open' ? 3.0 : -2.2) : CAM_Z
    if (gate.state === 'closed') { view.x = gateViewX(); view.camZ = view.camZT }
    view.ppu = ppu
    const hw = w / ppu / 2, hh = h / ppu / 2
    cam.left = -hw; cam.right = hw; cam.top = hh; cam.bottom = -hh
    cam.updateProjectionMatrix()
  }
  function placeCamera(t) {
    const sx = view.shake > 0 ? Math.sin(t * 80) * view.shake * 0.25 : 0
    const cx = view.x + (view.insetRight / 2) / view.ppu + sx
    const zc = view.camZ - ((view.insetTop - view.insetBottom) / 2) / view.ppu / Math.sin(ELEV)
    cam.position.set(cx, Math.sin(ELEV) * 80, zc + Math.cos(ELEV) * 80)
    cam.lookAt(cx, 0, zc)
    cam.updateMatrixWorld()
  }
  const v3 = new THREE.Vector3()
  function project(x, y, z, out = {}) {
    v3.set(x, y, z).project(cam)
    out.x = (v3.x + 1) / 2 * view.w; out.y = (1 - v3.y) / 2 * view.h
    return out
  }
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2()
  function pick(px, py) {
    ndc.set(px / view.w * 2 - 1, -(py / view.h) * 2 + 1)
    ray.setFromCamera(ndc, cam)
    const hit = ray.intersectObjects(pickables, false)[0]
    return hit ? hit.object.userData.id : null
  }

  // ── per frame ──
  let time = 0
  const shipQ = new THREE.Quaternion()
  function update(dt) {
    time += dt
    const t = time
    if (!reduced) water.uniforms.uTime.value = t
    view.shake = Math.max(0, view.shake - dt)

    // ship
    const S = shipState
    if (S.mode === 'gate-run') {
      gate.t += dt
      const T = 3.6
      const k = clamp(gate.t / T, 0, 1)
      const nx = GATE.ship + (GATE.out - GATE.ship) * easeInOut(k)
      S.v = (nx - S.x) / Math.max(dt, 1e-3)
      S.x = nx
      view.x = Math.max(gateViewX(), S.x + 4)
      // release the plate ahead of the keel: lane pieces first, the rest as the crack runs out
      const bow = S.x + 2.3 * SHIP_SCALE
      for (const p of gate.pieces) {
        if (p.released) continue
        const dz = p.cz - Z.lane
        const reach = Math.abs(dz) < 2.4 ? 0.6 : 0.6 - Math.abs(dz) * 0.55
        if (p.cx - bow < reach) {
          p.released = true
          const away = Math.sign(dz) || (p.seed % 2 ? 1 : -1)
          const near = Math.max(0, 1 - Math.abs(dz) / 6)
          p.home = { x: Math.min(GATE.x1 - 1.5, p.cx + 0.5 + near * 0.8), z: p.cz + away * (0.6 + near * 1.6), k: 0.28 }
          if (p.body) {
            p.body.freeze(false)
            p.body.home = { ...p.home, rot: null }
            const m = 1.4 + near * 3.2
            p.body.impulse(m * 0.6, away * m * (1.1 + Math.random() * 0.6), p.cx + (Math.random() - 0.5), p.cz)
          } else p.v = { x: 0.6 + near, z: away * (1.6 + near * 2.4), w: (Math.random() - 0.5) * 0.8 }
          if (Math.abs(dz) < 2.4 && Math.random() < 0.5) splash(p.cx, p.cz, 0.7)
        }
      }
      if (k >= 1) {
        S.mode = 'follow'; gate.state = 'open'; S.target = S.x; gate.done?.()
        // the broken plates sink back under as the pack refreezes around the open channel
        gate.settle = { t: 0 }
        for (const p of gate.pieces) p.sink = { delay: 1.2 + Math.abs(p.cz - Z.lane) * 0.06 + Math.random() * 0.9, k: 0 }
        gatePack.visible = true; gatePack.position.y = -0.55
      }
    } else if (S.mode === 'follow') {
      const want = clamp(view.x - 3, GATE.out - 1, layout.maxX - 6)
      const halfW = view.w / view.ppu / 2
      // a long jump (ruler, Now, Home/End): the ship re-enters from just off-screen instead of sailing for half a minute
      if (Math.abs(want - S.x) > halfW * 1.8) { S.x = want - Math.sign(want - S.x) * halfW * 1.15; S.v = Math.sign(want - S.x) * 8 }
      const dx = want - S.x
      const acc = clamp(dx * 2.2 - S.v * 1.9, -14, 14)
      S.v = clamp(S.v + acc * dt, -16, 16)
      S.x += S.v * dt
    }
    if (S.bump > 0) {
      S.bump += dt
      const b = Math.sin(clamp(S.bump / 0.5, 0, 1) * Math.PI) * 0.45
      ship.group.position.x = S.x + b
      if (S.bump > 0.5) S.bump = 0
    } else ship.group.position.x = S.x
    const wantHead = S.v < -0.6 ? Math.PI : S.v > 0.6 ? 0 : S.heading
    S.heading += (wantHead - S.heading) * Math.min(1, dt * 2.5)
    const bob = reduced ? 0 : Math.sin(t * 1.3) * 0.04
    ship.group.position.set(ship.group.position.x, bob, S.z)
    ship.group.rotation.set(reduced ? 0 : Math.sin(t * 0.9) * 0.015, S.heading, reduced ? 0 : Math.sin(t * 1.1) * 0.02 - S.v * 0.002)
    if (S.body) S.body.moveTo(ship.group.position.x, S.z, S.heading)
    water.uniforms.uShip.value.set(ship.group.position.x, S.z, Math.abs(S.v) > 0.4 ? S.v : 0)

    // brash: recycle chunks far from the view into the lane ahead of the ship
    const half = view.w / view.ppu / 2 + 6
    for (const it of brash) {
      if (Math.abs(it.x - view.x) > half + 18 && gate.state === 'open') placeBrash(it, view.x + Math.sign(S.v || 1) * (half + 2 + Math.random() * 14))
    }

    // physics
    if (!reduced) world.step(dt, t)
    for (const it of brash) {
      if (it.body) { it.x = it.body.x; it.z = it.body.z; it.rot = it.body.rot }
      it.y = reduced ? 0 : Math.sin(t * 1.7 + it.seed) * 0.03
    }
    brashBatch.update()

    // gate pieces
    for (const p of gate.pieces) {
      if (p.body) { p.x = p.body.x; p.z = p.body.z; p.rot = p.body.rot }
      else if (p.v && !reduced) {
        p.x += p.v.x * dt; p.z += p.v.z * dt; p.rot += p.v.w * dt
        const d = Math.exp(-1.6 * dt); p.v.x *= d; p.v.z *= d; p.v.w *= d
      }
      let jx = 0
      if (p.jig > 0) { p.jig = Math.max(0, p.jig - dt); jx = Math.sin(t * 70 + p.seed) * p.jig * 0.12 }
      let sinkY = 0
      if (p.sink) {
        p.sink.k = clamp((gate.settle.t - p.sink.delay) / 2.4, 0, 1)
        const e = easeInOut(p.sink.k)
        sinkY = -0.75 * e
        const sc = 1 - 0.12 * e
        p.obj.group.scale.set(sc, 1, sc)
      }
      p.obj.group.position.set(p.x + jx, (reduced || !p.released ? 0 : Math.sin(t * 1.2 + p.seed) * 0.03) + sinkY, p.z)
      p.obj.group.rotation.y = p.rot
    }
    if (gate.settle) {
      gate.settle.t += dt
      // the pack rises while the plates go under; once every plate is gone they leave the scene and the physics world
      gatePack.position.y = -0.55 * (1 - easeInOut(clamp((gate.settle.t - 1.6) / 2.8, 0, 1)))
      if (gate.pieces.every((p) => !p.sink || p.sink.k >= 1) && gate.settle.t > 4.4) { dropGatePieces(); gatePack.position.y = 0; gate.settle = null }
    }

    // floes
    for (const rec of floes.values()) {
      // thickness follows the live bounty
      if (rec.kind === 'ice' && Math.abs(rec.hTarget - rec.hCur) > 0.002) {
        rec.hCur += (rec.hTarget - rec.hCur) * Math.min(1, dt * (reduced ? 60 : 1.8))
        const p = rec.parts[0]
        if (p) {
          if (Math.abs(rec.hTarget - rec.hCur) < 0.004) { rec.hCur = rec.hTarget; p.obj.group.userData.rebuild(rec.hCur); rec.hBuilt = rec.hCur; p.obj.group.scale.y = 1 }
          else p.obj.group.scale.y = rec.hCur / rec.hBuilt
        }
      }
      if (rec.meltT != null) {
        rec.meltT += dt
        const k = clamp(rec.meltT / 2.2, 0, 1)
        const p = rec.parts[0]
        if (p) p.obj.group.scale.y = (rec.hBuilt + (0.13 - rec.hBuilt) * easeInOut(k)) / rec.hBuilt
        if (k >= 1) { rec.meltT = null; buildWhole(rec, 'slab', 0.13) }
      }
      let appear = 1
      if (rec.appear < 1) { rec.appear = Math.min(1, rec.appear + dt / 2.6); appear = easeOutBack(rec.appear) }
      let pulseY = 0
      if (rec.pulseT != null) { rec.pulseT += dt; pulseY = Math.sin(clamp(rec.pulseT / 0.6, 0, 1) * Math.PI) * 0.08; if (rec.pulseT > 0.6) rec.pulseT = null }
      for (const p of rec.parts) {
        const b = p.body
        const y = reduced ? 0 : Math.sin(t * 0.9 + rec.seed % 7 + p.seed % 3) * 0.035 - pulseY
        p.obj.group.position.set(b.x, y - (1 - Math.min(1, appear)) * 0.4, b.z)
        p.obj.group.rotation.set(reduced ? 0 : Math.sin(t * 0.7 + rec.seed % 5) * 0.012, b.rot, reduced ? 0 : Math.cos(t * 0.8 + p.seed % 4) * 0.012)
        if (rec.appear < 1 || appear !== 1) { const s = Math.max(0.05, appear); p.obj.group.scale.x = s; p.obj.group.scale.z = s }
        else if (p.obj.group.scale.x !== 1) { p.obj.group.scale.x = 1; p.obj.group.scale.z = 1 }
      }
    }

    // skim ice grows through the hour
    if (skim) {
      const prog = clamp((Date.now() % HOUR) / HOUR, 0, 1)
      const s = 0.3 + 0.7 * prog
      skim.group.scale.set(s, 1, s)
      skimMat.opacity = 0.35 + 0.5 * prog
      skimLine.opacity = 0.2 + 0.35 * prog
      skim.group.position.y = reduced ? 0 : Math.sin(t * 0.8) * 0.02
    }
    for (const b of buoys) {
      b.obj.position.y = reduced ? 0 : Math.sin(t * 1.4 + b.seed) * 0.08
      b.obj.rotation.z = reduced ? 0 : Math.sin(t * 1.1 + b.seed) * 0.06
    }

    if (view.portrait) view.camZT = gate.state === 'open' ? 3.0 : -2.2
    view.camZ += (view.camZT - view.camZ) * Math.min(1, dt * (reduced ? 60 : 1.6))
    placeCamera(t)
    renderer.render(scene, cam)
  }

  resize()
  physReady.then((R) => { if (R) attachPhysics(R) })

  return {
    renderer, scene, camera: cam, view, layout, floes, buoys, gate, shipState,
    get physics() { return world.physics },
    physReady,
    setData, crack, melt, pulse, freezeIn, replay, setSelected, splash,
    gateShake, gateCrack, gateOpenInstant,
    resize, update, project, pick, slotX, gateViewX,
    lowerQuality() { renderer.setPixelRatio(Math.max(1, renderer.getPixelRatio() * 0.72)); resize() },
    floeTop(rec) {
      const p = rec.parts[0]
      if (!p) return { x: rec.x0, y: 0.5, z: rec.z0 }
      if (rec.kind === 'pieces') return { x: rec.x0, y: rec.hCur, z: rec.z0 - 2.2 }
      return { x: p.body.x, y: rec.hCur * (p.obj.group.scale.y || 1), z: p.body.z - 1.0 }
    },
  }
}
