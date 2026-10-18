#!/usr/bin/env node
// Writes the built KeelBoard ABI to contracts/abi/KeelBoard.json (a plain ABI array) and, when web/contracts.json exists
// (APP owns that file), sets only its "abi.board" field; every other field is left as it is. The file is never created.
//   cd contracts && forge build && node script/export-abi.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const contracts = join(dirname(fileURLToPath(import.meta.url)), '..')
const artifactPath = join(contracts, 'out', 'KeelBoard.sol', 'KeelBoard.json')
if (!existsSync(artifactPath)) throw new Error('run `forge build` first (missing out/KeelBoard.sol/KeelBoard.json)')
const abi = JSON.parse(readFileSync(artifactPath, 'utf8')).abi

mkdirSync(join(contracts, 'abi'), { recursive: true })
const file = join(contracts, 'abi', 'KeelBoard.json')
writeFileSync(file, JSON.stringify(abi, null, 2) + '\n')
const count = (t) => abi.filter((e) => e.type === t).length
console.log(`KeelBoard ABI: ${count('function')} functions, ${count('event')} events, ${count('error')} errors -> ${file}`)

const webJson = join(contracts, '..', 'web', 'contracts.json')
if (existsSync(webJson)) {
  const raw = readFileSync(webJson, 'utf8')
  const cfg = JSON.parse(raw)
  cfg.abi = { ...(cfg.abi || {}), board: abi }
  const compact = !raw.includes('\n ') // keep APP's formatting style (compact one-liner or pretty)
  writeFileSync(webJson, (compact ? JSON.stringify(cfg) : JSON.stringify(cfg, null, 2)) + '\n')
  console.log(`web/contracts.json abi.board updated (${abi.length} entries)`)
} else {
  console.log('web/contracts.json not found: skipped (APP creates it)')
}
