// Tier I — how many distinct addresses received the stock out of a named pool (Swap recipients of buys) in the window.
import { STOCKS } from '../../config.mjs'
import { sourceParams, decode } from '../sources.mjs'
import { between, poolLabel, SWAP_HINT, OFFICIAL_RPC_HINT, ref } from '../helpers.mjs'

export default {
  key: 'stock-buyer-count', tier: 1, span: 1, sources: ['swaps'],
  variants: STOCKS.map((s) => ({ stock: s.symbol })),
  build({ window: w, logs, params }) {
    const s = STOCKS.find((x) => x.symbol === params.stock)
    const buys = logs('swaps').filter((l) => l.address === s.pool).map((l) => ({ l, d: decode.swap(l) })).filter((x) => x.d.stock < 0n)
    const who = new Map()
    for (const { l, d } of buys) if (!who.has(d.recipient)) who.set(d.recipient, ref(l))
    if (who.size < 2) return null
    return {
      title: `Distinct ${s.symbol} receivers`,
      prompt: `How many distinct addresses received ${s.symbol} out of the ${poolLabel(s)} ${between(w)}? Count the distinct \`recipient\`s of its Swap events where amount1 (${s.symbol}, token1) is negative. Answer with a whole number.`,
      answerFormat: 'uint', unit: 'count',
      hints: [SWAP_HINT, `token0 = WETH, token1 = ${s.symbol} ${s.token}; amounts are signed from the pool's side (negative = left the pool)`, OFFICIAL_RPC_HINT],
      answer: String(who.size),
      method: `Decode the Swap logs of ${s.pool} over [${w.fromBlock}, ${w.toBlock}], keep those with amount1 < 0, count the distinct recipients (second indexed topic).`,
      sources: [sourceParams('swaps', w.fromBlock, w.toBlock, s.pool)],
      items: [...who].map(([address, first]) => ({ address, ...first })),
    }
  },
}
