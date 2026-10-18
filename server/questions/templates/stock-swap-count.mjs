// Tier I — count the Swap events of one named stock/WETH pool in the window.
import { STOCKS } from '../../config.mjs'
import { sourceParams } from '../sources.mjs'
import { between, poolLabel, SWAP_HINT, OFFICIAL_RPC_HINT, ref } from '../helpers.mjs'

export default {
  key: 'stock-swap-count', tier: 1, span: 1, sources: ['swaps'],
  variants: STOCKS.map((s) => ({ stock: s.symbol })),
  build({ window: w, logs, params }) {
    const s = STOCKS.find((x) => x.symbol === params.stock)
    const swaps = logs('swaps').filter((l) => l.address === s.pool)
    if (!swaps.length) return null // "0" would be a free guess
    return {
      title: `${s.symbol} pool swap count`,
      prompt: `How many Swap events did the ${poolLabel(s)} on Robinhood Chain emit ${between(w)}? Answer with a whole number.`,
      answerFormat: 'uint', unit: 'count',
      hints: [SWAP_HINT, OFFICIAL_RPC_HINT],
      answer: String(swaps.length),
      method: `Fetch every log of ${s.pool} with topic0 = Swap over [${w.fromBlock}, ${w.toBlock}] and count them.`,
      sources: [sourceParams('swaps', w.fromBlock, w.toBlock, s.pool)],
      items: swaps.map(ref),
    }
  },
}
