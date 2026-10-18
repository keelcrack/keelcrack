// KEELCRACK shared3d/ice.js — the ice kit shared by the landing and the app pages (owner: LANDING; APP imports, never edits).
//
// Low-poly, flat-shaded ice: a faceted top, a thin cold rim (bevel), side walls, a fine outline drawn analytically
// (inner rim, outer rim, verticals, waterline). Floes are convex polygons in the XZ plane; y is up; water is y = 0.
//
// Exports
//   COLORS                         palette (hex numbers), matching the design tokens in BRIEF.md
//   rng(seed) · hashSeed(any)      deterministic random (mulberry32) · string/number → uint32 seed
//   floeOutline(seed, opts)        convex polygon [[x,z],…] (CCW seen from above), roughly an ice floe
//   fracture(poly, seed, opts)     pre-fractured Voronoi cells of a convex polygon → [{ poly (local), cx, cz, crack:[bool per edge] }]
//   buildFloe(poly, opts)          → { geometry (flat-shaded, vertex colours), lines (Float32Array of segment pairs), top }
//   floeObject(poly, opts)         → THREE.Group { mesh, outline } with userData.rebuild(h) for live thickness
//   mergeFloes(list, opts)         many static floes (pack ice) → { mesh, outline } as two draw calls
//   iceMaterial() · lineMaterial(color, opacity)   shared materials (cached)
//   waterMaterial({ reduced })     flat water with a simple ripple pattern + a ship wake; returns { material, uniforms }
//   thicknessFor(loadEth)          live bounty (ETH) → floe thickness in world units (0.4 … 2.6, log scale)
//   loadRapier()                   lazy import + init of the vendored rapier (2 MB, cached; resolves null on failure)
//   planarWorld(R | null)          floating bodies locked to the water plane (x, z, yaw) with a no-physics fallback
//
// Nothing here touches the DOM except loadRapier's dynamic import.
import * as THREE from 'three'

export const COLORS = {
  ice: 0xF3F7F9, floe: 0xFFFFFF, frost: 0xD8E6ED, arctic: 0x0E5A8A, ink: 0x0D1B24, dim: 0x5E7482,
  water: 0x0B2A3C, hull: 0xFF5A1F,
  top: 0xFFFFFF, topShade: 0xEEF4F7, rim: 0xC4DFEC, side: 0x93BDD2, sideLow: 0x6E9FB9, crack: 0x3F7896,
  slabTop: 0xB4C1C8, slabSide: 0x8797A1, practiceTop: 0xF7FAFC,
  waterDeep: 0x0B2A3C, waterMid: 0x17506D, waterLine: 0x3A7F9F,
}

// ── random ──────────────────────────────────────────────
export function rng(seed) {
  let a = (seed >>> 0) || 0x9E3779B9
  return function () {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
export function hashSeed(v) {
  const s = String(v)
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}

// ── 2D polygon helpers (points are [x, z]) ──────────────
export function centroid(poly) {
  let a = 0, cx = 0, cz = 0
  for (let i = 0; i < poly.length; i++) {
    const [x0, z0] = poly[i], [x1, z1] = poly[(i + 1) % poly.length]
    const f = x0 * z1 - x1 * z0
    a += f; cx += (x0 + x1) * f; cz += (z0 + z1) * f
  }
  if (Math.abs(a) < 1e-9) {
    let sx = 0, sz = 0
    for (const p of poly) { sx += p[0]; sz += p[1] }
    return [sx / poly.length, sz / poly.length]
  }
  return [cx / (3 * a), cz / (3 * a)]
}
export function area(poly) {
  let a = 0
  for (let i = 0; i < poly.length; i++) { const [x0, z0] = poly[i], [x1, z1] = poly[(i + 1) % poly.length]; a += x0 * z1 - x1 * z0 }
  return a / 2
}
function hull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (p.length < 3) return p
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lo = [], up = []
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q) }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q) }
  up.pop(); lo.pop()
  return lo.concat(up)
}
/** keep the half-plane where (p - m)·d <= 0 */
function clip(poly, mx, mz, dx, dz) {
  const out = []
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]
    const da = (a[0] - mx) * dx + (a[1] - mz) * dz, db = (b[0] - mx) * dx + (b[1] - mz) * dz
    if (da <= 0) out.push(a)
    if ((da <= 0) !== (db <= 0)) { const t = da / (da - db); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]) }
  }
  return out
}
function pointInConvex(poly, x, z) {
  let sign = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]
    const c = (b[0] - a[0]) * (z - a[1]) - (b[1] - a[1]) * (x - a[0])
    if (c !== 0) { if (sign === 0) sign = Math.sign(c); else if (Math.sign(c) !== sign) return false }
  }
  return true
}
function distToSeg(px, pz, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1]
  const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (pz - a[1]) * dz) / (dx * dx + dz * dz || 1)))
  return Math.hypot(px - a[0] - dx * t, pz - a[1] - dz * t)
}

/** A convex ice-floe outline. opts: { r = 2.2, n = 9, stretch = 1.25 (x), jitter = 0.22 } */
export function floeOutline(seed, { r = 2.2, n = 9, stretch = 1.25, jitter = 0.22 } = {}) {
  const R = rng(seed)
  const pts = []
  const a0 = R() * Math.PI * 2
  for (let i = 0; i < n; i++) {
    const a = a0 + (i + (R() - 0.5) * 0.55) / n * Math.PI * 2
    const rr = r * (1 - jitter / 2 + R() * jitter)
    pts.push([Math.cos(a) * rr * stretch, Math.sin(a) * rr])
  }
  let h = hull(pts)
  if (area(h) < 0) h = h.reverse()
  return h
}

/** Voronoi pre-fracture of a convex polygon. Seeds are spread along a "keel line" through the floe so the crack reads
 *  as the keel's cut. opts: { count = 6, angle (rad, keel direction), seeds ([[x,z]] to use instead) }.
 *  → [{ poly: [[x,z],…] relative to (cx, cz), cx, cz, crack: [bool] per edge (true = fresh crack face, not the old rim) }] */
export function fracture(poly, seed, { count = 6, angle = null, seeds: given = null } = {}) {
  const R = rng(seed ^ 0x5bd1e995)
  let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity
  for (const [x, z] of poly) { minx = Math.min(minx, x); maxx = Math.max(maxx, x); minz = Math.min(minz, z); maxz = Math.max(maxz, z) }
  const [ccx, ccz] = centroid(poly)
  const ang = angle ?? R() * Math.PI
  const ux = Math.cos(ang), uz = Math.sin(ang)
  const seeds = given ? given.filter(([x, z]) => pointInConvex(poly, x, z)) : []
  let guard = given ? 1e9 : 0
  while (seeds.length < count && guard++ < 500) {
    // half the seeds hug the keel line on alternating sides, the rest anywhere: long cut + a few side cracks
    let x, z
    if (seeds.length < Math.ceil(count * 0.6)) {
      const t = (R() - 0.5) * Math.max(maxx - minx, maxz - minz)
      const side = seeds.length % 2 ? 1 : -1
      const off = side * (0.35 + R() * 0.6)
      x = ccx + ux * t - uz * off; z = ccz + uz * t + ux * off
    } else { x = minx + R() * (maxx - minx); z = minz + R() * (maxz - minz) }
    if (!pointInConvex(poly, x, z)) continue
    if (seeds.some((s) => Math.hypot(s[0] - x, s[1] - z) < 0.55)) continue
    seeds.push([x, z])
  }
  const pieces = []
  for (let i = 0; i < seeds.length; i++) {
    let cell = poly.slice()
    for (let j = 0; j < seeds.length && cell.length >= 3; j++) {
      if (i === j) continue
      const [ax, az] = seeds[i], [bx, bz] = seeds[j]
      cell = clip(cell, (ax + bx) / 2, (az + bz) / 2, bx - ax, bz - az)
    }
    if (cell.length < 3 || Math.abs(area(cell)) < 0.05) continue
    if (area(cell) < 0) cell.reverse()
    const [cx, cz] = centroid(cell)
    const crack = cell.map((a, k) => {
      const b = cell[(k + 1) % cell.length]
      const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2
      let d = Infinity
      for (let e = 0; e < poly.length; e++) d = Math.min(d, distToSeg(mx, mz, poly[e], poly[(e + 1) % poly.length]))
      return d > 1e-3
    })
    pieces.push({ poly: cell.map(([x, z]) => [x - cx, z - cz]), cx, cz, crack })
  }
  return pieces
}

/** Pack ice: a Voronoi mosaic of a jittered grid over [x0,x1]×[z0,z1], every cell shrunk by a small gap (the dark cracks).
 *  opts: { cell = 3.3, gap = [0.08, 0.3], drop = 0 (chance a cell is open water), keep(x, z) → bool, h = [0.22, 0.42] }
 *  → [{ poly (local), x, z, rot: 0, h, seed }] ready for mergeFloes. */
export function voronoiMosaic(x0, x1, z0, z1, seed, { cell = 3.3, gap = [0.05, 0.2], drop = 0, keep = null, h = [0.22, 0.42] } = {}) {
  // the jittered grid is global (hashed by cell index), so neighbouring chunks of the same band tile without overlaps
  const site = (i, k) => {
    const r = rng(hashSeed(seed + ':' + i + ':' + k))
    return [(i + 0.12 + r() * 0.76 + (k & 1) * 0.5) * cell, (k + 0.12 + r() * 0.76) * cell, r]
  }
  const i0 = Math.floor(x0 / cell) - 1, i1 = Math.ceil(x1 / cell) + 1
  const k0 = Math.floor(z0 / cell) - 1, k1 = Math.ceil(z1 / cell) + 1
  const out = []
  for (let i = i0; i <= i1; i++) for (let k = k0; k <= k1; k++) {
    const [sx, sz, R] = site(i, k)
    if (sx < x0 || sx >= x1 || sz < z0 - cell * 0.5 || sz > z1 + cell * 0.5) continue
    if (keep && !keep(sx, sz)) continue
    const roll = R()
    if (roll < drop) continue
    const r = cell * 1.8
    let poly = [[sx - r, sz - r], [sx + r, sz - r], [sx + r, sz + r], [sx - r, sz + r]]
    for (let di = -2; di <= 2 && poly.length >= 3; di++) for (let dk = -2; dk <= 2; dk++) {
      if (!di && !dk) continue
      const [nx2, nz2] = site(i + di, k + dk)
      poly = clip(poly, (sx + nx2) / 2, (sz + nz2) / 2, nx2 - sx, nz2 - sz)
      if (poly.length < 3) break
    }
    if (poly.length >= 3) poly = clip(poly, 0, z0, 0, -1)
    if (poly.length >= 3) poly = clip(poly, 0, z1, 0, 1)
    if (poly.length < 3 || Math.abs(area(poly)) < 0.4) continue
    if (area(poly) < 0) poly.reverse()
    const [cx, cz] = centroid(poly)
    let mr = 0
    for (const [x, z] of poly) mr += Math.hypot(x - cx, z - cz)
    mr /= poly.length
    const g = gap[0] + R() * (gap[1] - gap[0])
    const f = Math.max(0.3, 1 - g / mr)
    out.push({ poly: poly.map(([x, z]) => [(x - cx) * f, (z - cz) * f]), x: cx, z: cz, rot: 0, h: h[0] + R() * (h[1] - h[0]), seed: Math.floor(R() * 1e9) })
  }
  return out
}

// ── floe geometry ───────────────────────────────────────
const _c = new THREE.Color()
function rgb(hex) { _c.set(hex); return [_c.r, _c.g, _c.b] }
function lerp3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t] }

/**
 * Build one floe. poly in local coords (around 0,0). opts:
 *   h      top height above the water (thickness shown)            default 0.6
 *   depth  how far the walls go under water                       default 0.45
 *   rim    bevel width (the thin cold rim)                         default 0.13
 *   drop   bevel drop                                              default 0.1
 *   seed   facet jitter seed
 *   crack  [bool] per edge: fresh crack face (darker, no bevel highlight)
 *   kind   'ice' | 'slab' | 'practice'
 *   facets true → mid ring for a faceted top (off for small pieces)
 *   waterline  true → add the waterline loop to the outline
 * → { geometry, lines: Float32Array (x,y,z pairs), h }
 */
export function buildFloe(poly, { h = 0.6, depth = 0.45, rim = 0.13, drop = 0.1, seed = 1, crack = null, kind = 'ice', facets = true, waterline = true } = {}) {
  const R = rng(seed)
  const n = poly.length
  const [cx, cz] = centroid(poly)
  const slab = kind === 'slab'
  const cTop = rgb(slab ? COLORS.slabTop : kind === 'practice' ? COLORS.practiceTop : COLORS.top)
  const cTopShade = rgb(slab ? 0xA7B5BD : COLORS.topShade)
  const cRim = rgb(slab ? 0x9AA9B2 : COLORS.rim)
  const cSide = rgb(slab ? COLORS.slabSide : COLORS.side)
  const cSideLow = rgb(slab ? 0x6F808B : COLORS.sideLow)
  const cCrack = rgb(COLORS.crack)
  const rimW = Math.min(rim, 0.22 * Math.sqrt(Math.abs(area(poly))))
  const dropH = Math.min(drop, h * 0.45)
  const yRim = h - dropH
  const amp = slab ? 0.01 : Math.min(0.07, h * 0.08)
  // rings
  const P = poly.map(([x, z]) => [x, yRim, z])
  const Q = poly.map(([x, z]) => {
    const dx = x - cx, dz = z - cz, d = Math.hypot(dx, dz) || 1
    const s = Math.max(0.2, 1 - rimW / d)
    return [cx + dx * s, h + (R() - 0.5) * amp, cz + dz * s]
  })
  const useMid = facets && n >= 5 && !slab
  const M = useMid ? poly.map(([x, z]) => [cx + (x - cx) * 0.52, h + amp * 0.6 + R() * amp, cz + (z - cz) * 0.52]) : null
  const C = [cx, h + (useMid ? amp * 1.4 : amp * 0.5), cz]
  const pos = [], col = []
  const tri = (a, b, c, color, ox, oy, oz) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    if (nx * ox + ny * oy + nz * oz < 0) { const t = b; b = c; c = t }
    pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2])
    for (let k = 0; k < 3; k++) col.push(color[0], color[1], color[2])
  }
  const topCol = () => lerp3(cTop, cTopShade, R() * 0.85)
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    if (useMid) {
      tri(C, M[i], M[j], topCol(), 0, 1, 0)
      tri(M[i], Q[i], Q[j], topCol(), 0, 1, 0)
      tri(M[i], Q[j], M[j], topCol(), 0, 1, 0)
    } else tri(C, Q[i], Q[j], topCol(), 0, 1, 0)
    // bevel (rim) — outward + up
    const ex = (poly[i][0] + poly[j][0]) / 2 - cx, ez = (poly[i][1] + poly[j][1]) / 2 - cz
    const isCrack = crack && crack[i]
    const rimC = isCrack ? lerp3(cCrack, cRim, 0.45) : cRim
    tri(Q[i], P[i], P[j], rimC, ex, 0.6, ez)
    tri(Q[i], P[j], Q[j], rimC, ex, 0.6, ez)
    // walls
    const Bi = [poly[i][0], -depth, poly[i][1]], Bj = [poly[j][0], -depth, poly[j][1]]
    const wall = isCrack ? cCrack : lerp3(cSide, cSideLow, R() * 0.35)
    tri(P[i], Bi, Bj, wall, ex, 0, ez)
    tri(P[i], Bj, P[j], wall, ex, 0, ez)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
  // outline: inner rim loop, outer rim loop, vertical corners down to the water, waterline
  const L = []
  const seg = (a, b) => L.push(a[0], a[1], a[2], b[0], b[1], b[2])
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    seg(Q[i], Q[j]); seg(P[i], P[j]); seg(P[i], [poly[i][0], 0.0, poly[i][1]])
    if (waterline) seg([poly[i][0], 0.012, poly[i][1]], [poly[j][0], 0.012, poly[j][1]])
  }
  return { geometry, lines: new Float32Array(L), h }
}

// ── materials (cached) ──────────────────────────────────
let _iceMat = null
export function iceMaterial() {
  return _iceMat || (_iceMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }))
}
const _lineMats = new Map()
export function lineMaterial(color = COLORS.arctic, opacity = 0.5) {
  const k = color + ':' + opacity
  if (!_lineMats.has(k)) _lineMats.set(k, new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity, depthWrite: false }))
  return _lineMats.get(k)
}

/** One floe as an object: { group, mesh, outline }. group.userData.setThickness(h) rebuilds when the bounty changes. */
export function floeObject(poly, opts = {}) {
  const group = new THREE.Group()
  const mat = opts.material || iceMaterial()
  const lmat = opts.lineMaterial || lineMaterial(opts.lineColor ?? COLORS.arctic, opts.lineOpacity ?? 0.55)
  let built = buildFloe(poly, opts)
  const mesh = new THREE.Mesh(built.geometry, mat)
  const lg = new THREE.BufferGeometry()
  lg.setAttribute('position', new THREE.BufferAttribute(built.lines, 3))
  const outline = new THREE.LineSegments(lg, lmat)
  outline.renderOrder = 2
  group.add(mesh, outline)
  group.userData.h = built.h
  group.userData.rebuild = (h, more = {}) => {
    opts = { ...opts, ...more, h }
    const b = buildFloe(poly, opts)
    mesh.geometry.dispose(); mesh.geometry = b.geometry
    outline.geometry.dispose()
    const g2 = new THREE.BufferGeometry(); g2.setAttribute('position', new THREE.BufferAttribute(b.lines, 3))
    outline.geometry = g2
    group.userData.h = h
  }
  return { group, mesh, outline }
}

/** Merge many static floes into one mesh + one outline. list: [{ poly, x, z, rot, h, seed, kind }] */
export function mergeFloes(list, { lineColor = COLORS.arctic, lineOpacity = 0.32, material = null } = {}) {
  const pos = [], col = [], lin = []
  const v = new THREE.Vector3()
  for (const f of list) {
    const b = buildFloe(f.poly, { h: f.h ?? 0.35, seed: f.seed, kind: f.kind || 'ice', facets: f.facets ?? true, depth: 0.35, rim: f.rim ?? 0.12, drop: f.drop ?? 0.08 })
    const c = Math.cos(f.rot || 0), s = Math.sin(f.rot || 0)
    const p = b.geometry.attributes.position.array, cc = b.geometry.attributes.color.array
    for (let i = 0; i < p.length; i += 3) {
      v.set(p[i] * c - p[i + 2] * s + f.x, p[i + 1], p[i] * s + p[i + 2] * c + f.z)
      pos.push(v.x, v.y, v.z)
    }
    for (let i = 0; i < cc.length; i++) col.push(cc[i])
    for (let i = 0; i < b.lines.length; i += 3) lin.push(b.lines[i] * c - b.lines[i + 2] * s + f.x, b.lines[i + 1], b.lines[i] * s + b.lines[i + 2] * c + f.z)
    b.geometry.dispose()
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  g.computeVertexNormals(); g.computeBoundingSphere()
  const lg = new THREE.BufferGeometry()
  lg.setAttribute('position', new THREE.Float32BufferAttribute(lin, 3))
  lg.computeBoundingSphere()
  const mesh = new THREE.Mesh(g, material || iceMaterial())
  const outline = new THREE.LineSegments(lg, lineMaterial(lineColor, lineOpacity))
  outline.renderOrder = 2
  return { mesh, outline }
}

/** Live bounty (ETH) → thickness above water. 0 → 0.4 · 0.005 → 0.67 · 0.05 → 1.35 · 0.5 → 2.2 · cap 2.6 */
export function thicknessFor(loadEth) {
  const e = Math.max(0, Number(loadEth) || 0)
  return Math.min(2.6, 0.4 + 0.9 * Math.log10(1 + e * 200))
}

// ── water ───────────────────────────────────────────────
/** Flat water with contour-line ripples (a slow, simple pattern) and expanding rings behind the ship.
 *  uniforms: uTime, uShip (vec3: x, z, speed), uRings (vec4[6]: x, z, startTime, strength) for local splashes. */
export function waterMaterial({ reduced = false } = {}) {
  const uniforms = {
    uTime: { value: 0 },
    uShip: { value: new THREE.Vector3(0, 0, 0) },
    uRings: { value: Array.from({ length: 6 }, () => new THREE.Vector4(0, 0, -99, 0)) },
    uDeep: { value: new THREE.Color(COLORS.waterDeep) },
    uMid: { value: new THREE.Color(COLORS.waterMid) },
    uLine: { value: new THREE.Color(COLORS.waterLine) },
  }
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */`
      varying vec2 vP;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vP = w.xz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime; uniform vec3 uShip; uniform vec4 uRings[6];
      uniform vec3 uDeep; uniform vec3 uMid; uniform vec3 uLine;
      varying vec2 vP;
      float band(float v, float k) {            // thin anti-aliased contour line of v every 1/k
        float f = v * k; float w = fwidth(f) * 1.1;
        float d = abs(fract(f) - 0.5);
        return smoothstep(0.5 - w * 1.6, 0.5 - w * 0.2, d);
      }
      void main() {
        vec2 p = vP;
        float t = uTime;
        // large slow swell for the base tone
        float sw = sin(p.x * 0.11 + t * 0.05) * 0.5 + sin(p.y * 0.23 - p.x * 0.05 + 1.7) * 0.5;
        vec3 col = mix(uDeep, uMid, 0.55 + 0.25 * sw);
        // ripples: contour lines of a warped sine field
        float n = sin(p.x * 0.42 + t * 0.35 + sin(p.y * 0.55 + t * 0.21) * 1.4)
                + sin(p.y * 0.83 - t * 0.27 + sin(p.x * 0.31 - t * 0.12) * 1.1) * 0.7;
        float r = band(n, 1.15) * 0.42;
        // ship wake: rings expanding behind the hull while it moves
        vec2 d = p - uShip.xy;
        float dist = length(d);
        float behind = smoothstep(0.5, -2.0, d.x * sign(uShip.z + 1e-4));
        float wake = band(dist - t * 2.4, 0.6) * smoothstep(7.0, 2.0, dist) * behind * clamp(abs(uShip.z) * 0.25, 0.0, 1.0);
        r = max(r, wake * 0.5);
        // local splash rings (freeze-in, crack, commit)
        for (int i = 0; i < 6; i++) {
          vec4 R = uRings[i];
          float age = t - R.z;
          if (age > 0.0 && age < 4.0) {
            float dd = length(p - R.xy);
            float ring = band(dd - age * 2.2, 1.6) * smoothstep(4.0, 0.0, age) * smoothstep(age * 2.2 + 3.0, age * 2.2, dd) * R.w;
            r = max(r, ring);
          }
        }
        col = mix(col, uLine, clamp(r, 0.0, 1.0));
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  })
  material.extensions = { derivatives: true }
  if (reduced) uniforms.uTime.value = 12.5
  return { material, uniforms }
}

// ── rapier ──────────────────────────────────────────────
export const RAPIER_URL = '/assets/vendor/rapier/rapier3d-compat-0.12.0.es.js'
let _rapier = null
export function loadRapier(url = RAPIER_URL) {
  if (_rapier) return _rapier
  _rapier = (async () => {
    try {
      const mod = await import(url)
      const R = mod.default || mod
      await R.init()
      return R
    } catch (e) { console.warn('[keelcrack] rapier unavailable, using the simple drift fallback', e); return null }
  })()
  return _rapier
}

/**
 * Floating bodies locked to the water plane: they move in x/z and turn about y only.
 * With rapier (R) they collide with each other, with the walls and with a kinematic hull; without it (R = null)
 * a tiny integrator keeps the same API (no collisions).
 *
 * const w = planarWorld(R)
 *   w.wall(x, z, halfX, halfZ)                       fixed box (e.g. the pack-ice edges of the water band)
 *   const b = w.body(poly, { x, z, rot, density, damping, angularDamping, frozen })
 *       b.x b.z b.rot (read after step) · b.home = { x, z, k } soft spring that keeps the piece near its slot
 *       b.impulse(ix, iz, px?, pz?) · b.freeze(bool) · b.remove()
 *   const k = w.kinematic(poly, { x, z, rot })       moved with k.moveTo(x, z, rot)
 *   w.step(dt, t)                                    fixed 60 Hz sub-steps; applies home springs + a gentle current
 */
export function planarWorld(R) {
  const bodies = new Set()
  const kinematics = new Set()
  let world = null
  if (R) {
    world = new R.World({ x: 0, y: 0, z: 0 })
    world.timestep = 1 / 60
  }
  const hullPoints = (poly, y = 0.35) => {
    const a = new Float32Array(poly.length * 6)
    poly.forEach(([x, z], i) => { a.set([x, -y, z, x, y, z], i * 6) })
    return a
  }
  const api = {
    physics: !!R,
    wall(x, z, hx, hz) {
      if (!world) return
      const b = world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(x, 0, z))
      world.createCollider(R.ColliderDesc.cuboid(hx, 1, hz).setFriction(0.2), b)
    },
    body(poly, { x = 0, z = 0, rot = 0, density = 0.9, damping = 0.9, angularDamping = 1.2, frozen = false } = {}) {
      const b = { x, z, rot, vx: 0, vz: 0, w: 0, home: null, frozen, poly, rb: null, damping, angularDamping, seed: Math.random() * 100 }
      if (world) {
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot)
        const desc = (frozen ? R.RigidBodyDesc.kinematicPositionBased() : R.RigidBodyDesc.dynamic())
          .setTranslation(x, 0, z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
          .enabledTranslations(true, false, true).enabledRotations(false, true, false)
          .setLinearDamping(damping).setAngularDamping(angularDamping)
        b.rb = world.createRigidBody(desc)
        const cd = R.ColliderDesc.convexHull(hullPoints(poly)) || R.ColliderDesc.ball(0.5)
        world.createCollider(cd.setDensity(density).setFriction(0.15).setRestitution(0.1), b.rb)
      }
      b.impulse = (ix, iz, px, pz) => {
        if (b.frozen) return
        if (b.rb) {
          if (px != null) b.rb.applyImpulseAtPoint({ x: ix, y: 0, z: iz }, { x: px, y: 0, z: pz }, true)
          else b.rb.applyImpulse({ x: ix, y: 0, z: iz }, true)
        } else {
          const m = Math.max(0.3, Math.abs(area(poly)) * density * 0.7)
          b.vx += ix / m; b.vz += iz / m
          if (px != null) b.w += ((px - b.x) * iz - (pz - b.z) * ix) / (m * 1.6)
        }
      }
      b.freeze = (f) => {
        if (b.frozen === f) return
        b.frozen = f
        if (b.rb) b.rb.setBodyType(f ? R.RigidBodyType.KinematicPositionBased : R.RigidBodyType.Dynamic, true)
      }
      b.place = (nx, nz, nr = b.rot) => {
        b.x = nx; b.z = nz; b.rot = nr; b.vx = b.vz = b.w = 0
        if (b.rb) {
          const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), nr)
          b.rb.setTranslation({ x: nx, y: 0, z: nz }, true); b.rb.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true)
          b.rb.setLinvel({ x: 0, y: 0, z: 0 }, true); b.rb.setAngvel({ x: 0, y: 0, z: 0 }, true)
        }
      }
      b.remove = () => { bodies.delete(b); if (b.rb && world) world.removeRigidBody(b.rb); b.rb = null }
      bodies.add(b)
      return b
    },
    kinematic(poly, { x = 0, z = 0, rot = 0 } = {}) {
      const k = { x, z, rot, rb: null }
      if (world) {
        k.rb = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(x, 0, z))
        world.createCollider(R.ColliderDesc.convexHull(hullPoints(poly, 0.6)).setFriction(0.1), k.rb)
      }
      k.moveTo = (nx, nz, nr = k.rot) => {
        k.x = nx; k.z = nz; k.rot = nr
        if (k.rb) {
          k.rb.setNextKinematicTranslation({ x: nx, y: 0, z: nz })
          const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), nr)
          k.rb.setNextKinematicRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        }
      }
      kinematics.add(k)
      return k
    },
    acc: 0,
    step(dt, t = 0) {
      api.acc = Math.min(api.acc + dt, 0.1)
      while (api.acc >= 1 / 60) {
        api.acc -= 1 / 60
        const h = 1 / 60
        for (const b of bodies) {
          if (b.frozen) continue
          // gentle current + the home spring (keeps a cracked floe's pieces readable in their hour slot)
          let fx = Math.sin(t * 0.21 + b.seed) * 0.05, fz = Math.cos(t * 0.17 + b.seed * 1.3) * 0.05
          if (b.home) { fx += (b.home.x - b.x) * b.home.k; fz += (b.home.z - b.z) * b.home.k }
          if (b.rb) {
            const m = b.rb.mass()
            b.rb.resetForces(false)
            b.rb.addForce({ x: fx * m, y: 0, z: fz * m }, true)
            if (b.home && b.home.rot != null) {
              b.rb.resetTorques(false)
              b.rb.addTorque({ x: 0, y: -Math.sin(b.rot - b.home.rot) * b.home.k * m * 0.6, z: 0 }, true)
            }
          } else {
            b.vx += fx * h; b.vz += fz * h
            if (b.home && b.home.rot != null) b.w += -Math.sin(b.rot - b.home.rot) * b.home.k * 0.6 * h
            const dl = Math.exp(-b.damping * h), da = Math.exp(-b.angularDamping * h)
            b.vx *= dl; b.vz *= dl; b.w *= da
            b.x += b.vx * h; b.z += b.vz * h; b.rot += b.w * h
          }
        }
        t += h
        if (world) world.step()
      }
      if (world) {
        for (const b of bodies) {
          if (!b.rb) continue
          const p = b.rb.translation(), q = b.rb.rotation()
          b.x = p.x; b.z = p.z
          b.rot = 2 * Math.atan2(q.y, q.w)
        }
      }
    },
    size: () => bodies.size,
  }
  return api
}
