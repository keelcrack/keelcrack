// HTTP routes (BRIEF "API") + the static site from WEB_ROOT with clean URLs (/board → board/index.html).
// JSON everywhere ({error, preview} on errors); times epoch ms; *Wei exact strings, *Eth numbers. Rate limits → 429 +
// Retry-After (per-IP token buckets; a tight one for the practice checker). GET API answers carry
// Access-Control-Allow-Origin: * so agents and notebooks can read it from anywhere.
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join, normalize, extname, sep } from 'node:path'
import { log, bucket, httpError, WEB_ROOT } from './lib/util.mjs'
import * as bus from './lib/bus.mjs'

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream', '.wasm': 'application/wasm', '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.xml': 'application/xml', '.webmanifest': 'application/manifest+json',
}
const LONG_CACHE = /\.(woff2?|ttf|png|jpe?g|webp|avif|gif|ico|svg|glb|bin|wasm)$/i
export const BODY_MAX = Number(process.env.BODY_MAX) || 2048
const STATUSES = new Set(['open', 'solved', 'unsolved', 'all'])
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' }

/** ctx = { store, preview, started, serveWeb, webRoot, stateExtra() → {launchAt, board, nextQuestionAt, block}, healthExtra() } */
export function createApp({ store, preview, started = Date.now(), webRoot = WEB_ROOT, serveWeb = true, stateExtra = () => ({}), healthExtra = async () => ({}) }) {
  const perIp = bucket(Number(process.env.RL_IP_BURST) || 240, Number(process.env.RL_IP_PER_S) || 40)
  const checkIp = bucket(Number(process.env.RL_CHECK_BURST) || 8, Number(process.env.RL_CHECK_PER_S) || 0.2) // 8 at once, then 1 per 5 s
  const checkPid = bucket(Number(process.env.RL_CHECK_PID_BURST) || 4, Number(process.env.RL_CHECK_PID_PER_S) || 0.05) // per (ip, question): 4, then 1 per 20 s

  function clientIp(req) {
    const peer = req.socket.remoteAddress || ''
    if (/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(peer)) { const real = req.headers['x-real-ip']; if (real) return String(real).trim() }
    return peer
  }
  function send(res, status, body, headers = {}) {
    const isRaw = typeof body === 'string' || Buffer.isBuffer(body)
    const buf = isRaw ? Buffer.from(body) : Buffer.from(JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? String(v) : v)))
    res.writeHead(status, {
      'content-length': buf.length, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'x-keelcrack-mode': preview ? 'preview' : 'live',
      ...(isRaw ? {} : { 'content-type': 'application/json; charset=utf-8' }), ...headers,
    })
    res.end(buf)
  }
  function readJson(req, max) {
    return new Promise((resolve, reject) => {
      const ct = String(req.headers['content-type'] || '')
      if (!/^application\/json\b/i.test(ct)) return reject(httpError(415, 'content-type must be application/json'))
      const len = Number(req.headers['content-length'] || 0)
      if (len > max) { req.resume(); return reject(httpError(413, `body too large (max ${max} bytes)`)) }
      const chunks = []
      let n = 0, done = false
      req.on('data', (c) => {
        if (done) return
        n += c.length
        if (n > max) { done = true; req.resume(); reject(httpError(413, `body too large (max ${max} bytes)`)); return }
        chunks.push(c)
      })
      req.on('end', () => { if (done) return; done = true; try { const s = Buffer.concat(chunks).toString('utf8'); resolve(s ? JSON.parse(s) : {}) } catch { reject(httpError(400, 'invalid JSON')) } })
      req.on('error', (e) => { if (!done) { done = true; reject(e) } })
    })
  }

  async function serveStatic(req, res, pathname) {
    let rel
    try { rel = decodeURIComponent(pathname) } catch { return send(res, 400, 'bad path') }
    if (rel.includes('\0')) return send(res, 400, 'bad path')
    if (/(^|[\\/])\.(?!well-known)/.test(rel)) return send(res, 404, 'not found')
    const root = normalize(webRoot + sep)
    let file = normalize(join(root, rel))
    if (!file.startsWith(root) && file + sep !== root) return send(res, 403, 'forbidden')
    let st = await stat(file).catch(() => null)
    if (st?.isDirectory()) { file = join(file, 'index.html'); st = await stat(file).catch(() => null) }
    if (!st?.isFile() && !extname(file)) { const f2 = file.replace(/[\\/]$/, '') + '.html'; const s2 = await stat(f2).catch(() => null); if (s2?.isFile()) { file = f2; st = s2 } }
    if (!st?.isFile()) {
      const nf = join(root, '404.html')
      const s404 = await stat(nf).catch(() => null)
      if (s404?.isFile()) { res.writeHead(404, { 'content-type': TYPES['.html'], 'content-length': s404.size }); return req.method === 'HEAD' ? res.end() : createReadStream(nf).pipe(res) }
      return send(res, 404, 'not found', { 'content-type': 'text/plain; charset=utf-8' })
    }
    const ext = extname(file).toLowerCase()
    res.writeHead(200, {
      'content-type': TYPES[ext] || 'application/octet-stream', 'content-length': st.size, 'x-content-type-options': 'nosniff',
      'cache-control': /(token|contracts)\.json$/.test(file) ? 'no-store' : LONG_CACHE.test(file) ? 'public, max-age=604800' : 'no-cache',
    })
    if (req.method === 'HEAD') return res.end()
    createReadStream(file).pipe(res)
  }

  const state = () => store.stateView(stateExtra())
  async function api(req, res, url, ip) {
    const p = url.pathname.replace(/\/+$/, '')
    const seg = p.split('/').slice(2)
    const isGet = req.method === 'GET' || req.method === 'HEAD'
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...CORS, 'access-control-max-age': '86400' }); return res.end() }
    if (seg[0] === 'live' && seg.length === 1 && isGet) {
      bus.attach(req, res, ip, [['hello', { ...state(), now: Date.now() }]])
      return
    }
    const lim = perIp.take(ip)
    if (!lim.ok) throw httpError(429, 'rate_limited', { retryAfter: lim.retryAfter })

    if (req.method === 'POST') {
      // POST /api/practice/:pid/check {answer}
      if (seg[0] === 'practice' && seg.length === 3 && seg[2] === 'check') {
        if (!/^\d{1,9}$/.test(seg[1])) throw httpError(404, 'no such practice question')
        const l1 = checkIp.take(ip)
        if (!l1.ok) throw httpError(429, 'rate_limited', { retryAfter: l1.retryAfter })
        const l2 = checkPid.take(`${ip}|${seg[1]}`)
        if (!l2.ok) throw httpError(429, 'rate_limited', { retryAfter: l2.retryAfter })
        const body = await readJson(req, BODY_MAX)
        if (body.answer == null || (typeof body.answer !== 'string' && typeof body.answer !== 'number') || String(body.answer).length > 200) throw httpError(400, 'body must be {"answer": "…"}')
        const r = store.practiceCheck(Number(seg[1]), body.answer)
        if (!r) throw httpError(404, 'no such practice question')
        return send(res, 200, store.out(r), CORS)
      }
      throw httpError(404, 'no such endpoint')
    }
    if (!isGet) throw httpError(405, 'method not allowed')

    const q = (k) => url.searchParams.get(k)
    switch (seg.join('/')) {
      case 'health': return send(res, 200, { ok: true, preview, mode: preview ? 'preview' : 'live', uptimeS: Math.round((Date.now() - started) / 1000), stream: { clients: bus.clientCount() }, ...(await healthExtra()) })
      case 'state': return send(res, 200, state(), CORS)
      case 'questions': {
        const status = q('status') || 'all'
        if (!STATUSES.has(status)) throw httpError(400, 'status must be open, solved, unsolved or all')
        return send(res, 200, store.questionsView({ status, limit: q('limit') }), CORS)
      }
      case 'leaderboard': {
        const by = q('by') || 'model', range = q('range') || 'all'
        if (!['wallet', 'model'].includes(by)) throw httpError(400, 'by must be wallet or model')
        if (!['24h', '7d', 'all'].includes(range)) throw httpError(400, 'range must be 24h, 7d or all')
        return send(res, 200, store.leaderboard({ by, range }), CORS)
      }
      case 'practice': return send(res, 200, store.practiceList({ limit: q('limit') }), CORS)
      case 'ledger': return send(res, 200, store.ledgerView({ limit: q('limit') }), CORS)
    }
    if (seg[0] === 'q' && seg.length === 2) {
      if (!/^\d{1,9}$/.test(seg[1])) throw httpError(404, 'no such question')
      const v = store.qView(Number(seg[1]))
      if (!v) throw httpError(404, 'no such question')
      return send(res, 200, v, CORS)
    }
    throw httpError(404, 'no such endpoint')
  }

  return async function handler(req, res) {
    const t0 = Date.now()
    let url
    try { url = new URL(req.url, 'http://local') } catch { return send(res, 400, { error: 'bad url', preview }) }
    const ip = clientIp(req)
    try {
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) await api(req, res, url, ip)
      else if (!serveWeb) send(res, 404, { error: 'static files are served by nginx', preview })
      else if (req.method !== 'GET' && req.method !== 'HEAD') send(res, 405, 'method not allowed')
      else await serveStatic(req, res, url.pathname)
    } catch (e) {
      const status = e.status || 500
      if (status >= 500) log(`${req.method} ${url.pathname}: ${e.stack?.split('\n').slice(0, 3).join(' | ') || e.message}`)
      if (res.headersSent) { try { res.end() } catch {} return }
      send(res, status, { error: status === 500 ? 'internal error' : e.message, preview }, { ...CORS, ...(e.retryAfter ? { 'retry-after': String(e.retryAfter) } : {}), ...(status === 413 ? { connection: 'close' } : {}) })
    } finally {
      if (process.env.LOG_REQUESTS === '1' && url.pathname.startsWith('/api/') && url.pathname !== '/api/live') log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - t0}ms`)
    }
  }
}
