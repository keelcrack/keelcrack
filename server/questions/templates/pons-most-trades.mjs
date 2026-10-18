// Tier II — of the Pons launches in the window, the token with the most bonding-curve trades (Buy + Sell events) by block B.
import { sourceParams, decode, TOPICS } from '../sources.mjs'
import { between, FACTORY, LAUNCH_HINT, OFFICIAL_RPC_HINT, topicHint, pos } from '../helpers.mjs'

export default {
  key: 'pons-most-trades', tier: 2, span: 1, sources: ['launches', 'trades'],
  variants: [{}],
  build({ window: w, logs }) {
    const launches = logs('launches').map((l) => ({ l, d: decode.launch(l) }))
    if (launches.length < 2) return null
    const byCurve = new Map(launches.map(({ l, d }) => [d.curve, { token: d.token, curve: d.curve, launchBlock: l.block, launchTx: l.tx, first: pos(l), trades: 0, buys: 0, sells: 0 }]))
    for (const t of logs('trades')) {
      const r = byCurve.get(t.address)
      if (!r || pos(t) < r.first) continue
      r.trades++
      if (t.topics[0] === TOPICS.curveBuy) r.buys++; else r.sells++
    }
    const ranked = [...byCurve.values()].sort((a, b) => b.trades - a.trades || a.first - b.first)
    if (ranked[0].trades < 2) return null
    return {
      title: 'Busiest new Pons launch',
      prompt: `Of the tokens launched through the Pons V2 factory ${FACTORY} ${between(w)}, which one had the most trades on its bonding curve by block ${w.toBlock}? A trade is a Buy or Sell event emitted by the token's curve (the curve address is the second indexed topic of its TokenLaunched event). Ties go to the token launched first. Answer with the token address.`,
      answerFormat: 'address', unit: null,
      hints: [LAUNCH_HINT, topicHint('curve Buy', TOPICS.curveBuy), topicHint('curve Sell', TOPICS.curveSell), OFFICIAL_RPC_HINT],
      answer: ranked[0].token,
      method: `List the TokenLaunched logs of ${FACTORY} over [${w.fromBlock}, ${w.toBlock}] (token, curve). For each curve count its Buy and Sell logs from its launch to block ${w.toBlock}. Take the most trades; ties → the earliest launch.`,
      sources: [sourceParams('launches', w.fromBlock, w.toBlock), sourceParams('trades', w.fromBlock, w.toBlock, ranked.slice(0, 200).map((r) => r.curve))],
      items: ranked.map(({ first, ...r }) => r),
    }
  },
}
