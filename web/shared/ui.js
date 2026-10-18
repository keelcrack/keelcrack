// KEELCRACK ui.js: small DOM helpers shared by the app pages (board, q, practice, leaderboard, ledger). Owner: APP.
//   floeSvg(seed, { load, status, size }) → static SVG of an ice floe (thickness = bounty; cracked = split; unsolved = flat grey)
//   tierTag(t) · statusTag(s) · ethOf(x) → number (accepts {eth}, {wei}, wei string, number) · fmtBounty(x)
//   copyBtn(text, label?) → HTML of a small copy button (wire with wireCopy(root)) · wireCopy(root)
//   ticker(fn, ms) → stop() (runs fn now and every ms; pauses while the tab is hidden)
//   explorer helpers re-exported from site.js · $ / $$

import { esc, fmtEth, tierRoman, STATUS_LABEL, toNum } from './fmt.js'
import { ICON, copyText, toast } from './site.js'

export const $ = (s, r = document) => r.querySelector(s)
export const $$ = (s, r = document) => [...r.querySelectorAll(s)]

export function ethOf(x) {
  if (x === null || x === undefined) return NaN
  if (typeof x === 'object') { if ('eth' in x && x.eth != null) return Number(x.eth); if ('wei' in x) return toNum(String(x.wei)) }
  if (typeof x === 'string' && /^\d+$/.test(x)) return toNum(x)
  return Number(x)
}
export const fmtBounty = (x) => fmtEth(ethOf(x))

export const tierTag = (t) => `<span class="tag tier" title="Tier ${tierRoman(t)}: ${t == 1 ? 'count something in the window' : t == 2 ? 'find and compare' : 'combine several sources'}">Tier ${tierRoman(t)}</span>`
export const statusTag = (s) => `<span class="tag ${esc(s)}">${esc(STATUS_LABEL[s] || s)}</span>`

function rng(seed) {
  let a = (Number(seed) * 2654435761) >>> 0 || 1
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

/** A low-poly floe seen slightly from the side: top face (ice), side band (thickness = bounty). Cracked floes split along a
 *  jagged line with dark water between; unsolved floes are a thin flat grey slab. Pure SVG string, deterministic per seed. */
export function floeSvg(seed, { load = 0, status = 'open', w = 56, h = 44, title = '' } = {}) {
  const r = rng(seed + 11)
  const cx = w / 2, cy = h * 0.42, rx = w * 0.44, ry = h * 0.26
  const n = 7
  const pts = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + r() * 0.5
    const k = 0.78 + r() * 0.22
    pts.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k])
  }
  const thick = status === 'unsolved' ? 2 : Math.max(3, Math.min(13, 3 + Math.sqrt(Math.max(0, load)) * 55))
  const P = (a) => a.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ')
  const side = (poly, dx = 0) => {
    // lower silhouette band: shift the polygon down by thick and draw the hull of both
    const low = poly.map(([x, y]) => [x + dx, y + thick])
    return `<polygon points="${P(low)}" fill="var(--side)"/>` + poly.map(([x, y], i) => {
      const [x2, y2] = poly[(i + 1) % poly.length]
      return y + y2 > 2 * cy - 2 ? `<polygon points="${P([[x + dx, y], [x2 + dx, y2], [x2 + dx, y2 + thick], [x + dx, y + thick]])}" fill="var(--side)"/>` : ''
    }).join('')
  }
  const top = (poly, dx = 0, fill = 'var(--top)') => `<polygon points="${P(poly.map(([x, y]) => [x + dx, y]))}" fill="${fill}" stroke="var(--rim)" stroke-width="1" stroke-linejoin="round"/>`
  const facet = (poly, dx = 0) => { const [a, b] = [poly[0], poly[3]]; return `<polyline points="${P([[a[0] + dx, a[1]], [cx + dx, cy], [b[0] + dx, b[1]]])}" fill="none" stroke="var(--rim)" stroke-width=".6" opacity=".7"/>` }
  const vars = status === 'unsolved' ? '--top:#E4EAEE;--side:#AEBDC6;--rim:#9AAAB4' : '--top:#FFFFFF;--side:#9EC3D8;--rim:#7FA9C2'
  let body
  if (status === 'solved') {
    const left = pts.filter(([x]) => x < cx), right = pts.filter(([x]) => x >= cx)
    const crack = [[cx + 1, cy - ry], [cx - 2, cy - ry * 0.3], [cx + 2, cy + ry * 0.2], [cx - 1, cy + ry]]
    const L = [...crack, ...left.sort((a, b) => Math.atan2(b[1] - cy, b[0] - cx) - Math.atan2(a[1] - cy, a[0] - cx))]
    const R = [...[...crack].reverse(), ...right.sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx))]
    body = side(L, -4) + top(L, -4) + side(R, 4) + top(R, 4) + `<polyline points="${P(crack.map(([x, y]) => [x, y + 2]))}" fill="none" stroke="var(--water)" stroke-width="1.4" opacity=".5"/>`
  } else {
    body = side(pts) + top(pts) + facet(pts)
  }
  const keel = status === 'open' ? `<path d="M${(w - 9).toFixed(1)} ${(h - 3).toFixed(1)} l7 -7 v7z" fill="var(--hull)"/>` : ''
  return `<svg class="floe-ic" viewBox="0 0 ${w} ${h}" style="${vars}" ${title ? `role="img" aria-label="${esc(title)}"` : 'aria-hidden="true"'}>${body}${keel}</svg>`
}

export function copyBtn(text, label = 'Copy') {
  return `<button class="btn btn-sm" type="button" data-copy="${esc(text)}" aria-label="${esc(label)}">${ICON.copy}<span>${esc(label)}</span></button>`
}
export function wireCopy(root = document) {
  root.querySelectorAll('[data-copy]').forEach((b) => {
    if (b.__kc) return
    b.__kc = true
    b.addEventListener('click', async () => { await copyText(b.getAttribute('data-copy')); toast('Copied.', { kind: 'ok', ms: 1400 }) })
  })
}

export function ticker(fn, ms) {
  let t = null
  const run = () => { try { fn() } catch (e) { console.error(e) } }
  const start = () => { if (!t) t = setInterval(run, ms) }
  const stop = () => { clearInterval(t); t = null }
  const vis = () => (document.hidden ? stop() : (run(), start()))
  document.addEventListener('visibilitychange', vis)
  run(); start()
  return () => { stop(); document.removeEventListener('visibilitychange', vis) }
}

export function errorBox(el, e, retry, title = 'Could not load this.') {
  el.innerHTML = `<div class="notice hull"><div><p><b>${esc(title)}</b> ${esc(e?.message || e)}</p>${retry ? '<button class="btn btn-sm" type="button" data-retry>Try again</button>' : ''}</div></div>`
  if (retry) el.querySelector('[data-retry]').onclick = retry
}
