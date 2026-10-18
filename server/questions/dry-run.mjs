#!/usr/bin/env node
// Dry run: generate one real question per template from live Robinhood Chain data and print it (nothing is posted).
//   node server/questions/dry-run.mjs                 the last closed hour
//   node server/questions/dry-run.mjs --hour 492250   a given unix hour number (window = that hour)
//   node server/questions/dry-run.mjs --only stock-top-buyer
//   node server/questions/dry-run.mjs --json          machine-readable output
//   node server/questions/dry-run.mjs --capture server/questions/fixtures/hour-<h>.json.gz   also record a test fixture
// RC logs are cached in DATA_DIR/dryrun.db (so re-runs cost no RPC calls). Needs network; uses server/lib/rpc.mjs mirrors.
import { loadLocalEnv } from '../lib/env.mjs'
loadLocalEnv()
const { join } = await import('node:path')
const { writeFileSync } = await import('node:fs')
const { gzipSync } = await import('node:zlib')
const { openDb } = await import('../db.mjs')
const { createRcData } = await import('../indexer.mjs')
const { clients } = await import('../lib/rpc.mjs')
const { TEMPLATES, runTemplate, assemble, workingOf } = await import('./index.mjs')
const { canonicalQuestion } = await import('./canon.mjs')
const { textHash } = await import('./hash.mjs')
const { DATA_DIR } = await import('../lib/util.mjs')
const { FINAL_LAG_S } = await import('../indexer.mjs')

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null }
const flag = (k) => process.argv.includes(k)
const db = openDb(process.env.DRYRUN_DB || join(DATA_DIR, 'dryrun.db'))
const { logs: rpc } = clients()
const data = createRcData({ db, rpc })
const head = await data.head()
const hour = arg('--hour') ? Number(arg('--hour')) : Math.floor((head.timestamp - FINAL_LAG_S) / 3600) - 1
const only = arg('--only')
const out = []
const t0 = Date.now()
for (const t of TEMPLATES) {
  if (only && t.key !== only) continue
  try {
    const g = await runTemplate(t, { data, hour })
    if (!g) { out.push({ template: t.key, tier: t.tier, skipped: 'not applicable this hour' }); continue }
    g.generatedAt = Date.now()
    const postedAt = (hour + 1) * 3_600_000 + 45_000
    const q = assemble(g, { id: 0, postedAt, closesAt: postedAt + 24 * 3_600_000 })
    out.push({ template: t.key, tier: t.tier, title: g.title, prompt: g.prompt, window: g.window, answerFormat: g.answerFormat, unit: g.unit, answer: g.answer, answerBytes32: g.answerBytes32, items: g.work.items.length, textHash: textHash(canonicalQuestion(q)), hints: g.hints, method: g.work.method, _g: g })
  } catch (e) { out.push({ template: t.key, tier: t.tier, error: String(e.message).slice(0, 200) }) }
}

if (flag('--json')) console.log(JSON.stringify(out.map(({ _g, ...r }) => r), null, 2))
else {
  console.log(`KEELCRACK dry run · window hour ${hour} (${new Date(hour * 3_600_000).toISOString()} → +1 h) · head ${head.number} · ${((Date.now() - t0) / 1000).toFixed(1)} s · rpc ${JSON.stringify({ calls: rpc.state().calls, requests: rpc.state().requests, rateLimited: rpc.state().rateLimited })}\n`)
  for (const r of out) {
    console.log(`── [Tier ${'I'.repeat(r.tier)}] ${r.template}${r.title ? ` — ${r.title}` : ''}`)
    if (r.error || r.skipped) { console.log(`   ${r.error ? 'ERROR ' + r.error : 'skipped: ' + r.skipped}\n`); continue }
    console.log(`   ${r.prompt}`)
    console.log(`   window ${r.window.fromBlock}–${r.window.toBlock} (${r.window.fromTime} → ${r.window.toTime}) · format ${r.answerFormat}${r.unit ? ' · unit ' + r.unit : ''}`)
    console.log(`   ANSWER ${r.answer}  (bytes32 ${r.answerBytes32}) · ${r.items} working items · textHash(id 0) ${r.textHash}\n`)
  }
}

const cap = arg('--capture')
if (cap) {
  // record exactly the logs the templates read, plus the windows (+ the expected answers at capture time)
  const windows = {}, logs = { swaps: [], launches: [], trades: [], escrow: [] }
  const w1 = await data.window(hour, 1), w24 = await data.window(hour, 24)
  windows[`${hour}:1`] = w1; windows[`${hour}:24`] = w24
  logs.swaps = data.logs('swaps', w1.fromBlock, w1.toBlock)
  logs.escrow = data.logs('escrow', w1.fromBlock, w1.toBlock)
  logs.launches = data.logs('launches', w24.fromBlock, w24.toBlock)
  const curves = new Set(data.logs('launches', w1.fromBlock, w1.toBlock).map((l) => '0x' + l.topics[2].slice(26)))
  logs.trades = data.logs('trades', w1.fromBlock, w1.toBlock).filter((l) => curves.has(l.address))
  const expected = Object.fromEntries(out.filter((r) => r.answer).map((r) => [r.template, { answer: r.answer, params: r._g.params, items: r.items }]))
  const fx = { capturedAt: new Date().toISOString(), hour, windows, logs, expected }
  writeFileSync(cap, gzipSync(JSON.stringify(fx)))
  console.log(`fixture → ${cap} (${Object.entries(logs).map(([k, v]) => `${k} ${v.length}`).join(', ')})`)
}
db.close()
void workingOf
