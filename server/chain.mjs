// KeelBoard adapter over lib/rpc.mjs (no viem client: encode/decode with viem, transport = our paced multi-mirror RPC with
// the IP pin). The same code drives RC mainnet and a local anvil (tests).
//   read(fn, args) · head() · stats() · question(id) · commitAt(id, i) · openIds() · nextDripAt() · minBond() · owed(a)
//   boardLogs(from, to) → decoded events [{eventName, args, blockNumber, logIndex, transactionHash}]
//   simulate(fn, args, {value}) → {ok, result} | {ok:false, errorName, errorArgs, message}   (eth_call from the keeper)
//   send(fn, args, {value}) → {hash, receipt, events} — simulated first (a revert costs nothing), serialised (one tx at a
//     time, nonce from 'pending'), EIP-1559 fields (priority 0: Arbitrum ignores tips), receipt awaited.
//   KEEPER_DRY_RUN=1: simulate and log instead of sending ({dryRun: true}).
import { encodeFunctionData, decodeFunctionResult, decodeErrorResult, decodeEventLog } from 'viem'
import { hexToBig, toQty } from './lib/rpc.mjs'
import { log, lower, sleep } from './lib/util.mjs'

const errText = (e) => String(e?.rpc?.message || e?.shortMessage || e?.message || e).split('\n')[0].slice(0, 200)

export function createBoardChain({ reads, logs, address, abi, account = null, chainId, dryRun = process.env.KEEPER_DRY_RUN === '1', receiptTimeoutMs = 120_000, pollMs = 1000 }) {
  const A = () => (typeof abi === 'function' ? abi() : abi)
  const to = lower(address)
  let lock = Promise.resolve()
  let cid = chainId ?? null

  async function read(functionName, args = [], { from } = {}) {
    const data = encodeFunctionData({ abi: A(), functionName, args })
    const res = await reads.rpc('eth_call', [{ to, data, ...(from ? { from } : {}) }, 'latest'])
    return decodeFunctionResult({ abi: A(), functionName, data: res })
  }
  const head = () => reads.block('latest')
  async function stats() {
    const [pool, infra, totalLoad, lastDrip, count] = await read('stats')
    return { pool, infra, totalLoad, lastDrip: Number(lastDrip), count: Number(count) }
  }
  const field = (o, n, i) => (o && !Array.isArray(o) && n in o ? o[n] : Object.values(o)[i])
  async function question(id) {
    const q = await read('questionOf', [BigInt(id)])
    return { postedAt: Number(field(q, 'postedAt', 0)), closesAt: Number(field(q, 'closesAt', 1)), tier: Number(field(q, 'tier', 2)), status: Number(field(q, 'status', 3)),
      answerHash: field(q, 'answerHash', 4), textHash: field(q, 'textHash', 5), load: BigInt(field(q, 'load', 6)), winner: lower(field(q, 'winner', 7)), winnerIndex: Number(field(q, 'winnerIndex', 8)), commits: Number(field(q, 'commits', 9)) }
  }
  async function commitAt(id, i) {
    const c = await read('commitOf', [BigInt(id), BigInt(i)])
    return { solver: lower(field(c, 'solver', 0)), hash: field(c, 'hash', 1), at: Number(field(c, 'at', 2)), bond: BigInt(field(c, 'bond', 3)), model: field(c, 'model', 4), revealed: !!field(c, 'revealed', 5), answer: field(c, 'answer', 6) }
  }
  const openIds = async () => (await read('openIds')).map(Number)
  const nextDripAt = async () => Number(await read('nextDripAt'))
  const minBond = async () => BigInt(await read('MIN_BOND'))
  const owed = async (a) => BigInt(await read('owed', [a]))
  const balance = async (a = to) => hexToBig(await reads.rpc('eth_getBalance', [a, 'latest']))

  function decode(l) {
    try {
      const ev = decodeEventLog({ abi: A(), data: l.data, topics: l.topics })
      return { eventName: ev.eventName, args: ev.args, blockNumber: Number(hexToBig(l.blockNumber)), logIndex: Number(hexToBig(l.logIndex)), transactionHash: l.transactionHash }
    } catch { return null }
  }
  async function boardLogs(from, toBlock) {
    const raw = await logs.getLogs({ address: to }, from, toBlock)
    return raw.map(decode).filter(Boolean)
  }

  async function simulate(functionName, args = [], { value } = {}) {
    if (!account) return { ok: false, errorName: 'NoKey', message: 'no keeper key' }
    const data = encodeFunctionData({ abi: A(), functionName, args })
    try {
      const res = await reads.rpc('eth_call', [{ from: account.address, to, data, ...(value ? { value: toQty(value) } : {}) }, 'latest'])
      let result = null
      try { result = decodeFunctionResult({ abi: A(), functionName, data: res }) } catch {}
      return { ok: true, result, data }
    } catch (e) {
      const d = e?.rpc?.data
      const hex = typeof d === 'string' ? d : typeof d?.data === 'string' ? d.data : null
      if (hex && hex.length >= 10) {
        try { const er = decodeErrorResult({ abi: A(), data: hex }); return { ok: false, errorName: er.errorName, errorArgs: er.args, message: `${er.errorName}(${(er.args || []).map(String).join(', ')})` } } catch {}
      }
      if (!e.rpc) throw e // transport trouble: not a revert
      return { ok: false, errorName: 'Revert', message: errText(e) }
    }
  }

  async function receiptOf(hash) {
    const t0 = Date.now()
    while (Date.now() - t0 < receiptTimeoutMs) {
      const r = await reads.rpc('eth_getTransactionReceipt', [hash]).catch(() => null)
      if (r) return r
      await sleep(pollMs)
    }
    throw new Error(`no receipt for ${hash} after ${receiptTimeoutMs / 1000} s`)
  }

  function send(functionName, args = [], { value = 0n } = {}) {
    const run = async () => {
      const sim = await simulate(functionName, args, { value })
      if (!sim.ok) throw Object.assign(new Error(`${functionName} would revert: ${sim.message}`), { errorName: sim.errorName, errorArgs: sim.errorArgs, simulated: true })
      if (dryRun) { log(`[dry run] keeper ${functionName}(${args.map(String).join(', ').slice(0, 160)})`); return { dryRun: true } }
      if (cid == null) cid = Number(hexToBig(await reads.rpc('eth_chainId', [])))
      const from = account.address
      const [nonceHex, gasHex, priceHex] = await Promise.all([
        reads.rpc('eth_getTransactionCount', [from, 'pending']),
        reads.rpc('eth_estimateGas', [{ from, to, data: sim.data, ...(value ? { value: toQty(value) } : {}) }]),
        reads.rpc('eth_gasPrice', []),
      ])
      const gas = (hexToBig(gasHex) * 13n) / 10n + 10_000n
      const price = hexToBig(priceHex)
      const signed = await account.signTransaction({ type: 'eip1559', chainId: cid, nonce: Number(hexToBig(nonceHex)), to, data: sim.data, value: BigInt(value || 0), gas, maxFeePerGas: price * 2n + 1n, maxPriorityFeePerGas: 0n })
      const hash = await reads.rpc('eth_sendRawTransaction', [signed], { rounds: 1 })
      log(`keeper: ${functionName} tx ${hash}`)
      const receipt = await receiptOf(hash)
      if (receipt.status !== '0x1') throw Object.assign(new Error(`${functionName} reverted on chain (${hash})`), { hash, receipt })
      const events = (receipt.logs || []).filter((l) => lower(l.address) === to).map(decode).filter(Boolean)
      return { hash, receipt, events, blockNumber: Number(hexToBig(receipt.blockNumber)) }
    }
    const p = lock.then(run, run)
    lock = p.catch(() => {})
    return p
  }

  /** Head as the log mirror sees it (the board tail never asks for blocks the log mirror does not have yet). */
  const logHead = async () => ({ number: await logs.blockNumber() })
  return { address: to, account: account ? lower(account.address) : null, dryRun, read, head, logHead, stats, question, commitAt, openIds, nextDripAt, minBond, owed, balance, boardLogs, decode, simulate, send, block: (n) => logs.block(n) }
}
