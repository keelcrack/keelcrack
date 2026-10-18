// All database writes + the API views (BRIEF "API"). One store per process; `preview` decides where /api/questions reads
// from: live → the board mirror (questions/commits from KeelBoard events), preview → the hourly preview questions (gen kind
// 'preview', id = gid, bounty 0, flagged preview).
import { eth, lower, median, modelTag, ZERO } from './lib/util.mjs'
import { kvGet, kvSet } from './db.mjs'
import { decodeAnswer, normalizeAnswer, canonicalQuestion } from './questions/canon.mjs'
import { textHash } from './questions/hash.mjs'
import { assemble } from './questions/index.mjs'
import { BOARD } from './config.mjs'

const STATUS = { 1: 'open', 2: 'solved', 3: 'unsolved' }
const STATUS_N = { open: 1, solved: 2, unsolved: 3 }
const RANGES = { '24h': 86_400_000, '7d': 7 * 86_400_000, all: Infinity }
const big = (v) => BigInt(v ?? 0)
const j = (s, d = null) => { try { return s == null ? d : JSON.parse(s) } catch { return d } }

export function createStore(db, { preview = true, box, emit = () => {}, now = () => Date.now() } = {}) {
  const live = { stats: null, minBondWei: BOARD.MIN_BOND_WEI, block: null, nextDripAt: null, paused: false, token: null }
  const out = (o) => ({ ...o, preview })
  const secretCache = new Map()
  function secretOf(g) {
    if (secretCache.has(g.gid)) return secretCache.get(g.gid)
    const s = box.open(g.secret)
    if (secretCache.size > 500) secretCache.delete(secretCache.keys().next().value)
    secretCache.set(g.gid, s)
    return s
  }

  // ---------------------------------------------------------------- generated questions
  const genCols = ['kind', 'qid', 'hour', 'template', 'tier', 'title', 'prompt', 'window', 'answer_format', 'unit', 'hints', 'question', 'text_hash', 'answer_hash', 'secret', 'created_at', 'posted_at', 'closes_at', 'practice', 'status']
  function insertGen(r) {
    const row = { ...r, window: JSON.stringify(r.window), hints: JSON.stringify(r.hints || []) }
    const res = db.prepare(`INSERT INTO gen (${genCols.join(',')}) VALUES (${genCols.map(() => '?').join(',')})`).run(...genCols.map((c) => row[c] ?? null))
    return Number(res.lastInsertRowid)
  }
  function updateGen(gid, fields) {
    const ks = Object.keys(fields)
    if (!ks.length) return
    db.prepare(`UPDATE gen SET ${ks.map((k) => `${k} = ?`).join(', ')} WHERE gid = ?`).run(...ks.map((k) => fields[k] ?? null), gid)
    secretCache.delete(gid)
  }
  const genRow = (gid) => db.prepare('SELECT * FROM gen WHERE gid = ?').get(gid)
  const genByQid = (qid) => db.prepare('SELECT * FROM gen WHERE qid = ?').get(qid)
  const genByHour = (kind, hour) => db.prepare('SELECT * FROM gen WHERE kind = ? AND hour = ? ORDER BY gid DESC LIMIT 1').get(kind, hour)

  /** A generated question + its secret → stored row. kind 'preview' gets id = gid (canonical JSON written after insert). */
  function storePreview(g, { postedAt, closesAt }) {
    const secret = box.seal({ answer: g.answer, answerBytes32: g.answerBytes32, salt: null, work: g.work, generatedAt: g.generatedAt })
    const gid = insertGen({ kind: 'preview', qid: null, hour: g.hour, template: g.template, tier: g.tier, title: g.title, prompt: g.prompt, window: g.window, answer_format: g.answerFormat, unit: g.unit, hints: g.hints, secret, created_at: now(), posted_at: postedAt, closes_at: closesAt, practice: 1, status: 'preview' })
    const q = assemble(g, { id: gid, postedAt, closesAt })
    const cq = canonicalQuestion(q)
    updateGen(gid, { question: cq, text_hash: textHash(cq) })
    return gid
  }

  /** Publish answer + salt + working of a closed question (gen row): decrypt → plaintext columns, practice pool. */
  function openGen(gid, { salt = null } = {}) {
    const g = genRow(gid)
    if (!g || g.opened_at) return g
    const s = secretOf(g)
    const working = { id: g.qid ?? g.gid, answer: s.answer, answerBytes32: s.answerBytes32, salt: salt ?? s.salt ?? null, method: s.work.method, sources: s.work.sources, items: s.work.items, computedAt: s.generatedAt ?? g.created_at }
    updateGen(gid, { answer: s.answer, salt: working.salt, working: JSON.stringify(working), opened_at: now(), practice: 1, status: g.kind === 'live' ? 'closed' : g.status })
    return genRow(gid)
  }
  /** Preview questions past closesAt → working public. */
  function openExpiredPreview() {
    const rows = db.prepare("SELECT gid FROM gen WHERE kind = 'preview' AND opened_at IS NULL AND closes_at <= ?").all(now())
    for (const r of rows) openGen(r.gid)
    return rows.length
  }

  // ---------------------------------------------------------------- board mirror
  const qRow = (id) => db.prepare('SELECT * FROM questions WHERE id = ?').get(id)
  function ledger(e) {
    try {
      db.prepare('INSERT OR IGNORE INTO ledger (t, kind, qid, amount_wei, from_addr, tx, block, log_index, extra) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(e.t, e.kind, e.qid ?? null, e.amountWei != null ? String(e.amountWei) : null, e.from ?? null, e.tx ?? null, e.block ?? null, e.logIndex ?? null, e.extra ? JSON.stringify(e.extra) : null)
    } catch {}
  }
  const loadPoint = (qid, t, wei) => db.prepare('INSERT INTO load_points (qid, t, load_wei) VALUES (?,?,?)').run(qid, t, String(wei))

  /** Apply one decoded KeelBoard event (idempotent per (tx, logIndex) through the ledger / primary keys). t = block time ms. */
  function applyEvent(ev, t) {
    const a = ev.args || {}, txh = ev.transactionHash, li = ev.logIndex
    const seen = txh && db.prepare('SELECT 1 FROM kv WHERE k = ?').get(`ev:${txh}:${li}`)
    if (seen) return false
    if (txh) db.prepare('INSERT OR IGNORE INTO kv (k, v) VALUES (?, ?)').run(`ev:${txh}:${li}`, String(t))
    const base = { t, tx: txh, block: ev.blockNumber, logIndex: li }
    switch (ev.eventName) {
      case 'Posted': {
        const id = Number(a.id)
        const g = genByQid(id)
        db.prepare('INSERT OR IGNORE INTO questions (id, gid, tier, status, answer_hash, text_hash, posted_at, closes_at, load_wei, post_tx) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(id, g?.gid ?? null, Number(a.tier), 1, a.answerHash, a.textHash, t, Number(a.closesAt) * 1000, '0', txh)
        loadPoint(id, t, 0n)
        ledger({ ...base, kind: 'posted', qid: id })
        emit('posted', qItem(qRow(id)))
        return true
      }
      case 'Committed': {
        const id = Number(a.id), i = Number(a.i)
        db.prepare('INSERT OR IGNORE INTO commits (id, i, solver, hash, at, bond_wei, model, model_raw, commit_tx) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(id, i, lower(a.solver), a.hash, t, String(a.bond), modelTag(a.model), a.model, txh)
        db.prepare('UPDATE questions SET commits = (SELECT COUNT(*) FROM commits WHERE id = ?) WHERE id = ?').run(id, id)
        ledger({ ...base, kind: 'commit', qid: id, amountWei: a.bond, from: lower(a.solver), extra: { i, model: modelTag(a.model) } })
        emit('commit', out({ id, i, solver: lower(a.solver), model: modelTag(a.model), bondWei: String(a.bond), bondEth: eth(a.bond), at: t }))
        return true
      }
      case 'Revealed': {
        const id = Number(a.id), i = Number(a.i)
        db.prepare('UPDATE commits SET revealed = 1, answer_b32 = ?, revealed_at = ?, reveal_tx = ? WHERE id = ? AND i = ?').run(a.answer, t, txh, id, i)
        db.prepare('UPDATE questions SET reveals = (SELECT COUNT(*) FROM commits WHERE id = ? AND revealed = 1) WHERE id = ?').run(id, id)
        ledger({ ...base, kind: 'reveal', qid: id, from: lower(a.solver), extra: { i } })
        emit('reveal', out({ id, i, solver: lower(a.solver), answer: answerText(id, a.answer), at: t }))
        return true
      }
      case 'Settled': {
        const id = Number(a.id)
        const solved = lower(a.winner) !== ZERO
        db.prepare('UPDATE questions SET status = ?, winner = ?, winner_index = ?, amount_wei = ?, answer_b32 = ?, salt = ?, settled_at = ?, settle_tx = ? WHERE id = ?')
          .run(solved ? 2 : 3, solved ? lower(a.winner) : null, solved ? Number(a.winnerIndex) : null, String(a.amount), a.answer, a.salt, t, txh, id)
        const g = genByQid(id)
        if (g) openGen(g.gid, { salt: a.salt })
        ledger({ ...base, kind: 'settled', qid: id, amountWei: a.amount, from: solved ? lower(a.winner) : null, extra: { solved } })
        emit('settled', qItem(qRow(id)))
        return true
      }
      case 'Abandoned': {
        const id = Number(a.id)
        db.prepare('UPDATE questions SET status = 3, abandoned = 1, settled_at = ? WHERE id = ?').run(t, id)
        ledger({ ...base, kind: 'settled', qid: id, amountWei: 0n, extra: { abandoned: true } })
        emit('settled', qItem(qRow(id)))
        return true
      }
      case 'Dripped': {
        const per = big(a.perQuestion)
        const open = db.prepare('SELECT id, load_wei FROM questions WHERE status = 1 AND closes_at > ?').all(t)
        for (const q of open) { const nl = big(q.load_wei) + per; db.prepare('UPDATE questions SET load_wei = ? WHERE id = ?').run(String(nl), q.id); loadPoint(q.id, t, nl) }
        ledger({ ...base, kind: 'drip', amountWei: a.total, extra: { perQuestionWei: String(per), count: Number(a.count) } })
        emit('drip', out({ totalWei: String(a.total), totalEth: eth(a.total), perQuestionWei: String(per), perQuestionEth: eth(per), count: Number(a.count), t }))
        return true
      }
      case 'ToppedUp': {
        const id = Number(a.id)
        const q = qRow(id)
        if (q) { const nl = big(q.load_wei) + big(a.amount); db.prepare('UPDATE questions SET load_wei = ? WHERE id = ?').run(String(nl), id); loadPoint(id, t, nl) }
        ledger({ ...base, kind: 'topup', qid: id, amountWei: a.amount, from: lower(a.from) })
        emit('topup', out({ id, from: lower(a.from), amountWei: String(a.amount), amountEth: eth(a.amount), loadEth: q ? eth(big(q.load_wei) + big(a.amount)) : null, t }))
        return true
      }
      case 'Harvested': {
        ledger({ ...base, kind: 'harvest', amountWei: a.amount, extra: { toPoolWei: String(a.toPool), toInfraWei: String(a.toInfra) } })
        emit('harvest', out({ amountWei: String(a.amount), amountEth: eth(a.amount), toPoolEth: eth(a.toPool), toInfraEth: eth(a.toInfra), t }))
        return true
      }
      case 'Claimed': {
        ledger({ ...base, kind: 'claim', amountWei: a.amount, from: lower(a.to) })
        return true
      }
    }
    return false
  }
  /** Chain truth for an open question's load (reconcile drift). */
  function setLoad(id, wei, t = now()) {
    const q = qRow(id)
    if (!q || big(q.load_wei) === big(wei)) return
    db.prepare('UPDATE questions SET load_wei = ? WHERE id = ?').run(String(wei), id)
    loadPoint(id, t, wei)
  }

  // ---------------------------------------------------------------- views
  function answerText(id, b32) {
    const g = genByQid(id)
    if (!g || !b32) return b32 ?? null
    try { return decodeAnswer(g.answer_format, b32) } catch { return b32 }
  }
  const bondFor = (loadWei) => { const b = (big(loadWei) * BigInt(BOARD.BOND_BPS)) / 10_000n; return b > live.minBondWei ? b : live.minBondWei }
  const age = (postedAt) => (postedAt ? Math.round(((now() - postedAt) / 3_600_000) * 10) / 10 : null)

  /** QItem (live) from a questions row. */
  function qItem(q) {
    if (!q) return null
    const g = q.gid ? genRow(q.gid) : genByQid(q.id)
    const w = q.winner_index != null ? db.prepare('SELECT model, at FROM commits WHERE id = ? AND i = ?').get(q.id, q.winner_index) : null
    const status = STATUS[q.status] || 'open'
    return out({
      id: q.id, tier: q.tier, template: g?.template ?? null, title: g?.title ?? `Question #${q.id}`, prompt: g?.prompt ?? null,
      window: g ? j(g.window) : null, answerFormat: g?.answer_format ?? null, unit: g?.unit ?? null, status,
      loadWei: q.load_wei, loadEth: eth(q.load_wei), bondWei: status === 'open' ? String(bondFor(q.load_wei)) : null,
      postedAt: g?.posted_at ?? q.posted_at, closesAt: q.closes_at, ageHours: age(q.posted_at), commits: q.commits, reveals: q.reveals,
      winner: q.winner ?? null, winnerModel: w ? w.model || null : null, solveSeconds: w ? Math.max(0, Math.round((w.at - q.posted_at) / 1000)) : null,
      textHash: q.text_hash, amountEth: q.amount_wei ? eth(q.amount_wei) : null,
    })
  }
  /** QItem (preview) from a gen row. */
  function previewItem(g) {
    const status = g.closes_at > now() ? 'open' : 'unsolved'
    return out({
      id: g.gid, pid: g.gid, tier: g.tier, template: g.template, title: g.title, prompt: g.prompt, window: j(g.window), answerFormat: g.answer_format, unit: g.unit, status,
      loadWei: '0', loadEth: 0, bondWei: status === 'open' ? String(live.minBondWei) : null, postedAt: g.posted_at, closesAt: g.closes_at, ageHours: age(g.posted_at),
      commits: 0, reveals: 0, winner: null, winnerModel: null, solveSeconds: null, textHash: g.text_hash ?? null,
    })
  }

  function questionsView({ status = 'all', limit = 50 } = {}) {
    limit = Math.max(1, Math.min(200, Number(limit) || 50))
    if (preview) {
      let rows = db.prepare("SELECT * FROM gen WHERE kind = 'preview' AND question IS NOT NULL ORDER BY gid DESC LIMIT ?").all(status === 'all' ? limit : 500).map(previewItem)
      if (status !== 'all') rows = rows.filter((r) => r.status === status).slice(0, limit)
      return out({ items: rows })
    }
    const where = status === 'all' ? '' : 'WHERE status = ?'
    const rows = db.prepare(`SELECT * FROM questions ${where} ORDER BY id DESC LIMIT ?`).all(...(status === 'all' ? [] : [STATUS_N[status]]), limit)
    return out({ items: rows.map(qItem) })
  }

  function qView(id) {
    if (preview) {
      const g = db.prepare("SELECT * FROM gen WHERE gid = ? AND kind = 'preview'").get(id)
      if (!g) return null
      return { ...previewItem(g), hints: j(g.hints, []), question: g.question, commits: [], loadHistory: [], working: g.opened_at ? j(g.working) : null }
    }
    const q = qRow(id)
    if (!q) return null
    const g = q.gid ? genRow(q.gid) : genByQid(id)
    const commits = db.prepare('SELECT * FROM commits WHERE id = ? ORDER BY i').all(id).map((c) => ({
      i: c.i, solver: c.solver, at: c.at, model: c.model || null, bondWei: c.bond_wei, revealed: !!c.revealed,
      ...(c.revealed ? { answer: answerText(id, c.answer_b32), correct: q.answer_b32 ? c.answer_b32 === q.answer_b32 : null } : {}), tx: c.commit_tx,
    }))
    const loadHistory = db.prepare('SELECT t, load_wei FROM load_points WHERE qid = ? ORDER BY t').all(id).map((p) => ({ t: p.t, loadEth: eth(p.load_wei) }))
    const closed = q.status !== 1
    let working = closed && g?.working ? j(g.working) : null
    if (closed && !working && q.answer_b32) working = { id, answer: answerText(id, q.answer_b32), answerBytes32: q.answer_b32, salt: q.salt, method: null, sources: [], items: [], computedAt: null }
    return { ...qItem(q), hints: g ? j(g.hints, []) : [], question: g?.question ?? null, commits, loadHistory, working, postTx: q.post_tx, settleTx: q.settle_tx }
  }

  function leaderboard({ by = 'model', range = 'all' } = {}) {
    const since = Number.isFinite(RANGES[range]) ? now() - RANGES[range] : 0
    const key = by === 'wallet' ? 'solver' : 'model'
    const att = db.prepare(`SELECT ${key} AS k, COUNT(*) AS n FROM commits WHERE at >= ? GROUP BY ${key}`).all(since)
    const wins = db.prepare(`SELECT c.${key} AS k, q.amount_wei AS amt, c.at AS cat, q.posted_at AS pat FROM questions q JOIN commits c ON c.id = q.id AND c.i = q.winner_index WHERE q.status = 2 AND q.settled_at >= ?`).all(since)
    const m = new Map()
    const row = (k) => { const kk = k || (by === 'model' ? 'undeclared' : k); if (!m.has(kk)) m.set(kk, { key: kk, cracked: 0, attempts: 0, paidWei: 0n, solve: [] }); return m.get(kk) }
    for (const a of att) row(a.k).attempts += a.n
    for (const w of wins) { const r = row(w.k); r.cracked++; r.paidWei += big(w.amt); r.solve.push((w.cat - w.pat) / 1000) }
    const items = [...m.values()].map((r) => ({ key: r.key, cracked: r.cracked, attempts: r.attempts, paidEth: eth(r.paidWei), medianSolveSeconds: r.solve.length ? Math.round(median(r.solve)) : null }))
      .sort((a, b) => b.cracked - a.cracked || b.paidEth - a.paidEth || a.attempts - b.attempts || String(a.key).localeCompare(String(b.key)))
    return out({ by: by === 'wallet' ? 'wallet' : 'model', range, items })
  }

  function practiceList({ limit = 100 } = {}) {
    limit = Math.max(1, Math.min(500, Number(limit) || 100))
    const rows = db.prepare('SELECT gid, kind, qid, tier, template, title, prompt, window, answer_format, unit, posted_at FROM gen WHERE practice = 1 AND question IS NOT NULL ORDER BY gid DESC LIMIT ?').all(limit)
    return out({ items: rows.map((g) => ({ pid: g.gid, tier: g.tier, title: g.title, prompt: g.prompt, window: j(g.window), answerFormat: g.answer_format, unit: g.unit, template: g.template, postedAt: g.posted_at, source: g.kind, id: g.qid ?? null })) })
  }
  /** → {correct, hint?} | null (no such practice question). */
  function practiceCheck(pid, input) {
    const g = db.prepare('SELECT * FROM gen WHERE gid = ? AND practice = 1').get(pid)
    if (!g) return null
    let a
    try { a = normalizeAnswer(g.answer_format, input) } catch (e) { return { correct: false, hint: e.message.replace(/^bad answer: /, '') } }
    const truth = g.answer ?? secretOf(g).answer
    if (a === truth) return { correct: true }
    let hint
    if (g.answer_format === 'uint') {
      const x = BigInt(a), t = BigInt(truth)
      const d = x > t ? x - t : t - x
      if (t > 0n && d * 100n <= t) hint = 'close: within 1%'
    }
    return hint ? { correct: false, hint } : { correct: false }
  }

  function ledgerView({ limit = 100 } = {}) {
    limit = Math.max(1, Math.min(500, Number(limit) || 100))
    const rows = db.prepare('SELECT * FROM ledger ORDER BY t DESC, n DESC LIMIT ?').all(limit)
    return out({ items: rows.map((r) => ({ t: r.t, kind: r.kind, ...(r.qid != null ? { id: r.qid } : {}), ...(r.amount_wei != null ? { amountEth: eth(r.amount_wei), amountWei: r.amount_wei } : {}), ...(r.from_addr ? { from: r.from_addr } : {}), tx: r.tx, ...(r.extra ? { extra: j(r.extra) } : {}) })) })
  }

  function counts() {
    if (preview) {
      const c = db.prepare("SELECT SUM(closes_at > ?) AS open, SUM(closes_at <= ?) AS unsolved FROM gen WHERE kind = 'preview' AND question IS NOT NULL").get(now(), now())
      return { open: c.open || 0, solved: 0, unsolved: c.unsolved || 0 }
    }
    const c = db.prepare('SELECT SUM(status = 1) AS open, SUM(status = 2) AS solved, SUM(status = 3) AS unsolved FROM questions').get()
    return { open: c.open || 0, solved: c.solved || 0, unsolved: c.unsolved || 0 }
  }
  /** /api/state; extra = {launchAt, board, nextQuestionAt, block} from index.mjs. */
  function stateView(extra = {}) {
    const s = live.stats
    const w = (x) => ({ wei: String(x ?? 0n), eth: eth(x ?? 0n) })
    const lastDripAt = s?.lastDrip ? s.lastDrip * 1000 : null
    return out({
      launchAt: extra.launchAt ?? null, block: live.block ?? extra.block ?? null, board: extra.board ?? null,
      pool: w(s?.pool), infra: w(s?.infra), totalLoad: w(s?.totalLoad), ...counts(),
      lastDripAt, nextDripAt: live.nextDripAt ?? (lastDripAt ? (Math.floor(lastDripAt / 3_600_000) + 1) * 3_600_000 : null),
      nextQuestionAt: extra.nextQuestionAt ?? null, generating: !!extra.generating, minBondWei: String(live.minBondWei), paused: !!live.paused,
    })
  }
  const setLive = (o) => Object.assign(live, o)

  return {
    db, live, setLive, out, insertGen, updateGen, genRow, genByQid, genByHour, storePreview, openGen, openExpiredPreview, secretOf,
    applyEvent, setLoad, qRow, qItem, previewItem, questionsView, qView, leaderboard, practiceList, practiceCheck, ledgerView, stateView,
    counts, kvGet: (k, d) => kvGet(db, k, d), kvSet: (k, v) => kvSet(db, k, v), keeperLog: (action, qid, txh, status, note = null) =>
      db.prepare('INSERT INTO keeper_log (at, action, qid, tx, status, note) VALUES (?,?,?,?,?,?)').run(now(), action, qid ?? null, txh ?? null, status, note),
  }
}
