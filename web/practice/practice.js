// /practice/: past questions with an instant server check. No wallet.
import { api } from '/shared/api.js'
import { encodeAnswer } from '/shared/abi.js'
import { esc, fmtInt, fmtDate, FORMAT_LABEL } from '/shared/fmt.js'
import { tierTag, $, $$, errorBox } from '/shared/ui.js'
import { explorerBlock, ICON } from '/shared/site.js'

const LS = 'kc.practice.solved'
const solved = new Set((() => { try { return JSON.parse(localStorage.getItem(LS) || '[]') } catch { return [] } })())
const saveSolved = () => { try { localStorage.setItem(LS, JSON.stringify([...solved])) } catch {} }
let items = [], tier = '0'
const chev = '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>'
const ph = (f) => (f === 'address' ? '0x… address' : f === 'bytes32' ? '0x… transaction hash' : 'whole number')

function card(p) {
  const w = p.window || {}
  const ok = solved.has(p.pid)
  return `<details class="pcard${ok ? ' ok' : ''}" data-pid="${esc(p.pid)}">
    <summary>${tierTag(p.tier)}<div><h3>${esc(p.title)}</h3><div class="sub">${w.fromTime ? fmtDate(w.fromTime) : ''} · ${esc(FORMAT_LABEL[p.answerFormat] || p.answerFormat)}${ok ? ' · <b style="color:var(--arctic)">cracked</b>' : ''}</div></div>${chev}</summary>
    <div class="pbody">
      <p style="margin:0;font-size:16px">${esc(p.prompt)}</p>
      <dl class="kv small"><dt>Blocks</dt><dd class="num"><a href="${explorerBlock(w.fromBlock)}" target="_blank" rel="noopener">${fmtInt(w.fromBlock)}</a> → <a href="${explorerBlock(w.toBlock)}" target="_blank" rel="noopener">${fmtInt(w.toBlock)}</a> (inclusive)</dd>
      ${p.unit ? `<dt>Unit</dt><dd>${esc(p.unit)}</dd>` : ''}</dl>
      ${Array.isArray(p.hints) && p.hints.length ? `<ul class="hints">${p.hints.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>` : ''}
      <form class="pform" novalidate><input class="input mono" name="a" autocomplete="off" spellcheck="false" placeholder="${ph(p.answerFormat)}" aria-label="Your answer"><button class="btn btn-hull" type="submit">Check</button></form>
      <p class="help" data-out>Encoded like the live board (${esc(p.answerFormat)} → bytes32) before checking.</p>
    </div>
  </details>`
}

function render() {
  const list = items.filter((p) => tier === '0' || String(p.tier) === tier)
  $('#list').innerHTML = list.length ? list.map(card).join('') : '<div class="panel empty">No practice questions yet. They fill in hourly from closed windows.</div>'
  $('#score').textContent = items.length ? `${items.filter((p) => solved.has(p.pid)).length} of ${items.length} cracked in this browser` : ''
  $$('#list .pcard').forEach(wire)
}

function wire(el) {
  const p = items.find((x) => String(x.pid) === el.dataset.pid)
  const form = el.querySelector('form'), out = el.querySelector('[data-out]'), input = form.a, btn = form.querySelector('button')
  input.addEventListener('input', () => {
    try { const e = input.value.trim() ? encodeAnswer(p.answerFormat, input.value) : null; out.className = 'help'; out.textContent = e ? `bytes32: ${e}` : 'Type an answer.' ; input.removeAttribute('aria-invalid') }
    catch (e) { out.className = 'help err'; out.textContent = e.message; input.setAttribute('aria-invalid', 'true') }
  })
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    try { encodeAnswer(p.answerFormat, input.value) } catch (err) { out.className = 'help err'; out.textContent = err.message; return }
    btn.classList.add('busy')
    try {
      const r = await api.practiceCheck(p.pid, input.value.trim())
      if (r.correct) {
        out.className = 'help'; out.innerHTML = `<span class="check ok">${ICON.ok}Correct: cracked.</span>`
        solved.add(p.pid); saveSolved(); el.classList.add('ok')
        $('#score').textContent = `${items.filter((x) => solved.has(x.pid)).length} of ${items.length} cracked in this browser`
      } else { out.className = 'help err'; out.innerHTML = `<span class="check bad">${ICON.bad}Not this one.</span> ${r.hint ? esc(r.hint) : 'Check the window and the encoding.'}` }
    } catch (err) { out.className = 'help err'; out.textContent = err.message }
    btn.classList.remove('busy')
  })
}

$('#f-tier').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; tier = b.dataset.v; $$('#f-tier button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); render() })

async function load() {
  try { items = ((await api.practice()).items || []).map((p) => ({ ...p, pid: String(p.pid) })); render() } catch (e) { errorBox($('#list'), e, load) }
}
load()
