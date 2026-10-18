// KEELCRACK landing · main.js — data, the gate, panning, callouts, buoys, the side panel and the time ruler.
// Reads /api/state, /api/questions, /api/leaderboard?by=model and SSE /api/live through /shared/api.js (which falls back to
// the DEMO fixtures when the server is unreachable). The 3D field lives in field.js.
import { init as initSite, LEGAL, ICON, copyText, toast } from '/shared/site.js'
import { api, live, isDemo, isPreview, statusOf, qPage, API } from '/shared/api.js'
import { fmtEth, fmtSolve, fmtLeft, fmtCountdown, tierRoman, esc, shortAddr, fmtInt, toMs, fmtTime } from '/shared/fmt.js'
import { createField, HOUR, SLOT, GATE } from './field.js'

const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]
const html = document.documentElement
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const isWide = () => innerWidth > 1000
const isShort = () => innerHeight <= 560
// the selected floe opens in a side panel on desktop and on short landscape screens (a bottom sheet there would cover
// the whole field); portrait phones and tablets get the bottom sheet
const isDocked = () => isWide() || (isShort() && innerWidth > 640)
const isPhone = () => innerWidth <= 760
const smallCo = () => isPhone() || isShort()
const SVGNS = 'http://www.w3.org/2000/svg'

initSite({ nav: '#nav', footer: false, overlay: true })
document.querySelectorAll('.buoy [data-link="x"]').forEach((a) => { if (!a.innerHTML.trim()) a.innerHTML = ICON.x })
document.querySelectorAll('.buoy [data-link="telegram"]').forEach((a) => { if (!a.innerHTML.trim()) a.innerHTML = ICON.tg })

const sea = $('#main')
const canvas = $('#sea')
const svg = $('#leaders')
const panel = $('#panel')
const S = { items: [], byId: new Map(), state: null, models: null, selected: null, practice: false, mode: 'connecting', lastLoad: 0, hour: Math.floor(Date.now() / HOUR) }
const pan = { x: GATE.view, target: GATE.view, vel: 0, drag: null, moved: false, touched: false }
let gateMode = html.classList.contains('gate-on') ? 'closed' : 'off'

// ── the field ──────────────────────────────────────────
let field
try { field = createField({ canvas, reduced }) } catch (e) {
  console.error('[keelcrack] WebGL unavailable', e)
  sea.classList.add('failed', 'ready')
  html.classList.remove('gate-on'); html.classList.add('gate-off', 'nogl')
}

// ── helpers ────────────────────────────────────────────
function svgEl(tag, cls) { const e = document.createElementNS(SVGNS, tag); if (cls) e.setAttribute('class', cls); svg.append(e); return e }
function setLine(l, x1, y1, x2, y2) { l.setAttribute('x1', x1.toFixed(1)); l.setAttribute('y1', y1.toFixed(1)); l.setAttribute('x2', x2.toFixed(1)); l.setAttribute('y2', y2.toFixed(1)) }
function show(el, on) { if (el._on !== on) { el._on = on; el.style.visibility = on ? '' : 'hidden' } }
const hourLabel = (h) => new Date(h * HOUR).toISOString().slice(11, 16)
const ethOf = (q) => (q.loadEth != null ? Number(q.loadEth) : Number(q.loadWei || 0) / 1e18)

function insets() {
  const nav = $('.kc-nav'), bar = $('.kc-preview'), mbar = $('.kc-mbar')
  const top = (nav?.offsetHeight || 60) + (bar && bar.isConnected ? bar.offsetHeight : 0)
  const mb = mbar && getComputedStyle(mbar).display !== 'none' ? mbar.offsetHeight : 0
  const panelOn = isDocked() && S.selected != null && gateMode === 'off'
  return { top, bottom: 54 + mb, right: panelOn ? (panel.offsetWidth || (isWide() ? 330 : 290)) + (isWide() ? 28 : 16) : 0, mbar: mb }
}
let IN = insets()
function applyInsets() {
  IN = insets()
  if (!field) return
  field.view.insetTop = IN.top
  field.view.insetBottom = IN.bottom
  field.view.insetRight = IN.right
}

// ── data ───────────────────────────────────────────────
// Pre-launch the server serves its hourly preview questions (real RC data, `preview: true`, bounty 0): they are practice
// questions until launch and the field labels them so.
const mapQ = (q) => ({ ...q, status: q.preview ? 'practice' : statusOf(q), hour: Math.floor(toMs(q.postedAt) / HOUR) })
const mapP = (p) => {
  const t = toMs(p.window?.toTime) || Date.now()
  return { id: p.pid, pid: p.pid, tier: p.tier, title: p.title, prompt: p.prompt, window: p.window, answerFormat: p.answerFormat, unit: p.unit, status: 'practice', loadEth: 0, hour: Math.floor(t / HOUR), postedAt: t, commits: 0, reveals: 0 }
}

// Once the real server has answered, the landing reads it directly (with a timeout) and keeps the last good data through
// slow or failed requests, retrying with a backoff. api.js (and its DEMO fixtures) is used only while the server has never
// answered, so a short outage or a restart never swaps the real field for demo data.
const net = { real: false, fails: 0, retryT: 0, busy: null, again: false }
async function getJ(path, ms = 9000) {
  const ac = new AbortController()
  const to = setTimeout(() => ac.abort(), ms)
  try {
    const r = await fetch(API + path, { headers: { accept: 'application/json' }, signal: ac.signal, cache: 'no-store' })
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status })
    return await r.json()
  } finally { clearTimeout(to) }
}
async function from(path, viaApi) {
  if (isDemo() && !net.real) return viaApi()
  try { const d = await getJ(path); net.real = true; return d } catch (e) {
    if (net.real) throw e
    const d = await viaApi()
    if (!isDemo() && d) net.real = true
    return d
  }
}
function netFail(e) {
  net.fails++
  setMode()
  clearTimeout(net.retryT)
  net.retryT = setTimeout(() => load().catch(() => {}), Math.min(60000, 4000 * 2 ** (net.fails - 1)))
  console.warn('[keelcrack] server unreachable, keeping the last field', e?.message || e)
}

async function load() {
  if (net.busy) { net.again = true; return net.busy }
  net.busy = loadOnce().finally(() => { net.busy = null; if (net.again) { net.again = false; refreshSoon(250) } })
  return net.busy
}
async function loadOnce() {
  S.lastLoad = Date.now()
  let st, qs
  try {
    [st, qs] = await Promise.all([
      from('/api/state', () => api.state().catch(() => null)),
      from('/api/questions?status=all&limit=48', () => api.questions({ status: 'all', limit: 48 }).catch(() => ({ items: [] }))),
    ])
  } catch (e) { netFail(e); return }
  if (net.fails) { net.fails = 0; clearTimeout(net.retryT) }
  S.state = st || S.state
  let items = (qs?.items || []).map(mapQ)
  S.practice = false
  if (!items.length) {
    const p = await from('/api/practice', () => api.practice().catch(() => ({ items: [] }))).catch(() => ({ items: [] }))
    items = (p?.items || []).map(mapP)
    // practice windows can be older than the 48-hour field: keep the newest 48 hours of them, laid out by their window
    S.practice = items.length > 0
  }
  S.items = items
  S.byId = new Map(items.map((q) => [q.id, q]))
  if (field) {
    // keep the "Now" view at now when the hour rolls over (the skim ice moves one slot right)
    const atNow = gateMode === 'off' && field.layout.built && Math.abs(pan.target - nowX()) < SLOT * 0.75
    const events = field.setData({ items, nowMs: fieldNow() })
    for (const [type, rec] of events) {
      if (type === 'crack') { field.crack(rec.id); flash(rec.id) }
      else if (type === 'melt') field.melt(rec.id)
      else if (type === 'posted') { field.freezeIn(rec); flash(rec.id); if (gateMode === 'off') toast(`${rec.q.status === 'practice' ? 'New practice question' : 'New question'}: ${rec.q.title}`) }
      else if (type === 'pulse') field.pulse(rec.id)
    }
    if (atNow) panTo(nowX())
  }
  renderCallouts()
  renderRuler()
  fillBuoys()
  if (S.selected != null) { if (S.byId.has(S.selected)) renderPanel(); else select(null) }
  setMode()
}
async function loadModels() {
  const get = (range) => from(`/api/leaderboard?by=model&range=${range}`, () => api.leaderboard({ by: 'model', range }))
  try {
    let r = await get('7d')
    let range = '7d'
    if (!r?.items?.length) { r = await get('all'); range = 'all' }
    S.models = { items: (r?.items || []).filter((x) => x.key).slice(0, 5), range }
  } catch { if (!S.models) S.models = { items: [], range: '7d' } }
  fillModels()
}
let soonT = 0
function refreshSoon(ms = 1200) { clearTimeout(soonT); soonT = setTimeout(() => load().catch(console.warn), ms) }

function setMode(m) {
  if (m) S.mode = m
  const el = $('#r-mode')
  const mode = isDemo() && !net.real ? 'demo' : net.fails || S.mode === 'reconnecting' ? 'reconnecting' : S.state && isPreview(S.state) ? 'preview' : S.mode
  const label = mode === 'demo' ? 'demo data' : mode === 'preview' ? 'preview' : mode
  if (el.dataset.m === label) return
  el.dataset.m = label
  el.innerHTML = `<span class="dot ${mode === 'live' ? 'live' : mode === 'demo' || mode === 'reconnecting' ? 'warn' : ''}"></span><span>${esc(label)}</span>`
  el.title = mode === 'reconnecting' ? 'The server is not answering right now. The field keeps the last data and retries.' : ''
}

// ── callouts ───────────────────────────────────────────
const itemsBox = $('#items')
const callEls = new Map()   // id → { el, line, dot, w, h, mw, mh, mini }
let skimCo = null
function calloutHtml(q) {
  const st = q.status
  const stamp = st === 'solved' ? 'cracked' : st === 'unsolved' ? 'unsolved' : st === 'practice' ? 'practice' : 'open'
  let foot
  if (st === 'solved') foot = `<b>${esc(fmtSolve(q.solveSeconds))}</b><span class="st">${esc(q.winnerModel || shortAddr(q.winner || ''))}</span>`
  else if (st === 'unsolved') foot = `<span>no model cracked it</span>`
  else if (st === 'practice') foot = `<b>try it free</b><span class="st">bounty at launch</span>`
  else foot = `<b class="bounty">${esc(fmtEth(ethOf(q)))}</b><span class="st">${esc(fmtInt(q.commits || 0))} commit${q.commits === 1 ? '' : 's'}</span>`
  return `<span class="co-h"><span class="stamp">${stamp}</span><span class="id">Q${esc(String(q.id).replace(/^p/, ''))}</span><span class="tr">${tierRoman(q.tier)}</span><span class="hr">${hourLabel(q.hour)}</span></span>
    <span class="co-t">${esc(q.title)}</span><span class="co-b">${foot}</span>`
}
function calloutLabel(q) {
  const st = q.status
  const what = st === 'solved' ? `cracked in ${fmtSolve(q.solveSeconds)}` : st === 'unsolved' ? 'unsolved' : st === 'practice' ? 'practice question, bounty starts at launch' : `open, bounty ${fmtEth(ethOf(q))}`
  return `Question ${String(q.id).replace(/^p/, '')}, tier ${tierRoman(q.tier)}, ${hourLabel(q.hour)} UTC: ${q.title}. ${what}`
}
function renderCallouts() {
  const seen = new Set()
  for (const q of S.items) {
    if (!field?.floes.has(q.id)) continue
    seen.add(q.id)
    let c = callEls.get(q.id)
    if (!c) {
      const el = document.createElement('button')
      el.type = 'button'
      el.dataset.id = q.id
      const id = q.id
      // Enter / Space (click with detail 0) also moves focus into the panel; Esc brings it back
      el.addEventListener('click', (e) => { if (pan.moved) return; e.stopPropagation(); select(id, { center: true, focus: e.detail === 0 }) })
      el.addEventListener('focus', () => { c.focus = true; if (gateMode === 'off') panTo(field.floes.get(id)?.x0 ?? pan.target) })
      el.addEventListener('blur', () => { c.focus = false })
      itemsBox.append(el)
      c = { el, line: svgEl('line', 'fl'), dot: svgEl('circle', 'fl'), w: 0, h: 0, mw: 0, mh: 0, mini: false }
      c.dot.setAttribute('r', '3')
      callEls.set(q.id, c)
    }
    const key = q.status + ':' + q.loadEth + ':' + q.commits + ':' + q.winnerModel
    if (c.key !== key) {
      c.key = key
      c.el.className = `co ${q.status}${S.selected === q.id ? ' sel' : ''}${c.mini ? ' mini' : ''}`
      c.el.innerHTML = calloutHtml(q)
      c.el.setAttribute('aria-label', calloutLabel(q))
      c.w = 0; c.mw = 0
    }
  }
  for (const [id, c] of callEls) if (!seen.has(id)) { c.el.remove(); c.line.remove(); c.dot.remove(); callEls.delete(id) }
  if (!skimCo) {
    const el = document.createElement('div')
    el.className = 'co skim'
    itemsBox.append(el)
    skimCo = { el, line: svgEl('line', 'fl'), dot: svgEl('circle', 'fl'), w: 0, h: 0 }
    skimCo.dot.setAttribute('r', '3')
  }
  updateSkim()
  orderItems()
}
// DOM order = field order (left → right, oldest → newest, buoys in between), so Tab walks the field the way it reads;
// focusing anything pans the field to it.
function orderItems() {
  if (!field) return
  const L = field.layout
  const list = []
  buoyEls.forEach((el, i) => list.push([L.buoyX[i] ?? 0, el]))
  for (const [id, c] of callEls) list.push([field.floes.get(id)?.x0 ?? 0, c.el])
  if (skimCo) list.push([L.skimX, skimCo.el])
  list.sort((a, b) => a[0] - b[0])
  const want = list.map((x) => x[1])
  const have = [...itemsBox.children]
  if (want.length === have.length && want.every((el, i) => el === have[i])) return
  const act = document.activeElement
  for (const el of want) itemsBox.append(el)
  if (act && act !== document.activeElement && itemsBox.contains(act)) act.focus({ preventScroll: true })
}
// this hour's question is still being written: the server announces ~:00:45, but generating from live RC data can take a
// minute or two more. Until it lands (or 5 minutes pass: the hour was skipped) the skim ice keeps this hour's slot.
function pendingNow() {
  const now = Date.now(), h = Math.floor(now / HOUR)
  return now % HOUR < 300000 && S.items.some((q) => q.hour === h - 1) && !S.items.some((q) => q.hour === h)
}
function nextQuestionAt() {
  // the server's state.nextQuestionAt; once that passes without fresh state the label says "any moment" for two
  // minutes and then rolls on to the following hour
  const now = Date.now()
  if (pendingNow()) return now
  let n = S.state?.nextQuestionAt ? toMs(S.state.nextQuestionAt) : NaN
  if (!Number.isFinite(n)) n = (Math.floor(now / HOUR) + 1) * HOUR
  while (n < now - 120000) n += HOUR
  return n
}
function nextLeft() { return Math.max(0, Math.ceil((nextQuestionAt() - Date.now()) / 1000)) }
const nextText = (left) => (left > 0 ? fmtCountdown(left) : 'any moment')
// the field's "now" (which slot the skim ice sits in): it stays put until the hour's question has landed
function fieldNow() {
  const now = Date.now()
  if (pendingNow()) return Math.floor(now / HOUR) * HOUR - 1
  return Math.min(now, Math.floor(nextQuestionAt() / HOUR) * HOUR - 1)
}
function updateSkim() {
  if (!skimCo) return
  const next = nextQuestionAt(), left = nextLeft()
  const html = `<span class="co-h"><span class="stamp">freezing</span><span class="hr">${hourLabel(Math.floor(next / HOUR))}</span></span>
    <span class="co-t">Next question</span><span class="co-b"><b class="num">${left > 0 ? 'in ' : ''}${nextText(left)}</b>${S.practice || (S.state && isPreview(S.state)) ? '<span class="st">practice</span>' : ''}</span>`
  if (skimCo.html !== html) { skimCo.html = html; skimCo.el.innerHTML = html }
}
function flash(id) { const c = callEls.get(id); if (c) { c.el.classList.remove('fresh'); void c.el.offsetWidth; c.el.classList.add('fresh') } }

// ── side panel ─────────────────────────────────────────
function select(id, { center = false, open = true, refocus = false, focus = false } = {}) {
  if (id == null || !S.byId.has(id)) {
    const prev = S.selected
    const act = document.activeElement
    const lost = !act || act === document.body || panel.contains(act)
    S.selected = null; panel.classList.add('closed'); if (isDocked()) panel.hidden = true; field?.setSelected(null); markSel(); applyInsets()
    // keyboard: closing the panel from inside it puts focus back on the floe's callout
    if (refocus && lost && prev != null) callEls.get(prev)?.el.focus({ preventScroll: true })
    return
  }
  S.selected = id
  field?.setSelected(id)
  markSel()
  renderPanel()
  if (open) { panel.hidden = false; requestAnimationFrame(() => panel.classList.remove('closed')) }
  applyInsets()
  if (center && field) panTo(field.floes.get(id)?.x0 ?? pan.target)
  if (focus) panel.querySelector('h3')?.focus({ preventScroll: true })
}
function markSel() {
  for (const [id, c] of callEls) { const s = id === S.selected; c.el.classList.toggle('sel', s); c.line.classList.toggle('sel', s); c.dot.classList.toggle('sel', s) }
  $$('#r-marks i').forEach((i) => i.classList.toggle('sel', String(i.dataset.id) === String(S.selected)))
}
const ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 12h16M14 6l6 6-6 6"/></svg>'
function renderPanel() {
  const q = S.byId.get(S.selected)
  if (!q) return
  const st = q.status
  const pv = st === 'practice' && q.preview
  const stTag = st === 'solved' ? '<span class="tag solved">cracked</span>' : st === 'unsolved' ? '<span class="tag unsolved">unsolved</span>' : st === 'practice' ? '<span class="tag tier">practice</span>' : '<span class="tag open">open</span>'
  const w = q.window || {}
  let stats
  if (st === 'practice') {
    stats = `<div class="stat"><div class="k">Bounty</div><div class="v sm">starts at launch</div></div><div class="stat"><div class="k">Window</div><div class="v sm">${esc(hourLabel(q.hour - 1))}–${esc(hourLabel(q.hour))} UTC</div></div>`
    if (pv && q.closesAt) stats += `<div class="stat"><div class="k">Check</div><div class="v sm">free, no wallet</div></div><div class="stat"><div class="k">Working in</div><div class="v sm" data-p="clock">${esc(fmtLeft(q.closesAt))}</div></div>`
  } else stats = `<div class="stat"><div class="k">${st === 'open' ? 'Bounty' : st === 'solved' ? 'Paid' : 'Back to pool'}</div><div class="v ${st === 'unsolved' ? '' : 'bounty'}">${esc(fmtEth(ethOf(q), { unit: false }))}<small style="font:600 11px var(--sans);color:var(--dim)"> ETH</small></div></div>
      <div class="stat"><div class="k">${st === 'open' ? 'Closes in' : st === 'solved' ? 'Cracked in' : 'Closed'}</div><div class="v" data-p="clock">${esc(st === 'open' ? fmtLeft(q.closesAt) : st === 'solved' ? fmtSolve(q.solveSeconds) : 'after 24 h')}</div></div>
      <div class="stat"><div class="k">Commits</div><div class="v">${fmtInt(q.commits || 0)}</div></div>
      <div class="stat"><div class="k">Reveals</div><div class="v">${fmtInt(q.reveals || 0)}</div></div>`
  const rows = []
  if (w.fromBlock != null) rows.push(['Blocks', `${fmtInt(w.fromBlock)} – ${fmtInt(w.toBlock)}`])
  if (q.postedAt && (st !== 'practice' || pv)) rows.push([pv ? 'Written' : 'Posted', fmtTime(q.postedAt)])
  if (q.answerFormat) rows.push(['Answer', q.answerFormat + (q.unit ? ` (${q.unit})` : '')])
  if (st === 'solved') rows.push(['Model', q.winnerModel || 'undeclared'], ['Solver', `<span class="mono">${esc(shortAddr(q.winner || ''))}</span>`])
  const main = st === 'open' ? ['Crack this question', qPage(q.id)] : st === 'practice' ? ['Practice it, no wallet', '/practice/'] : ['See the working', qPage(q.id)]
  const html = `<div class="grip" aria-hidden="true"></div>
    <div class="side-h">${stTag}<span class="tag tier">Tier ${tierRoman(q.tier)}</span><span class="id">Q${esc(String(q.id).replace(/^p/, ''))} · ${hourLabel(q.hour)} UTC</span>
      <button class="icon-btn side-x" type="button" aria-label="Close the question panel">${'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>'}</button></div>
    <h3 tabindex="-1">${esc(q.title)}</h3>
    ${pv ? '<p class="pv-note">Practice until launch: written from real Robinhood Chain data this hour, checked for free. Bounties start at launch.</p>' : ''}
    <p class="prompt">${esc(q.prompt || '')}</p>
    <div class="stats">${stats}</div>
    <dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${k === 'Solver' ? v : esc(v)}</dd>`).join('')}</dl>
    <div class="acts">
      <a class="btn ${st === 'open' || st === 'practice' ? 'btn-hull' : ''}" href="${main[1]}">${main[0]} ${ARROW}</a>
      ${st === 'solved' && !reduced ? '<button class="btn btn-sm" type="button" data-replay>Replay the crack</button>' : ''}
      ${pv ? `<a class="btn btn-sm btn-ghost" href="${qPage(q.id)}">Question page</a>` : '<a class="btn btn-sm btn-ghost" href="/board/">Board</a>'}
    </div>`
  // the same content (only the clock moved) → leave the DOM alone, so a keyboard user inside the panel keeps focus
  const key = html.replace(/data-p="clock">[^<]*/, '')
  if (panel._key === key && panel._id === q.id) return
  const hadFocus = panel.contains(document.activeElement)
  panel._key = key; panel._id = q.id
  panel.innerHTML = html
  if (hadFocus) panel.querySelector('h3')?.focus({ preventScroll: true })
  panel.querySelector('.side-x').addEventListener('click', (e) => select(null, { refocus: e.detail === 0 }))
  panel.querySelector('[data-replay]')?.addEventListener('click', () => { field?.replay(q.id); panTo(field.floes.get(q.id)?.x0 ?? pan.target) })
}

// ── buoys ──────────────────────────────────────────────
// Each buoy card can fold to its title chip. It folds by itself when it would otherwise cover the ship's lane (short
// screens, a tall card near the ruler); the title button unfolds it (the reader's choice holds until it leaves the view).
const buoyEls = $$('.buoy')
const buoyLines = buoyEls.map(() => svgEl('line', 'buoy fl'))
buoyEls.forEach((el, i) => {
  el._user = null
  el.querySelector('.b-tog')?.addEventListener('click', (e) => {
    e.stopPropagation()
    el._user = el.classList.contains('compact')
  })
  el.addEventListener('focusin', () => { if (gateMode === 'off' && field) { const x = field.layout.buoyX[i]; if (x != null && !onScreen(x)) panTo(x + (i === 5 ? 0 : 3)) } })
})
function setCompact(el, on) {
  if (el._compact === on) return
  el._compact = on
  el.classList.toggle('compact', on)
  el.querySelector('.b-tog')?.setAttribute('aria-expanded', String(!on))
  el._w = 0; el._h = 0
}
function setLive(key, val, isHtml = false) { $$(`[data-live="${key}"]`).forEach((el) => { if (isHtml) el.innerHTML = val; else el.textContent = val }) }
function fillBuoys() {
  const st = S.state
  const preview = st ? isPreview(st) : false
  const open = S.items.filter((q) => q.status === 'open'), solved = S.items.filter((q) => q.status === 'solved'), uns = S.items.filter((q) => q.status === 'unsolved')
  const prac = S.items.filter((q) => q.status === 'practice').length
  if (prac && prac === S.items.length) setLive('counts', `${fmtInt(prac)} practice question${prac === 1 ? '' : 's'}`)
  else setLive('counts', `${fmtInt(st?.open ?? open.length)} open · ${fmtInt(st?.solved ?? solved.length)} cracked · ${fmtInt(st?.unsolved ?? uns.length)} unsolved`)
  const newest = [...S.items].sort((a, b) => b.hour - a.hour)[0]
  if (newest?.answerHash) { setLive('hashLabel', `Q${newest.id} · answerHash, on-chain since ${hourLabel(newest.hour)} UTC`); setLive('hash', newest.answerHash) }
  else if (newest?.textHash && (preview || newest.preview)) { setLive('hashLabel', `Q${newest.id} · textHash (preview: hashes go on-chain from launch)`); setLive('hash', newest.textHash) }
  else if (newest?.textHash) { setLive('hashLabel', `Q${newest.id} · textHash (the answer hash sits next to it on-chain)`); setLive('hash', newest.textHash) }
  if (st?.pool && !preview) setLive('pool', fmtEth(st.pool.eth ?? st.pool.wei, { unit: true }))
  else setLive('pool', preview ? 'at launch' : '–')
  const note = $('[data-live="poolNote"]')
  if (preview || S.practice) { note.hidden = false; note.textContent = 'Preview: bounties start at launch. Questions are already written every hour into practice.' } else note.hidden = true
  setLive('legal', LEGAL)
  fillModels()
  remeasureBuoys()
  tick()
}
function fillModels() {
  const m = S.models
  const box = $('[data-live="models"]')
  const preview = S.state ? isPreview(S.state) : false
  if (!m || !m.items.length) {
    const t = !m ? 'loading…' : preview ? 'No cracks yet: the board starts at launch. Practice is open now.' : 'No cracks yet. The first model on the board takes row one.'
    if (box.dataset.t !== t) { box.dataset.t = t; box.innerHTML = `<li class="muted">${esc(t)}</li>`; remeasureBuoys() }
    return
  }
  box.dataset.t = ''
  const max = Math.max(1, ...m.items.map((x) => x.cracked || 0))
  box.innerHTML = m.items.map((x, i) => `<li><span class="rk">${i + 1}</span><span class="m">${esc(x.key)}</span><span class="c">${fmtInt(x.cracked)}</span><span class="s">${x.medianSolveSeconds != null ? esc(fmtSolve(x.medianSolveSeconds)) : '–'}</span><span class="bar"><i style="width:${Math.round((x.cracked || 0) / max * 100)}%"></i></span></li>`).join('')
  setLive('modelsNote', `${m.range === '7d' ? 'Last 7 days' : 'All time'} · cracked · median time · model tags are self-declared.`)
  remeasureBuoys()
}
function tick() {
  const now = Date.now()
  applyInsets()
  setLive('nextQ', nextText(nextLeft()))
  const nd = S.state?.nextDripAt ? toMs(S.state.nextDripAt) : NaN
  setLive('nextDrip', S.state && isPreview(S.state) ? 'at launch' : Number.isFinite(nd) ? fmtCountdown(Math.max(0, nd - now) / 1000) : '–')
  updateSkim()
  const clk = panel.querySelector('[data-p="clock"]')
  const q = S.byId.get(S.selected)
  if (clk && (q?.status === 'open' || (q?.status === 'practice' && q.closesAt))) clk.textContent = fmtLeft(q.closesAt)
  // a new hour → a new floe freezes in (SSE `posted` usually gets there first; this is the fallback)
  const h = Math.floor(now / HOUR)
  const due = S.state?.nextQuestionAt ? toMs(S.state.nextQuestionAt) : NaN
  if (h !== S.hour && now % HOUR > 6000) { S.hour = h; load().catch(console.warn) }
  else if (Number.isFinite(due) && now > due + 4000 && S.lastLoad < due + 4000) load().catch(console.warn)
  else if (now - S.lastLoad > (pendingNow() ? 20000 : 60000)) load().catch(console.warn)
}

// ── ruler ──────────────────────────────────────────────
const track = $('#r-track'), rwin = $('#r-win')
function rulerRange() { const L = field.layout; return [L.minX + 6, L.maxX] }
function toRuler(x) { const [a, b] = rulerRange(); return clamp((x - a) / (b - a), 0, 1) * 100 }
function renderRuler() {
  if (!field) return
  const L = field.layout
  const ticks = []
  for (let i = 0; i <= L.n; i++) {
    const hour = L.hour0 + i, x = field.slotX(hour)
    const narrow = track.clientWidth < 520
    const big = hour % 6 === 0
    if (!narrow || big) ticks.push(`<i class="${big ? 'big' : ''}" style="left:${toRuler(x).toFixed(2)}%"></i>`)
    if (big && i < L.n - 1 && (!narrow || hour % 12 === 0)) ticks.push(`<span style="left:${toRuler(x).toFixed(2)}%">${hourLabel(hour)}</span>`)
  }
  if (track.clientWidth >= 520) ticks.push(`<span style="left:${toRuler(L.skimX).toFixed(2)}%">next</span>`)
  $('#r-ticks').innerHTML = ticks.join('')
  const marks = S.items.filter((q) => field.floes.has(q.id)).map((q) => `<i class="${q.status}${q.id === S.selected ? ' sel' : ''}" data-id="${esc(q.id)}" style="left:${toRuler(field.floes.get(q.id).x0).toFixed(2)}%"></i>`)
  L.buoyX.forEach((x, i) => marks.push(`<b style="left:${toRuler(x).toFixed(2)}%">${i + 1}</b>`))
  $('#r-marks').innerHTML = marks.join('')
}
function updateRulerWin() {
  const v = field.view
  const half = (v.w - IN.right) / v.ppu / 2
  const a = toRuler(pan.x - half), b = toRuler(pan.x + half)
  rwin.style.left = a + '%'
  rwin.style.width = Math.max(1.5, b - a) + '%'
  rwin.setAttribute('aria-valuenow', String(Math.round(toRuler(pan.x))))
}
function rulerX(clientX) { const r = track.getBoundingClientRect(); const [a, b] = rulerRange(); return a + clamp((clientX - r.left) / r.width, 0, 1) * (b - a) }
track.addEventListener('pointerdown', (e) => {
  if (gateMode !== 'off' || !field) return
  e.preventDefault()
  track.setPointerCapture(e.pointerId)
  const move = (ev) => { pan.target = clampPan(rulerX(ev.clientX)); pan.vel = 0; if (reduced) pan.x = pan.target }
  move(e)
  const up = () => { track.removeEventListener('pointermove', move); track.removeEventListener('pointerup', up); track.removeEventListener('pointercancel', up) }
  track.addEventListener('pointermove', move); track.addEventListener('pointerup', up); track.addEventListener('pointercancel', up)
  nudged()
})
rwin.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); step(e.key === 'ArrowRight' ? 1 : -1) } })
$('#r-now').addEventListener('click', () => goNow())

// ── panning ────────────────────────────────────────────
function clampPan(x) { if (!field) return x; const L = field.layout; return clamp(x, L.minX + (field.view.w - IN.right) / field.view.ppu / 2 - 4, L.maxX) }
function panTo(x) { pan.target = clampPan(x); pan.vel = 0; if (reduced) pan.x = pan.target }
function stops() {
  const L = field.layout
  const xs = [...L.buoyX, ...[...field.floes.values()].map((r) => r.x0), L.skimX]
  return [...new Set(xs.map((x) => Math.round(x * 10) / 10))].sort((a, b) => a - b)
}
function step(dir) {
  const s = stops(), cur = pan.target
  const next = dir > 0 ? s.find((x) => x > cur + 0.6) : [...s].reverse().find((x) => x < cur - 0.6)
  if (next != null) panTo(next)
  nudged()
}
function nowX() { return clampPan(field.layout.skimX - SLOT * 1.2) }
function onScreen(x) { const half = (field.view.w - IN.right) / field.view.ppu / 2; return Math.abs(x - pan.target) < half - 2 }
function newestOpen() {
  const list = S.items.filter((q) => field.floes.has(q.id)).sort((a, b) => b.hour - a.hour)
  return list.find((q) => q.status === 'open') || list[0]
}
function goNow() {
  panTo(nowX())
  const q = newestOpen()
  if (q && isWide()) select(q.id)
  nudged()
}
let hinted = false
function nudged() { if (!hinted) { hinted = true; setTimeout(() => $('#hint-keys').classList.add('gone'), 1200) } }

sea.addEventListener('wheel', (e) => {
  if (gateMode !== 'off' || !field) return
  const side = e.target.closest('.side, .buoy.scroll')
  if (side && side.scrollHeight > side.clientHeight + 2 && Math.abs(e.deltaY) > Math.abs(e.deltaX)) return
  e.preventDefault()
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? field.view.w : 1
  const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * unit
  pan.target = clampPan(pan.target + d / field.view.ppu * 1.1)
  pan.vel = 0
  if (reduced) pan.x = pan.target
  nudged()
}, { passive: false })

sea.addEventListener('pointerdown', (e) => {
  if (gateMode !== 'off' || !field || e.button > 0) return
  if (e.target.closest('.side, .ruler, input, textarea, .copyrow, .gate')) return
  pan.drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: pan.target, last: e.clientX, lt: performance.now(), v: 0, captured: false }
  pan.moved = false
})
sea.addEventListener('pointermove', (e) => {
  const d = pan.drag
  if (d && d.id === e.pointerId) {
    const dx = e.clientX - d.x0, dy = e.clientY - d.y0
    if (!d.captured && Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(dy) * 0.8) {
      d.captured = true; pan.moved = true
      try { sea.setPointerCapture(e.pointerId) } catch {}
      sea.classList.add('dragging')
    }
    if (d.captured) {
      const now = performance.now()
      const inst = (e.clientX - d.last) / Math.max(1, now - d.lt)
      d.v = d.v * 0.6 + inst * 0.4
      d.last = e.clientX; d.lt = now
      pan.target = clampPan(d.t0 - dx / field.view.ppu)
      pan.x = pan.target
      nudged()
    }
    return
  }
  if (e.pointerType === 'mouse' && gateMode === 'off' && field && e.target === canvas) hoverAt(e.clientX, e.clientY)
})
function endDrag(e) {
  const d = pan.drag
  if (!d || d.id !== e.pointerId) return
  pan.drag = null
  sea.classList.remove('dragging')
  if (d.captured) {
    if (!reduced) pan.vel = -d.v * 1000 / field.view.ppu
    setTimeout(() => (pan.moved = false), 0)
  } else if (e.type === 'pointerup' && e.target === canvas) {
    const r = canvas.getBoundingClientRect()
    const id = field.pick(e.clientX - r.left, e.clientY - r.top)
    if (id != null) select(id)
    else if (!isWide()) select(null)
  }
}
sea.addEventListener('pointerup', endDrag)
sea.addEventListener('pointercancel', endDrag)
sea.addEventListener('click', (e) => { if (pan.moved) { e.preventDefault(); e.stopPropagation() } }, true)
let hoverRaf = 0
function hoverAt(x, y) {
  if (hoverRaf) return
  hoverRaf = requestAnimationFrame(() => {
    hoverRaf = 0
    const r = canvas.getBoundingClientRect()
    sea.classList.toggle('hovering', field.pick(x - r.left, y - r.top) != null)
  })
}

addEventListener('keydown', (e) => {
  if (gateMode !== 'off' || !field) return
  if (e.target.closest?.('input, textarea, select, [contenteditable]')) return
  const page = (field.view.w - IN.right) / field.view.ppu * 0.8
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); if (e.shiftKey) panTo(pan.target + (e.key === 'ArrowRight' ? page : -page)); else step(e.key === 'ArrowRight' ? 1 : -1) }
  else if (e.key === 'PageDown' || e.key === 'PageUp') { e.preventDefault(); panTo(pan.target + (e.key === 'PageDown' ? page : -page)) }
  else if (e.key === 'Home') { e.preventDefault(); panTo(field.layout.buoyX[0]) }
  else if (e.key === 'End') { e.preventDefault(); goNow() }
  else if (e.key === 'Escape' && S.selected != null) select(null, { refocus: true })
  else return
  nudged()
})

// copy buttons
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-copy]')
  if (!b) return
  const t = $(b.dataset.copy)?.textContent?.trim()
  if (t && await copyText(t)) { toast('Copied. Paste it to your agent.', { kind: 'ok' }); b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy'), 1400) }
})

// ── the gate ───────────────────────────────────────────
const gateEl = $('#gate'), gatePos = $('#gate-pos'), gateCard = $('#gate-card'), gateIn = $('#gate-input'), gateHint = $('#gate-hint')
const gateLine = svgEl('line', 'gt'), gateDot = svgEl('circle', 'gt')
gateDot.setAttribute('r', '3.5')
let tries = 0
const HINTS = [
  'The ice holds. Hint: it is a four-digit number.',
  'The ice holds. Hint: it starts with 46. Wallets show it when you add the network.',
  'Still frozen. It is 4663. Type it and press Enter.',
]
function gateWrong(msg) {
  gateHint.textContent = msg
  gateHint.className = 'gate-hint err'
  gateCard.classList.remove('shake'); void gateCard.offsetWidth; gateCard.classList.add('shake')
  gateIn.setAttribute('aria-invalid', 'true')
  field?.gateShake()
}
gateCard.addEventListener('submit', (e) => {
  e.preventDefault()
  if (gateMode !== 'closed') return
  const v = gateIn.value.trim().toLowerCase().replace(/[\s,._']/g, '')
  if (!v) return gateWrong('Type the chain ID first, then press Enter.')
  if (v === '4663' || v === '0x1237') return openGate(true)
  gateWrong(HINTS[Math.min(tries++, HINTS.length - 1)])
  gateIn.select()
})
gateIn.addEventListener('input', () => gateIn.removeAttribute('aria-invalid'))
$('#gate-skip').addEventListener('click', () => openGate(false))

async function openGate(cracked) {
  if (gateMode !== 'closed') return
  gateMode = 'opening'
  try { localStorage.setItem('kc.gate', '1') } catch {}
  gateIn.readOnly = true
  if (cracked) { gateHint.textContent = '4663. Correct: the keel cracks the ice.'; gateHint.className = 'gate-hint ok'; gateCard.classList.add('cracked') }
  html.classList.add('opening')
  gateIn.blur()
  if (field) {
    if (cracked && !reduced) await field.gateCrack()
    else { field.gateOpenInstant() }
    pan.x = field.view.x
  }
  finishGate(true)
}
function finishGate(first) {
  gateMode = 'off'
  html.classList.remove('gate-on', 'opening'); html.classList.add('gate-off')
  gateLine.remove(); gateDot.remove()
  setTimeout(() => { gateEl.hidden = true }, 700)
  if (!field) return
  applyInsets()
  if (first) panTo(field.layout.buoyX[0] + 6)
  else { goNow(); pan.x = pan.target }   // returning visitors land at "now" without a long pan from the gate
  if (isWide() && S.selected == null) {
    const q = newestOpen()
    if (q) select(q.id)
  }
  sea.focus({ preventScroll: true })
}

// ── per frame: field + overlay ─────────────────────────
const P = {}, PM = {}
function measure(c) {
  if (c.w) return
  if (c.mini) c.el.classList.remove('mini')
  c.w = c.el.offsetWidth; c.h = c.el.offsetHeight
  if (c.mini) c.el.classList.add('mini')
}
function measureMini(c) {
  if (c.mw) return
  if (!c.mini) c.el.classList.add('mini')
  c.mw = c.el.offsetWidth; c.mh = c.el.offsetHeight
  if (!c.mini) c.el.classList.remove('mini')
}
function setMini(c, on) {
  if (c.mini === on) return
  c.mini = on
  c.el.classList.toggle('mini', on)
  if (on) c.el.title = S.byId.get(Number(c.el.dataset.id))?.title || S.byId.get(c.el.dataset.id)?.title || ''
  else c.el.removeAttribute('title')
}
// off-screen items stay in the tab order (focusing one pans the field to it) but are invisible and parked inside the
// viewport, so a focus never scrolls the page
function park(el, line, dot, x, w, W, top) {
  if (el._off) return
  el._off = true
  el.classList.add('off')
  show(line, false); if (dot) show(dot, false)
  el.style.transform = `translate3d(${clamp(x - w / 2, 0, Math.max(0, W - w)).toFixed(1)}px, ${top.toFixed(1)}px, 0)`
}
function unpark(el) { if (el._off) { el._off = false; el.classList.remove('off') } }
const placed = []
const MARGIN = 6
const BUOY_ORDER = [5, 0, 1, 2, 3, 4]
function hitRect(l, t, w, h) {
  for (const q of placed) if (l < q[2] + MARGIN && l + w > q[0] - MARGIN && t < q[3] + MARGIN && t + h > q[1] - MARGIN) return q
  return null
}
// greedy placement: the preferred spot above the floe, else nudged sideways (≤ 45% of the card), else stacked above the
// card in the way, else null
function fit(x, top0, w, h, topLim, minL, maxL) {
  const left0 = clamp(x - w / 2, minL, maxL)
  let q = hitRect(left0, top0, w, h)
  if (!q) return [left0, top0]
  const tries = [[q[2] + MARGIN + 1, top0], [q[0] - MARGIN - 1 - w, top0], [left0, q[1] - MARGIN - 1 - h]]
  for (const [l, t] of tries) {
    if (Math.abs(l - left0) > w * 0.45 || l < minL - 1 || l > maxL + 1 || t < topLim) continue
    if (!hitRect(l, t, w, h)) return [l, t]
  }
  return null
}
function frame(dt) {
  if (!field) return
  if (gateMode === 'opening') { pan.x = pan.target = field.view.x }
  else if (gateMode === 'off') {
    if (!pan.drag?.captured) {
      if (Math.abs(pan.vel) > 0.05) { pan.target = clampPan(pan.target + pan.vel * dt); pan.vel *= Math.exp(-3.2 * dt) } else pan.vel = 0
      pan.x += (pan.target - pan.x) * (reduced ? 1 : 1 - Math.exp(-9 * dt))
    }
    field.view.x = pan.x
  } else field.view.x = field.gateViewX()
  field.update(dt)
  overlay()
}
function overlay() {
  const v = field.view, W = v.w, H = v.h
  const right = W - IN.right
  const phone = isPhone()
  const topLim = IN.top + 8, botLim = H - IN.bottom - 8
  if (gateMode !== 'off') {
    // gate card pinned to the ice in front of the bow
    field.project(GATE.ship + 4.6, 0.42, 1.4, P)
    const w = gatePos.offsetWidth || 400, h = gatePos.offsetHeight || 220
    let left = clamp(P.x - Math.min(70, w * 0.2), 12, W - w - 12)
    let top = P.y - (phone ? 44 : 64) - h
    top = Math.max(topLim + 4, top)
    gatePos.style.transform = `translate3d(${left.toFixed(1)}px, ${top.toFixed(1)}px, 0)`
    const lx = clamp(P.x, left + 14, left + w - 14)
    setLine(gateLine, lx, top + h, P.x, P.y); gateDot.setAttribute('cx', P.x.toFixed(1)); gateDot.setAttribute('cy', P.y.toFixed(1))
    if (gateMode === 'closed') return
  }
  // floe callouts: the selected / focused one first, then the skim ice, then open → practice → cracked →
  // unsolved, newer first. A callout that cannot find room shrinks to a small "Q12" tag (full again on focus or
  // selection; tapping or clicking it selects the floe; the mouse gets the title as a tooltip)
  const lift = smallCo() ? 40 : 54
  placed.length = 0
  const list = []
  for (const [id, c] of callEls) {
    const rec = field.floes.get(id)
    if (!rec) continue
    const t = field.floeTop(rec)
    field.project(t.x, t.y, t.z, P)
    measure(c)
    const vis = P.x > -c.w * 0.2 && P.x < right + c.w * 0.2 && P.y > topLim
    if (!vis) { park(c.el, c.line, c.dot, P.x, c.w, W, topLim); continue }
    const q = rec.q
    const rank = id === S.selected ? 0 : c.focus ? 1 : q.status === 'open' ? 3 : q.status === 'practice' ? 4 : q.status === 'solved' ? 5 : 6
    list.push({ c, x: P.x, y: P.y, rank, hour: q.hour })
  }
  if (skimCo) {
    field.project(field.layout.skimX, 0.1, -4.3, P)
    measure(skimCo)
    const vis = P.x + skimCo.w / 2 > -20 && P.x - skimCo.w / 2 < right + 10
    if (vis) list.push({ c: skimCo, x: P.x, y: P.y, rank: 2, hour: 1e9, skim: true })
    else park(skimCo.el, skimCo.line, skimCo.dot, P.x, skimCo.w, W, topLim)
  }
  list.sort((a, b) => a.rank - b.rank || b.hour - a.hour)
  for (const it of list) {
    const c = it.c
    const top0 = Math.max(topLim, it.y - lift - c.h)
    let spot = fit(it.x, top0, c.w, c.h, topLim, it.skim ? 6 : -c.w, it.skim ? right - c.w - 6 : W)
    let w = c.w, h = c.h, mini = false
    if (!spot && !it.skim && it.rank > 1) {
      measureMini(c)
      w = c.mw; h = c.mh; mini = true
      spot = fit(it.x, Math.max(topLim, it.y - 16 - h), w, h, topLim, -w, W) || [it.x - w / 2, Math.max(topLim, it.y - 16 - h)]
    }
    if (!spot) spot = [clamp(it.x - w / 2, it.skim ? 6 : -w, it.skim ? right - w - 6 : W), top0]
    if (!it.skim) setMini(c, mini)
    unpark(c.el); show(c.line, true); show(c.dot, true)
    const [left, top] = spot
    placed.push([left, top, left + w, top + h])
    c.el.style.transform = `translate3d(${left.toFixed(1)}px, ${top.toFixed(1)}px, 0)`
    setLine(c.line, clamp(it.x, left + 8, left + w - 8), top + h, it.x, it.y)
    c.dot.setAttribute('cx', it.x.toFixed(1)); c.dot.setAttribute('cy', it.y.toFixed(1))
  }
  // buoy cards: hang below the buoy and never rise over the ship's lane on their own. Short screens (phone landscape)
  // and cards too tall for the room above the ruler fold to their title chip, which sits beside the buoy.
  const sheetOpen = !isDocked() && S.selected != null && !panel.classList.contains('closed')
  const short = isShort()
  const bplaced = []
  const bhit = (l, t, w, h) => bplaced.some((q) => l < q[2] + 8 && l + w > q[0] - 8 && t < q[3] + 8 && t + h > q[1] - 8)
  // buoy 6 (send your agent) claims its room first
  for (const i of BUOY_ORDER) {
    const b = field.buoys[i], el = buoyEls[i], line = buoyLines[i]
    if (!el || !b) continue
    field.project(b.x, 1.35, b.z, P)
    if (!fullSize(el)) continue
    // a buoy behind the side panel or off-screen parks its card (it stays reachable with Tab)
    const onView = P.x > -40 && P.x < right - 10
    if (!onView || sheetOpen) {
      if (P.x < -40 || P.x > W + 40) el._user = null
      park(el, line, null, P.x, el._compact ? el._cw || 200 : el._fw, W, Math.max(topLim, P.y))
      continue
    }
    // full card if it fits below the buoy; buoy 6 then tries its slim layout (no CA / countdown: the navbar has both);
    // else the title chip. A card that would sit on another buoy's card folds too.
    const fits = (h) => P.y + 30 + h <= botLim || botLim - h >= P.y - 6
    const spot = (h) => {
      const w = el._fw
      const left = clamp(P.x - (i === 5 ? w * 0.45 : Math.min(60, w * 0.18)), 8, right - w - 8)
      let top = P.y + 30
      if (top + h > botLim) top = el._user === true ? Math.max(topLim, botLim - h) : botLim - h
      return [left, top]
    }
    let compact = el._user === false || (el._user !== true && short), slim = false
    if (!compact && el._user !== true && !fits(el._fh)) { if (el._sh < el._fh && fits(el._sh)) slim = true; else compact = true }
    if (!compact && el._user !== true) { const h = slim ? el._sh : el._fh, [l, t] = spot(h); if (bhit(l, t, el._fw, h)) compact = true }
    setSlim(el, slim && !compact)
    setCompact(el, compact)
    unpark(el)
    let left, top, w, h
    if (compact) {
      if (!el._cw) { setTiny(el, false); el._cw = el.offsetWidth; el._ch = el.offsetHeight; setTiny(el, true); el._tw = el.offsetWidth; setTiny(el, false) }
      h = el._ch
      field.project(b.x, 0.5, b.z, PM)
      top = clamp(PM.y - h / 2, topLim, botLim - h)
      // the chip sits right of its buoy; crowded → only its number (the title stays for screen readers), then left of it
      let tiny = false
      w = el._cw; left = clamp(P.x + 16, 8, right - w - 8)
      if (bhit(left, top, w, h)) {
        tiny = true; w = el._tw; left = clamp(P.x + 16, 8, right - w - 8)
        if (bhit(left, top, w, h)) left = clamp(P.x - 16 - w, 8, right - w - 8)
      }
      setTiny(el, tiny)
      const side = left > P.x ? left : left + w
      show(line, Math.abs(side - P.x) > 8)
      setLine(line, P.x + (left > P.x ? 6 : -6), PM.y, side, top + h / 2)
      if (el.style.maxHeight) { el.style.maxHeight = ''; el.classList.remove('scroll') }
    } else {
      setTiny(el, false)
      w = el._fw; h = slim ? el._sh : el._fh
      ;[left, top] = spot(h)
      // unfolded by hand on a short screen: never taller than the room, scrolls inside
      const room = botLim - topLim
      if (h > room) { h = room; el.style.maxHeight = room + 'px'; el.classList.add('scroll') } else if (el.style.maxHeight) { el.style.maxHeight = ''; el.classList.remove('scroll') }
      const below = top > P.y + 4
      show(line, below)
      if (below) setLine(line, P.x, P.y, clamp(P.x, left + 12, left + w - 12), top)
    }
    bplaced.push([left, top, left + w, top + h])
    el.style.transform = `translate3d(${left.toFixed(1)}px, ${top.toFixed(1)}px, 0)`
  }
  updateRulerWin()
}
// full card size, measured once per content change (also while folded)
function fullSize(el) {
  if (!el._fh) {
    el.classList.remove('compact', 'slim')
    el._fw = el.offsetWidth; el._fh = el.offsetHeight
    el._sh = el._fh
    if (el.dataset.buoy === '5') { el.classList.add('slim'); el._sh = el.offsetHeight; el.classList.remove('slim') }
    if (el._compact) el.classList.add('compact')
    if (el._slim) el.classList.add('slim')
  }
  return el._fh > 0
}
function setTiny(el, on) { if (el._tiny !== on) { el._tiny = on; el.classList.toggle('tiny', on) } }
function setSlim(el, on) { if (el._slim !== on) { el._slim = on; el.classList.toggle('slim', on) } }
function remeasureBuoys() { buoyEls.forEach((el) => { el._fh = 0; el._cw = 0 }) }

// ── boot ───────────────────────────────────────────────
function onResize() {
  if (!field) return
  field.resize()
  applyInsets()
  for (const c of callEls.values()) { c.w = 0; c.mw = 0 }
  if (skimCo) skimCo.w = 0
  remeasureBuoys()
  if (S.selected != null) { panel.hidden = false; panel.classList.remove('closed') }
  pan.target = clampPan(pan.target)
}
addEventListener('resize', () => { onResize(); renderRuler() })
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => applyInsets()).observe(document.body)
document.addEventListener('kc:demo', () => setMode())

async function boot() {
  if (!field) { gateEl.hidden = true; return }
  applyInsets()
  if (gateMode === 'off') field.gateOpenInstant()
  let last = performance.now()
  let first = true
  const perf = { t: 0, n: 0, drops: 0 }
  const loop = (now) => {
    requestAnimationFrame(loop)
    if (document.hidden) { last = now; return }
    const raw = (now - last) / 1000
    const dt = Math.min(0.05, raw)
    last = now
    frame(dt)
    // adaptive quality: a slow device (avg frame > 24 ms over ~2 s) drops the pixel ratio, at most twice
    if (raw < 0.25) { perf.t += raw; perf.n++ }
    if (perf.t > 2) { if (perf.t / perf.n > 0.024 && perf.drops < 2) { perf.drops++; field.lowerQuality() } perf.t = 0; perf.n = 0 }
    if (first) { first = false; sea.classList.add('ready') }
  }
  requestAnimationFrame(loop)
  if (gateMode === 'closed') setTimeout(() => { try { gateIn.focus({ preventScroll: true }) } catch {} }, 350)
  await load().catch((e) => console.warn('[keelcrack] load', e))
  loadModels()
  setInterval(tick, 1000)
  setInterval(loadModels, 5 * 60000)
  if (gateMode === 'off') finishGate(false)
  connectLive()
}
function onLive(type, data) {
  if (type === 'open' || type === 'hello') { const was = S.mode === 'reconnecting'; setMode('live'); if (was) refreshSoon(300); return }
  if (type === 'error') { setMode('reconnecting'); return }
  if (type === 'ping') return
  const id = data?.id
  if (id != null && field?.floes.has(id) && (type === 'commit' || type === 'reveal' || type === 'topup')) {
    field.pulse(id)
    const q = S.byId.get(id)
    if (q && type === 'commit') { q.commits = (q.commits || 0) + 1; renderCallouts() }
    if (q && type === 'topup' && data.loadEth != null) { q.loadEth = data.loadEth }
  }
  if (type === 'harvest' || type === 'drip') from('/api/state', () => api.state()).then((s) => { if (s) { S.state = s; fillBuoys() } }).catch(() => {})
  refreshSoon(type === 'settled' || type === 'posted' ? 300 : 2500)
}
// SSE: once the real server has answered, the landing keeps its own EventSource (reconnects with a backoff and catches up
// with one reload of the data); before that, api.js live() (which also runs the DEMO ticker)
const LIVE_EVENTS = ['hello', 'posted', 'drip', 'commit', 'reveal', 'settled', 'harvest', 'topup', 'ping']
function connectLive() {
  if (!net.real || typeof EventSource === 'undefined') { live(onLive); return }
  let es = null, retry = 3000
  const open = () => {
    es = new EventSource(API + '/api/live')
    for (const ev of LIVE_EVENTS) es.addEventListener(ev, (e) => { let d = null; try { d = JSON.parse(e.data) } catch {} onLive(ev, d) })
    es.onopen = () => { retry = 3000; onLive('open', null) }
    es.onerror = () => {
      onLive('error', null)
      // the browser retries by itself while the stream is CONNECTING; a hard failure (HTTP error) closes it
      if (es.readyState === 2) { es.close(); setTimeout(open, retry); retry = Math.min(retry * 2, 60000) }
    }
  }
  open()
}
boot()
if (/[?&]debug\b/.test(location.search)) window.KC = { field, S, pan, load, select, net, onLive, callEls }
