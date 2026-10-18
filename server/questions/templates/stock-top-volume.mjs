// Tier III — of the four stock/WETH pools, the one with the largest WETH volume (Σ|amount0|) in the window.
import { STOCKS } from '../../config.mjs'
import { sourceParams, decode } from '../sources.mjs'
import { between, SWAP_HINT, OFFICIAL_RPC_HINT, abs } from '../helpers.mjs'

export default {
  key: 'stock-top-volume', tier: 3, span: 1, sources: ['swaps'],
  variants: [{}],
  build({ window: w, logs }) {
    const per = new Map(STOCKS.map((s, i) => [s.pool, { pool: s.pool, symbol: s.symbol, i, wethWei: 0n, swaps: 0 }]))
    for (const l of logs('swaps')) { const r = per.get(l.address); if (r) { r.wethWei += abs(decode.swap(l).weth); r.swaps++ } }
    const ranked = [...per.values()].sort((a, b) => (a.wethWei === b.wethWei ? a.i - b.i : a.wethWei > b.wethWei ? -1 : 1))
    if (ranked[0].wethWei === 0n || ranked[0].wethWei === ranked[1].wethWei) return null
    return {
      title: 'Busiest stock pool by ETH volume',
      prompt: `Of the four stock/WETH Uniswap V3 pools on Robinhood Chain — ${STOCKS.map((s) => `${s.symbol} ${s.pool}`).join(', ')} — which had the largest WETH volume ${between(w)}? Volume = the sum of |amount0| (WETH, token0) over the pool's Swap events. Answer with the pool address.`,
      answerFormat: 'address', unit: null,
      hints: [SWAP_HINT, 'token0 is WETH on all four pools', OFFICIAL_RPC_HINT],
      answer: ranked[0].pool,
      method: `Fetch the Swap logs of the four pools over [${w.fromBlock}, ${w.toBlock}], add |amount0| per pool, take the largest.`,
      sources: [sourceParams('swaps', w.fromBlock, w.toBlock)],
      items: ranked.map(({ i, ...r }) => ({ ...r, wethWei: r.wethWei.toString() })),
    }
  },
}
