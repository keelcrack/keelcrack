// Templates on recorded RC data (questions/fixtures/hour-*.json.gz, captured 16-10-2026 with dry-run.mjs --capture):
// every template reproduces the answer recorded at capture time, a straightforward independent recount agrees, and the
// generator's rotation / fallbacks / skip rules behave.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixtureFiles, loadFixture } from './helpers.mjs'
import { fixtureData } from '../indexer.mjs'
import { TEMPLATES, ROTATION, byKey, runTemplate, generate, assemble, workingOf } from '../questions/index.mjs'
import { canonicalQuestion, encodeAnswer } from '../questions/canon.mjs'
import { TOPICS, decode } from '../questions/sources.mjs'
import { STOCKS, ADDR } from '../config.mjs'

const FILES = fixtureFiles()
const word = (d, i) => BigInt('0x' + d.slice(2 + i * 64, 2 + (i + 1) * 64))
const s256 = (w) => (w >= 1n << 255n ? w - (1n << 256n) : w)

test('≥ 8 templates over 3 tiers; rotation lists each once and alternates tiers', () => {
  assert.ok(TEMPLATES.length >= 8)
  for (const tier of [1, 2, 3]) assert.ok(TEMPLATES.filter((t) => t.tier === tier).length >= 2, `tier ${tier}`)
  assert.deepEqual([...ROTATION].sort(), TEMPLATES.map((t) => t.key).sort())
  const tiers = ROTATION.map((k) => byKey(k).tier)
  for (let k = 0; k + 2 < 9; k += 3) assert.deepEqual(tiers.slice(k, k + 3), [1, 2, 3])
})

for (const f of FILES) {
  const fx = loadFixture(f)
  const data = fixtureData(fx)
  const w1 = fx.windows[`${fx.hour}:1`], w24 = fx.windows[`${fx.hour}:24`]

  test(`${f}: every template reproduces the recorded answer`, async () => {
    for (const t of TEMPLATES) {
      const exp = fx.expected[t.key]
      const g = await runTemplate(t, { data, hour: fx.hour })
      if (!exp) { assert.equal(g, null, `${t.key} was not applicable at capture`); continue }
      assert.ok(g, `${t.key} applicable`)
      assert.equal(g.answer, exp.answer, t.key)
      assert.deepEqual(g.params, exp.params, `${t.key} params`)
      assert.equal(g.answerBytes32, encodeAnswer(g.answerFormat, g.answer))
      assert.ok(g.prompt.includes(String(g.window.fromBlock)) && g.prompt.includes(String(g.window.toBlock)), `${t.key} prompt names the window`)
      assert.ok(!g.prompt.includes('undefined') && !g.prompt.includes('NaN'), `${t.key} prompt is clean`)
      assert.ok(g.work.sources.length && g.work.sources.every((s) => s.rpcMethod === 'eth_getLogs'))
      // the question built from it is canonical-valid
      canonicalQuestion(assemble({ ...g }, { id: 1, postedAt: Date.UTC(2026, 9, 15, 20, 0, 45), closesAt: Date.UTC(2026, 9, 16, 20, 0, 45) }))
    }
  })

  test(`${f}: independent recounts agree`, async () => {
    const swaps = fx.logs.swaps.filter((l) => l.block >= w1.fromBlock && l.block <= w1.toBlock && l.topics[0] === TOPICS.swap)
    const launches1 = fx.logs.launches.filter((l) => l.block >= w1.fromBlock && l.block <= w1.toBlock)
    // swap count of the stock the template picked
    const sc = fx.expected['stock-swap-count']
    if (sc) assert.equal(String(swaps.filter((l) => l.address === STOCKS.find((s) => s.symbol === sc.params.stock).pool).length), sc.answer)
    // launches
    assert.equal(String(launches1.length), fx.expected['pons-launch-count'].answer)
    assert.ok(launches1.every((l) => l.address === ADDR.ponsFactory))
    // escrow total (raw word 0 of every Claimed)
    const total = fx.logs.escrow.filter((l) => l.topics[0] === TOPICS.escrowClaimed).reduce((a, l) => a + word(l.data, 0), 0n)
    if (fx.expected['escrow-payout-total']) assert.equal(total.toString(), fx.expected['escrow-payout-total'].answer)
    // top volume pool
    const vol = new Map()
    for (const l of swaps) { const a0 = s256(word(l.data, 0)); vol.set(l.address, (vol.get(l.address) || 0n) + (a0 < 0n ? -a0 : a0)) }
    const best = [...vol].sort((a, b) => (a[1] > b[1] ? -1 : 1))[0][0]
    assert.equal(best, fx.expected['stock-top-volume'].answer)
    // top deployer over 24 h (topic 3), ties → first launch
    const cnt = new Map()
    for (const l of fx.logs.launches.filter((x) => x.block >= w24.fromBlock && x.block <= w24.toBlock)) { const d = '0x' + l.topics[3].slice(26); const c = cnt.get(d) || { n: 0, first: l.block * 1e6 + l.logIndex }; c.n++; cnt.set(d, c) }
    const top = [...cnt].sort((a, b) => b[1].n - a[1].n || a[1].first - b[1].first)[0][0]
    assert.equal(top, fx.expected['pons-top-deployer'].answer)
    // most trades: count Buy/Sell per curve launched in the window
    const curves = new Map(launches1.map((l) => [decode.launch(l).curve, { token: decode.launch(l).token, n: 0, first: l.block * 1e6 + l.logIndex }]))
    for (const l of fx.logs.trades) { const c = curves.get(l.address); if (c && l.block * 1e6 + l.logIndex > c.first) c.n++ }
    const mt = [...curves.values()].sort((a, b) => b.n - a.n || a.first - b.first)[0]
    assert.equal(mt.token, fx.expected['pons-most-trades'].answer)
    // largest swap: tx of max |amount0| on the picked pool
    const ls = fx.expected['stock-largest-swap']
    const pool = STOCKS.find((s) => s.symbol === ls.params.stock).pool
    const big = swaps.filter((l) => l.address === pool).map((l) => { const a = s256(word(l.data, 0)); return { tx: l.tx, a: a < 0n ? -a : a, p: l.block * 1e6 + l.logIndex } }).sort((x, y) => (x.a === y.a ? x.p - y.p : x.a > y.a ? -1 : 1))[0]
    assert.equal(big.tx, ls.answer)
  })

  test(`${f}: generate() follows the rotation and skips templates that do not apply`, async () => {
    const g = await generate({ data, hour: fx.hour })
    const first = ROTATION[fx.hour % ROTATION.length]
    assert.equal(g.template, first)
    assert.equal(g.tried.length, 0)
    // a data source that fails → its templates are skipped, the next applicable one is used
    const broken = { ...data, ensure: async (src) => { if (src === 'launches' || src === 'escrow') throw new Error('getLogs: budget hit'); return data.ensure(src) } }
    for (let h = 0; h < ROTATION.length; h++) {
      const want = ROTATION.map((_, k) => ROTATION[(h + k) % ROTATION.length]).find((k) => !byKey(k).sources.some((s) => s === 'launches' || s === 'escrow'))
      const g2 = await generate({ data: { ...broken, window: (_h, span) => data.window(fx.hour, span) }, hour: h })
      assert.equal(g2.template, want, `hour ${h}`)
    }
    // nothing applies → throws with the reasons
    const empty = { ...data, window: (_h, span) => data.window(fx.hour, span), logs: () => [] }
    await assert.rejects(generate({ data: empty, hour: fx.hour }), /no template applies/)
  })

  test(`${f}: working lists the sources + items and the answer`, async () => {
    const g = await generate({ data, hour: fx.hour, only: 'stock-top-buyer' })
    const wk = workingOf(g, { id: 5, salt: '0x' + '11'.repeat(32) })
    assert.equal(wk.id, 5)
    assert.equal(wk.answer, g.answer)
    assert.equal(wk.answerBytes32, encodeAnswer('address', g.answer))
    assert.equal(wk.items[0].address, g.answer)
    assert.ok(BigInt(wk.items[0].stockWei) >= BigInt(wk.items[1].stockWei))
    assert.equal(wk.sources[0].params[0].fromBlock, '0x' + w1.fromBlock.toString(16))
    assert.ok(JSON.stringify(wk)) // BigInt-free
  })
}

test('trivial answers are refused (no swaps → no count question; zero escrow total → no question)', async () => {
  const w = { fromBlock: 1, toBlock: 10, fromTime: '2026-10-15T19:00:00Z', toTime: '2026-10-15T20:00:00Z' }
  const none = () => []
  for (const k of ['stock-swap-count', 'pons-launch-count', 'escrow-payout-total', 'stock-top-volume', 'pons-most-trades', 'stock-largest-swap', 'stock-top-buyer', 'escrow-top-claimer', 'pons-top-deployer', 'stock-buyer-count']) {
    const t = byKey(k)
    assert.equal(t.build({ window: w, logs: none, params: t.variants[0] }), null, k)
  }
})
