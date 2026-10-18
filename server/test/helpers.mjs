// Test helpers: recorded RC fixtures, a controllable clock, an in-memory store.
import { readFileSync, readdirSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb } from '../db.mjs'
import { createStore } from '../store.mjs'
import { createSecretBox } from '../lib/secret.mjs'
import { fixtureData } from '../indexer.mjs'

export const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'questions', 'fixtures')
export const fixtureFiles = () => readdirSync(FIX_DIR).filter((f) => f.endsWith('.json.gz')).sort()
export const loadFixture = (f) => JSON.parse(gunzipSync(readFileSync(join(FIX_DIR, f))).toString('utf8'))

/** fixtureData that answers any hour with the fixture's windows (keeper/e2e tests run on other clock hours). */
export function anyHourData(fx) {
  const d = fixtureData(fx)
  return { ...d, window: async (_hour, span = 1) => fx.windows[`${fx.hour}:${span}`] }
}

/** A controllable clock (ms). */
export function clock(t) { const c = { t, now: () => c.t, add: (ms) => { c.t += ms; return c.t } }; return c }

export const TEST_KEY = 'ab'.repeat(32)
export function memStore({ preview = false, now, emit } = {}) {
  const db = openDb(':memory:')
  const box = createSecretBox({ key: TEST_KEY })
  const events = []
  const store = createStore(db, { preview, box, now, emit: emit || ((ev, d) => events.push([ev, d])) })
  return { db, box, store, events }
}
