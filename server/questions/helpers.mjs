// Small helpers shared by the templates (wording, ranking with explicit tie-breaks, working items).
import { STOCKS, ADDR } from '../config.mjs'
import { TOPICS } from './sources.mjs'

export const OFFICIAL_RPC_HINT = 'Official RPC https://rpc.mainnet.chain.robinhood.com serves eth_getLogs over a whole hour with an address filter (≤ 10,000 logs per answer: halve the range if refused).'
export const between = (w) => `between blocks ${w.fromBlock} and ${w.toBlock} (inclusive)`
export const poolLabel = (s) => `${s.symbol}/WETH ${s.fee / 10_000}% Uniswap V3 pool ${s.pool}`
export const stockOf = (symbol) => STOCKS.find((s) => s.symbol === symbol)
export const FACTORY = ADDR.ponsFactory
export const ESCROW = ADDR.feeEscrow
export const topicHint = (name, topic) => `${name} topic0 = ${topic}`
export const SWAP_HINT = topicHint('Uniswap V3 Swap(address,address,int256,int256,uint160,uint128,int24)', TOPICS.swap)
export const LAUNCH_HINT = topicHint('TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256, uint256)', TOPICS.tokenLaunched)
export const ESCROW_HINT = topicHint('Claimed(address indexed recipient, uint256 amount)', TOPICS.escrowClaimed)
export const abs = (x) => (x < 0n ? -x : x)
export const ref = (l) => ({ tx: l.tx, block: l.block, logIndex: l.logIndex })
/** Chain-order key of a log (block, logIndex) → comparable number. */
export const pos = (l) => l.block * 1e6 + l.logIndex

/**
 * Group → ranked list. rows: [{key, value (bigint), first (chain position)}]; ranking = value desc, then first asc
 * (the tie-break every template states in words). Returns [{key, value, first, n}] sorted.
 */
export function rank(entries) {
  const m = new Map()
  for (const e of entries) {
    const r = m.get(e.key)
    if (!r) m.set(e.key, { key: e.key, value: e.value, first: e.first, n: 1 })
    else { r.value += e.value; r.n++; if (e.first < r.first) r.first = e.first }
  }
  return [...m.values()].sort((a, b) => (a.value === b.value ? a.first - b.first : a.value > b.value ? -1 : 1))
}
export const str = (v) => (typeof v === 'bigint' ? v.toString() : v)
