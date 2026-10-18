// KEELCRACK shared3d/stage.js — one WebGLRenderer, several views (owner: LANDING; APP imports, never edits).
//
// The landing uses one full-screen view. APP pages (board cards) can draw many small floe previews with ONE WebGL context:
// a fixed, pointer-transparent canvas covers the window and each view renders into its element's rectangle with
// setViewport/setScissor. Offscreen views are skipped; the loop sleeps while nothing is visible or the tab is hidden.
//
//   import { createStage, mountFloePreview } from '/shared3d/stage.js'
//   const stage = createStage()                         // fixed overlay canvas (or createStage({ canvas, fullscreen:false }))
//   const v = stage.add({ el, scene, camera, update(dt, t, view) {} , fit(w, h, view) {} })   // returns the view; v.remove()
//   mountFloePreview(el, qitem, { stage })              // small floe for a question card (status/thickness from the QItem)
//
// createStage options: { canvas, dpr = min(devicePixelRatio, 2), background = null (transparent), antialias = true,
//                        overlay = true (fixed full-window canvas behind nothing, pointer-events none, z-index 0) }
// stage: { renderer, canvas, add(view), remove(view), render(), start(), stop(), reduced, views }
import * as THREE from 'three'
import { COLORS, floeOutline, fracture, floeObject, thicknessFor, waterMaterial, hashSeed } from './ice.js'

export const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

export function createStage({ canvas = null, dpr = null, background = null, antialias = true, overlay = true } = {}) {
  if (!canvas) {
    canvas = document.createElement('canvas')
    canvas.className = 'kc-stage'
    if (overlay) Object.assign(canvas.style, { position: 'fixed', inset: '0', width: '100vw', height: '100vh', pointerEvents: 'none', zIndex: '0' })
    document.body.prepend(canvas)
  }
  const renderer = new THREE.WebGLRenderer({ canvas, antialias, alpha: background == null, powerPreference: 'high-performance' })
  renderer.setPixelRatio(dpr ?? Math.min(window.devicePixelRatio || 1, 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  if (background != null) renderer.setClearColor(background, 1); else renderer.setClearColor(0x000000, 0)
  renderer.setScissorTest(true)
  const views = new Set()
  let raf = 0, running = false, t = 0, lastT = performance.now()
  const reduced = reducedMotion()

  function size() {
    const w = canvas.clientWidth, h = canvas.clientHeight
    if (canvas.width !== Math.floor(w * renderer.getPixelRatio()) || canvas.height !== Math.floor(h * renderer.getPixelRatio())) renderer.setSize(w, h, false)
    return [w, h]
  }

  function render() {
    const [W, H] = size()
    const cr = canvas.getBoundingClientRect()
    renderer.setScissorTest(false); renderer.clear(); renderer.setScissorTest(true)
    const nowT = performance.now()
    const dt = Math.min((nowT - lastT) / 1000, 0.05)
    lastT = nowT
    t += dt
    let drew = 0
    for (const v of views) {
      const r = v.el === canvas ? cr : v.el.getBoundingClientRect()
      const x = r.left - cr.left, y = r.top - cr.top, w = r.width, h = r.height
      if (w < 2 || h < 2 || x + w < 0 || y + h < 0 || x > W || y > H) { v.onscreen = false; continue }
      v.onscreen = true
      if (v._w !== w || v._h !== h) { v._w = w; v._h = h; v.fit?.(w, h, v) }
      v.update?.(dt, t, v)
      const by = H - (y + h)
      renderer.setViewport(x, by, w, h); renderer.setScissor(x, by, w, h)
      renderer.render(v.scene, v.camera)
      drew++
    }
    return drew
  }
  function loop() {
    raf = requestAnimationFrame(loop)
    if (document.hidden) return
    render()
  }
  const stage = {
    renderer, canvas, views, reduced,
    add(view) { views.add(view); view.remove = () => stage.remove(view); if (!running) stage.start(); return view },
    remove(view) { views.delete(view) },
    render,
    start() { if (running) return; running = true; lastT = performance.now(); loop() },
    stop() { running = false; cancelAnimationFrame(raf) },
  }
  return stage
}

// ── small floe preview for APP cards ────────────────────
let _shared = null
/** A small isometric floe for a question card. q = QItem ({ id, status, loadEth }). Returns { view, update(q), remove() }.
 *  status: 'open' → whole floe, thickness from loadEth · 'solved' → split pieces · 'unsolved' → grey slab. */
export function mountFloePreview(el, q, { stage = null } = {}) {
  stage = stage || _shared || (_shared = createStage())
  const scene = new THREE.Scene()
  scene.add(new THREE.HemisphereLight(0xffffff, 0x6F9DB8, 1.75))
  const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(-6, 12, 7); scene.add(sun)
  const water = waterMaterial({ reduced: stage.reduced })
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2), water.material)
  scene.add(sea)
  const cam = new THREE.OrthographicCamera(-4, 4, 3, -3, 0.1, 100)
  cam.position.set(0, 9, 8); cam.lookAt(0, 0, 0)
  let root = new THREE.Group(); scene.add(root)
  const seed = hashSeed('q' + (q?.id ?? 0))
  const poly = floeOutline(seed, { r: 2.1, n: 9 })
  function build(item) {
    scene.remove(root); root = new THREE.Group(); scene.add(root)
    const st = item?.status || 'open'
    const h = st === 'unsolved' ? 0.14 : thicknessFor(item?.loadEth)
    if (st === 'solved') {
      for (const p of fracture(poly, seed, { count: 6 })) {
        const o = floeObject(p.poly, { h, seed: seed + Math.round(p.cx * 100), crack: p.crack, facets: false })
        const push = 0.35
        o.group.position.set(p.cx * (1 + push), 0, p.cz * (1 + push))
        o.group.rotation.y = (p.cx - p.cz) * 0.08
        root.add(o.group)
      }
    } else {
      const o = floeObject(poly, { h, seed, kind: st === 'unsolved' ? 'slab' : 'ice', lineColor: st === 'unsolved' ? COLORS.dim : COLORS.arctic })
      root.add(o.group)
    }
  }
  build(q)
  const view = stage.add({
    el, scene, camera: cam,
    fit(w, h) { const a = w / h, H = 7.2; cam.left = -H * a / 2; cam.right = H * a / 2; cam.top = H / 2; cam.bottom = -H / 2; cam.updateProjectionMatrix() },
    update(dt, t) { if (!stage.reduced) { water.uniforms.uTime.value = t; root.rotation.y = Math.sin(t * 0.25) * 0.15 } },
  })
  return { view, update: build, remove() { view.remove() } }
}
