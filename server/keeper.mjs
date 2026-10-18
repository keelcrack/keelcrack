// Keeper (BRIEF "Keeper"), live mode with the poster key. One tick every KEEPER_MS (15 s):
//   1. read the board (stats, nextDripAt, open ids) → /api/state; tail its events (board.mjs)
//   2. post — once per hour, from hh:00 + POST_DELAY (45 s) until hh:50: the window = the hour that just ended; generate
//      (rotation, a template whose data source failed is skipped), id = stats().count + 1, postedAt = now, closesAt =
//      postedAt + 24 h, textHash = keccak(canonical JSON), salt = 32 random bytes, answerHash = keccak(abi.encode(id,
//      answer, salt)); the answer, salt and working are sealed (AES-GCM, SALT_KEY) BEFORE the tx is sent; post(...)
//   3. drip() right after (and on any later tick while it is due and a question is still before its closesAt)
//   4. settle — for each Open question we hold the salt of: when a revealed answer equals ours, or once closesAt passed;
//      simulated first: EarlierCommitPending / NotClosed → retry next tick. The Settled event publishes answer + salt and
//      the store opens the working (practice pool).
//   5. harvest() every HARVEST_MS (10 min) when Pons fees ≥ HARVEST_MIN_WEI are pending (escrow + curve/hook)
//   6. every 5 min: re-read the load of open questions (drift from event replay)
// Without SALT_KEY in the environment the keeper never posts (salts must not be sealed with a file key on the VPS).
import { log, hourOf, HOUR_MS, eth } from './lib/util.mjs'
import { generate, assemble } from './questions/index.mjs'
import { canonicalQuestion } from './questions/canon.mjs'
import { textHash, answerHash, randomSalt } from './questions/hash.mjs'
import { SCHEDULE, BOARD } from './config.mjs'

export const KEEPER_MS = Number(process.env.KEEPER_MS) || 15_000
export const HARVEST_MS = Number(process.env.HARVEST_MS) || 10 * 60_000
const HARVEST_MIN = BigInt(process.env.HARVEST_MIN_WEI || '10000000000000') // 0.00001 ETH
const POST_LATEST_MS = 50 * 60_000
const RECONCILE_MS = 5 * 60_000
const SETTLE_GAP_MS = Number(process.env.SETTLE_GAP_MS ?? 10_000)

export function createKeeper({ store, chain, board, data, box, fees = null, enabled = true, canPost = true, now = () => Date.now(), schedule = SCHEDULE, generator = generate }) {
  const st = { enabled, canPost, lastRunAt: null, lastAction: store.kvGet('keeper.lastAction', null), lastError: null, counts: { post: 0, drip: 0, settle: 0, harvest: 0 }, waiting: {} }
  const act = (action, qid, txh, status, note = null) => {
    store.keeperLog(action, qid, txh, status, note)
    st.lastAction = { at: now(), action, qid: qid ?? null, status, tx: txh ?? null, ...(note ? { note } : {}) }
    store.kvSet('keeper.lastAction', st.lastAction)
  }
  const fail = (what, e) => { st.lastError = { at: now(), what, message: String(e?.message || e).slice(0, 240) }; log(`keeper ${what}: ${st.lastError.message}`) }

  let minBondRead = false
  async function readBoard() {
    const [stats, nextDrip, head, openIds] = await Promise.all([chain.stats(), chain.nextDripAt().catch(() => null), chain.head(), chain.openIds()])
    if (!minBondRead) { try { store.setLive({ minBondWei: await chain.minBond() }); minBondRead = true } catch {} }
    store.setLive({ stats, nextDripAt: nextDrip ? nextDrip * 1000 : null, block: head.number })
    return { stats, head, openIds, nextDripAt: nextDrip }
  }

  async function sendAndApply(fn, args, qid = null, opts = {}) {
    const r = await chain.send(fn, args, opts)
    if (r.dryRun) { act(fn, qid, null, 'dry-run'); return r }
    act(fn, qid, r.hash, 'sent')
    await board.applyOwn(r.events)
    return r
  }

  // ---------------------------------------------------------------- 2. post
  async function postDue(ctx) {
    if (!st.canPost) return null
    const t = now(), hour = hourOf(t) - 1, into = t - (hour + 1) * HOUR_MS
    if (into < schedule.postDelayMs || into > POST_LATEST_MS) return null
    const ex = store.genByHour('live', hour)
    if (ex && ex.status === 'posting') return resumePosting(ex)
    if (ex && ex.status !== 'failed') return null
    const tries = store.kvGet(`post.tries.${hour}`, 0)
    if (tries >= 3) return null
    if (ctx.openIds.length >= BOARD.MAX_OPEN) { if (!st.waiting.maxOpen) log('keeper: 48 questions open — not posting'); st.waiting.maxOpen = true; return null }
    st.waiting.maxOpen = false
    let g
    try { g = await generator({ data, hour, now }) } catch (e) {
      if (e.notYet) return null
      store.kvSet(`post.tries.${hour}`, tries + 1)
      fail(`generate hour ${hour}`, e)
      return null
    }
    const stats = await chain.stats()
    const id = stats.count + 1
    const postedAt = Math.floor(now() / 1000) * 1000, closesAt = postedAt + schedule.openHours * HOUR_MS
    const cq = canonicalQuestion(assemble(g, { id, postedAt, closesAt }))
    const th = textHash(cq), salt = randomSalt(), ah = answerHash(id, g.answerBytes32, salt)
    const secret = box.seal({ answer: g.answer, answerBytes32: g.answerBytes32, salt, work: g.work, generatedAt: g.generatedAt })
    const gid = store.insertGen({ kind: 'live', qid: id, hour, template: g.template, tier: g.tier, title: g.title, prompt: g.prompt, window: g.window, answer_format: g.answerFormat, unit: g.unit, hints: g.hints,
      question: cq, text_hash: th, answer_hash: ah, secret, created_at: now(), posted_at: postedAt, closes_at: closesAt, practice: 0, status: 'posting' })
    try {
      const r = await sendAndApply('post', [ah, th, g.tier, BigInt(closesAt / 1000)], id)
      if (r.dryRun) { store.updateGen(gid, { status: 'failed', qid: null }); return null }
      const posted = r.events.find((e) => e.eventName === 'Posted')
      if (posted && Number(posted.args.id) !== id) { store.updateGen(gid, { status: 'id-mismatch' }); fail('post', new Error(`posted id ${posted.args.id} ≠ predicted ${id}: text/answer hash refer to ${id}`)); return null }
      store.updateGen(gid, { status: 'posted' })
      st.counts.post++
      log(`posted #${id} [tier ${g.tier}] ${g.template} — ${g.title} (window ${g.window.fromBlock}–${g.window.toBlock})`)
      return id
    } catch (e) {
      if (e.simulated) { store.updateGen(gid, { status: 'failed', qid: null }); store.kvSet(`post.tries.${hour}`, tries + 1) }
      fail(`post #${id}`, e)
      return null
    }
  }
  /** A post whose outcome is unknown (crash / timeout): adopt it if the board has our answer hash at that id. */
  async function resumePosting(row) {
    const q = await chain.question(row.qid).catch(() => null)
    if (q && q.answerHash?.toLowerCase() === row.answer_hash.toLowerCase()) { store.updateGen(row.gid, { status: 'posted' }); await board.poll().catch(() => {}); return row.qid }
    if (now() - row.created_at > 3 * 60_000) { store.updateGen(row.gid, { status: 'failed', qid: null }); log(`keeper: post of hour ${row.hour} never landed — will retry`) }
    return null
  }

  // ---------------------------------------------------------------- 3. drip
  async function dripDue(ctx) {
    const t = now()
    if (ctx.nextDripAt != null && ctx.nextDripAt * 1000 > t) return false
    const live = store.db.prepare('SELECT COUNT(*) AS n FROM questions WHERE status = 1 AND closes_at > ?').get(t).n
    if (!live) return false
    const sim = await chain.simulate('drip', [])
    if (!sim.ok) { if (!['TooEarly', 'NothingOpen', 'IsPaused'].includes(sim.errorName)) fail('drip', new Error(sim.message)); return false }
    const r = await sendAndApply('drip', [])
    if (!r.dryRun) st.counts.drip++
    return !r.dryRun
  }

  // ---------------------------------------------------------------- 4. settle
  const lastTry = new Map()
  async function settleDue(ctx) {
    const t = now()
    let n = 0
    for (const id of ctx.openIds) {
      const g = store.genByQid(id)
      if (!g || g.kind !== 'live' || !['posted', 'posting'].includes(g.status)) continue
      const q = store.qRow(id)
      if (!q || q.status !== 1) continue
      let s
      try { s = store.secretOf(g) } catch (e) { fail(`secret #${id}`, e); continue }
      const correct = store.db.prepare('SELECT i FROM commits WHERE id = ? AND revealed = 1 AND lower(answer_b32) = ? ORDER BY i LIMIT 1').get(id, s.answerBytes32.toLowerCase())
      const closed = t >= q.closes_at
      if (!correct && !closed) continue
      if (t - (lastTry.get(id) || 0) < SETTLE_GAP_MS) continue
      lastTry.set(id, t)
      const args = [BigInt(id), s.answerBytes32, s.salt]
      const sim = await chain.simulate('settle', args)
      if (!sim.ok) {
        if (['EarlierCommitPending', 'NotClosed'].includes(sim.errorName)) { st.waiting[id] = sim.message; continue }
        fail(`settle #${id}`, new Error(sim.message)); continue
      }
      try {
        const r = await sendAndApply('settle', args, id)
        if (!r.dryRun) { st.counts.settle++; n++; delete st.waiting[id]; const ev = r.events.find((e) => e.eventName === 'Settled'); log(`settled #${id}: ${ev && ev.args.winner !== '0x0000000000000000000000000000000000000000' ? `cracked by ${ev.args.winner} (${eth(ev.args.amount)} ETH)` : 'unsolved'}`) }
      } catch (e) { fail(`settle #${id}`, e) }
    }
    return n
  }

  // ---------------------------------------------------------------- 5. harvest
  async function harvestDue(force = false) {
    if (!fees) return false
    const t = now(), last = store.kvGet('keeper.lastHarvestAt', 0)
    if (!force && t - last < HARVEST_MS) return false
    store.kvSet('keeper.lastHarvestAt', t)
    const p = await fees()
    if (p.totalWei < HARVEST_MIN) return false
    const r = await sendAndApply('harvest', [])
    if (!r.dryRun) st.counts.harvest++
    return !r.dryRun
  }

  // ---------------------------------------------------------------- 6. reconcile loads
  let lastRec = 0
  async function reconcile(ctx) {
    if (now() - lastRec < RECONCILE_MS) return
    lastRec = now()
    for (const id of ctx.openIds) { try { store.setLoad(id, (await chain.question(id)).load) } catch {} }
  }

  let busy = false
  async function tick() {
    if (busy) return
    busy = true
    st.lastRunAt = now()
    try {
      await board.poll().catch((e) => fail('board', e))
      const ctx = await readBoard()
      if (st.enabled) {
        try { if (await postDue(ctx)) Object.assign(ctx, await readBoard()) } catch (e) { fail('post', e) }
        try { await dripDue(ctx) } catch (e) { fail('drip', e) }
        try { await settleDue(ctx) } catch (e) { fail('settle', e) }
        try { await harvestDue() } catch (e) { fail('harvest', e) }
      }
      await reconcile(ctx).catch(() => {})
    } catch (e) { fail('tick', e) } finally { busy = false }
  }

  return { tick, postDue, dripDue, settleDue, harvestDue, readBoard, state: st }
}
