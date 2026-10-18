// Tier II — the address that claimed the most native ETH from the Pons fee escrow in the window.
import { sourceParams, decode } from '../sources.mjs'
import { between, ESCROW, ESCROW_HINT, OFFICIAL_RPC_HINT, rank, pos } from '../helpers.mjs'

export default {
  key: 'escrow-top-claimer', tier: 2, span: 1, sources: ['escrow'],
  variants: [{}],
  build({ window: w, logs }) {
    const ranked = rank(logs('escrow').map((l) => { const d = decode.escrowClaim(l); return { key: d.recipient, value: d.amount, first: pos(l) } }))
    if (ranked.length < 2 || ranked[0].value === 0n) return null
    return {
      title: 'Top creator-fee claimer',
      prompt: `Which address claimed the most native ETH from the Pons V2 fee escrow ${ESCROW} ${between(w)}? Sum the amount of its Claimed(recipient, amount) events per recipient. Ties go to the address that claimed first. Answer with the address.`,
      answerFormat: 'address', unit: null,
      hints: [ESCROW_HINT, 'ClaimedToken events (ERC-20 payouts) do not count', OFFICIAL_RPC_HINT],
      answer: ranked[0].key,
      method: `Decode the Claimed logs of ${ESCROW} over [${w.fromBlock}, ${w.toBlock}], sum amount by recipient, take the largest (ties → first claimer).`,
      sources: [sourceParams('escrow', w.fromBlock, w.toBlock)],
      items: ranked.slice(0, 25).map((r) => ({ address: r.key, wei: r.value.toString(), claims: r.n })),
    }
  },
}
