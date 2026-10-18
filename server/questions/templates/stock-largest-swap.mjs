// Tier II — the transaction of the largest single swap (by |WETH amount|) on a named stock pool in the window.
import { STOCKS } from '../../config.mjs'
import { sourceParams, decode } from '../sources.mjs'
import { between, poolLabel, SWAP_HINT, OFFICIAL_RPC_HINT, abs, ref, pos } from '../helpers.mjs'

export default {
  key: 'stock-largest-swap', tier: 2, span: 1, sources: ['swaps'],
  variants: STOCKS.map((s) => ({ stock: s.symbol })),
  build({ window: w, logs, params }) {
    const s = STOCKS.find((x) => x.symbol === params.stock)
    const swaps = logs('swaps').filter((l) => l.address === s.pool).map((l) => ({ l, weth: abs(decode.swap(l).weth) }))
    if (swaps.length < 2) return null
    swaps.sort((a, b) => (a.weth === b.weth ? pos(a.l) - pos(b.l) : a.weth > b.weth ? -1 : 1))
    return {
      title: `Largest ${s.symbol} swap`,
      prompt: `Which transaction made the largest single swap on the ${poolLabel(s)} ${between(w)}, measured by the absolute WETH amount (amount0) of its Swap event? Ties go to the earliest swap. Answer with the transaction hash.`,
      answerFormat: 'bytes32', unit: null,
      hints: [SWAP_HINT, 'token0 = WETH on this pool; amounts are signed int256 from the pool\'s side', OFFICIAL_RPC_HINT],
      answer: swaps[0].l.tx.toLowerCase(),
      method: `Decode the Swap logs of ${s.pool} over [${w.fromBlock}, ${w.toBlock}], take |amount0| (WETH wei) of each, pick the largest (ties → earliest), answer its transaction hash.`,
      sources: [sourceParams('swaps', w.fromBlock, w.toBlock, s.pool)],
      items: swaps.slice(0, 25).map(({ l, weth }) => ({ ...ref(l), wethWei: weth.toString() })),
    }
  },
}
