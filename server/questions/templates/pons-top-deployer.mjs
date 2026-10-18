// Tier III — the deployer with the most Pons V2 launches in the last 24 hours (window = the 24 hours ending at block B).
import { sourceParams, decode } from '../sources.mjs'
import { between, FACTORY, LAUNCH_HINT, OFFICIAL_RPC_HINT, rank, pos } from '../helpers.mjs'

export default {
  key: 'pons-top-deployer', tier: 3, span: 24, sources: ['launches'],
  variants: [{}],
  build({ window: w, logs }) {
    const ranked = rank(logs('launches').map((l) => ({ key: decode.launch(l).deployer, value: 1n, first: pos(l) })))
    if (!ranked.length || ranked[0].value < 2n) return null
    return {
      title: 'Most active Pons deployer (24 h)',
      prompt: `Which address launched the most tokens through the Pons V2 factory ${FACTORY} in the 24 hours ${between(w)}? Count TokenLaunched events by their deployer (the third indexed topic). Ties go to the deployer whose first launch in the window came first. Answer with the address.`,
      answerFormat: 'address', unit: null,
      hints: [LAUNCH_HINT, 'The window spans about 864,000 blocks; the official RPC answers it in one eth_getLogs call with the factory address', OFFICIAL_RPC_HINT],
      answer: ranked[0].key,
      method: `Fetch the TokenLaunched logs of ${FACTORY} over [${w.fromBlock}, ${w.toBlock}], count them by deployer (topic 3), take the most (ties → earliest first launch).`,
      sources: [sourceParams('launches', w.fromBlock, w.toBlock)],
      items: ranked.slice(0, 25).map((r) => ({ address: r.key, launches: Number(r.value) })),
    }
  },
}
