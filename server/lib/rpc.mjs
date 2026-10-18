// JSON-RPC to Robinhood Chain (4663): paced, multi-mirror, retries, JSON-RPC batching, and a ranged eth_getLogs that adapts
// its window per mirror.
//
// Mirror facts (BRIEF "RC data access", verified 16-10-2026):
//  - rpc.mainnet.chain.robinhood.com (official, Cloudflare): no archive state, eth_getLogs ≤ 10,000,000 blocks per call WITH
//    an address filter (≤ 30,000 without), ≤ 10,000 logs per answer (→ "query returned more than 10000 results": the window
//    is halved), bursts → HTTP 429. → history LOGS + block headers + latest reads.
//    The dev machine's ISP answers its DNS name with a block page (TLS fails). IP pin: RPC_PIN=auto (default) tries DNS
//    first and switches the host to the pinned Cloudflare IPs for 30 min after a transport failure; RPC_PIN=on always pins,
//    RPC_PIN=off never. RPC_RESOLVE="host=ip|ip;host2=ip" forces explicit pins (TLS/SNI unchanged).
//  - robinhood-rpc.publicnode.com: latest state + eth_call; getLogs only ~50 blocks and only with an address.
//  - robinhood.drpc.org (free): getLogs tiny ranges; slow tail. Last resort.
// Clients: `reads` (latest state, eth_call, sendRawTransaction), `logs` (history logs, block headers), `tail` (recent logs).
// Env overrides: RPC_URLS (all three), LOG_RPC_URLS, TAIL_RPC_URLS. Pacing is per URL and shared by all clients.
// A mirror that refuses a call (range/rate/method) is skipped for that call; a transport failure benches it (≤ 2 min);
// an answered error (revert …) is the truth and is thrown (e.rpc = {code, message, data}).
import https from 'node:https'
import { encodeFunctionData, decodeFunctionResult } from 'viem'
import { UA, sleep } from './util.mjs'

export const OFFICIAL = 'https://rpc.mainnet.chain.robinhood.com'
export const PUBLICNODE = 'https://robinhood-rpc.publicnode.com'
export const DRPC = 'https://robinhood.drpc.org'

const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean).filter((u, i, a) => a.indexOf(u) === i)
const envAll = list(process.env.RPC_URLS || process.env.RPC_URL)
export const READ_URLS = envAll.length ? envAll : [PUBLICNODE, OFFICIAL, DRPC]
export const LOG_URLS = list(process.env.LOG_RPC_URLS).length ? list(process.env.LOG_RPC_URLS) : envAll.length ? envAll : [OFFICIAL, DRPC]
export const TAIL_URLS = list(process.env.TAIL_RPC_URLS).length ? list(process.env.TAIL_RPC_URLS) : envAll.length ? envAll : [OFFICIAL, PUBLICNODE, DRPC]

/** "host=ip[|ip];host2=ip" → Map(host → [ip]) */
export function parseResolve(s) {
  const m = new Map()
  for (const part of String(s || '').split(/[;\s]+/).filter(Boolean)) {
    const [host, ips] = part.split('=')
    if (host && ips) m.set(host.trim().toLowerCase(), ips.split(/[|,]/).map((x) => x.trim()).filter(Boolean))
  }
  return m
}
export const PIN_DEFAULTS = parseResolve('rpc.mainnet.chain.robinhood.com=104.20.46.209|172.66.147.70')
const FORCED = parseResolve(process.env.RPC_RESOLVE)
const PIN_MODE = (process.env.RPC_PIN || 'auto').toLowerCase()
const PIN_MS = 30 * 60_000
const pinnedUntil = new Map()
/** The IPs to use for `host` right now, or null (normal DNS). */
export function pinFor(host, now = Date.now()) {
  host = host.toLowerCase()
  if (FORCED.has(host)) return FORCED.get(host)
  if (PIN_MODE === 'off' || !PIN_DEFAULTS.has(host)) return null
  if (PIN_MODE === 'on' || (pinnedUntil.get(host) || 0) > now) return PIN_DEFAULTS.get(host)
  return null
}
const quiet = () => process.env.QUIET === '1'

const RATE_LIMITED = /429|too many requests|rate.?limit|exceeded the|request blocked|capacity|per 10s|strict rate/i
const RANGE = /ranges over|block range|range is too large|range_too_large|too many blocks|limited to \d+ blocks|query returned more than|response size|too many results|narrow the block range|exceeds limit|requested blocks is|query spans|more than \d+ results/i
const REFUSED = /does not exist|not available|not supported|method not found|-32601|free plan|archive|personal token|unsupported|forbidden|403|missing trie node|header not found|state.*not available|specify an address|invalid method|historical state/i

/** Per-mirror traits. maxRange = eth_getLogs blocks per call (with an address), maxRangeNoAddr without one;
 *  batchMax = JSON-RPC batch size; minGapMs = spacing between calls to that mirror. */
export function mirrorTraits(url) {
  if (/chain\.robinhood\.com/.test(url)) return { maxRange: 10_000_000, maxRangeNoAddr: 30_000, batchMax: 50, minGapMs: 60 }
  if (/publicnode/.test(url)) return { maxRange: 50, maxRangeNoAddr: 0, batchMax: 50, minGapMs: 0 }
  if (/drpc\.org/.test(url)) return { maxRange: 100, maxRangeNoAddr: 100, batchMax: 3, minGapMs: 80 }
  const w = Number(process.env.LOG_WINDOW) || 100_000
  return { maxRange: w, maxRangeNoAddr: w, batchMax: 50, minGapMs: 0 } // anvil / keyed endpoints
}

const SHARED = new Map()
function shared(url) {
  if (!SHARED.has(url)) {
    const t = mirrorTraits(url)
    SHARED.set(url, { lastAt: 0, benchedUntil: 0, fails: 0, traits: t, maxRange: t.maxRange, maxRangeNoAddr: t.maxRangeNoAddr, batchMax: t.batchMax })
  }
  return SHARED.get(url)
}

class Skip extends Error {}
const benchNoted = new Map()
function benchNote(url, why) {
  if (quiet() || Date.now() - (benchNoted.get(url) || 0) < 60_000) return
  benchNoted.set(url, Date.now())
  console.log(`${new Date().toISOString().slice(11, 19)} rpc benched ${new URL(url).hostname}: ${String(why).slice(0, 160)}`)
}
const rpcError = (method, err) => Object.assign(new Error(`rpc ${method}: ${err.message}`), { rpc: err })

export const hexToBig = (hex) => (hex && /^(0x)?[0-9a-fA-F]+$/.test(String(hex)) ? BigInt('0x' + String(hex).replace(/^0x/, '')) : 0n)
export const toQty = (n) => '0x' + BigInt(n).toString(16)

function pinnedPost(u, body, ips, timeoutMs) {
  const ip = ips[Math.floor(Math.random() * ips.length)]
  const family = ip.includes(':') ? 6 : 4
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: u.hostname, servername: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'user-agent': UA },
      lookup: (_h, o, cb) => (o && o.all ? cb(null, [{ address: ip, family }]) : cb(null, ip, family)),
      timeout: timeoutMs,
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', reject)
    })
    const hard = setTimeout(() => req.destroy(new Error('timeout')), timeoutMs)
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', (e) => { clearTimeout(hard); reject(e) })
    req.on('close', () => clearTimeout(hard))
    req.end(body)
  })
}

/** POST JSON → {status, text}. fetch, or node:https with a pinned IP (see pinFor); RPC_PIN=auto falls back to the pin. */
export async function httpPost(url, body, timeoutMs = 25_000) {
  const u = new URL(url)
  const ips = pinFor(u.hostname)
  if (ips) return pinnedPost(u, body, ips, timeoutMs)
  try {
    const r = await fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json', 'user-agent': UA }, signal: AbortSignal.timeout(timeoutMs) })
    return { status: r.status, text: await r.text() }
  } catch (e) {
    const host = u.hostname.toLowerCase()
    if (PIN_MODE !== 'auto' || !PIN_DEFAULTS.has(host) || e?.name === 'TimeoutError') throw e
    pinnedUntil.set(host, Date.now() + PIN_MS)
    if (!quiet()) console.log(`${new Date().toISOString().slice(11, 19)} rpc: ${host} unreachable by DNS (${e.cause?.code || e.message}) → IP pin for 30 min`)
    return pinnedPost(u, body, PIN_DEFAULTS.get(host), timeoutMs)
  }
}

/**
 * A JSON-RPC client over an ordered list of mirrors:
 *   rpc(method, params, opts) · rpcBatch([{method, params}]) · call(to, abi, functionName, args) · getLogs(filter, from, to, opts)
 *   blockNumber() · block(n) · state()
 */
export function createRpc(urls, { name = 'rpc', minGapMs = Number(process.env.RPC_MIN_GAP_MS ?? 25), maxInFlight = Number(process.env.RPC_MAX_IN_FLIGHT ?? 4), post = httpPost } = {}) {
  const URLS = [...urls]
  const S = URLS.map(shared)
  let gap = minGapMs, nextSlot = 0, inFlight = 0, id = 0, preferred = 0
  const waiting = []
  const stats = { calls: 0, requests: 0, errors: 0, rateLimited: 0 }

  async function pace(i) {
    if (inFlight >= maxInFlight) await new Promise((r) => waiting.push(r))
    inFlight++
    const now = Date.now()
    const slot = Math.max(now, nextSlot, S[i].lastAt + S[i].traits.minGapMs)
    nextSlot = Math.max(nextSlot, now) + gap
    S[i].lastAt = slot
    if (slot > now) await sleep(slot - now)
  }
  function release() { inFlight = Math.max(0, inFlight - 1); waiting.shift()?.() }
  const isBenched = (i) => S[i].benchedUntil > Date.now()
  const waitFor = (i) => Math.max(0, S[i].lastAt + S[i].traits.minGapMs - Date.now())

  function order(opts = {}) {
    const n = URLS.length
    let o = [...Array(n).keys()]
    if (!opts.logs) o = o.map((i) => (preferred + i) % n)
    return o.sort((a, b) => (isBenched(a) - isBenched(b)) || ((waitFor(a) > 2000) - (waitFor(b) > 2000)))
  }

  async function send(payload, label, judge, opts = {}) {
    const body = JSON.stringify(payload)
    const nBatch = Array.isArray(payload) ? payload.length : 0
    let last, sawRange = false, sawRate = false
    for (const i of order(opts)) {
      if (nBatch && S[i].batchMax < nBatch) continue
      if (opts.window && S[i][opts.key] < opts.window) { sawRange = true; continue } // this mirror cannot serve that window
      const url = URLS[i]
      await pace(i)
      stats.requests++
      try {
        let r
        try { r = await post(url, body, opts.logs ? 45_000 : 25_000) } catch (e) {
          S[i].fails++; S[i].benchedUntil = Date.now() + Math.min(120_000, 10_000 * S[i].fails)
          benchNote(url, `${label || 'call'}: ${e.cause?.code || e.message}`)
          throw new Skip(`${url}: ${e.cause?.code || e.message}`)
        }
        const text = r.text
        if (r.status === 429 || (r.status >= 400 && RATE_LIMITED.test(text) && !RANGE.test(text))) {
          stats.rateLimited++; gap = Math.min(1500, Math.max(gap * 1.5, 50))
          S[i].lastAt = Date.now() + 1500 // back off this mirror
          sawRate = true
          throw new Skip(`${url}: rate limited`)
        }
        if (r.status >= 500 && !/^\s*[[{]/.test(text)) { S[i].benchedUntil = Date.now() + 60_000; benchNote(url, `${label || 'call'}: HTTP ${r.status}`); throw new Skip(`${url}: HTTP ${r.status}`) }
        let j
        try { j = JSON.parse(text) } catch {
          if (r.status === 403) S[i].benchedUntil = Date.now() + 600_000
          throw new Skip(`${url}: HTTP ${r.status} non-JSON`)
        }
        if (j && typeof j.error === 'string') {
          const msg = `${j.error}: ${j.message || ''}`
          throw Object.assign(new Skip(`${url}: ${msg.slice(0, 100)}`), { range: RANGE.test(msg) })
        }
        const out = judge(j, url, i)
        S[i].fails = 0
        if (gap > minGapMs) gap = Math.max(minGapMs, gap - 5)
        if (!opts.logs) preferred = i
        return out
      } catch (e) {
        last = e
        if (process.env.RPC_DEBUG === '1') console.log(`[rpc ${name}] ${label} ${URLS[i]} → ${String(e.message).slice(0, 140)}`)
        if (e instanceof Skip && e.rate) sawRate = true
        if (e instanceof Skip) { if (e.range) { sawRange = true; if (opts.onRange) opts.onRange(i, e.message) } continue }
        throw e
      } finally { release() }
    }
    stats.errors++
    throw Object.assign(new Error(`${name} ${label}: no mirror answered (${last?.message || last || 'none eligible'})`), { range: !!last?.range || sawRange, rateLimited: sawRate })
  }

  function judgeOne(method) {
    return (j, url) => {
      if (Array.isArray(j)) j = j[0]
      if (j?.error) {
        const msg = String(j.error.message ?? '')
        const revert = /revert/i.test(msg) || j.error.code === 3
        if (!revert && RANGE.test(msg)) throw Object.assign(new Skip(`${url}: ${msg.slice(0, 160)}`), { range: true })
        if (!revert && RATE_LIMITED.test(msg)) { stats.rateLimited++; throw Object.assign(new Skip(`${url}: ${msg.slice(0, 80)}`), { rate: true }) }
        if (!revert && REFUSED.test(msg)) throw new Skip(`${url} refuses ${method}: ${msg.slice(0, 80)}`)
        throw rpcError(method, j.error)
      }
      if (!j || !('result' in j)) throw new Skip(`${url}: malformed answer`)
      return j.result
    }
  }

  /** One call. Throws the node's answer for real errors (e.rpc = {code, message, data}). */
  async function rpc(method, params = [], opts = {}) {
    stats.calls++
    let last
    for (let round = 0; round < (opts.rounds ?? 3); round++) {
      try { return await send({ jsonrpc: '2.0', id: ++id, method, params }, method, judgeOne(method), opts) } catch (e) {
        last = e
        if (e.rpc || e.range || !/no mirror answered/.test(e.message)) throw e
        await sleep(700 * (round + 1) * (e.rateLimited ? 2 : 1))
      }
    }
    throw last
  }

  /** JSON-RPC batch: [{method, params}] → [{result} | {error}] in order; a refused batch falls back to single calls. */
  async function rpcBatch(calls, opts = {}) {
    const out = []
    const eligible = URLS.map((_, i) => i).filter((i) => !isBenched(i))
    const cap = Math.max(1, opts.chunk || Math.max(1, ...eligible.map((i) => S[i].batchMax)))
    for (let k = 0; k < calls.length; k += cap) {
      const chunk = calls.slice(k, k + cap)
      if (chunk.length === 1) {
        try { out.push({ result: await rpc(chunk[0].method, chunk[0].params || [], opts) }) } catch (e) { if (!e.rpc && !/no mirror/.test(e.message)) throw e; out.push({ error: e }) }
        continue
      }
      const payload = chunk.map((c) => ({ jsonrpc: '2.0', id: ++id, method: c.method, params: c.params || [] }))
      stats.calls += chunk.length
      let res
      try {
        res = await send(payload, `batch(${chunk.length})`, (j, url) => {
          if (!Array.isArray(j)) throw new Skip(`${url}: ${String(j?.error?.message || 'not a batch answer').slice(0, 80)}`)
          const byId = new Map(j.map((x) => [x.id, x]))
          const items = payload.map((p) => byId.get(p.id) || { error: { message: 'missing in batch answer' } })
          const errs = items.filter((x) => x.error)
          if (errs.length && errs.some((x) => RATE_LIMITED.test(String(x.error.message)) || /batch/i.test(String(x.error.message)) || (REFUSED.test(String(x.error.message)) && !/revert/i.test(String(x.error.message))))) {
            throw new Skip(`${url}: batch refused (${String(errs[0].error.message).slice(0, 60)})`)
          }
          return items.map((x, i) => (x.error ? { error: rpcError(chunk[i].method, x.error) } : { result: x.result }))
        }, opts)
      } catch (e) {
        if (e.rpc) throw e
        res = []
        for (const c of chunk) { try { res.push({ result: await rpc(c.method, c.params || [], opts) }) } catch (e2) { res.push({ error: e2 }) } }
      }
      out.push(...res)
    }
    return out
  }

  const blockNumber = async () => Number(hexToBig(await rpc('eth_blockNumber', [])))
  /** Block header {number, hash, timestamp (s)} by number or 'latest'. */
  async function block(n = 'latest') {
    const b = await rpc('eth_getBlockByNumber', [n === 'latest' ? 'latest' : toQty(n), false])
    if (!b) throw new Error(`block ${n} not found`)
    return { number: Number(hexToBig(b.number)), hash: b.hash, timestamp: Number(hexToBig(b.timestamp)) }
  }
  /** eth_call of abi.functionName(args) → decoded result. */
  async function call(to, abi, functionName, args = [], { from, blockTag = 'latest' } = {}) {
    const data = encodeFunctionData({ abi, functionName, args })
    const res = await rpc('eth_call', [{ to, data, ...(from ? { from } : {}) }, blockTag])
    return decodeFunctionResult({ abi, functionName, data: res })
  }

  /**
   * eth_getLogs over [from, to] of any width: windows sized for the widest mirror, halved for a mirror that refuses the
   * range or answers "more than 10000 results"; ≤ 200 addresses per call. Raw logs in chain order.
   * opts.maxCalls caps the work (throws {partial: lastDone, logs} when hit — a data source that would hammer a narrow
   * mirror fails instead). onProgress(lastBlockDone, logsOfWindow) after every window.
   */
  async function getLogs(filter, from, to, { onProgress, maxCalls = Infinity, deadline = 0 } = {}) {
    const addrs = Array.isArray(filter.address) ? filter.address : filter.address ? [filter.address] : [null]
    if (!addrs.length || from > to) return []
    const noAddr = !addrs[0]
    const key = noAddr ? 'maxRangeNoAddr' : 'maxRange'
    const widest = () => Math.max(1, ...S.map((x) => x[key]))
    const groups = []
    for (let k = 0; k < addrs.length; k += 200) groups.push(addrs.slice(k, k + 200))
    const out = []
    let a = from, rangeFails = 0, rateFails = 0, calls = 0
    let win = widest()
    while (a <= to) {
      const cap = widest()
      if (win > cap) win = cap
      const b = Math.min(to, a + win - 1)
      const req = b - a + 1
      const got = []
      if (calls >= maxCalls || (deadline && Date.now() > deadline)) throw Object.assign(new Error(`getLogs: budget hit at block ${a - 1}`), { partial: a - 1, logs: out, budget: true })
      try {
        for (const g of groups) {
          calls++
          const f = { ...(g[0] ? { address: g.length === 1 ? g[0] : g } : {}), ...(filter.topics ? { topics: filter.topics } : {}), fromBlock: toQty(a), toBlock: toQty(b) }
          got.push(...await rpc('eth_getLogs', [f], {
            logs: true, window: req, key,
            onRange: (m, msg) => {
              const allowed = /only (\d+) are allowed|number of requested blocks is (\d+)/.exec(msg || '')
              if (allowed) S[m][key] = Math.min(S[m][key], Number(allowed[1] || allowed[2]))
              else if (!/exceeds limit|too many results|response size|query returned more than|more than \d+ results/i.test(msg || '') && req <= S[m][key]) S[m][key] = Math.max(5, Math.floor(req / 2))
            },
          }))
        }
      } catch (e) {
        if (e.rateLimited && ++rateFails < 8) { await sleep(1500 * rateFails); continue } // busy: wait, keep the window
        if (e.range && ++rangeFails < 30) { win = Math.max(1, Math.floor(req / 2)); continue } // retry the same start, smaller
        throw e
      }
      rangeFails = 0; rateFails = 0
      win = Math.min(widest(), win * 2)
      out.push(...got)
      a = b + 1
      if (onProgress) await onProgress(b, got)
    }
    out.sort((x, y) => Number(hexToBig(x.blockNumber) - hexToBig(y.blockNumber)) || Number(hexToBig(x.logIndex) - hexToBig(y.logIndex)))
    return out
  }

  const state = () => ({ name, mirrors: URLS.map((u) => new URL(u).hostname), preferred: new URL(URLS[preferred]).hostname, gapMs: gap, inFlight, ...stats, benched: URLS.filter((_, i) => isBenched(i)).map((u) => new URL(u).hostname) })

  return { rpc, rpcBatch, call, getLogs, blockNumber, block, state, urls: URLS }
}

let _clients = null
/** The three shared clients (created lazily, so tests that never touch the network never build them). */
export function clients() {
  if (!_clients) _clients = { reads: createRpc(READ_URLS, { name: 'reads' }), logs: createRpc(LOG_URLS, { name: 'logs' }), tail: createRpc(TAIL_URLS, { name: 'tail' }) }
  return _clients
}
export const rpcState = () => (_clients ? { reads: _clients.reads.state(), logs: _clients.logs.state(), tail: _clients.tail.state(), pin: PIN_MODE, pinned: [...pinnedUntil].filter(([, t]) => t > Date.now()).map(([h]) => h), forced: [...FORCED.keys()] } : null)
