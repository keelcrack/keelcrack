// /docs/: encoding calculator, addresses from contracts.json / token.json, TOC highlight.
import { encodeAnswer, commitHash, answerHash, loadBoard } from '/shared/abi.js'
import { esc } from '/shared/fmt.js'
import { tokenReady, isLive, explorerAddress } from '/shared/site.js'

const $ = (s) => document.querySelector(s)
function calc() {
  const out = []
  try {
    const a = encodeAnswer($('#c-fmt').value, $('#c-ans').value)
    out.push(['bytes32', a])
    const id = BigInt($('#c-id').value.trim() || '0')
    try { out.push(['commitHash', commitHash(id, $('#c-solver').value.trim(), a, $('#c-nonce').value.trim())]) } catch (e) { out.push(['commitHash', `– (${e.message})`]) }
    try { out.push(['answerHash', answerHash(id, a, $('#c-salt').value.trim())]) } catch (e) { out.push(['answerHash', `– (${e.message})`]) }
  } catch (e) { out.push(['error', e.message]) }
  $('#c-out').innerHTML = out.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')
}
document.querySelectorAll('#calc input, #calc select').forEach((n) => n.addEventListener('input', calc))
calc()

loadBoard().then((b) => {
  const el = document.querySelector('[data-a="board"]')
  el.innerHTML = b.address ? `<a href="${explorerAddress(b.address)}" target="_blank" rel="noopener">${esc(b.address)}</a>` : '<span class="muted">deployed at launch</span>'
})
tokenReady.then((t) => {
  const el = document.querySelector('[data-a="token"]')
  el.innerHTML = isLive(t) ? `<a href="${explorerAddress(t.ca)}" target="_blank" rel="noopener">${esc(t.ca)}</a>` : '<span class="muted">0x000…000 · drops at launch</span>'
})

const links = [...document.querySelectorAll('.toc a')]
const io = new IntersectionObserver((es) => {
  for (const e of es) if (e.isIntersecting) links.forEach((a) => a.classList.toggle('on', a.getAttribute('href') === '#' + e.target.id))
}, { rootMargin: '-20% 0px -70% 0px' })
document.querySelectorAll('article section').forEach((s) => io.observe(s))
