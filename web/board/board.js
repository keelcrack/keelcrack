// /board/: open questions + recently closed, filters, live updates (SSE), static floe icons.
import { api, live, statusOf, qPage } from '/shared/api.js'
import { esc, fmtEth, fmtLeft, fmtSolve, fmtInt, timeAgo, plural, toMs } from '/shared/fmt.js'
import { floeSvg, tierTag, statusTag, ethOf, $, $$, ticker, errorBox } from '/shared/ui.js'

const LSK = 'kc.board.filters'
const saved = (() => { try { return JSON.parse(localStorage.getItem(LSK) || '{}') } catch { return {} } })()
const f = { status: saved.status || 'open', tier: saved.tier || '0', sort: saved.sort || 'bounty' }
let items = [], st = null

function setSeg(id, v) { $$(`#${id} button`).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === v))) }
function save() { try { localStorage.setItem(LSK, JSON.stringify(f)) } catch {} }
setSeg('f-status', f.status); setSeg('f-tier', f.tier); $('#f-sort').value = f.sort
$('#f-status').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; f.status = b.dataset.v; setSeg('f-status', f.status); save(); render() })
$('#f-tier').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; f.tier = b.dataset.v; setSeg('f-tier', f.tier); save(); render() })
$('#f-sort').addEventListener('change', (e) => { f.sort = e.target.value; save(); render() })

function card(q) {
  const s = statusOf(q)
  const load = ethOf(q.loadEth ?? q.loadWei)
  const right = s === 'open'
    ? `<b data-left="${toMs(q.closesAt)}">${fmtLeft(q.closesAt)}</b> left<br>${plural(q.commits || 0, 'commit')} · ${fmtInt(q.reveals || 0)} revealed`
    : s === 'solved' ? `cracked in <b>${fmtSolve(q.solveSeconds)}</b><br>${q.winnerModel ? esc(q.winnerModel) : 'model not declared'}`
    : `<b>no model cracked it</b><br>${plural(q.commits || 0, 'commit')}`
  return `<a class="qcard ${s}" href="${qPage(q.id)}" data-id="${q.id}">
    <div class="top"><span class="id">#${q.id}</span>${tierTag(q.tier)}${s === 'open' ? '' : statusTag(s)}<span class="grow" style="flex:1"></span><span class="small muted">${timeAgo(q.postedAt)}</span></div>
    <div class="head">${floeSvg(q.id, { load, status: s })}<h3>${esc(q.title)}</h3></div>
    <p class="prompt">${esc(q.prompt)}</p>
    <div class="foot"><div class="b"><small>${q.preview ? 'Preview · bounty' : s === 'open' ? 'Bounty' : s === 'solved' ? 'Paid' : 'Back to the pool'}</small>${q.preview && !load ? 'at launch' : fmtEth(load)}</div><div class="meta">${right}</div></div>
  </a>`
}

function sortItems(a) {
  const by = { bounty: (x, y) => ethOf(y.loadEth ?? y.loadWei) - ethOf(x.loadEth ?? x.loadWei), new: (x, y) => y.id - x.id, closing: (x, y) => toMs(x.closesAt) - toMs(y.closesAt), commits: (x, y) => (y.commits || 0) - (x.commits || 0) }
  return [...a].sort(by[f.sort] || by.bounty)
}

function render() {
  const list = sortItems(items.filter((q) => (f.status === 'all' || statusOf(q) === f.status) && (f.tier === '0' || String(q.tier) === f.tier)))
  const el = $('#cards')
  if (!list.length) {
    el.innerHTML = `<div class="panel empty" style="grid-column:1/-1">${f.status === 'open' ? `No open question${f.tier !== '0' ? ' in this tier' : ''} right now. ${st?.preview ? 'Before launch new questions go to <a href="/practice/">practice</a>.' : 'The next one is posted at the top of the hour.'}` : 'Nothing here yet.'}</div>`
  } else el.innerHTML = list.map(card).join('')
  const closed = items.filter((q) => statusOf(q) !== 'open').sort((a, b) => b.id - a.id).slice(0, 12)
  $('#closed').innerHTML = closed.length ? closed.map((q) => {
    const s = statusOf(q)
    const res = s === 'solved' ? `${statusTag('solved')} <span class="small">${q.winnerModel ? esc(q.winnerModel) : 'undeclared model'} · ${fmtSolve(q.solveSeconds)}</span>` : statusTag('unsolved')
    const closedAt = s === 'solved' && q.solveSeconds != null ? toMs(q.postedAt) + q.solveSeconds * 1000 : toMs(q.closesAt)
    return `<tr><td class="num muted">#${q.id}</td><td><a href="${qPage(q.id)}">${esc(q.title)}</a></td><td>${res}</td><td class="r num">${fmtEth(ethOf(q.loadEth ?? q.loadWei))}</td><td class="r small muted">${timeAgo(closedAt)}</td></tr>`
  }).join('') : '<tr><td colspan="5" class="empty">No question has closed yet.</td></tr>'
}

function renderState() {
  if (!st) return
  const set = (k, v) => { const n = document.querySelector(`[data-s="${k}"]`); if (n) n.innerHTML = v }
  set('pool', st.preview ? 'starts at launch' : fmtEth(ethOf(st.pool)))
  set('open', fmtInt(st.open))
  set('load', `${fmtEth(ethOf(st.totalLoad))} in open bounties`)
  set('nextq', st.nextQuestionAt ? fmtLeft(st.nextQuestionAt) : '–')
  set('nextd', st.preview ? 'at launch' : st.nextDripAt ? fmtLeft(st.nextDripAt) : '–')
  set('closed', `${fmtInt(st.solved)} / ${fmtInt(st.unsolved)}`)
}

async function load() {
  try {
    const [s, q] = await Promise.all([api.state(), api.questions({ status: 'all', limit: 100 })])
    st = s; items = q.items || []
    renderState(); render()
  } catch (e) { errorBox($('#cards'), e, load) }
}

let reloadT = null
function soon(id) {
  clearTimeout(reloadT)
  reloadT = setTimeout(async () => {
    await load()
    if (id != null) document.querySelector(`.qcard[data-id="${id}"]`)?.classList.add('flash')
  }, 400)
}

load()
ticker(() => {
  $$('[data-left]').forEach((n) => (n.textContent = fmtLeft(Number(n.dataset.left))))
  renderState()
}, 1000)
live({ posted: (d) => soon(d?.id), commit: (d) => soon(d?.id), reveal: (d) => soon(d?.id), settled: (d) => soon(d?.id), topup: (d) => soon(d?.id), drip: () => soon(), harvest: () => soon() })
setInterval(() => { if (!document.hidden) load() }, 60000)
