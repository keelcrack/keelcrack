// lib/rpc.mjs (mirror fallback, 429 back-off, range halving, pins) and indexer.mjs (blockAt, coverage) against fake mirrors.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRpc, parseResolve, toQty, hexToBig } from '../lib/rpc.mjs'
import { createRcData } from '../indexer.mjs'
import { createSecretBox } from '../lib/secret.mjs'
import { openDb } from '../db.mjs'

const ok = (id, result) => JSON.stringify({ jsonrpc: '2.0', id, result })
const err = (id, message, code = -32000) => JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })

test('parseResolve: host=ip|ip;host2=ip', () => {
  const m = parseResolve('rpc.mainnet.chain.robinhood.com=104.20.46.209|172.66.147.70; a.b=1.2.3.4')
  assert.deepEqual(m.get('rpc.mainnet.chain.robinhood.com'), ['104.20.46.209', '172.66.147.70'])
  assert.deepEqual(m.get('a.b'), ['1.2.3.4'])
})

test('rpc: a 429 backs off and falls through to the next mirror; transport failure benches', async () => {
  const seen = []
  const post = async (url, body) => {
    seen.push(new URL(url).hostname)
    const p = JSON.parse(body)
    if (url.includes('a.test')) return { status: 429, text: 'Too Many Requests' }
    if (url.includes('b.test')) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } })
    return { status: 200, text: ok(p.id, '0x10') }
  }
  const r = createRpc(['https://a.test', 'https://b.test', 'https://c.test'], { post, minGapMs: 0 })
  assert.equal(await r.blockNumber(), 16)
  assert.deepEqual(seen, ['a.test', 'b.test', 'c.test'])
  assert.equal(r.state().rateLimited, 1)
  assert.ok(r.state().benched.includes('b.test'))
})

test('rpc: reverts are thrown with e.rpc (not retried on other mirrors)', async () => {
  let calls = 0
  const post = async (_u, body) => { calls++; const p = JSON.parse(body); return { status: 200, text: JSON.stringify({ jsonrpc: '2.0', id: p.id, error: { code: 3, message: 'execution reverted', data: '0x12345678' } }) } }
  const r = createRpc(['https://x.test', 'https://y.test'], { post, minGapMs: 0 })
  await assert.rejects(r.rpc('eth_call', [{}, 'latest']), (e) => e.rpc?.data === '0x12345678')
  assert.equal(calls, 1)
})

test('rpc getLogs: "more than 10000 results" halves the window until it fits, logs come back in chain order', async () => {
  const LOGS = Array.from({ length: 300 }, (_, k) => ({ blockNumber: toQty(1000 + k * 10), logIndex: '0x0', address: '0xaa', topics: [], data: '0x', transactionHash: '0x' + k.toString(16).padStart(64, '0') }))
  const windows = []
  const post = async (_u, body) => {
    const p = JSON.parse(body)
    const f = p.params[0], a = Number(hexToBig(f.fromBlock)), b = Number(hexToBig(f.toBlock))
    windows.push(b - a + 1)
    const got = LOGS.filter((l) => { const n = Number(hexToBig(l.blockNumber)); return n >= a && n <= b })
    if (got.length > 100) return { status: 200, text: err(p.id, 'query returned more than 10000 results') }
    return { status: 200, text: ok(p.id, got.reverse()) }
  }
  const r = createRpc(['https://rpc.mainnet.chain.robinhood.com'], { post, minGapMs: 0 })
  const out = await r.getLogs({ address: '0xaa' }, 1000, 3999)
  assert.equal(out.length, 300)
  assert.ok(out.every((l, i) => i === 0 || hexToBig(out[i - 1].blockNumber) <= hexToBig(l.blockNumber)))
  assert.ok(windows[0] === 3000 && Math.max(...windows.slice(1)) < 3000)
  await assert.rejects(r.getLogs({ address: '0xaa' }, 1000, 3999, { maxCalls: 1 }), /budget/)
})

/** A fake chain: block n has timestamp T0 + floor(n / 10) (10 blocks per second), head = HEAD. */
function fakeChain({ T0 = 1_792_000_000, HEAD = 200_000, logs = [] } = {}) {
  const st = { calls: 0, posts: 0, getLogs: [] }
  const tsOf = (n) => T0 + Math.floor(n / 10)
  const block = (n) => ({ number: toQty(n), hash: '0x' + n.toString(16).padStart(64, '0'), timestamp: toQty(tsOf(n)) })
  function answer(p) {
    st.calls++
    if (p.method === 'eth_getBlockByNumber') { const n = p.params[0] === 'latest' ? HEAD : Number(hexToBig(p.params[0])); return n > HEAD ? null : block(n) }
    if (p.method === 'eth_blockNumber') return toQty(HEAD)
    if (p.method === 'eth_getLogs') { const f = p.params[0]; const a = Number(hexToBig(f.fromBlock)), b = Number(hexToBig(f.toBlock)); st.getLogs.push([a, b]); return logs.filter((l) => { const n = Number(hexToBig(l.blockNumber)); return n >= a && n <= b }) }
    throw new Error('unexpected ' + p.method)
  }
  const post = async (_u, body) => {
    st.posts++
    const p = JSON.parse(body)
    if (Array.isArray(p)) return { status: 200, text: JSON.stringify(p.map((x) => ({ jsonrpc: '2.0', id: x.id, result: answer(x) }))) }
    return { status: 200, text: ok(p.id, answer(p)) }
  }
  return { st, tsOf, rpc: createRpc(['https://rpc.mainnet.chain.robinhood.com'], { post, minGapMs: 0 }), T0, HEAD }
}

test('indexer.blockAt: first block with timestamp ≥ ts, cached; windows are [first ≥ start, first ≥ end − 1]', async () => {
  const fc = fakeChain()
  const db = openDb(':memory:')
  const rc = createRcData({ db, rpc: fc.rpc, now: () => (fc.T0 + 20_000) * 1000 })
  for (const ts of [fc.T0 + 5_000, fc.T0 + 12_345, fc.T0 + 1, fc.T0 + 19_000]) {
    const b = await rc.blockAt(ts)
    assert.equal(fc.tsOf(b), ts)
    assert.ok(fc.tsOf(b - 1) < ts)
  }
  const calls = fc.st.calls, posts = fc.st.posts
  assert.equal(await rc.blockAt(fc.T0 + 12_345), 123_450)
  assert.equal(fc.st.calls, calls, 'cached')
  assert.ok(posts <= 32, `few round trips for 4 lookups (${posts})`)
  const hour = Math.floor((fc.T0 + 15_000) / 3600) - 1
  const w = await rc.window(hour)
  assert.equal(fc.tsOf(w.fromBlock), hour * 3600)
  assert.equal(fc.tsOf(w.toBlock), (hour + 1) * 3600 - 1)
  assert.equal(fc.tsOf(w.toBlock + 1), (hour + 1) * 3600)
  assert.equal(w.fromTime, new Date(hour * 3_600_000).toISOString().replace('.000', ''))
  await assert.rejects(rc.window(Math.floor((fc.T0 + 20_000) / 3600)), (e) => e.notYet)
})

test('indexer.ensure fetches only uncovered ranges and stores logs per source', async () => {
  const L = (n) => ({ blockNumber: toQty(n), logIndex: '0x1', address: '0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e', topics: ['0xd8138f8a3f377c5259ca548e70e4c2de94f129f5a11036a15b69513cba2b426a', '0x' + '0'.repeat(24) + 'ab'.repeat(20)], data: '0x' + (5n).toString(16).padStart(64, '0'), transactionHash: '0x' + n.toString(16).padStart(64, '0') })
  const fc = fakeChain({ logs: [L(100), L(150), L(250), L(400)] })
  const db = openDb(':memory:')
  const rc = createRcData({ db, rpc: fc.rpc })
  await rc.ensure('escrow', 100, 200)
  await rc.ensure('escrow', 150, 300)
  await rc.ensure('escrow', 120, 280)
  assert.deepEqual(fc.st.getLogs, [[100, 200], [201, 300]])
  assert.deepEqual(rc.logs('escrow', 0, 1000).map((l) => l.block), [100, 150, 250])
  assert.deepEqual(rc.gaps('escrow', 50, 350), [[50, 99], [301, 350]])
  assert.ok(rc.covered('escrow', 100, 300))
})

test('secret box: sealed blobs hide the plaintext, open round-trips, tampering fails', () => {
  const box = createSecretBox({ key: 'cd'.repeat(32) })
  const blob = box.seal({ answer: '0xabc', salt: '0x' + '11'.repeat(32) })
  assert.ok(blob.startsWith('v1:') && !blob.includes('abc') && !blob.includes('1111'))
  assert.deepEqual(box.open(blob), { answer: '0xabc', salt: '0x' + '11'.repeat(32) })
  const raw = Buffer.from(blob.slice(3), 'base64'); raw[raw.length - 1] ^= 1
  assert.throws(() => box.open('v1:' + raw.toString('base64')))
  assert.throws(() => createSecretBox({ key: 'other' }).open(blob))
})
