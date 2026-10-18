// KeelBoard event tail (live mode): every poll, eth_getLogs of the board from the cursor to the head (the official RPC
// serves millions of blocks per call with the address filter), block times from headers (cached), each event applied to
// the store (questions, commits, ledger, loads, SSE). Cursor in kv 'board.cursor'; first start = BOARD_DEPLOY_BLOCK /
// contracts.json deployBlock, else head − 30,000,000 (~3.5 days of RC blocks).
import { log } from './lib/util.mjs'

export function createBoardIndexer({ chain, store, startBlock = null, lookback = 30_000_000 }) {
  const st = { cursor: store.kvGet('board.cursor', null), head: null, events: 0, lastError: null, lastRunAt: null }
  const ts = new Map()
  async function timeOf(n) {
    if (!ts.has(n)) { ts.set(n, (await chain.block(n)).timestamp * 1000); if (ts.size > 4000) ts.delete(ts.keys().next().value) }
    return ts.get(n)
  }
  let busy = null
  async function run() {
    st.lastRunAt = Date.now()
    const head = (await (chain.logHead || chain.head)()).number
    st.head = head
    if (st.cursor == null) { st.cursor = startBlock ?? Math.max(0, head - lookback); log(`board: indexing from block ${st.cursor}`) }
    if (st.cursor > head) return 0
    const evs = await chain.boardLogs(st.cursor, head)
    let n = 0
    for (const ev of evs) if (store.applyEvent(ev, await timeOf(ev.blockNumber))) n++
    st.cursor = head + 1
    store.kvSet('board.cursor', st.cursor)
    st.events += n
    return n
  }
  /** One poll (concurrent callers share it). */
  async function poll() {
    if (busy) return busy
    busy = run().catch((e) => { st.lastError = String(e?.message || e).slice(0, 200); throw e }).finally(() => { busy = null })
    return busy
  }
  /** Apply events from our own receipts at once (the next poll skips them: applyEvent is idempotent). */
  async function applyOwn(events) { for (const ev of events || []) store.applyEvent(ev, await timeOf(ev.blockNumber)) }
  return { poll, applyOwn, state: st, view: () => ({ cursor: st.cursor, head: st.head, lag: st.head != null && st.cursor != null ? Math.max(0, st.head - st.cursor + 1) : null, events: st.events, lastError: st.lastError }) }
}
