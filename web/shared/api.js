// KEELCRACK api.js: client for the server API (BRIEF.md "API"; same origin in production, nginx proxies /api).
// Owner: APP. LANDING imports it read-only. Questions, commits, practice, the ledger.
//
// Exports (stable):
//   API                       base URL ('' = same origin; on dev hosts ?api=http://127.0.0.1:4878 is sticky per tab)
//   isDemo() · DEMO           fixtures are served when ?demo=1 (sticky per tab, ?demo=0 resets) or automatically when the
//                             server was never reachable in this tab (first network failure before any live answer → fixtures + 'kc:demo'; site.js
//                             shows the "demo" bar). Fixtures live in demo.js and never contain a ticker.
//   ApiError { status, body, reason, offline, retryAfter }
//   api.state()                                   GET /api/state
//   api.questions({ status, limit })              GET /api/questions?status=open|solved|unsolved|all&limit=   → { items:[QItem] }
//   api.q(id)                                     GET /api/q/:id    → QItem + { question, commits, loadHistory, working }
//   api.leaderboard({ by, range })                GET /api/leaderboard?by=wallet|model&range=24h|7d|all
//   api.practice()                                GET /api/practice
//   api.practiceCheck(pid, answer)                POST /api/practice/:pid/check { answer } → { correct, hint? }
//   api.ledger({ limit })                         GET /api/ledger?limit=
//   api.clear()                                   drop the GET cache
//   live(handlers | fn) → close()                 SSE /api/live: posted · drip · commit · reveal · settled · harvest · topup
//                                                 (+ local pseudo-events open / error). In demo, a fixture ticker emits them.
//   statusOf(item) → 'open' | 'solved' | 'unsolved' | 'none'  (accepts the API string or the contract number 0–3)
//   isPreview(state) · demoWorld() · qPage(id) → '/q/?id=N'

const hasLoc = typeof location !== 'undefined'
const qs = hasLoc ? new URLSearchParams(location.search) : new URLSearchParams()
const devHost = hasLoc && /^(localhost|127\.0\.0\.1|\[::1\]|.+\.localhost|.+\.test)$/.test(location.hostname)

function sticky(key, param, map = (v) => v, allow = true) {
  if (!allow) return null
  let v = null
  try {
    if (qs.has(param)) {
      const raw = qs.get(param)
      v = raw && raw !== '0' ? map(raw) : null
      if (v) sessionStorage.setItem(key, v); else sessionStorage.removeItem(key)
    } else v = sessionStorage.getItem(key)
  } catch { v = qs.has(param) && qs.get(param) && qs.get(param) !== '0' ? map(qs.get(param)) : null }
  return v || null
}

export const API = (sticky('kc.api', 'api', (v) => v, devHost) || '').replace(/\/$/, '')
export let DEMO = sticky('kc.demo', 'demo', () => 'live')
export const isDemo = () => !!DEMO
// Once the server has answered in this tab, a later outage (502 on restart, a dropped SSE) is shown as "unreachable"
// and retried; it never switches the tab to fixtures. Auto-demo is only for a server that was never reachable.
let everLive = false

function goAuto() {
  if (DEMO || everLive) return
  DEMO = 'auto'
  console.info('[keelcrack] API unreachable: serving demo fixtures')
  try { document.dispatchEvent(new CustomEvent('kc:demo', { detail: { mode: 'auto' } })) } catch {}
}

export class ApiError extends Error {
  constructor(status, body, message, retryAfter = null) {
    super(message || body?.message || body?.error || body?.reason || `HTTP ${status}`)
    this.status = status; this.body = body; this.retryAfter = retryAfter
    this.reason = body?.error || body?.reason || null
    this.offline = status === 0 || status === 502 || status === 503 || status === 504 || (status === 404 && !body)
  }
}

const cache = new Map()
const inflight = new Map()
const OFFLINE_MSG = 'The KEELCRACK server is unreachable right now.'

async function request(path, init) {
  let r
  try { r = await fetch(API + path, { ...init, headers: { accept: 'application/json', ...(init?.headers || {}) } }) } catch (e) {
    if (e?.name === 'AbortError') throw e
    throw new ApiError(0, null, OFFLINE_MSG)
  }
  const ct = r.headers.get('content-type') || ''
  let data = null
  if (ct.includes('json')) { try { data = await r.json() } catch {} }
  if (!r.ok) {
    const ra = Number(r.headers.get('retry-after')) || null
    throw new ApiError(r.status, data, r.status === 404 && !data ? 'The KEELCRACK server is not running here.' : r.status === 429 ? `Too many tries. Wait ${ra ? ra + ' s' : 'a little'} and try again.` : undefined, ra)
  }
  if (data === null) throw new ApiError(0, null, 'The KEELCRACK server is not running here.')
  everLive = true
  return data
}

let demoP
export function demoWorld() {
  if (!DEMO) return Promise.resolve(null)
  return (demoP ||= import('./demo.js').then((m) => m.world()))
}

async function call(method, path, body, opts = {}) {
  if (!DEMO) {
    try {
      return await request(path, method === 'GET' ? { signal: opts.signal } : { method, body: JSON.stringify(body ?? {}), headers: { 'content-type': 'application/json' } })
    } catch (e) {
      if (!(e instanceof ApiError) || !e.offline || everLive) throw e
      goAuto()
    }
  }
  const w = await demoWorld()
  try { return await (method === 'GET' ? w.get(path) : w.post(path, body ?? {})) } catch (e) {
    throw new ApiError(e?.status || 500, e?.body || { error: String(e?.message || e) }, e?.message)
  }
}

export async function get(path, { ttl = 0, signal } = {}) {
  const hit = cache.get(path)
  if (ttl && hit && Date.now() - hit.at < ttl) return hit.data
  if (inflight.has(path)) return inflight.get(path)
  const p = (async () => {
    const data = await call('GET', path, null, { signal })
    if (ttl) cache.set(path, { at: Date.now(), data })
    return data
  })()
  inflight.set(path, p)
  try { return await p } finally { inflight.delete(path) }
}
export const post = (path, body) => call('POST', path, body)

const idOk = (id) => /^\d{1,9}$/.test(String(id))
const pidOk = (id) => /^[A-Za-z0-9_.:-]{1,80}$/.test(String(id))
const bad = (msg) => Promise.reject(new ApiError(400, { error: 'bad_request' }, msg))

export const api = {
  state: (o) => get('/api/state', { ttl: 2000, ...o }),
  questions({ status = 'all', limit = 100 } = {}, o) {
    return get(`/api/questions?status=${encodeURIComponent(status)}&limit=${Number(limit) || 100}`, { ttl: 3000, ...o })
  },
  q: (id, o) => (idOk(id) ? get(`/api/q/${Number(id)}`, { ttl: 2000, ...o }) : bad('That is not a question number.')),
  leaderboard({ by = 'model', range = '7d' } = {}, o) {
    return get(`/api/leaderboard?by=${encodeURIComponent(by)}&range=${encodeURIComponent(range)}`, { ttl: 10000, ...o })
  },
  practice: (o) => get('/api/practice', { ttl: 60000, ...o }),
  practiceCheck: (pid, answer) => (pidOk(pid) ? post(`/api/practice/${encodeURIComponent(pid)}/check`, { answer: String(answer ?? '') }) : bad('Unknown practice question.')),
  ledger({ limit = 200 } = {}, o) { return get(`/api/ledger?limit=${Number(limit) || 200}`, { ttl: 4000, ...o }) },
  clear: () => cache.clear(),
}

export const qPage = (id) => `/q/?id=${encodeURIComponent(id)}`
export const isPreview = (s) => !!s?.preview

const STATUS_NUM = ['none', 'open', 'solved', 'unsolved']
export function statusOf(x) {
  const s = typeof x === 'object' && x !== null ? x.status : x
  if (typeof s === 'number' || /^\d$/.test(String(s))) return STATUS_NUM[Number(s)] || 'none'
  const v = String(s || '').toLowerCase()
  return v === 'cracked' ? 'solved' : STATUS_NUM.includes(v) ? v : 'none'
}

// ── SSE ─────────────────────────────────────────────────
export const EVENTS = ['hello', 'posted', 'drip', 'commit', 'reveal', 'settled', 'harvest', 'topup', 'ping']
const KEEP_CACHE = new Set(['ping', 'hello'])
function normalize(h) {
  if (typeof h === 'function') return (type, data) => h(type, data)
  return (type, data) => h?.[type]?.(data)
}

export function live(handlers = {}) {
  const emit = normalize(handlers)
  let closed = false, stop = null, es = null, retry = 3000, demoOn = false
  const startDemo = () => {
    if (demoOn) return
    demoOn = true
    demoWorld().then((w) => { if (!closed && w) stop = w.subscribe((type, data) => { if (!KEEP_CACHE.has(type)) cache.clear(); emit(type, data) }) })
  }
  if (DEMO) { startDemo(); return () => { closed = true; stop?.() } }
  if (typeof EventSource === 'undefined') return () => {}
  const onDemo = () => { es?.close(); if (!closed) startDemo() }
  if (typeof document !== 'undefined') document.addEventListener('kc:demo', onDemo, { once: true })
  const open = () => {
    if (closed) return
    if (DEMO) { startDemo(); return }
    es = new EventSource(API + '/api/live')
    for (const ev of EVENTS) es.addEventListener(ev, (e) => {
      let d = null
      try { d = JSON.parse(e.data) } catch {}
      if (!KEEP_CACHE.has(ev)) cache.clear()
      emit(ev, d)
    })
    es.onopen = () => { everLive = true; retry = 3000; emit('open', null) }
    es.onerror = () => {
      es.close(); emit('error', null)
      if (!DEMO) api.state().catch(() => {})
      if (!closed && !DEMO) setTimeout(open, (retry = Math.min(retry * 2, 120000)))
    }
  }
  open()
  return () => { closed = true; es?.close(); stop?.() }
}
