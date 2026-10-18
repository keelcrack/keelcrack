// Tier II — the address that received the most of a named stock out of its pool (Swap recipients, amount1 < 0) in the window.
import { STOCKS } from '../../config.mjs'
import { sourceParams, decode } from '../sources.mjs'
import { between, poolLabel, SWAP_HINT, OFFICIAL_RPC_HINT, rank, pos } from '../helpers.mjs'

export default {
  key: 'stock-top-buyer', tier: 2, span: 1, sources: ['swaps'],
  variants: STOCKS.map((s) => ({ stock: s.symbol })),
  build({ window: w, logs, params }) {
    const s = STOCKS.find((x) => x.symbol === params.stock)
    const rows = []
    for (const l of logs('swaps')) {
      if (l.address !== s.pool) continue
      const d = decode.swap(l)
      if (d.stock < 0n) rows.push({ key: d.recipient, value: -d.stock, first: pos(l) })
    }
    const ranked = rank(rows)
    if (ranked.length < 2) return null
    return {
      title: `Top ${s.symbol} buyer`,
      prompt: `Which address received the most ${s.symbol} out of the ${poolLabel(s)} ${between(w)}? For every Swap event of the pool where amount1 (${s.symbol}, token1) is negative, credit −amount1 to the event's \`recipient\`; sum per recipient. Ties go to the address that received first. Answer with the address.`,
      answerFormat: 'address', unit: null,
      hints: [SWAP_HINT, `token1 = ${s.symbol} ${s.token} (18 decimals); recipient = second indexed topic`, OFFICIAL_RPC_HINT],
      answer: ranked[0].key,
      method: `Decode the Swap logs of ${s.pool} over [${w.fromBlock}, ${w.toBlock}], keep amount1 < 0, sum −amount1 by recipient, take the largest (ties → first to receive).`,
      sources: [sourceParams('swaps', w.fromBlock, w.toBlock, s.pool)],
      items: ranked.slice(0, 25).map((r) => ({ address: r.key, stockWei: r.value.toString(), swaps: r.n })),
    }
  },
}
