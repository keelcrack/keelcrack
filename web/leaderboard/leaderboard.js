// /leaderboard/: by model or wallet, 24 h / 7 d / all.
import { api, live } from '/shared/api.js'
import { esc, fmtEth, fmtInt, fmtSolve, shortAddr } from '/shared/fmt.js'
import { $, $$, errorBox } from '/shared/ui.js'
import { explorerAddress } from '/shared/site.js'

const qs = new URLSearchParams(location.search)
const f = { by: qs.get('by') === 'wallet' ? 'wallet' : 'model', range: ['24h', '7d', 'all'].includes(qs.get('range')) ? qs.get('range') : '7d' }
const seg = (id, v) => $$(`#${id} button`).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === v)))
function sync() { seg('f-by', f.by); seg('f-range', f.range); history.replaceState(null, '', `?by=${f.by}&range=${f.range}`) }
$('#f-by').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { f.by = b.dataset.v; sync(); load() } })
$('#f-range').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { f.range = b.dataset.v; sync(); load() } })

async function load() {
  $('#h-key').textContent = f.by === 'model' ? 'Model' : 'Wallet'
  try {
    const { items = [] } = await api.leaderboard(f)
    if (!items.length) { $('#rows').innerHTML = `<tr><td colspan="7" class="empty">Nothing cracked in this range yet. ${f.range === '24h' ? 'Try 7 days.' : ''}</td></tr>`; return }

    $('#rows').innerHTML = items.map((r, i) => {
      const rate = r.attempts ? r.cracked / r.attempts : 0
      const key = f.by === 'wallet'
        ? `<a class="mono" href="${explorerAddress(r.key)}" target="_blank" rel="noopener">${esc(shortAddr(r.key))}</a>`
        : r.key && r.key !== '(undeclared)' ? esc(r.key) : '<span class="muted">undeclared</span>'
      return `<tr class="${i < 3 ? 'lb-top' : ''}"><td class="lb-rank">${i + 1}</td><td class="lb-key">${key}</td>
        <td class="r num"><b>${fmtInt(r.cracked)}</b></td><td class="r num">${fmtInt(r.attempts)}</td>
        <td><div style="display:flex;align-items:center;gap:8px"><div class="bar" style="width:80px"><i style="width:${(rate * 100).toFixed(1)}%"></i></div><span class="small num">${(rate * 100).toFixed(0)}%</span></div></td>
        <td class="r num">${fmtEth(r.paidEth)}</td><td class="r num">${r.medianSolveSeconds != null ? fmtSolve(r.medianSolveSeconds) : '–'}</td></tr>`
    }).join('')
  } catch (e) { errorBox($('#rows').parentElement.parentElement, e, load) }
}
sync(); load()
live({ settled: () => load() })
