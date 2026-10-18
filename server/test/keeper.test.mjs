// Keeper lifecycle on the JS board model (test/mockboard.mjs) with recorded RC data: hourly post (hashes verifiable),
// drip, settle on a correct reveal (earliest correct commit; retry while an earlier commit is pending), unsolved at close,
// harvest when fees are pending, salts sealed until settle, working + practice afterwards, preview generator.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mockBoard } from './mockboard.mjs'
import { memStore, clock, loadFixture, fixtureFiles, anyHourData } from './helpers.mjs'
import { createKeeper } from '../keeper.mjs'
import { createBoardIndexer } from '../board.mjs'
import { createPreviewGenerator } from '../preview.mjs'
import { textHash, answerHash, commitHash, encodeAnswer, modelBytes32 } from '../questions/hash.mjs'
import { HOUR_MS } from '../lib/util.mjs'

const ETH = 10n ** 18n
const ALICE = '0x' + 'a1'.repeat(20), BOB = '0x' + 'b2'.repeat(20), CAROL = '0x' + 'c3'.repeat(20)
const N1 = '0x' + '01'.repeat(32), N2 = '0x' + '02'.repeat(32), N3 = '0x' + '03'.repeat(32)
const fx = loadFixture(fixtureFiles().at(-1))

test('post: hourly question with verifiable text/answer hashes; secret sealed; drip follows', async () => {
  const c = clock((fx.hour + 1) * HOUR_MS + 60_000)
  const m = mockBoard({ now: c.now })
  const ms = memStore({ preview: false, now: c.now })
  const board = createBoardIndexer({ chain: m.chain, store: ms.store, startBlock: 0 })
  const keeper = createKeeper({ store: ms.store, chain: m.chain, board, data: anyHourData(fx), box: ms.box, now: c.now })
  m.fund(1n * ETH)
  await keeper.tick()
  assert.equal(m.S.count, 1, 'posted')
  const g = ms.store.genByQid(1)
  assert.equal(g.status, 'posted')
  const q = m.S.q.get(1)
  // text hash = keccak(canonical JSON stored) ; JSON id/closesAt match the chain
  assert.equal(textHash(g.question), q.textHash)
  const qj = JSON.parse(g.question)
  assert.equal(qj.id, 1)
  assert.equal(Date.parse(qj.closesAt) / 1000, q.closesAt)
  assert.equal(q.closesAt - Math.floor(c.now() / 1000), 24 * 3600)
  assert.equal(qj.template, fx.expected[qj.template] ? qj.template : null)
  // answer hash = keccak(abi.encode(id, answer, salt)) with the sealed secret
  const s = ms.store.secretOf(g)
  assert.equal(s.answer, fx.expected[qj.template].answer)
  assert.equal(answerHash(1, s.answerBytes32, s.salt), q.answerHash)
  // nothing public before settle
  assert.equal(g.answer, null); assert.equal(g.salt, null); assert.equal(g.working, null); assert.equal(g.practice, 0)
  assert.ok(!g.secret.includes(s.salt.slice(2, 20)))
  const v = ms.store.qView(1)
  assert.equal(v.working, null)
  assert.equal(v.status, 'open')
  assert.equal(v.question, g.question)
  // drip ran after the post: 1% of the pool (0.8 ETH) onto the one open question
  assert.equal(q.load, (8n * ETH) / 10n / 100n)
  assert.equal(v.loadWei, String(q.load))
  assert.deepEqual(ms.events.map((e) => e[0]), ['posted', 'drip'])
  // a second tick in the same hour posts nothing and does not drip again
  c.add(60_000)
  await keeper.tick()
  assert.equal(m.S.count, 1)
  assert.equal(ms.events.filter((e) => e[0] === 'drip').length, 1)
})

test('settle: earliest correct reveal wins; retry while an earlier commit is pending; working + practice + leaderboard', async () => {
  const c = clock((fx.hour + 1) * HOUR_MS + 60_000)
  const m = mockBoard({ now: c.now })
  const ms = memStore({ preview: false, now: c.now })
  const board = createBoardIndexer({ chain: m.chain, store: ms.store, startBlock: 0 })
  const keeper = createKeeper({ store: ms.store, chain: m.chain, board, data: anyHourData(fx), box: ms.box, now: c.now })
  m.fund(1n * ETH)
  await keeper.tick()
  const g = ms.store.genByQid(1)
  const fmt = g.answer_format
  const s = ms.store.secretOf(g)
  const right = s.answerBytes32
  const wrong = encodeAnswer(fmt, fmt === 'uint' ? '1' : fmt === 'address' ? '0x' + '99'.repeat(20) : '0x' + '99'.repeat(32))
  const bond = m.bondFor(1)
  // alice commits first (will stay pending), bob commits right, carol commits wrong
  m.call(ALICE, 'commit', [1n, commitHash(1, ALICE, right, N1), modelBytes32('gpt-5')], bond)
  c.add(1000)
  m.call(BOB, 'commit', [1n, commitHash(1, BOB, right, N2), modelBytes32('claude-opus-4')], bond)
  m.call(CAROL, 'commit', [1n, commitHash(1, CAROL, wrong, N3), modelBytes32('claude-opus-4')], bond)
  c.add(2000)
  m.call(BOB, 'reveal', [1n, 1n, right, N2])
  m.call(CAROL, 'reveal', [1n, 2n, wrong, N3])
  await keeper.tick()
  assert.equal(m.S.q.get(1).status, 1, 'not settled: alice (index 0) still inside her reveal window')
  assert.match(keeper.state.waiting[1], /EarlierCommitPending\(0\)/)
  // alice never reveals → after her 10 min window bob is the earliest correct commit
  c.add(601_000)
  await keeper.tick()
  const q = m.S.q.get(1)
  assert.equal(q.status, 2)
  assert.equal(q.winner, BOB)
  assert.equal(m.S.owed.get(BOB), q.load + bond)
  const row = ms.store.qRow(1)
  assert.equal(row.status, 2); assert.equal(row.winner, BOB); assert.equal(row.salt, s.salt)
  // working + answer public, question in practice
  const v = ms.store.qView(1)
  assert.equal(v.status, 'solved'); assert.equal(v.winner, BOB); assert.equal(v.winnerModel, 'claude-opus-4')
  assert.equal(v.working.answer, s.answer); assert.equal(v.working.salt, s.salt); assert.ok(v.working.items.length > 0)
  assert.equal(v.commits.length, 3)
  assert.equal(v.commits[1].correct, true); assert.equal(v.commits[2].correct, false); assert.equal(v.commits[0].revealed, false)
  assert.ok(v.solveSeconds >= 1)
  assert.ok(ms.store.practiceList().items.some((p) => p.id === 1))
  assert.deepEqual(ms.store.practiceCheck(ms.store.genByQid(1).gid, s.answer), { correct: true })
  const lb = ms.store.leaderboard({ by: 'model', range: '24h' })
  assert.deepEqual(lb.items[0], { key: 'claude-opus-4', cracked: 1, attempts: 2, paidEth: Number(q.load + bond) / 1e18, medianSolveSeconds: v.solveSeconds })
  const lbw = ms.store.leaderboard({ by: 'wallet' })
  assert.equal(lbw.items[0].key, BOB)
  assert.equal(lbw.items.find((x) => x.key === ALICE).cracked, 0)
  const kinds = ms.store.ledgerView().items.map((x) => x.kind)
  for (const k of ['posted', 'drip', 'commit', 'reveal', 'settled']) assert.ok(kinds.includes(k), k)
})

test('unsolved at close (no commit); a commit still inside its reveal window delays the close', async () => {
  const c = clock((fx.hour + 1) * HOUR_MS + 60_000)
  const m = mockBoard({ now: c.now })
  const ms = memStore({ preview: false, now: c.now })
  const board = createBoardIndexer({ chain: m.chain, store: ms.store, startBlock: 0 })
  const keeper = createKeeper({ store: ms.store, chain: m.chain, board, data: anyHourData(fx), box: ms.box, now: c.now })
  m.fund(1n * ETH)
  await keeper.tick()
  const q = m.S.q.get(1)
  // a commit 2 minutes before close, never revealed
  c.t = q.closesAt * 1000 - 120_000
  m.call(ALICE, 'commit', [1n, '0x' + '77'.repeat(32), modelBytes32('x')], m.bondFor(1))
  c.t = q.closesAt * 1000 + 1000
  await keeper.tick()
  assert.equal(m.S.q.get(1).status, 1, 'waits for the pending commit')
  c.t = q.closesAt * 1000 - 120_000 + 601_000
  await keeper.tick()
  assert.equal(m.S.q.get(1).status, 3)
  const v = ms.store.qView(1)
  assert.equal(v.status, 'unsolved'); assert.equal(v.winner, null)
  assert.ok(v.working && v.working.answer)
  assert.ok(m.S.pool > 0n)
})

test('harvest every 10 min only when fees are pending; MAX_OPEN guard; no post without canPost', async () => {
  const c = clock((fx.hour + 1) * HOUR_MS + 60_000)
  const m = mockBoard({ now: c.now })
  const ms = memStore({ preview: false, now: c.now })
  const board = createBoardIndexer({ chain: m.chain, store: ms.store, startBlock: 0 })
  let pending = 0n
  const keeper = createKeeper({ store: ms.store, chain: m.chain, board, data: anyHourData(fx), box: ms.box, now: c.now, canPost: false, fees: async () => ({ totalWei: pending }) })
  await keeper.tick()
  assert.equal(m.S.count, 0, 'canPost false → no question')
  assert.ok(!ms.events.some((e) => e[0] === 'harvest'))
  pending = 5n * ETH / 100n; m.setPending(pending)
  c.add(5 * 60_000); await keeper.tick()
  assert.ok(!ms.events.some((e) => e[0] === 'harvest'), 'not before 10 min')
  c.add(6 * 60_000); await keeper.tick()
  const h = ms.events.find((e) => e[0] === 'harvest')
  assert.ok(h)
  assert.equal(h[1].amountWei, String(pending))
  assert.equal(m.S.pool, pending - pending / 5n)
})

test('post is skipped while 48 questions are open, and a failed generate is retried at most 3 times', async () => {
  const c = clock((fx.hour + 1) * HOUR_MS + 60_000)
  const m = mockBoard({ now: c.now })
  const ms = memStore({ preview: false, now: c.now })
  const board = createBoardIndexer({ chain: m.chain, store: ms.store, startBlock: 0 })
  let gens = 0
  const keeper = createKeeper({ store: ms.store, chain: m.chain, board, data: anyHourData(fx), box: ms.box, now: c.now, generator: async () => { gens++; throw new Error('no template applies') } })
  for (let k = 0; k < 5; k++) { await keeper.tick(); c.add(30_000) }
  assert.equal(gens, 3)
  assert.equal(m.S.count, 0)
  m.S.open = Array.from({ length: 48 }, (_, i) => i + 100)
  c.add(HOUR_MS)
  await keeper.tick()
  assert.equal(gens, 3, 'no generate while full')
})

test('preview generator: hourly questions into practice (id = gid), backfill, working after 24 h, no chain', async () => {
  const c = clock((fx.hour + 1) * HOUR_MS + 90_000)
  const ms = memStore({ preview: true, now: c.now })
  const pg = createPreviewGenerator({ store: ms.store, data: anyHourData(fx), now: c.now, backfillHours: 3, emit: (ev, d) => ms.events.push([ev, d]) })
  await pg.tick()
  const list = ms.store.questionsView({ status: 'all' })
  assert.equal(list.items.length, 3)
  assert.ok(list.preview)
  const it = list.items[0]
  assert.equal(it.loadWei, '0'); assert.equal(it.status, 'open'); assert.equal(it.pid, it.id)
  const v = ms.store.qView(it.id)
  assert.equal(JSON.parse(v.question).id, it.id)
  assert.equal(textHash(v.question), it.textHash)
  assert.equal(v.working, null)
  assert.equal(ms.store.practiceList().items.length, 3)
  assert.equal(ms.events.filter((e) => e[0] === 'posted').length, 3)
  // practice check: right, wrong, malformed
  const g = ms.store.genRow(it.id)
  const s = ms.store.secretOf(g)
  assert.deepEqual(ms.store.practiceCheck(it.id, s.answer), { correct: true })
  assert.equal(ms.store.practiceCheck(it.id, g.answer_format === 'uint' ? '0' : '0x' + '12'.repeat(g.answer_format === 'address' ? 20 : 32)).correct, false)
  assert.ok(ms.store.practiceCheck(it.id, 'nonsense').hint)
  assert.equal(ms.store.practiceCheck(99999, '1'), null)
  // same hour again → nothing new; 24 h later → working public, status unsolved
  await pg.tick()
  assert.equal(ms.store.questionsView().items.length, 3)
  c.add(25 * HOUR_MS)
  ms.store.openExpiredPreview()
  const v2 = ms.store.qView(it.id)
  assert.equal(v2.status, 'unsolved')
  assert.equal(v2.working.answer, s.answer)
})

