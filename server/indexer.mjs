// RC data indexer: the logs the question templates read, stored in sqlite (rc_logs) with the block ranges each source
// covers (rc_cover), so a window is fetched once (1–3 eth_getLogs per source per hour on the official RPC) and every later
// read (dry runs, practice, the working) is local. Pruned after RC_KEEP_HOURS (72 h).
//   blockAt(ts)            first block with timestamp ≥ ts (unix s): interpolation from the head, then batched bisection
//                          (≈ 4 JSON-RPC batches), cached forever in rc_blocks
//   window(hour, span = 1) {fromBlock, toBlock, fromTime, toTime, fromTs, toTs}: [first block ≥ start, first block ≥ end − 1]
//                          of the `span` hours ending at the end of `hour` (unix hour number); only once the head is past the end
//   ensure(src, from, to)  fetch the uncovered parts of [from, to] for a source (budgeted: a source that would need more than
//                          RC_MAX_CALLS calls fails → the generator skips the templates that need it)
//   logs(src, from, to)    stored logs, chain order: {block, logIndex, tx, address, topics, data}
import { SOURCES } from './questions/sources.mjs'
import { log, isoS, sleep } from './lib/util.mjs'
import { hexToBig, toQty } from './lib/rpc.mjs'

const KEEP_HOURS = Number(process.env.RC_KEEP_HOURS) || 72
const MAX_CALLS = Number(process.env.RC_MAX_CALLS) || 40
export const FINAL_LAG_S = Number(process.env.RC_FINAL_LAG_S) || 20 // the head must be this far past a window's end

export function createRcData({ db, rpc, now = () => Date.now(), maxCalls = MAX_CALLS }) {
  const insLog = db.prepare('INSERT OR IGNORE INTO rc_logs (block, log_index, src, tx, address, topic0, topics, data) VALUES (?,?,?,?,?,?,?,?)')
  const st = { lastError: null, fetched: 0, calls: 0 }

  // ---------------------------------------------------------------- blocks by time
  const getCached = (ts) => db.prepare('SELECT block FROM rc_blocks WHERE ts = ?').get(ts)?.block ?? null
  async function header(n) { const b = await rpc.block(n); return b }
  let headCache = { at: 0, b: null }
  async function head() {
    if (headCache.b && now() - headCache.at < 3000) return headCache.b
    headCache = { at: now(), b: await header('latest') }
    return headCache.b
  }

  async function blockAt(ts) {
    const c = getCached(ts)
    if (c != null) return c
    const h = await head()
    if (h.timestamp < ts) throw Object.assign(new Error(`chain head (${isoS(h.timestamp * 1000)}) is before ${isoS(ts * 1000)}`), { notYet: true })
    // bracket from the cache: nearest known boundaries around ts
    const below = db.prepare('SELECT ts, block FROM rc_blocks WHERE ts < ? ORDER BY ts DESC LIMIT 1').get(ts)
    const above = db.prepare('SELECT ts, block FROM rc_blocks WHERE ts > ? ORDER BY ts ASC LIMIT 1').get(ts)
    let lo = below ? below.block - 1 : null, loT = below ? below.ts - 1 : null // below.block - 1 has timestamp < below.ts ≤ … < ts
    let hi = above ? above.block : h.number, hiT = above ? above.ts : h.timestamp
    if (lo == null) {
      // interpolate from the head (RC ≈ 10 blocks/s); step back until a block before ts is found
      let rate = 10, guess = hi - Math.ceil((hiT - ts) * rate) - 200
      for (let k = 0; k < 12 && lo == null; k++) {
        const g = Math.max(0, guess)
        const b = await header(g)
        if (b.timestamp < ts) { lo = b.number; loT = b.timestamp } else {
          hi = b.number; hiT = b.timestamp
          if (g === 0) return 0
          guess = hi - Math.ceil((hiT - ts + 1) * rate * 1.6) - 500 * (k + 1)
        }
      }
      if (lo == null) throw new Error(`blockAt(${ts}): could not bracket`)
    }
    // interpolation probe inside the bracket, then batched bisection
    for (let round = 0; round < 30 && hi - lo > 1; round++) {
      const span = hi - lo - 1
      const n = Math.min(24, span)
      const pts = []
      if (round === 0 && hiT > loT && span > 200) {
        const est = lo + Math.floor(((ts - loT) / (hiT - loT)) * (hi - lo))
        for (let k = -n / 2; k < n / 2; k++) pts.push(Math.min(hi - 1, Math.max(lo + 1, est + k * 40)))
      } else for (let k = 1; k <= n; k++) pts.push(lo + Math.round((k * (span + 1)) / (n + 1)))
      const uniq = [...new Set(pts)].filter((p) => p > lo && p < hi).sort((a, b) => a - b)
      const res = await rpc.rpcBatch(uniq.map((p) => ({ method: 'eth_getBlockByNumber', params: [toQty(p), false] })))
      for (let k = 0; k < uniq.length; k++) {
        const r = res[k]
        if (r.error || !r.result) throw r.error || new Error(`block ${uniq[k]} missing`)
        const t = Number(hexToBig(r.result.timestamp))
        if (t < ts) { lo = uniq[k]; loT = t } else { hi = uniq[k]; hiT = t; break }
      }
    }
    db.prepare('INSERT OR REPLACE INTO rc_blocks (ts, block) VALUES (?, ?)').run(ts, hi)
    return hi
  }

  /** The `span` hours ending at the end of hour `hour`. */
  async function window(hour, span = 1) {
    const fromTs = (hour - span + 1) * 3600, toTs = (hour + 1) * 3600
    const h = await head()
    if (h.timestamp < toTs + FINAL_LAG_S) throw Object.assign(new Error(`window ${isoS(toTs * 1000)} not closed yet (head ${isoS(h.timestamp * 1000)})`), { notYet: true })
    const fromBlock = await blockAt(fromTs)
    const toBlock = (await blockAt(toTs)) - 1
    return { hour, span, fromBlock, toBlock, fromTs, toTs, fromTime: isoS(fromTs * 1000), toTime: isoS(toTs * 1000) }
  }

  // ---------------------------------------------------------------- coverage
  const covers = (src) => db.prepare('SELECT from_block AS a, to_block AS b FROM rc_cover WHERE src = ? ORDER BY from_block').all(src)
  function gaps(src, from, to) {
    const out = []
    let a = from
    for (const c of covers(src)) {
      if (c.b < a) continue
      if (c.a > to) break
      if (c.a > a) out.push([a, Math.min(to, c.a - 1)])
      a = Math.max(a, c.b + 1)
      if (a > to) break
    }
    if (a <= to) out.push([a, to])
    return out
  }
  function addCover(src, a, b) {
    const all = covers(src).concat([{ a, b }]).sort((x, y) => x.a - y.a)
    const merged = []
    for (const c of all) { const m = merged.at(-1); if (m && c.a <= m.b + 1) m.b = Math.max(m.b, c.b); else merged.push({ ...c }) }
    db.exec('BEGIN')
    try {
      db.prepare('DELETE FROM rc_cover WHERE src = ?').run(src)
      const ins = db.prepare('INSERT INTO rc_cover (src, from_block, to_block) VALUES (?,?,?)')
      for (const m of merged) ins.run(src, m.a, m.b)
      db.exec('COMMIT')
    } catch (e) { db.exec('ROLLBACK'); throw e }
  }
  const covered = (src, from, to) => gaps(src, from, to).length === 0

  const busy = new Map()
  /** Fetch [from, to] of `src` (only the uncovered parts). Concurrent calls for the same source wait for each other. */
  async function ensure(src, from, to) {
    const s = SOURCES[src]
    if (!s) throw new Error(`unknown source ${src}`)
    while (busy.get(src)) await busy.get(src).catch(() => {})
    const p = (async () => {
      for (const [a, b] of gaps(src, from, to)) {
        const calls0 = rpc.state().requests
        const got = await rpc.getLogs({ address: s.address, topics: s.topics }, a, b, { maxCalls })
        st.calls += rpc.state().requests - calls0
        db.exec('BEGIN')
        try {
          for (const l of got) insLog.run(Number(hexToBig(l.blockNumber)), Number(hexToBig(l.logIndex)), src, l.transactionHash, l.address.toLowerCase(), l.topics[0] || null, JSON.stringify(l.topics), l.data)
          db.exec('COMMIT')
        } catch (e) { db.exec('ROLLBACK'); throw e }
        addCover(src, a, b)
        st.fetched += got.length
      }
    })()
    busy.set(src, p)
    try { await p } catch (e) { st.lastError = `${src}: ${String(e.message).slice(0, 160)}`; throw e } finally { busy.delete(src) }
  }

  function logs(src, from, to) {
    return db.prepare('SELECT block, log_index, tx, address, topics, data FROM rc_logs WHERE src = ? AND block BETWEEN ? AND ? ORDER BY block, log_index').all(src, from, to)
      .map((r) => ({ block: r.block, logIndex: r.log_index, tx: r.tx, address: r.address, topics: JSON.parse(r.topics), data: r.data }))
  }

  /** Drop logs (and coverage) older than KEEP_HOURS before the head. */
  async function prune() {
    const h = await head()
    const keep = await blockAt(Math.floor(h.timestamp / 3600) * 3600 - KEEP_HOURS * 3600).catch(() => null)
    if (keep == null) return 0
    const n = db.prepare('DELETE FROM rc_logs WHERE block < ?').run(keep).changes
    for (const src of Object.keys(SOURCES)) {
      const cs = covers(src)
      if (cs.some((c) => c.a < keep)) {
        db.prepare('DELETE FROM rc_cover WHERE src = ? AND to_block < ?').run(src, keep)
        db.prepare('UPDATE rc_cover SET from_block = ? WHERE src = ? AND from_block < ?').run(keep, src, keep)
      }
    }
    if (n) log(`rc data: pruned ${n} logs before block ${keep}`)
    return n
  }

  return { head, blockAt, window, ensure, logs, covered, gaps, prune, state: () => ({ ...st }), sleep }
}

/** A read-only data adapter over a recorded fixture (tests, offline dry runs): same `logs` + `window` surface. */
export function fixtureData(fx) {
  const bySrc = fx.logs
  return {
    window: async (hour, span = 1) => {
      const w = fx.windows?.[`${hour}:${span}`]
      if (!w) throw new Error(`fixture has no window ${hour}:${span}`)
      return w
    },
    ensure: async (src) => { if (!bySrc[src]) throw new Error(`fixture has no source ${src}`) },
    logs: (src, from, to) => (bySrc[src] || []).filter((l) => l.block >= from && l.block <= to),
    covered: (src) => !!bySrc[src],
  }
}
