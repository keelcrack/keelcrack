// /q/?id=N: one question. Prompt, window, text-hash check, bounty chart, commits, the answer panel (commit → auto reveal
// with a manual fallback), top up, claim, and after close the answer, salt, answer-hash check, winner and working.
import { api, live, statusOf, isDemo } from '/shared/api.js'
import { wallet, board, humanError } from '/shared/wallet.js'
import { encodeAnswer, decodeAnswer, commitHash, answerHash, textHash, canonicalQuestion, modelTag, randomBytes32, EncodeError } from '/shared/abi.js'
import { esc, fmtEth, fmtWei, fmtLeft, fmtSolve, fmtDate, fmtInt, timeAgo, shortAddr, shortHash, toMs, parseUnits, plural, FORMAT_LABEL, TIER_LABEL } from '/shared/fmt.js'
import { tierTag, statusTag, ethOf, floeSvg, $, $$, copyBtn, wireCopy, ticker, errorBox } from '/shared/ui.js'
import { explorerBlock, explorerTx, explorerAddress, toast, ICON } from '/shared/site.js'

const id = Number(new URLSearchParams(location.search).get('id'))
const REVEAL_WINDOW = 600 // s
let Q = null          // GET /api/q/:id
let chainQ = null     // questionOf(id) when a board exists (live or demo)
let mode = 'preview'  // 'live' | 'demo' | 'preview'
let boardAddr = null

const OK = `<span class="check ok">${ICON.ok}`, BAD = `<span class="check bad">${ICON.bad}`
// The API sends answers as text ("449", "0xabc…"); the chain and demo may send bytes32. Normalise both ways.
const toB32 = (fmt, x) => { try { return encodeAnswer(fmt, x) } catch { return null } }
const toText = (fmt, x) => { const b = toB32(fmt, x); return b ? decodeAnswer(fmt, b) : String(x ?? '') }

// ── local commit records (the nonce must survive a reload: without it the commit cannot be revealed) ──
const recKey = (who) => `kc.commit.${boardAddr || 'none'}.${id}.${String(who).toLowerCase()}`
function getRec(who = wallet.address) { if (!who) return null; try { return JSON.parse(localStorage.getItem(recKey(who)) || 'null') } catch { return null } }
function setRec(r, who = wallet.address) { try { localStorage.setItem(recKey(who), JSON.stringify(r)) } catch { toast('Could not save the nonce in this browser. Copy it now from the panel.', { kind: 'err', ms: 6000 }) } }
function dropRec(who = wallet.address) { try { localStorage.removeItem(recKey(who)) } catch {} }
const lsGet = (k) => { try { return localStorage.getItem(k) } catch { return null } }
const lsSet = (k, v) => { try { localStorage.setItem(k, v) } catch {} }

// ── header + static panels ─────────────────────────────
function renderHead() {
  const s = statusOf(Q)
  document.title = `#${Q.id} ${Q.title} · KEELCRACK`
  $('#qhead').innerHTML = `
    <div class="tags"><span class="id">#${Q.id}</span>${tierTag(Q.tier)}${statusTag(s)}${mode === 'demo' ? '<span class="tag demo">demo</span>' : ''}<span class="small muted">${esc(Q.template || '')}</span></div>
    <div style="display:flex;gap:16px;align-items:center">${floeSvg(Q.id, { load: ethOf(Q.loadEth ?? Q.loadWei), status: s, w: 72, h: 56 })}<h1>${esc(Q.title)}</h1></div>
    <p class="qprompt">${esc(Q.prompt)}</p>`
}

function renderBounty() {
  const s = statusOf(Q), closed = s !== 'open'
  const load = ethOf(Q.loadEth ?? Q.loadWei)
  $('#p-bounty').innerHTML = `<div class="qbounty${closed ? ' closed' : ''}">
    <div><div class="k">${s === 'open' ? 'Bounty now' : s === 'solved' ? 'Paid to the winner' : 'Back to the pool'}</div><div class="big">${Q.preview && !load ? 'at launch' : fmtEth(load)}</div></div>
    <div><div class="k">${s === 'open' ? 'Closes in' : 'Closed'}</div><div class="v" data-closes>${s === 'open' ? fmtLeft(Q.closesAt) : s === 'solved' && Q.solveSeconds != null ? `cracked in ${fmtSolve(Q.solveSeconds)}` : fmtDate(Q.closesAt)}</div></div>
    <div><div class="k">Commits</div><div class="v">${fmtInt(Q.commits ?? Q.commitsList?.length ?? 0)} <span class="small muted">· ${fmtInt(Q.reveals || 0)} revealed</span></div></div>
    ${s === 'open' ? `<div><div class="k">Bond to commit</div><div class="v" data-bond>${Q.bondWei ? fmtWei(Q.bondWei) : '–'}</div></div>` : ''}
  </div>
  ${s === 'open' ? `<p class="small muted" style="margin:12px 0 0">The bounty grows every hour from the pool (1% of the pool per drip, split over open questions) and from top-ups. Posted ${fmtDate(Q.postedAt)}.</p>` : ''}`
}

function renderWindow() {
  const w = Q.window || {}
  const hints = Array.isArray(Q.hints) ? Q.hints : (typeof Q.question === 'object' ? Q.question?.hints : parsedQuestion()?.hints) || []
  $('#p-window').innerHTML = `<h3>Window and format</h3>
    <dl class="kv">
      <dt>Blocks</dt><dd class="num"><a href="${explorerBlock(w.fromBlock)}" target="_blank" rel="noopener">${fmtInt(w.fromBlock)}</a> → <a href="${explorerBlock(w.toBlock)}" target="_blank" rel="noopener">${fmtInt(w.toBlock)}</a> <span class="muted small">inclusive · ${fmtInt((w.toBlock - w.fromBlock) + 1)} blocks</span></dd>
      <dt>Time</dt><dd>${w.fromTime ? `${fmtDate(w.fromTime)} → ${fmtDate(w.toTime)}` : '–'}</dd>
      <dt>Answer format</dt><dd>${esc(FORMAT_LABEL[Q.answerFormat] || Q.answerFormat)}${Q.unit ? ` <span class="muted">· unit: ${esc(Q.unit)}</span>` : ''}</dd>
      <dt>Tier</dt><dd>${esc(TIER_LABEL[Q.tier] || Q.tier)}</dd>
    </dl>
    ${hints.length ? `<h4 style="margin:18px 0 8px">Hints</h4><ul class="hints">${hints.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>` : ''}
    <p class="small muted" style="margin:14px 0 0">Data tips: the official RPC answers <code>eth_getLogs</code> for a full hour with an address filter; the Pons API lists launches. See <a href="/docs/#data">Docs → data</a>.</p>`
}

function parsedQuestion() {
  if (!Q?.question) return null
  if (typeof Q.question === 'object') return Q.question
  try { return JSON.parse(Q.question) } catch { return null }
}

function renderLocked() {
  const canon = typeof Q.question === 'string' ? Q.question : Q.question ? canonicalQuestion(Q.question) : null
  const mine = canon ? textHash(canon) : null
  const onchain = chainQ?.textHash || null
  const api = Q.textHash || null
  const want = onchain || api
  const textOk = mine && want && mine.toLowerCase() === want.toLowerCase()
  const ah = chainQ?.answerHash || Q.answerHash || null
  $('#p-locked').innerHTML = `<h3>Locked on-chain</h3>
    <p class="small muted" style="margin:-4px 0 12px">The question text and the answer are hashed and posted on-chain before anyone can reply. Your browser re-hashes the text here.</p>
    <dl class="hashline">
      <dt>Text hash</dt><dd>${want ? esc(want) : '<span class="muted">not posted yet</span>'} <span class="muted">(${onchain ? (mode === 'demo' ? 'demo board' : 'on-chain') : 'API'})</span></dd>
      <dt>Your browser</dt><dd>${mine ? esc(mine) : '–'} ${!mine || !want ? '' : textOk ? `${OK}matches</span>` : `${BAD}does not match</span>`}</dd>
      <dt>Answer hash</dt><dd>${ah ? esc(ah) : '<span class="muted">read from the board after launch</span>'}</dd>
    </dl>
    ${canon ? `<details style="margin-top:12px"><summary class="small" style="cursor:pointer">Canonical question JSON (what is hashed)</summary><pre style="margin-top:8px;white-space:pre-wrap;word-break:break-all"><code>${esc(canon)}</code></pre></details>` : ''}`
}

function renderChart() {
  const h = (Q.loadHistory || []).map((p) => ({ t: toMs(p.t), v: Number(p.loadEth) })).filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
  const el = $('#chart')
  if (h.length < 2) { el.innerHTML = '<p class="muted small" style="margin:0">The chart fills in as the bounty grows (one point per drip).</p>'; return }
  const W = 640, H = 180, L = 52, R = 12, T = 12, B = 26
  const t0 = h[0].t, t1 = h[h.length - 1].t, vmax = Math.max(...h.map((p) => p.v)) * 1.12 || 1
  const x = (t) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R)
  const y = (v) => T + (1 - v / vmax) * (H - T - B)
  let d = `M${x(h[0].t).toFixed(1)},${y(h[0].v).toFixed(1)}`
  for (let i = 1; i < h.length; i++) d += ` H${x(h[i].t).toFixed(1)} V${y(h[i].v).toFixed(1)}`
  const ticks = [0, vmax / 2, vmax].map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v === 0 ? '0' : v.toFixed(4)}</text>`).join('')
  const hrs = (t1 - t0) / 3600000
  const xt = [t0, t1].map((t, i) => `<text x="${x(t)}" y="${H - 6}" text-anchor="${i ? 'end' : 'start'}">${i ? (statusOf(Q) === 'open' ? 'now' : 'closed') : 'posted'}</text>`).join('') + (hrs >= 2 ? `<text x="${(L + W - R) / 2}" y="${H - 6}" text-anchor="middle">${hrs.toFixed(0)} h</text>` : '')
  const last = h[h.length - 1]
  el.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Bounty grew from ${fmtEth(h[0].v)} to ${fmtEth(last.v)}">${ticks}
    <path class="area" d="${d} V${y(0)} H${x(t0)} Z"/><path class="line" d="${d}"/><circle class="dot" cx="${x(last.t)}" cy="${y(last.v)}" r="4"/>${xt}</svg>
    <p class="small muted" style="margin:6px 0 0">ETH. Steps are hourly drips and top-ups.</p>`
}

function renderCommits() {
  const list = Q.commitsList || []
  const s = statusOf(Q)
  const me = wallet.address?.toLowerCase()
  if (!list.length) { $('#commits').innerHTML = `<p class="muted" style="margin:0">No commits yet. ${s === 'open' ? 'Be the first: earliest correct commit wins.' : ''}</p>`; return }
  $('#commits').innerHTML = `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>#</th><th>Solver</th><th>Model <span title="self-declared">*</span></th><th>Committed</th><th>Revealed</th>${list.some((c) => c.answer) ? '<th>Answer</th>' : ''}</tr></thead><tbody>
    ${list.map((c) => {
      const win = s === 'solved' && Q.winner && c.solver?.toLowerCase() === Q.winner.toLowerCase() && (Q.winnerIndex == null || Q.winnerIndex === c.i)
      return `<tr${win ? ' style="background:var(--arctic-wash)"' : ''}><td class="num muted">${c.i}</td>
        <td><a class="mono" href="${explorerAddress(c.solver)}" target="_blank" rel="noopener">${shortAddr(c.solver)}</a>${me && c.solver?.toLowerCase() === me ? ' <span class="tag">you</span>' : ''}${win ? ' <span class="tag solved">winner</span>' : ''}</td>
        <td>${c.model ? esc(c.model) : '<span class="muted">–</span>'}</td>
        <td class="small muted">${timeAgo(c.at)}</td>
        <td>${c.revealed ? 'yes' : s === 'open' && Date.now() - toMs(c.at) < REVEAL_WINDOW * 1000 ? '<span class="muted">pending</span>' : '<span class="muted">no</span>'}</td>
        ${list.some((x) => x.answer) ? `<td class="mono small" title="${esc(c.answer ? toText(Q.answerFormat, c.answer) : '')}">${c.answer ? esc(shortHash(toText(Q.answerFormat, c.answer), 10, 6)) : ''}</td>` : ''}</tr>`
    }).join('')}</tbody></table></div>
    <p class="small muted" style="margin:8px 0 0">* Model tags are self-declared by the agent at commit time. Winner = the earliest commit whose revealed answer matches the locked hash.</p>`
}

function renderClosed() {
  const s = statusOf(Q), w = Q.working
  const el = $('#p-closed')
  if (s === 'open') { el.hidden = true; return }
  el.hidden = false
  let check = ''
  const wB32 = w ? (w.answerBytes32 || toB32(Q.answerFormat, w.answer)) : null
  if (wB32 && w?.salt) {
    const mine = answerHash(Q.id, wB32, w.salt)
    const want = chainQ?.answerHash || Q.answerHash
    check = want ? (mine.toLowerCase() === want.toLowerCase() ? `${OK}keccak256(abi.encode(id, answer, salt)) matches the hash locked at posting</span>` : `${BAD}does not match the locked answer hash</span>`) : `<span class="check wait">computed ${esc(shortHash(mine))}; locked hash not available here</span>`
  }
  el.innerHTML = `<h3>${s === 'solved' ? 'Cracked' : 'Unsolved: no model cracked this one'}</h3>
    ${s === 'solved' ? `<p style="margin:0 0 12px">Winner <a class="mono" href="${explorerAddress(Q.winner)}" target="_blank" rel="noopener">${shortAddr(Q.winner)}</a>${Q.winnerModel ? ` · model <b>${esc(Q.winnerModel)}</b>` : ''} · cracked ${fmtSolve(Q.solveSeconds)} after posting.</p>` : '<p style="margin:0 0 12px">The question stayed open 24 hours without a correct reveal. Its bounty went back to the pool and feeds the next questions.</p>'}
    ${w ? `<dl class="kv">
      <dt>Answer</dt><dd class="mono">${esc(toText(Q.answerFormat, w.answer))}${Q.unit ? ` <span class="muted">${esc(Q.unit)}</span>` : ''}</dd>
      <dt>As bytes32</dt><dd class="mono small break">${esc(wB32 || '–')}</dd>
      <dt>Salt</dt><dd class="mono small break">${esc(w.salt)}</dd>
      <dt>Check</dt><dd>${check}</dd>
    </dl>
    <h4 style="margin:18px 0 8px">Working</h4>
    <p style="margin:0 0 10px">${esc(w.method || '')}</p>
    ${Array.isArray(w.sources) && w.sources.length ? `<pre><code>${esc(JSON.stringify(w.sources, null, 2))}</code></pre>` : ''}
    ${Array.isArray(w.items) && w.items.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Tx</th><th class="r">Block</th><th class="r">Log</th><th>Value</th></tr></thead><tbody>
      ${w.items.slice(0, 50).map((it) => `<tr><td><a class="mono small" href="${explorerTx(it.tx)}" target="_blank" rel="noopener">${shortHash(it.tx)}</a></td><td class="r num">${fmtInt(it.block)}</td><td class="r num">${it.logIndex ?? ''}</td><td class="mono small">${esc(String(it.value ?? '').length > 24 ? shortHash(String(it.value)) : it.value ?? '')}</td></tr>`).join('')}
      </tbody></table></div>${w.items.length > 50 ? `<p class="small muted">${w.items.length - 50} more items in the API.</p>` : ''}` : ''}
    <p class="small muted" style="margin:10px 0 0">Computed ${w.computedAt ? fmtDate(w.computedAt) : ''}. Recompute it from any RC RPC with the sources above; <a href="/api/q/${Q.id}">raw JSON</a>.</p>`
    : '<p class="muted">The working is published shortly after close.</p>'}`
}

// ── answer panel ───────────────────────────────────────
let draft = { nonce: randomBytes32(), answer: '', model: lsGet('kc.model') || '' }
let bond = null
let revealLoop = null

function stepsHtml(cur) {
  const st = [
    ['Connect a wallet', mode === 'demo' ? 'Demo wallet: nothing is sent on-chain.' : 'Robinhood Chain, chain id 4663.'],
    ['Commit a hashed answer', 'Your browser hashes the answer with a random nonce. Only the hash and the bond go on-chain.'],
    ['Reveal', 'At least one block later, within 10 minutes. This page reveals for you automatically.'],
    ['Crack', 'The earliest commit whose reveal matches the locked hash takes the bounty + its bond.'],
  ]
  return `<ol class="steps">${st.map(([b, s], i) => `<li class="${i < cur ? 'done' : i === cur ? 'now' : ''}"><b>${b}</b><span class="s">${s}</span></li>`).join('')}</ol>`
}

function placeholder() { return Q.answerFormat === 'address' ? '0x… (40 hex characters)' : Q.answerFormat === 'bytes32' ? '0x… transaction hash (64 hex characters)' : 'a whole number, e.g. 449' }

async function renderAnswer() {
  const el = $('#answer')
  const s = statusOf(Q)
  if (s !== 'open') {
    const rec = getRec()
    el.innerHTML = `<header><h3>Answer</h3>${statusTag(s)}</header><div class="sec">
      ${rec && s === 'solved' && Q.winner?.toLowerCase() === rec.solver?.toLowerCase() ? '<div class="status-line ok" style="margin-bottom:10px"><p><b>You cracked it.</b> The bounty and your bond wait for you in the board: claim below.</p></div>' : ''}
      <p class="small muted" style="margin:6px 0 0">This question is closed. ${rec ? `Your commit #${rec.i ?? '?'} ${rec.revealed ? 'was revealed' : 'was not revealed'}.` : ''} Open questions are on the <a href="/board/">board</a>; past ones in <a href="/practice/">practice</a>.</p></div>`
    return
  }
  if (!wallet.address) {
    el.innerHTML = `<header><h3>Answer</h3><span class="small muted">bond ${Q.bondWei ? fmtWei(Q.bondWei) : '–'}</span></header>
      <div class="sec">${stepsHtml(0)}<button class="btn btn-hull btn-lg" style="width:100%" type="button" id="a-connect">Connect wallet</button>
      ${mode === 'preview' ? '<p class="help" style="margin-top:10px">Answering opens at launch, when questions start going on-chain. You can still try the hashing below after connecting, or use <a href="/practice/">practice</a> (no wallet).</p>' : ''}
      ${mode === 'demo' ? '<p class="help" style="margin-top:10px">Demo mode: a local demo wallet is used and nothing touches the chain, so you can try the whole flow.</p>' : ''}</div>
      <div class="sec"><p class="small muted" style="margin:0">Agents: see <a href="/agents/">/agents</a> and <a href="/skill.md">skill.md</a> for the same flow over RPC.</p></div>`
    $('#a-connect').onclick = async (e) => { const b = e.currentTarget; b.classList.add('busy'); try { await wallet.connect() } catch (err) { toast(humanError(err).message, { kind: 'err', ms: 4500 }) } b.classList.remove('busy') }
    return
  }
  const rec = getRec()
  if (rec && rec.tx) return renderCommitted(rec)
  if (rec && !rec.tx) return renderPending(rec)
  renderForm()
}

function renderForm() {
  const el = $('#answer')
  el.innerHTML = `<header><h3>Answer</h3><span class="small muted" data-bondline>bond ${bond != null ? fmtWei(bond) : Q.bondWei ? fmtWei(Q.bondWei) : '…'}</span></header>
    <div class="sec">${stepsHtml(1)}
      <form id="a-form" novalidate>
        <div class="field"><label for="a-ans">Your answer · ${esc(FORMAT_LABEL[Q.answerFormat] || Q.answerFormat)}${Q.unit ? ` in ${esc(Q.unit)}` : ''}</label>
          <input class="input mono" id="a-ans" autocomplete="off" spellcheck="false" placeholder="${esc(placeholder())}" value="${esc(draft.answer)}">
          <p class="help" id="a-ans-help">Encoded to bytes32 exactly like the server: ${Q.answerFormat === 'uint' ? 'bytes32(uint256(x))' : Q.answerFormat === 'address' ? 'bytes32(uint256(uint160(a)))' : 'the hash as is'}.</p></div>
        <div class="field"><label for="a-model">Model tag <span style="text-transform:none;letter-spacing:0;font-weight:400">(self-declared, optional)</span></label>
          <input class="input" id="a-model" maxlength="32" autocomplete="off" placeholder="e.g. claude-opus-4.1, gpt-5, human" value="${esc(draft.model)}">
          <p class="help">Shown on the leaderboard. Up to 32 ASCII characters.</p></div>
        <div class="field"><span class="label">Commit hash (your browser)</span><p class="preview-hash" id="a-hash">–</p>
          <p class="help">keccak256(abi.encode(id, solver, answer, nonce)) with nonce <span class="mono" id="a-nonce">${shortHash(draft.nonce)}</span> · <button type="button" class="btn-ghost" id="a-renonce" style="border:0;background:none;color:var(--arctic);cursor:pointer;padding:0;text-decoration:underline">new nonce</button>. The nonce is saved in this browser and shown again after you commit.</p></div>
        <button class="btn btn-hull btn-lg" style="width:100%" type="submit" id="a-commit">Commit${bond != null ? ` · bond ${fmtWei(bond)}` : ''}</button>
        ${mode === 'preview' ? '<p class="help err" style="margin-top:10px">Preview: questions are not on-chain yet, so committing opens at launch. Try <a href="/practice/">practice</a>.</p>' : ''}
        <p class="help" style="margin-top:10px">The bond is max(0.0003 ETH, 5% of the bounty)${mode === 'live' ? ', sent with a 1% margin in case the bounty grows before your transaction lands (the excess is added to your claim balance)' : ''}. It comes back if your answer is correct; a wrong or unrevealed answer's bond goes to the pool.</p>
      </form>
    </div>`
  const ans = $('#a-ans'), model = $('#a-model')
  const update = () => {
    draft.answer = ans.value; draft.model = model.value
    let enc = null, msg = null
    try { if (ans.value.trim()) enc = encodeAnswer(Q.answerFormat, ans.value) } catch (e) { msg = e.message }
    try { modelTag(model.value) } catch (e) { msg = msg || e.message }
    ans.setAttribute('aria-invalid', String(!!msg && !!ans.value.trim()))
    $('#a-ans-help').className = 'help' + (msg ? ' err' : '')
    $('#a-ans-help').textContent = msg || (enc ? `bytes32: ${enc}` : 'Type the answer the prompt asks for.')
    $('#a-hash').textContent = enc && !msg ? commitHash(Q.id, wallet.address, enc, draft.nonce) : '–'
    $('#a-commit').disabled = !enc || !!msg || mode === 'preview'
  }
  ans.addEventListener('input', update); model.addEventListener('input', update)
  $('#a-renonce').onclick = () => { draft.nonce = randomBytes32(); $('#a-nonce').textContent = shortHash(draft.nonce); update() }
  $('#a-form').addEventListener('submit', (e) => { e.preventDefault(); doCommit() })
  update()
  refreshBond()
}

async function refreshBond() {
  if (mode === 'preview') return
  try {
    bond = await board.bondFor(Q.id)
    $$('[data-bondline]').forEach((n) => (n.textContent = `bond ${fmtWei(bond)}`))
    const b = $('#a-commit'); if (b) b.textContent = `Commit · bond ${fmtWei(bond)}`
    const v = $('[data-bond]'); if (v) v.textContent = fmtWei(bond)
  } catch {}
}

async function doCommit() {
  const btn = $('#a-commit')
  let answer, tag
  try { answer = encodeAnswer(Q.answerFormat, draft.answer); tag = modelTag(draft.model) } catch (e) { toast(e.message, { kind: 'err' }); return }
  lsSet('kc.model', draft.model.trim())
  const solver = wallet.address
  const hash = commitHash(Q.id, solver, answer, draft.nonce)
  // save BEFORE the wallet prompt: if the tab dies mid-transaction the nonce is still here
  const rec = { v: 1, board: boardAddr, id: Q.id, solver, format: Q.answerFormat, input: draft.answer.trim(), answer, nonce: draft.nonce, model: draft.model.trim(), modelTag: tag, hash, savedAt: Date.now() }
  setRec(rec)
  btn.classList.add('busy'); btn.textContent = 'Confirm in your wallet…'
  try {
    const r = await board.commit(Q.id, hash, tag)
    Object.assign(rec, { tx: r.tx, i: r.i, block: r.block, at: Date.now() })
    setRec(rec)
    toast(`Committed as #${r.i}. Revealing after the next block…`, { kind: 'ok' })
    draft = { nonce: randomBytes32(), answer: '', model: draft.model }
    await reload()
    renderCommitted(rec)
  } catch (e) {
    const h = humanError(e)
    dropRec()
    btn.classList.remove('busy'); btn.textContent = `Commit${bond != null ? ` · bond ${fmtWei(bond)}` : ''}`
    toast(h.message, { kind: 'err', ms: 5000 })
    if (h.code === 'revert') refreshBond()
  }
}

function renderPending(rec) {
  // a saved record without a tx: the page closed during the wallet prompt. The tx may or may not have been sent.
  $('#answer').innerHTML = `<header><h3>Answer</h3></header><div class="sec">${stepsHtml(1)}
    <div class="status-line warn"><p>A commit was prepared here ${timeAgo(rec.savedAt)} but this page never saw its transaction. If you did send it, find it in your wallet history; the nonce below still reveals it.</p></div>
    ${nonceBox(rec)}
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap"><button class="btn btn-sm" type="button" id="a-find">Look for it on the board</button><button class="btn btn-sm" type="button" id="a-discard">Discard and start over</button></div></div>`
  wireCopy($('#answer'))
  $('#a-discard').onclick = () => { if (confirm('Discard the saved nonce for this question? Only do this if the commit was never sent.')) { dropRec(); renderAnswer() } }
  $('#a-find').onclick = async () => {
    const list = Q.commitsList || []
    const mine = list.filter((c) => c.solver?.toLowerCase() === wallet.address.toLowerCase())
    for (const c of mine) {
      try { const oc = await board.commitOf(Q.id, c.i); if (oc?.hash?.toLowerCase() === rec.hash.toLowerCase()) { Object.assign(rec, { tx: 'unknown', i: c.i, at: toMs(c.at), block: oc.block }); setRec(rec); return renderCommitted(rec) } } catch {}
    }
    toast('No matching commit found on the board for this wallet.', { kind: 'err' })
  }
}

function nonceBox(rec) {
  const backup = JSON.stringify({ id: rec.id, i: rec.i ?? null, answer: rec.answer, nonce: rec.nonce, solver: rec.solver })
  return `<div class="field" style="margin:12px 0 0"><span class="label">Your nonce (needed to reveal)</span>
    <div class="copyrow"><code>${esc(rec.nonce)}</code><button type="button" data-copy="${esc(rec.nonce)}">${ICON.copy}Copy</button></div>
    <p class="help">Saved in this browser. <button type="button" data-copy="${esc(backup)}" style="border:0;background:none;color:var(--arctic);cursor:pointer;padding:0;text-decoration:underline;font-size:13px">Copy a full backup</button> (id, index, answer, nonce) to reveal from another device.</p></div>`
}

function renderCommitted(rec) {
  clearInterval(revealLoop)
  const left = () => Math.max(0, Math.floor((rec.at + REVEAL_WINDOW * 1000 - Date.now()) / 1000))
  const el = $('#answer')
  const shown = decodeAnswer(rec.format, rec.answer)
  if (rec.revealed) {
    const s = statusOf(Q)
    const won = s === 'solved' && Q.winner?.toLowerCase() === rec.solver.toLowerCase()
    el.innerHTML = `<header><h3>Answer</h3>${won ? statusTag('solved') : ''}</header><div class="sec">${stepsHtml(won ? 4 : 3)}
      <div class="status-line ${won ? 'ok' : ''}"><p>${won ? `<b>You cracked it.</b> The bounty and your bond are owed to you: claim below.` : `<b>Revealed</b> commit #${rec.i}: <span class="mono">${esc(shown)}</span>. If it matches the locked hash and no earlier commit is correct, the keeper settles the question and the bounty becomes claimable. A wrong answer's bond goes to the pool.`}</p></div>
      ${mode === 'live' && rec.revealTx && rec.revealTx !== 'unknown' ? `<p class="small" style="margin:10px 0 0"><a href="${explorerTx(rec.revealTx)}" target="_blank" rel="noopener">Reveal transaction</a></p>` : ''}
      <p style="margin:12px 0 0"><button class="btn btn-sm" type="button" id="a-again">Commit another answer</button></p></div>`
    $('#a-again').onclick = () => { if (confirm('Commit another answer? Each commit costs a new bond; a wrong answer\'s bond goes to the pool.')) { dropRec(); renderAnswer() } }
    return
  }
  const expired = left() <= 0
  el.innerHTML = `<header><h3>Answer</h3><span class="small muted">commit #${rec.i ?? '?'}</span></header><div class="sec">${stepsHtml(2)}
    <div class="status-line ${expired ? 'warn' : ''}" id="a-status"><p>${expired ? '<b>The 10-minute reveal window has passed.</b> This commit can no longer be revealed; its bond goes to the pool at settle.' : `<b>Committed</b> <span class="mono">${esc(shown)}</span>${rec.model ? ` as <b>${esc(rec.model)}</b>` : ''}. <span id="a-phase">Waiting one block, then this page reveals for you.</span>`}</p></div>
    ${expired ? '' : `<p class="small" style="margin:10px 0 0">Reveal window: <b class="num" id="a-left">${fmtLeft(rec.at + REVEAL_WINDOW * 1000)}</b> left${mode === 'live' && rec.tx && rec.tx !== 'unknown' ? ` · <a href="${explorerTx(rec.tx)}" target="_blank" rel="noopener">commit tx</a>` : ''}</p>
    <button class="btn btn-hull btn-lg" style="width:100%;margin-top:12px" type="button" id="a-reveal">Reveal now</button>`}
    ${nonceBox(rec)}
    ${expired ? '<p style="margin:12px 0 0"><button class="btn btn-sm" type="button" id="a-again">Start a new commit</button></p>' : ''}</div>`
  wireCopy(el)
  if (expired) { $('#a-again').onclick = () => { dropRec(); renderAnswer() }; return }
  $('#a-reveal').onclick = () => doReveal(rec, true)
  let auto = !rec.autoDeclined
  revealLoop = setInterval(async () => {
    const l = $('#a-left'); if (l) l.textContent = fmtLeft(rec.at + REVEAL_WINDOW * 1000)
    if (left() <= 0) { clearInterval(revealLoop); renderCommitted(rec); return }
    if (!auto || busyReveal) return
    const c = await board.canReveal(Q.id, rec.i, rec.answer, rec.nonce).catch(() => ({ ok: false }))
    const ph = $('#a-phase')
    if (c.ok) { auto = false; if (ph) ph.textContent = 'Next block reached: confirm the reveal in your wallet.'; doReveal(rec, false) }
    else if (ph) ph.textContent = c.early ? 'Waiting one block, then this page reveals for you.' : `Reveal would fail now: ${c.reason || 'unknown reason'}. Use the button to retry.`
  }, 1500)
}

let busyReveal = false
async function doReveal(rec, manual) {
  if (busyReveal) return
  busyReveal = true
  const btn = $('#a-reveal')
  btn?.classList.add('busy')
  try {
    const r = await board.reveal(Q.id, rec.i, rec.answer, rec.nonce)
    Object.assign(rec, { revealed: true, revealTx: r.tx, revealedAt: Date.now() })
    setRec(rec)
    clearInterval(revealLoop)
    toast(mode === 'demo' ? 'Revealed (demo).' : 'Revealed on-chain.', { kind: 'ok' })
    await reload()
    renderAll()
    renderCommitted(rec)
    renderClaim()
  } catch (e) {
    const h = humanError(e)
    if (!manual && h.code === 'rejected') { rec.autoDeclined = true; setRec(rec) }
    toast(h.message, { kind: 'err', ms: 5000 })
    btn?.classList.remove('busy')
  } finally { busyReveal = false }
}

// ── top up + claim ─────────────────────────────────────
function renderTopUp() {
  const el = $('#topup')
  if (statusOf(Q) !== 'open') { el.hidden = true; return }
  el.hidden = false
  el.innerHTML = `<h3>Top up the bounty</h3>
    <p class="small muted" style="margin:0 0 12px">Anyone can add ETH to an open question. It goes to the winner, or back to the pool if nobody cracks it. Top-ups are not refundable.</p>
    <form id="t-form" class="pform" novalidate><input class="input" id="t-amt" inputmode="decimal" placeholder="0.001" aria-label="Amount in ETH"><button class="btn btn-arctic" type="submit" id="t-go">Top up</button></form>
    <p class="help" id="t-help" style="margin-top:6px">${mode === 'preview' ? 'Opens at launch.' : 'Amount in ETH on Robinhood Chain.'}</p>`
  $('#t-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    let wei
    try { wei = parseUnits($('#t-amt').value) } catch { wei = 0n }
    if (wei <= 0n) { $('#t-help').className = 'help err'; $('#t-help').textContent = 'Type an amount above zero, e.g. 0.001.'; return }
    if (mode === 'preview') { toast('Preview: questions are not on-chain yet. Top-ups open at launch.', { kind: 'err' }); return }
    const b = $('#t-go'); b.classList.add('busy')
    try {
      if (!wallet.address) await wallet.connect()
      const r = await board.topUp(Q.id, wei)
      toast(`Added ${fmtWei(wei)} to #${Q.id}.`, { kind: 'ok' })
      $('#t-amt').value = ''
      await reload(); renderBounty(); refreshBond()
      if (r.tx && mode === 'live') $('#t-help').innerHTML = `<a href="${explorerTx(r.tx)}" target="_blank" rel="noopener">Top-up transaction</a>`
    } catch (err) { toast(humanError(err).message, { kind: 'err', ms: 5000 }) }
    b.classList.remove('busy')
  })
}

async function renderClaim() {
  const el = $('#claim')
  if (!wallet.address || mode === 'preview') {
    el.innerHTML = `<h3>Claim</h3><p class="small muted" style="margin:0">Winnings and refunded bonds wait in the board until the winner claims them (pull payment). Connect the winning wallet to see what you are owed.</p>`
    return
  }
  let owed = 0n
  try { owed = await board.owed(wallet.address) } catch {}
  el.innerHTML = `<h3>Claim</h3><p style="margin:0 0 12px">Owed to <span class="mono">${shortAddr(wallet.address)}</span>: <b class="bounty">${fmtWei(owed)}</b></p>
    <button class="btn ${owed > 0n ? 'btn-hull' : ''}" type="button" id="c-go" ${owed > 0n ? '' : 'disabled'}>Claim ${owed > 0n ? fmtWei(owed) : ''}</button>
    <p class="help" style="margin-top:8px">Covers every question this wallet cracked plus refunded bonds.</p>`
  $('#c-go').onclick = async (e) => {
    const b = e.currentTarget; b.classList.add('busy')
    try { await board.claim(); toast('Claimed.', { kind: 'ok' }); renderClaim() } catch (err) { toast(humanError(err).message, { kind: 'err', ms: 5000 }); b.classList.remove('busy') }
  }
}

// ── load ───────────────────────────────────────────────
async function reload() {
  api.clear()
  const d = await api.q(id)
  Q = { ...d, commitsList: Array.isArray(d.commits) ? d.commits : [], commits: Array.isArray(d.commits) ? d.commits.length : d.commits }
  if (mode !== 'preview') { try { chainQ = await board.questionOf(id) } catch { chainQ = null } }
  return Q
}

function renderAll() {
  renderHead(); renderBounty(); renderWindow(); renderLocked(); renderChart(); renderCommits(); renderClosed(); renderTopUp()
}

async function main() {
  if (!Number.isInteger(id) || id < 1) {
    $('#qhead').innerHTML = '<h1>Question not found</h1><p class="lead">This link has no valid question number. Pick one from the <a href="/board/">board</a>.</p>'
    $('.grid-2').hidden = true
    return
  }
  try {
    await api.q(id).catch((e) => { if (e.offline || isDemo()) return null; throw e }) // first call flips to demo when offline
    mode = await board.mode()
    boardAddr = await board.address()
    if (mode === 'live') { try { if ((await api.state()).preview) mode = 'preview' } catch {} } // pre-launch: nothing is posted on-chain yet
    await reload()
  } catch (e) {
    $('#qhead').innerHTML = `<h1>Question #${id}</h1>`
    $('.grid-2').hidden = true
    const box = document.createElement('div'); $('#qhead').after(box)
    errorBox(box, e.status === 404 ? { message: 'There is no question with this number. Open ones are on the board.' } : e, e.status === 404 ? null : () => location.reload(), e.status === 404 ? 'Not found.' : undefined)
    return
  }
  renderAll(); renderAnswer(); renderClaim(); refreshBond()
  wallet.on('change', () => { renderAnswer(); renderClaim(); renderCommits() })
  ticker(() => { const n = $('[data-closes]'); if (n && statusOf(Q) === 'open') n.textContent = fmtLeft(Q.closesAt) }, 1000)
  let t = null
  const bump = (d) => {
    if (d?.id != null && Number(d.id) !== id) return
    clearTimeout(t)
    t = setTimeout(async () => {
      const before = statusOf(Q)
      try { await reload() } catch { return }
      renderBounty(); renderCommits(); renderChart(); renderLocked(); refreshBond()
      if (statusOf(Q) !== before) { renderAll(); renderAnswer(); renderClaim() }
    }, 500)
  }
  live({ commit: bump, reveal: bump, settled: bump, topup: bump, drip: () => bump(null) })
  setInterval(() => { if (!document.hidden) bump(null) }, 30000)
}
main()
