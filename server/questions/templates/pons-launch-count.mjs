// Tier I — count the Pons V2 launches (TokenLaunched events of the factory) in the window.
import { sourceParams, decode } from '../sources.mjs'
import { between, FACTORY, LAUNCH_HINT, OFFICIAL_RPC_HINT, ref } from '../helpers.mjs'

export default {
  key: 'pons-launch-count', tier: 1, span: 1, sources: ['launches'],
  variants: [{}],
  build({ window: w, logs }) {
    const ls = logs('launches')
    if (!ls.length) return null
    return {
      title: 'New Pons launches',
      prompt: `How many tokens were launched through the Pons V2 launch factory ${FACTORY} on Robinhood Chain ${between(w)}? Count its TokenLaunched events. Answer with a whole number.`,
      answerFormat: 'uint', unit: 'count',
      hints: [LAUNCH_HINT, OFFICIAL_RPC_HINT],
      answer: String(ls.length),
      method: `Fetch the TokenLaunched logs of the factory ${FACTORY} over [${w.fromBlock}, ${w.toBlock}] and count them.`,
      sources: [sourceParams('launches', w.fromBlock, w.toBlock)],
      items: ls.map((l) => ({ ...ref(l), token: decode.launch(l).token })),
    }
  },
}
