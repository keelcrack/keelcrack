// The RC data sources the templates read (each = one eth_getLogs filter; the indexer stores the raw logs per source) and
// the log decoders. Event layouts were checked against live RC logs on 16-10-2026:
//   Uniswap V3 Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96,
//     uint128 liquidity, int24 tick) — on all four stock pools token0 = WETH, token1 = the stock (amounts: + into the pool)
//   PonsV2LaunchFactory TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken,
//     uint256 launchConfigId, uint256 graduationThreshold)
//   Pons V2 bonding curve Buy  topic0 0xec36bf57… (indexed sender, indexed recipient; data quoteIn, tokensOut, …)
//                         Sell topic0 0x8113d738… (indexed seller, indexed recipient; data tokensIn, quoteOut, …)
//   PonsV2FeeEscrow Claimed(address indexed recipient, uint256 amount) — native ETH paid out to a creator fee recipient
import { STOCKS, ADDR } from '../config.mjs'

export const TOPICS = Object.freeze({
  swap: '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67',
  tokenLaunched: '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607',
  curveBuy: '0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455',
  curveSell: '0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df',
  escrowClaimed: '0xd8138f8a3f377c5259ca548e70e4c2de94f129f5a11036a15b69513cba2b426a',
})

/** src → eth_getLogs filter (address may be null = all contracts; topics as in JSON-RPC). */
export const SOURCES = Object.freeze({
  swaps: { address: STOCKS.map((s) => s.pool), topics: [TOPICS.swap], about: 'Swap events of the four stock/WETH Uniswap V3 pools' },
  launches: { address: ADDR.ponsFactory, topics: [TOPICS.tokenLaunched], about: 'TokenLaunched events of the Pons V2 factory' },
  trades: { address: null, topics: [[TOPICS.curveBuy, TOPICS.curveSell]], about: 'Buy/Sell events of Pons V2 bonding curves' },
  escrow: { address: ADDR.feeEscrow, topics: [TOPICS.escrowClaimed], about: 'Claimed events of the Pons V2 fee escrow' },
})
/** The exact JSON-RPC params a reader sends to recompute from a source over [from, to] (for `working.sources`; block
 *  numbers as hex quantities so the object can be pasted into eth_getLogs as is). */
export function sourceParams(src, from, to, address = undefined) {
  const s = SOURCES[src]
  const addr = address !== undefined ? address : s.address
  const q = (n) => '0x' + Number(n).toString(16)
  return { rpcMethod: 'eth_getLogs', params: [{ ...(addr ? { address: addr } : {}), topics: s.topics, fromBlock: q(from), toBlock: q(to) }] }
}

const word = (data, i) => BigInt('0x' + (data.slice(2 + i * 64, 2 + (i + 1) * 64) || '0'))
const int256 = (w) => (w >= 1n << 255n ? w - (1n << 256n) : w)
const topicAddr = (t) => '0x' + t.slice(26).toLowerCase()

export const decode = {
  /** → {pool, sender, recipient, amount0, amount1, weth, stock (signed, + = into the pool)} */
  swap(l) {
    const a0 = int256(word(l.data, 0)), a1 = int256(word(l.data, 1))
    return { pool: l.address, sender: topicAddr(l.topics[1]), recipient: topicAddr(l.topics[2]), amount0: a0, amount1: a1, weth: a0, stock: a1 }
  },
  launch(l) {
    return { token: topicAddr(l.topics[1]), curve: topicAddr(l.topics[2]), deployer: topicAddr(l.topics[3]), pairToken: '0x' + l.data.slice(26, 66).toLowerCase() }
  },
  trade(l) {
    const buy = l.topics[0] === TOPICS.curveBuy
    return { curve: l.address, side: buy ? 'buy' : 'sell', sender: topicAddr(l.topics[1]), recipient: topicAddr(l.topics[2]), quote: buy ? word(l.data, 0) : word(l.data, 1), tokens: buy ? word(l.data, 1) : word(l.data, 0) }
  },
  escrowClaim(l) { return { recipient: topicAddr(l.topics[1]), amount: word(l.data, 0) } },
}
export const stockByPool = (p) => STOCKS.find((s) => s.pool === String(p).toLowerCase()) || null
