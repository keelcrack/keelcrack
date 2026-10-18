// SSE fan-out for /api/live (BRIEF "API"): hello on connect · posted · drip · commit · reveal · settled · harvest · topup ·
// ping every 20 s. Every payload carries `preview` (added by the emitter in index.mjs).
const clients = new Set()
const perIp = new Map()
export const MAX_CLIENTS = Number(process.env.SSE_MAX) || 2000
export const MAX_PER_IP = Number(process.env.SSE_PER_IP) || 12
const listeners = new Set()

const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data, (_, v) => (typeof v === 'bigint' ? String(v) : v))}\n\n`

function drop(c) {
  if (!clients.delete(c)) return
  const n = (perIp.get(c.ip) || 1) - 1
  if (n <= 0) perIp.delete(c.ip); else perIp.set(c.ip, n)
}
function write(c, msg) { try { c.res.write(msg) } catch { drop(c) } }

/** To every client (and in-process listeners, e.g. tests). */
export function emit(event, data) {
  for (const l of listeners) { try { l(event, data) } catch {} }
  if (!clients.size) return
  const msg = frame(event, data)
  for (const c of clients) write(c, msg)
}
export const on = (fn) => { listeners.add(fn); return () => listeners.delete(fn) }
export const clientCount = () => clients.size

/** Attaches an SSE client. Answers 503/429 (and returns null) over the limits. hello = [[event, data], …] sent first. */
export function attach(req, res, ip, hello = []) {
  if (clients.size >= MAX_CLIENTS) { res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '30' }); res.end('{"error":"stream full, retry soon"}'); return null }
  if ((perIp.get(ip) || 0) >= MAX_PER_IP) { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30' }); res.end('{"error":"too many streams from this address"}'); return null }
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' })
  res.write('retry: 5000\n\n')
  const c = { res, ip }
  clients.add(c)
  perIp.set(ip, (perIp.get(ip) || 0) + 1)
  req.on('close', () => drop(c))
  res.on('error', () => drop(c))
  for (const [ev, data] of hello) write(c, frame(ev, data))
  return c
}

let hb = null
export function startHeartbeat(ms = 20_000) {
  hb = setInterval(() => { const t = Date.now(); emit('ping', { t }) }, ms)
  hb.unref()
}
export function closeAll() {
  clearInterval(hb)
  for (const c of clients) { try { c.res.end() } catch {} }
  clients.clear()
  perIp.clear()
}
