// Question generator: the template registry, the hourly rotation (balanced over the three tiers), question assembly
// (canonical JSON + hashes) and the published working.
//   generate({data, hour, only?}) → generated question (no id yet) or throws when no template applies
//     data = indexer.mjs createRcData(...) or fixtureData(...); hour = unix hour number of the window (the hour that just ended)
//     Templates are tried in rotation order starting at hour % ROTATION.length; a template is skipped when one of its data
//     sources failed, or when its build returns null (no data, a trivial "0" answer, or no clear winner).
//   assemble(g, {id, postedAt, closesAt}) → the question object (canon.mjs order); canonicalQuestion() of it is hashed.
//   workingOf(g, {id, salt}) → {id, answer, answerBytes32, salt, method, sources, items, computedAt}
import { encodeAnswer, normalizeAnswer, QUESTION_VERSION } from './canon.mjs'
import { isoS } from '../lib/util.mjs'
import stockSwapCount from './templates/stock-swap-count.mjs'
import ponsLaunchCount from './templates/pons-launch-count.mjs'
import stockBuyerCount from './templates/stock-buyer-count.mjs'
import ponsMostTrades from './templates/pons-most-trades.mjs'
import stockLargestSwap from './templates/stock-largest-swap.mjs'
import stockTopBuyer from './templates/stock-top-buyer.mjs'
import escrowTopClaimer from './templates/escrow-top-claimer.mjs'
import escrowPayoutTotal from './templates/escrow-payout-total.mjs'
import ponsTopDeployer from './templates/pons-top-deployer.mjs'
import stockTopVolume from './templates/stock-top-volume.mjs'

export const TEMPLATES = Object.freeze([stockSwapCount, ponsLaunchCount, stockBuyerCount, ponsMostTrades, stockLargestSwap, stockTopBuyer, escrowTopClaimer, escrowPayoutTotal, ponsTopDeployer, stockTopVolume])
export const byKey = (k) => TEMPLATES.find((t) => t.key === k) || null
/** Tier I, II, III, I, II, III, … — each template once every 10 hours. */
export const ROTATION = Object.freeze(['stock-swap-count', 'pons-most-trades', 'escrow-payout-total', 'pons-launch-count', 'stock-largest-swap', 'pons-top-deployer', 'stock-buyer-count', 'stock-top-buyer', 'stock-top-volume', 'escrow-top-claimer'])

/** Run one template on a window (all variants in rotation order) → result or null. */
export async function runTemplate(t, { data, hour }) {
  const w = await data.window(hour, t.span)
  for (const src of t.sources) {
    try { await data.ensure(src, w.fromBlock, w.toBlock) } catch (e) { throw Object.assign(e, { src }) }
  }
  const logs = (src) => data.logs(src, w.fromBlock, w.toBlock)
  const n = t.variants.length
  const start = (Math.floor(hour / ROTATION.length) + hour) % n
  for (let k = 0; k < n; k++) {
    const params = t.variants[(start + k) % n]
    const out = t.build({ window: w, logs, params })
    if (!out) continue
    const answer = normalizeAnswer(out.answerFormat, out.answer)
    return {
      template: t.key, tier: t.tier, params, hour, title: out.title, prompt: out.prompt,
      window: { fromBlock: w.fromBlock, toBlock: w.toBlock, fromTime: w.fromTime, toTime: w.toTime },
      answerFormat: out.answerFormat, unit: out.unit ?? null, hints: out.hints || [],
      answer, answerBytes32: encodeAnswer(out.answerFormat, answer),
      work: { method: out.method, sources: out.sources, items: out.items || [] },
    }
  }
  return null
}

/** The question for `hour` (rotation with fallbacks). `only` forces one template. */
export async function generate({ data, hour, only = null, now = () => Date.now() }) {
  const tried = []
  const order = only ? [only] : ROTATION.map((_, k) => ROTATION[(hour + k) % ROTATION.length])
  const failedSrc = new Set()
  for (const key of order) {
    const t = byKey(key)
    if (!t) throw new Error(`unknown template ${key}`)
    if (t.sources.some((s) => failedSrc.has(s))) { tried.push({ template: key, reason: 'source failed' }); continue }
    try {
      const g = await runTemplate(t, { data, hour })
      if (g) return { ...g, tried, generatedAt: now() }
      tried.push({ template: key, reason: 'not applicable this hour' })
    } catch (e) {
      if (e.notYet) throw e
      if (e.src) failedSrc.add(e.src)
      tried.push({ template: key, reason: `error: ${String(e.message).slice(0, 120)}` })
    }
  }
  throw Object.assign(new Error(`no template applies for hour ${hour}: ${tried.map((x) => `${x.template} (${x.reason})`).join('; ')}`), { tried })
}

/** The question object hashed on-chain (BRIEF "Question format"). postedAt / closesAt in ms. */
export function assemble(g, { id, postedAt, closesAt }) {
  return {
    v: QUESTION_VERSION, id, tier: g.tier, template: g.template, title: g.title, prompt: g.prompt, window: { ...g.window },
    answerFormat: g.answerFormat, unit: g.unit, hints: [...g.hints], postedAt: isoS(postedAt), closesAt: isoS(closesAt),
  }
}

/** The working published after close. */
export function workingOf(g, { id, salt, computedAt = g.generatedAt ?? Date.now() }) {
  return { id, answer: g.answer, answerBytes32: g.answerBytes32, salt, method: g.work.method, sources: g.work.sources, items: g.work.items, computedAt }
}
