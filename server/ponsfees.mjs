// Pons V2 creator fees still waiting for the board (161 PONS-FEES / 176 pattern) → the keeper harvests when this is ≥ the
// threshold:
//   getLaunchedToken(token) → curve, phase, pairToken, creatorFeeRecipient …
//   curve phase (0): creatorTaxBalance + quoteFeeBalance × (1 − protocolFeeShareBps) − buybackQuoteBalance
//   graduated:       the same over the meme hook's pendingCreatorTax / pendingFees / pendingBuyback (native ETH)
//   escrow:          PonsV2FeeEscrow.balanceOf(board) (credited, not claimed yet)
// Plain ETH sent to the board (manual fee mode) is split by receive() at once — nothing to harvest.
import { keccak256, encodeAbiParameters } from 'viem'
import { lower, ZERO } from './lib/util.mjs'
import { ADDR } from './config.mjs'
import { PONS_FACTORY_ABI, CURVE_ABI, HOOK_ABI, ESCROW_ABI } from './abi.mjs'

/** Pure: the creator's share of a fee bucket. */
export const creatorShare = (fees, tax, buyback, shareBps) => {
  const bucket = fees - (fees * shareBps) / 10_000n
  const bb = buyback < bucket ? buyback : bucket
  return bucket - bb + tax
}
/** Uniswap V4 PoolId = keccak256(abi.encode(PoolKey{currency0, currency1, fee, tickSpacing, hooks})), currencies sorted. */
export function poolIdOf(token, pairToken, fee, tickSpacing, hook) {
  const a = lower(token), b = lower(pairToken || ZERO)
  const [c0, c1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a]
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], [c0, c1, Number(fee), Number(tickSpacing), hook]))
}

/** → {escrowWei, unsweptWei, totalWei, stage} ; token may be null (manual fee mode: escrow only). `reads` = rpc client. */
export async function pendingFees(reads, board, token) {
  const safe = (p) => p.then((v) => BigInt(v)).catch(() => 0n)
  const escrowWei = await safe(reads.call(ADDR.feeEscrow, ESCROW_ABI, 'balanceOf', [board]))
  if (!token) return { escrowWei, unsweptWei: 0n, totalWei: escrowWei, stage: null }
  const l = await reads.call(ADDR.ponsFactory, PONS_FACTORY_ABI, 'getLaunchedToken', [token])
  if (!l?.exists || lower(l.creatorFeeRecipient) !== lower(board) || lower(l.pairToken) !== ZERO) return { escrowWei, unsweptWei: 0n, totalWei: escrowWei, stage: 'not-bound' }
  let unswept = 0n
  if (Number(l.phase) === 0) {
    const [tax, fees, bb, share] = await Promise.all(['creatorTaxBalance', 'quoteFeeBalance', 'buybackQuoteBalance', 'protocolFeeShareBps'].map((f) => safe(reads.call(l.curve, CURVE_ABI, f))))
    unswept = creatorShare(fees, tax, bb, share || 3000n)
  } else {
    const pid = poolIdOf(token, ZERO, l.poolFee, l.tickSpacing, ADDR.memeHook)
    const [fees, tax, bb] = await Promise.all(['pendingFees', 'pendingCreatorTax', 'pendingBuyback'].map((f) => safe(reads.call(ADDR.memeHook, HOOK_ABI, f, [pid, ZERO]))))
    const share = await safe(reads.call(ADDR.memeHook, HOOK_ABI, 'protocolFeeShareBps'))
    unswept = creatorShare(fees, tax, bb, share || 3000n)
  }
  return { escrowWei, unsweptWei: unswept, totalWei: escrowWei + unswept, stage: Number(l.phase) === 0 ? 'curve' : 'graduated' }
}
