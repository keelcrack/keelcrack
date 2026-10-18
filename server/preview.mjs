// Preview generator (before the board + CA exist, or live without a poster key): no chain writes; every hour the question
// for the hour that just ended is generated from real RC data exactly like the keeper would, stored as kind 'preview'
// (id = gid, postedAt = hh:00 + POST_DELAY, closesAt = +24 h) and put straight into the practice pool, so practice works at
// T0. On first start the last PREVIEW_BACKFILL_HOURS hours (default 6) are generated too. A preview question's working is
// published when its closesAt passes (store.openExpiredPreview).
import { log, hourOf, HOUR_MS } from './lib/util.mjs'
import { generate } from './questions/index.mjs'
import { SCHEDULE } from './config.mjs'

export function createPreviewGenerator({ store, data, emit = () => {}, now = () => Date.now(), backfillHours = Number(process.env.PREVIEW_BACKFILL_HOURS ?? 6), schedule = SCHEDULE, generator = generate }) {
  const st = { lastRunAt: null, generated: 0, lastError: null, lastHour: null }
  let first = true
  async function genHour(hour) {
    if (store.genByHour('preview', hour)) return null
    const tries = store.kvGet(`preview.tries.${hour}`, 0)
    if (tries >= 3) return null
    try {
      const g = await generator({ data, hour, now })
      const postedAt = (hour + 1) * HOUR_MS + schedule.postDelayMs
      const gid = store.storePreview(g, { postedAt, closesAt: postedAt + schedule.openHours * HOUR_MS })
      st.generated++; st.lastHour = hour
      log(`preview question p${gid} [tier ${g.tier}] ${g.template} — ${g.title} (hour ${new Date(hour * HOUR_MS).toISOString().slice(0, 13)}h)`)
      emit('posted', store.previewItem(store.genRow(gid)))
      return gid
    } catch (e) {
      if (e.notYet) return null
      store.kvSet(`preview.tries.${hour}`, tries + 1)
      st.lastError = { at: now(), hour, message: String(e.message).slice(0, 240) }
      log(`preview hour ${hour}: ${st.lastError.message}`)
      return null
    }
  }
  async function tick() {
    st.lastRunAt = now()
    const last = hourOf(now() - schedule.postDelayMs) - 1
    const hours = first ? Array.from({ length: Math.max(1, backfillHours) }, (_, k) => last - Math.max(1, backfillHours) + 1 + k) : [last]
    first = false
    for (const h of hours) await genHour(h)
    store.openExpiredPreview()
  }
  return { tick, genHour, state: st }
}
