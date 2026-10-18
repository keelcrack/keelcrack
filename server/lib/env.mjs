// Local settings: server/.env (KEEPER_PRIVATE_KEY, SALT_KEY, RPC_URLS, PORT …). Never overrides real env vars, never prints
// values. On the VPS systemd's EnvironmentFile is used as well; NO_DOTENV=1 (tests) skips the file.
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { SERVER_DIR } from './util.mjs'

export const ENV_FILE = join(SERVER_DIR, '.env')

export function parseEnv(text) {
  const out = {}
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    else v = v.replace(/\s+#.*$/, '')
    out[m[1]] = v
  }
  return out
}

export function loadLocalEnv(files = [ENV_FILE]) {
  if (process.env.NO_DOTENV === '1') return []
  const loaded = []
  for (const f of files) {
    if (!existsSync(f)) continue
    try {
      for (const [k, v] of Object.entries(parseEnv(readFileSync(f, 'utf8')))) if (process.env[k] === undefined && v !== '') process.env[k] = v
      loaded.push(f)
    } catch {}
  }
  return loaded
}
