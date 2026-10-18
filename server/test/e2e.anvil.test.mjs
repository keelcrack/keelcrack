// End to end on a local anvil with the real KeelBoard (contracts/out/KeelBoard.sol/KeelBoard.json, built by CONTRACTS):
// the keeper posts from recorded RC data (text/answer hashes checked against the contract's own views), drips, two
// solvers commit + reveal with real txs, the keeper settles (contract picks the winner), the winner claims; a second
// question closes unsolved 24 h later; the accounting identity holds. Skips when anvil or the artifact is missing.
// Keys: anvil's public dev mnemonic accounts (local test values only).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodeAbiParameters } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { createRpc, hexToBig, toQty } from '../lib/rpc.mjs'
import { createBoardChain } from '../chain.mjs'
import { createBoardIndexer } from '../board.mjs'
import { createKeeper } from '../keeper.mjs'
import { memStore, clock, loadFixture, fixtureFiles, anyHourData } from './helpers.mjs'
import { textHash, answerHash, commitHash, modelBytes32 } from '../questions/hash.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ART = join(ROOT, 'contracts', 'out', 'KeelBoard.sol', 'KeelBoard.json')
const hasAnvil = spawnSync('anvil', ['--version']).status === 0
const skip = !hasAnvil ? 'anvil not installed' : !existsSync(ART) ? 'KeelBoard artifact missing (cd contracts && forge build)' : false
const DEV_MNEMONIC = 'test test test test test test test test test test test junk' // anvil's public dev mnemonic
const [OWNER, POSTER, ALICE, BOB] = [0, 1, 2, 3].map((addressIndex) => mnemonicToAccount(DEV_MNEMONIC, { addressIndex }))
const ETH = 10n ** 18n
const MIN_BOND = 300000000000000n
let proc = null
after(() => { if (proc) proc.kill('SIGKILL') })

async function startAnvil(timestamp) {
  for (let k = 0; k < 5; k++) {
    const port = 20000 + Math.floor(Math.random() * 20000)
    proc = spawn('anvil', ['--port', String(port), '--timestamp', String(timestamp), '--silent', '--chain-id', '31337'], { stdio: 'ignore' })
    const url = `http://127.0.0.1:${port}`
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100))
      try { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }); if (r.ok) return url } catch {}
    }
    proc.kill('SIGKILL')
  }
  throw new Error('anvil did not start')
}

test('e2e on anvil: post → drip → commit/reveal → settle (contract picks the winner) → claim → unsolved at close', { skip, timeout: 120_000 }, async () => {
  const fx = loadFixture(fixtureFiles().at(-1))
  const T0 = (fx.hour + 1) * 3600 + 60
  const url = await startAnvil(T0)
  const R = createRpc([url], { name: 'anvil', minGapMs: 0 })
  const rpc = (m, p = []) => R.rpc(m, p)
  const mine = async (secs) => { if (secs) await rpc('evm_increaseTime', [toQty(secs)]); await rpc('evm_mine') }
  const waitTx = async (hash) => { for (let i = 0; i < 100; i++) { const r = await rpc('eth_getTransactionReceipt', [hash]); if (r) return r; await new Promise((x) => setTimeout(x, 50)) } throw new Error('no receipt') }

  // deploy KeelBoard(owner, poster, pauser, minBond, ponsFactory, feeEscrow, memeHook) from the unlocked owner account
  const art = JSON.parse(readFileSync(ART, 'utf8'))
  const ctor = art.abi.find((x) => x.type === 'constructor')
  const args = encodeAbiParameters(ctor.inputs, [OWNER.address, POSTER.address, OWNER.address, MIN_BOND, '0x' + '00'.repeat(19) + '01', '0x' + '00'.repeat(19) + '02', '0x' + '00'.repeat(19) + '03'])
  const dep = await waitTx(await rpc('eth_sendTransaction', [{ from: OWNER.address, data: art.bytecode.object + args.slice(2), gas: toQty(8_000_000) }]))
  assert.equal(dep.status, '0x1')
  const address = dep.contractAddress
  // fund the pool: a plain transfer is split 80 / 20 by receive()
  await waitTx(await rpc('eth_sendTransaction', [{ from: OWNER.address, to: address, value: toQty(ETH), gas: toQty(200_000) }]))

  const c = clock(T0 * 1000)
  const sync = async () => { const b = await R.block('latest'); c.t = (b.timestamp + 1) * 1000 }
  const chain = createBoardChain({ reads: R, logs: R, address, abi: art.abi, account: POSTER, chainId: 31337, pollMs: 50 })
  const asUser = (acct) => createBoardChain({ reads: R, logs: R, address, abi: art.abi, account: acct, chainId: 31337, pollMs: 50 })
  const ms = memStore({ preview: false, now: c.now })
  const board = createBoardIndexer({ chain, store: ms.store, startBlock: 0 })
  const keeper = createKeeper({ store: ms.store, chain, board, data: anyHourData(fx), box: ms.box, now: c.now })

  // ---- hour 1: post + drip
  await sync(); await keeper.tick()
  const st1 = await chain.stats()
  assert.equal(st1.count, 1, `posted (lastError ${JSON.stringify(keeper.state.lastError)})`)
  const g = ms.store.genByQid(1)
  const s = ms.store.secretOf(g)
  const q = await chain.question(1)
  assert.equal(q.textHash, textHash(g.question), 'textHash on chain = keccak(canonical JSON served by /api/q)')
  assert.equal(await chain.read('answerHashOf', [1n, s.answerBytes32, s.salt]), q.answerHash, 'contract view agrees with hash.mjs')
  assert.equal(answerHash(1, s.answerBytes32, s.salt), q.answerHash)
  assert.equal(q.load, (8n * ETH) / 10n / 100n, '1 % of the 0.8 ETH pool dripped onto #1')
  assert.equal(ms.store.qRow(1).load_wei, String(q.load))

  // ---- two solvers, both right: alice commits first, bob second and reveals first → the contract waits for alice
  const NA = '0x' + 'aa'.repeat(32), NB = '0x' + 'bb'.repeat(32)
  const bond = BigInt(await chain.read('bondFor', [1n]))
  assert.equal(bond, q.load * 500n / 10_000n > MIN_BOND ? q.load * 500n / 10_000n : MIN_BOND, 'bond = max(MIN_BOND, load × 5 %)')
  assert.equal(ms.store.qItem(ms.store.qRow(1)).bondWei, String(bond), 'QItem.bondWei = bondFor(id)')
  const chA = commitHash(1, ALICE.address, s.answerBytes32, NA)
  assert.equal(await chain.read('commitHashOf', [1n, ALICE.address, s.answerBytes32, NA]), chA, 'commit hash matches the contract')
  await asUser(ALICE).send('commit', [1n, chA, modelBytes32('claude-opus-4')], { value: bond })
  await asUser(BOB).send('commit', [1n, commitHash(1, BOB.address, s.answerBytes32, NB), modelBytes32('gpt-5')], { value: bond + 1000n })
  assert.equal(await chain.owed(BOB.address), 1000n, 'overpaid bond credited to owed')
  await mine(2)
  await asUser(BOB).send('reveal', [1n, 1n, s.answerBytes32, NB])
  await sync(); await keeper.tick()
  assert.equal((await chain.question(1)).status, 1, 'alice (index 0) has not revealed: settle waits')
  assert.match(keeper.state.waiting[1] || '', /EarlierCommitPending\(0\)/)
  await asUser(ALICE).send('reveal', [1n, 0n, s.answerBytes32, NA])
  await mine(15); await sync(); await keeper.tick()
  const q1 = await chain.question(1)
  assert.equal(q1.status, 2, `solved (lastError ${JSON.stringify(keeper.state.lastError)})`)
  assert.equal(q1.winner, ALICE.address.toLowerCase(), 'the earliest correct commit wins')
  assert.equal(await chain.owed(ALICE.address), q1.load + bond)
  assert.equal(await chain.owed(BOB.address), bond + 1000n, 'a later correct reveal gets its bond back')
  const v = ms.store.qView(1)
  assert.equal(v.status, 'solved'); assert.equal(v.winnerModel, 'claude-opus-4'); assert.equal(v.working.salt, s.salt)
  assert.deepEqual(v.commits.map((x) => x.correct), [true, true])
  // alice claims
  await asUser(ALICE).send('claim', [])
  await board.poll()
  assert.ok(ms.store.ledgerView().items.some((x) => x.kind === 'claim' && x.from === ALICE.address.toLowerCase()))

  // ---- next hour: #2 posted + dripped; nobody answers; 24 h later it closes unsolved
  await mine(3600); await sync(); await keeper.tick()
  assert.equal((await chain.stats()).count, 2)
  const load2 = (await chain.question(2)).load
  assert.ok(load2 > 0n)
  await mine(24 * 3600 + 120); await sync(); await keeper.tick()
  assert.equal((await chain.question(2)).status, 3, `unsolved (lastError ${JSON.stringify(keeper.state.lastError)})`)
  assert.equal(ms.store.qView(2).status, 'unsolved')
  assert.ok(ms.store.qView(2).working.answer)

  // ---- accounting identity: balance == pool + infra + Σload(open) + Σbonds + Σowed
  const st = await chain.stats()
  const [bonds, owed] = await chain.read('held')
  const bal = await chain.balance()
  assert.equal(bal, st.pool + st.infra + st.totalLoad + bonds + owed)
  const lb = ms.store.leaderboard({ by: 'model', range: 'all' })
  assert.equal(lb.items[0].key, 'claude-opus-4')
  assert.equal(lb.items[0].cracked, 1)
})
