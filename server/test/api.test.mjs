// HTTP API shapes (BRIEF "API") over a real node:http server: live store fed by the JS board model + keeper, and a preview
// store; practice checker + rate limit; SSE hello + live events; errors; CORS; static files.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mockBoard } from './mockboard.mjs'
import { memStore, clock, loadFixture, fixtureFiles, anyHourData } from './helpers.mjs'
import { createKeeper } from '../keeper.mjs'
import { createBoardIndexer } from '../board.mjs'
import { createPreviewGenerator } from '../preview.mjs'
import { createApp } from '../app.mjs'
import * as bus from '../lib/bus.mjs'
import { commitHash, modelBytes32 } from '../questions/hash.mjs'
import { HOUR_MS } from '../lib/util.mjs'

const ETH = 10n ** 18n
const fx = loadFixture(fixtureFiles().at(-1))
const servers = []
after(() => { for (const s of servers) s.close(); bus.closeAll() })

async function serve(app) {
  const s = createServer(app)
  servers.push(s)
  await new Promise((r) => s.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${s.address().port}`
  const get = async (p) => { const r = await fetch(base + p); return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) } }
  const post = async (p, body, ip) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(ip ? { 'x-real-ip': ip } : {}) }, body: JSON.stringify(body) }); return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) } }
  return { base, get, post }
}

async function liveSetup() {
  const c = clock((fx.hour + 1) * HOUR_MS + 60_000)
  const m = mockBoard({ now: c.now })
  const ms = memStore({ preview: false, now: c.now, emit: (ev, d) => bus.emit(ev, d) })
  const board = createBoardIndexer({ chain: m.chain, store: ms.store, startBlock: 0 })
  const keeper = createKeeper({ store: ms.store, chain: m.chain, board, data: anyHourData(fx), box: ms.box, now: c.now })
  m.fund(2n * ETH)
  await keeper.tick() // #1 posted + drip
  const s = ms.store.secretOf(ms.store.genByQid(1))
  const W = '0x' + 'a1'.repeat(20)
  m.call(W, 'commit', [1n, commitHash(1, W, s.answerBytes32, '0x' + '05'.repeat(32)), modelBytes32('claude-opus-4')], m.bondFor(1))
  c.add(2000)
  m.call(W, 'reveal', [1n, 0n, s.answerBytes32, '0x' + '05'.repeat(32)])
  await keeper.tick() // settles #1
  c.add(HOUR_MS)
  await keeper.tick() // #2 posted + drip
  const app = createApp({ store: ms.store, preview: false, serveWeb: false, stateExtra: () => ({ launchAt: '2026-10-18T15:00:00Z', board: m.chain.address, nextQuestionAt: 1 }) })
  return { c, m, ms, keeper, app, W, s }
}

test('live API: state, questions, q/:id, leaderboard, ledger, practice', async () => {
  const L = await liveSetup()
  const { get, post } = await serve(L.app)
  const st = await get('/api/state')
  assert.equal(st.status, 200)
  for (const k of ['preview', 'launchAt', 'block', 'board', 'pool', 'infra', 'totalLoad', 'open', 'solved', 'unsolved', 'lastDripAt', 'nextDripAt', 'nextQuestionAt', 'minBondWei']) assert.ok(k in st.body, k)
  assert.equal(st.body.preview, false); assert.equal(st.body.open, 1); assert.equal(st.body.solved, 1)
  assert.equal(typeof st.body.pool.wei, 'string'); assert.equal(typeof st.body.pool.eth, 'number')
  assert.equal(st.headers.get('access-control-allow-origin'), '*')

  const qs = await get('/api/questions?status=all&limit=10')
  assert.equal(qs.body.items.length, 2)
  const QITEM = ['id', 'tier', 'template', 'title', 'prompt', 'window', 'answerFormat', 'unit', 'status', 'loadWei', 'loadEth', 'bondWei', 'postedAt', 'closesAt', 'ageHours', 'commits', 'reveals', 'winner', 'winnerModel', 'solveSeconds', 'textHash']
  for (const it of qs.body.items) for (const k of QITEM) assert.ok(k in it, `QItem.${k}`)
  const open = await get('/api/questions?status=open')
  assert.deepEqual(open.body.items.map((x) => x.id), [2])
  assert.ok(BigInt(open.body.items[0].bondWei) >= 300000000000000n)
  const solved = await get('/api/questions?status=solved')
  assert.equal(solved.body.items[0].winner, L.W)
  assert.equal(solved.body.items[0].winnerModel, 'claude-opus-4')
  assert.equal((await get('/api/questions?status=nope')).status, 400)

  const q1 = await get('/api/q/1')
  assert.equal(q1.status, 200)
  for (const k of ['question', 'commits', 'loadHistory', 'working']) assert.ok(k in q1.body, k)
  assert.equal(q1.body.commits[0].answer, L.s.answer)
  assert.equal(q1.body.working.salt, L.s.salt)
  assert.ok(q1.body.loadHistory.length >= 2)
  const q2 = await get('/api/q/2')
  assert.equal(q2.body.working, null, 'open question: no working')
  assert.ok(!JSON.stringify(q2.body).includes(L.ms.store.secretOf(L.ms.store.genByQid(2)).salt.slice(2)), 'no salt leaks while open')
  assert.equal((await get('/api/q/99')).status, 404)
  assert.equal((await get('/api/q/abc')).status, 404)

  const lb = await get('/api/leaderboard?by=wallet&range=24h')
  assert.deepEqual(Object.keys(lb.body.items[0]).sort(), ['attempts', 'cracked', 'key', 'medianSolveSeconds', 'paidEth'])
  assert.equal((await get('/api/leaderboard?by=x')).status, 400)
  const led = await get('/api/ledger?limit=50')
  assert.ok(led.body.items.every((x) => ['harvest', 'drip', 'posted', 'topup', 'commit', 'reveal', 'settled', 'claim'].includes(x.kind) && 't' in x && 'tx' in x))

  const pr = await get('/api/practice')
  assert.equal(pr.body.items.length, 1, 'only the closed question is in practice')
  const pid = pr.body.items[0].pid
  for (const k of ['pid', 'tier', 'title', 'prompt', 'window', 'answerFormat', 'unit']) assert.ok(k in pr.body.items[0], k)
  assert.deepEqual((await post(`/api/practice/${pid}/check`, { answer: L.s.answer }, '9.9.9.1')).body, { correct: true, preview: false })
  assert.equal((await post(`/api/practice/${pid}/check`, { nope: 1 }, '9.9.9.1')).status, 400)
  assert.equal((await post('/api/practice/9999/check', { answer: '1' }, '9.9.9.2')).status, 404)
  assert.equal((await post('/api/nothing', {}, '9.9.9.2')).status, 404)
})

test('practice checker is rate-limited per IP and per question', async () => {
  const L = await liveSetup()
  const { get, post } = await serve(L.app)
  const pid = (await get('/api/practice')).body.items[0].pid
  const codes = []
  for (let k = 0; k < 6; k++) codes.push((await post(`/api/practice/${pid}/check`, { answer: '1' }, '7.7.7.7')).status)
  assert.deepEqual(codes.slice(0, 4), [200, 200, 200, 200])
  assert.equal(codes[4], 429)
  const r = await post(`/api/practice/${pid}/check`, { answer: '1' }, '7.7.7.7')
  assert.ok(Number(r.headers.get('retry-after')) >= 1)
})

test('SSE /api/live: hello with state, then live events', async () => {
  const L = await liveSetup()
  const { base } = await serve(L.app)
  const ac = new AbortController()
  const res = await fetch(base + '/api/live', { signal: ac.signal })
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8')
  const reader = res.body.getReader()
  let text = ''
  const until = async (re) => { while (!re.test(text)) { const { value, done } = await reader.read(); if (done) break; text += Buffer.from(value).toString('utf8') } }
  await until(/event: hello\ndata: .*\n\n/)
  assert.ok(/"open":1/.test(text))
  bus.emit('commit', { id: 2, i: 0 })
  await until(/event: commit\ndata: \{"id":2,"i":0\}/)
  ac.abort()
})

test('preview API: questions from the hourly preview generator, flagged preview, bounty 0', async () => {
  const c = clock((fx.hour + 1) * HOUR_MS + 90_000)
  const ms = memStore({ preview: true, now: c.now })
  const pg = createPreviewGenerator({ store: ms.store, data: anyHourData(fx), now: c.now, backfillHours: 2 })
  await pg.tick()
  const app = createApp({ store: ms.store, preview: true, serveWeb: false, stateExtra: () => ({ launchAt: '2026-10-18T15:00:00Z', board: null, nextQuestionAt: 5 }) })
  const { get } = await serve(app)
  const st = (await get('/api/state')).body
  assert.equal(st.preview, true); assert.equal(st.open, 2); assert.equal(st.pool.wei, '0'); assert.equal(st.board, null)
  const qs = (await get('/api/questions')).body
  assert.equal(qs.items.length, 2)
  assert.ok(qs.items.every((x) => x.preview && x.loadWei === '0' && x.pid === x.id))
  const q = (await get(`/api/q/${qs.items[0].id}`)).body
  assert.deepEqual(q.commits, []); assert.equal(q.working, null)
  assert.equal(JSON.parse(q.question).id, qs.items[0].id)
  assert.equal((await get('/api/practice')).body.items.length, 2)
  assert.equal((await get('/api/leaderboard')).body.items.length, 0)
  const h = (await get('/api/health')).body
  assert.equal(h.ok, true); assert.equal(h.mode, 'preview')
})

test('static files + clean URLs + 404 JSON for unknown API', async () => {
  const { store } = memStore({ preview: true })
  const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const root = mkdtempSync(join(tmpdir(), 'kc-web-'))
  mkdirSync(join(root, 'board'))
  writeFileSync(join(root, 'board', 'index.html'), '<h1>board</h1>')
  writeFileSync(join(root, '404.html'), 'nf')
  writeFileSync(join(root, '.ticker'), 'SECRET')
  const app = createApp({ store, preview: true, webRoot: root })
  const { base, get } = await serve(app)
  assert.equal(await (await fetch(base + '/board')).text(), '<h1>board</h1>')
  assert.equal((await fetch(base + '/missing')).status, 404)
  assert.equal((await fetch(base + '/.ticker')).status, 404, 'dotfiles never served')
  assert.equal((await get('/api/nope')).status, 404)
})
