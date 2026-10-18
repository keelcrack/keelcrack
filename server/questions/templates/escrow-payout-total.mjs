// Tier III — total native ETH (wei) the Pons fee escrow paid out to creator fee recipients in the window.
import { sourceParams, decode } from '../sources.mjs'
import { between, ESCROW, ESCROW_HINT, OFFICIAL_RPC_HINT, ref } from '../helpers.mjs'

export default {
  key: 'escrow-payout-total', tier: 3, span: 1, sources: ['escrow'],
  variants: [{}],
  build({ window: w, logs }) {
    const ls = logs('escrow')
    const total = ls.reduce((a, l) => a + decode.escrowClaim(l).amount, 0n)
    if (total === 0n) return null
    return {
      title: 'Creator fees paid out',
      prompt: `How much native ETH, in wei, did the Pons V2 fee escrow ${ESCROW} pay out to creator fee recipients ${between(w)}? Sum the amount of every Claimed(address recipient, uint256 amount) event it emitted. Answer in wei as a whole number.`,
      answerFormat: 'uint', unit: 'wei',
      hints: [ESCROW_HINT, 'ClaimedToken events (ERC-20 payouts) do not count', OFFICIAL_RPC_HINT],
      answer: total.toString(),
      method: `Fetch the Claimed logs of ${ESCROW} over [${w.fromBlock}, ${w.toBlock}] and add up their amount (data word 0).`,
      sources: [sourceParams('escrow', w.fromBlock, w.toBlock)],
      items: ls.map((l) => { const d = decode.escrowClaim(l); return { ...ref(l), recipient: d.recipient, wei: d.amount.toString() } }),
    }
  },
}
