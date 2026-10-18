// /ledger/: every board event with tx links; live rows from SSE.
import { api, live, qPage, isDemo } from '/shared/api.js'
import { esc, fmtEth, timeAgo, fmtDate, shortAddr, shortHash, KIND_LABEL } from '/shared/fmt.js'
import { $, $$, ethOf, errorBox } from '/shared/ui.js'
import { explorerTx, explorerAddress } from '/shared/site.js'

const GROUPS = { all: null, money: ['harvest', 'drip', 'topup'], questions: ['posted', 'settled'], answers: ['commit', 'reveal'], payouts: ['settled', 'claim'] }
let kind = 'all', items = [], fresh = new Set()

function row(e) {
  const k = String(e.kind)
  const tx = e.tx ? (isDemo() ? `<span class="mono small muted" title="demo fixture">${shortHash(e.tx)}</span>` : `<a class="mono small" href="${explorerTx(e.tx)}" target="_blank" rel="noopener">${shortHash(e.tx)}</a>`) : ''
  return `<tr class="${fresh.has(e) ? 'new' : ''}"><td class="small muted" title="${esc(fmtDate(e.t))}">${timeAgo(e.t)}</td>
    <td><span class="kind ${esc(k)}"><i></i>${esc(KIND_LABEL[k] || k)}</span></td>
    <td>${e.id != null ? `<a href="${qPage(e.id)}">#${e.id}</a>` : '<span class="muted">–</span>'}</td>
    <td>${e.from ? `<a class="mono small" href="${explorerAddress(e.from)}" target="_blank" rel="noopener">${shortAddr(e.from)}</a>` : '<span class="muted">–</span>'}</td>
    <td class="r num">${e.amountEth != null ? fmtEth(e.amountEth) : ''}</td><td>${tx}</td></tr>`
}
function render() {
  const g = GROUPS[kind]
  const list = items.filter((e) => !g || g.includes(e.kind)).slice(0, 300)
  $('#rows').innerHTML = list.length ? list.map(row).join('') : '<tr><td colspan="6" class="empty">No events yet.</td></tr>'
}
async function load() {
  try {
    const [s, l] = await Promise.all([api.state(), api.ledger({ limit: 400 })])
    items = l.items || []
    const set = (k, v) => ($(`[data-s="${k}"]`).textContent = v)
    set('pool', s.preview ? 'starts at launch' : fmtEth(ethOf(s.pool))); set('load', fmtEth(ethOf(s.totalLoad))); set('infra', fmtEth(ethOf(s.infra))); set('drip', s.lastDripAt ? timeAgo(s.lastDripAt) : '–')
    render()
  } catch (e) { errorBox($('#rows').closest('.tbl-wrap'), e, load) }
}
$('#f-kind').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; kind = b.dataset.v; $$('#f-kind button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); render() })
load()
const push = (k) => (d) => { if (!d) return; const e = { t: d.t || Date.now(), kind: k, id: d.id, amountEth: d.amountEth, from: d.solver || d.from, tx: d.tx }; fresh = new Set([e]); items.unshift(e); render() }
live({ harvest: push('harvest'), drip: push('drip'), posted: push('posted'), topup: push('topup'), commit: push('commit'), reveal: push('reveal'), settled: push('settled') })
