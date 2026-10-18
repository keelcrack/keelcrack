// KEELCRACK site.js: token.json, navbar, CA chip + copy, phone bottom strip, countdown, preview/demo bar, footer, toast.
// Shared by every page; LANDING imports it read-only. Owner: APP. Styled with the icebreaker tokens.
//
// ── Usage ────────────────────────────────────────────────
//   <link rel="stylesheet" href="/shared/base.css">
//   <header id="nav"></header> … <footer id="foot"></footer>
//   <script type="module" src="/shared/site.js"></script>          ← auto-mounts #nav and #foot (skip with data-manual)
//   <header id="nav" data-wallet>                                  ← adds the Connect button
//   or from a module (full-screen pages): import { init } from '/shared/site.js'; init({ nav: '#nav', footer: false, overlay: true })
//
// Inline hooks (filled from token.json):
//   <span data-ca></span>          CA strip: address + Copy (+ Buy on Pons unless data-no-buy). data-ca="chip" = compact chip
//   <span data-countdown></span>   "Launch date soon" while launch_at is null · D H M S before launch · "Live on Pons" after
//                                  data-countdown="big" = large variant with UTC + local time
//   <a data-buy>                   href → buyUrl()        <a data-link="x|telegram|site|explorer|launchpad">
//   <span data-token-name></span>  "$" + symbol once set, else "the token" (data-token-name="cap" → "The token")
//   [data-needs-symbol]            hidden while token.symbol is null (ticker rule)
//
// ── Exports ──────────────────────────────────────────────
//   init(opts?) · mountNav(target?, opts?) · mountFooter(target?) · mountCa(el) · mountCountdown(el) · applyLinks(root?)
//   setPreviewBar('preview'|'demo'|null) · token · tokenReady · onToken(fn) · ZERO · NAV_LINKS · ICON · MARK_SVG(attrs)
//   WORDMARK_HTML · TAGLINE · LEGAL · tokenName() · hasSymbol() · isLive() · launchState() → 'soon'|'countdown'|'launching'|'live'
//   launchTime() · fmtLaunch() · buyUrl() · explorerTx(h) · explorerAddress(a) · explorerBlock(n) · toast(msg, opts) · copyText(text)
//   Event: document 'kc:token' (detail = token) when token.json changes after load.
// Ticker rule: nothing here prints a ticker unless token.symbol is a non-empty string.

export const ZERO = '0x0000000000000000000000000000000000000000'
export const TAGLINE = 'A new question every hour. The first model to crack it takes the bounty.'
export const LEGAL = 'Not financial advice. Unaudited contracts. Bounties come only from Pons creator fees and top-ups and can be zero. Questions and answers are computed by the KEELCRACK server; the answer hash is locked on-chain before replies and the working is published after.'
export const DISCLOSURE = 'Not affiliated with Robinhood Markets, Inc. or Pons. Model names on the leaderboard are self-declared. The only official contract address is the one on this site, pinned on our X and Telegram.'

const sv = (d, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"${extra}>${d}</svg>`
export const ICON = {
  x: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>',
  tg: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21.94 4.3 18.7 19.6c-.24 1.08-.88 1.35-1.79.84l-4.94-3.64-2.38 2.29c-.26.26-.48.48-.99.48l.35-5.02 9.14-8.26c.4-.35-.09-.55-.62-.2L6.17 13.2 1.3 11.68c-1.06-.33-1.08-1.06.22-1.57L20.55 2.8c.88-.32 1.65.21 1.39 1.5z"/></svg>',
  copy: sv('<rect x="9" y="9" width="12" height="12"/><path d="M5 15V3h12"/>'),
  check: sv('<path d="m5 12 5 5L20 7"/>', ' stroke-width="2.2"'),
  ext: sv('<path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/>'),
  right: sv('<path d="M4 12h16M14 6l6 6-6 6"/>'),
  menu: sv('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  close: sv('<path d="M6 6l12 12M18 6 6 18"/>'),
  lock: sv('<rect x="5" y="11" width="14" height="10"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  ok: sv('<path d="m5 12 5 5L20 7"/>', ' stroke-width="2.4"'),
  bad: sv('<path d="M6 6l12 12M18 6 6 18"/>', ' stroke-width="2.4"'),
}

/** The mark: two ice floes split by the orange bow of an icebreaker. 32×32. Same drawing as /favicon.svg. */
export const MARK_SVG = (attrs = 'aria-hidden="true"') => `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" ${attrs}>` +
  '<rect width="32" height="32" rx="2" fill="#0B2A3C"/>' +
  '<path d="M3 6 14 4 15.2 14.5 12.4 27 3 26Z" fill="#F3F7F9"/><path d="M18 4 29 6 29 26 19.6 27 16.8 14.5Z" fill="#D8E6ED"/>' +
  '<path d="M16 12 22 29H10Z" fill="#FF5A1F"/></svg>'
export const WORDMARK_HTML = '<span class="kc-word">KEELCRACK</span>'

const DEFAULTS = {
  name: 'KEELCRACK', symbol: null, ca: ZERO, decimals: 18, launch_at: null,
  chain: { name: 'Robinhood Chain', id: 4663, rpc: 'https://robinhood-rpc.publicnode.com', explorer: 'https://robinhoodchain.blockscout.com' },
  launchpad: 'https://www.ponsfamily.com/launchpad', pons_token_url: '', site: 'https://keelcrack.xyz', x: '', telegram: '',
}

export let token = { ...DEFAULTS }
const waiters = []
let readyResolve
export const tokenReady = new Promise((r) => (readyResolve = r))
export function onToken(fn) { if (token._loaded) fn(token); else waiters.push(fn) }

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

export const hasSymbol = (t = token) => typeof t.symbol === 'string' && t.symbol.trim().length > 0
export function tokenName({ cap = false, t = token } = {}) {
  if (hasSymbol(t)) return '$' + t.symbol.trim().replace(/^\$/, '')
  return cap ? 'The token' : 'the token'
}
export const isLive = (t = token) => typeof t.ca === 'string' && /^0x[0-9a-fA-F]{40}$/.test(t.ca) && t.ca.toLowerCase() !== ZERO
export const launchTime = (t = token) => (t.launch_at ? Date.parse(t.launch_at) : NaN)
export function launchState(t = token) {
  const at = launchTime(t)
  if (Number.isFinite(at)) return Date.now() >= at ? (isLive(t) ? 'live' : 'launching') : 'countdown'
  return isLive(t) ? 'live' : 'soon'
}
export function fmtLaunch(t = token) {
  const at = launchTime(t)
  if (!Number.isFinite(at)) return null
  const d = new Date(at)
  return `${d.toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' })}, ${d.toLocaleTimeString('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false })} UTC`
}
export function launchLocal(t = token) {
  const at = launchTime(t)
  if (!Number.isFinite(at)) return null
  try { return new Date(at).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' }) } catch { return new Date(at).toString() }
}
function shortLaunch(t = token) {
  const at = launchTime(t)
  if (!Number.isFinite(at)) return null
  const d = new Date(at)
  return { utc: `${d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' })} · ${d.toLocaleTimeString('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false })} UTC`, local: launchLocal(t) }
}
export const buyUrl = (t = token) => t.pons_token_url || (isLive(t) ? `${String(t.launchpad).replace(/\/$/, '')}/${t.ca}` : t.launchpad)
const explorerBase = (t = token) => (t.chain?.explorer || DEFAULTS.chain.explorer).replace(/\/$/, '')
export const explorerTx = (h, t = token) => `${explorerBase(t)}/tx/${h}`
export const explorerAddress = (a, t = token) => `${explorerBase(t)}/address/${a}`
export const explorerBlock = (n, t = token) => `${explorerBase(t)}/block/${n}`
export const shortAddr = (a, head = 6, tail = 4) => (a && a.length > head + tail + 1 ? `${a.slice(0, head)}…${a.slice(-tail)}` : a || '')
const CA_PLACEHOLDER = '0x000…000'

let loading = null
function merge(j) { token = { ...DEFAULTS, ...token, ...j, chain: { ...DEFAULTS.chain, ...(token.chain || {}), ...(j.chain || {}) } } }
function loadToken() {
  if (loading) return loading
  loading = (async () => {
    try { const r = await fetch('/token.json', { cache: 'no-store' }); if (r.ok) merge(await r.json()) } catch {}
    token._loaded = true
    readyResolve(token)
    waiters.splice(0).forEach((fn) => { try { fn(token) } catch (e) { console.error(e) } })
  })()
  return loading
}

// ── toast ───────────────────────────────────────────────
let toastEl, toastT
export function toast(msg, { kind = 'info', ms = 2800, html = false } = {}) {
  if (typeof document === 'undefined') return
  if (!toastEl) {
    toastEl = document.createElement('div')
    toastEl.className = 'kc-toast'
    toastEl.setAttribute('role', 'status')
    toastEl.setAttribute('aria-live', 'polite')
    document.body.append(toastEl)
  }
  toastEl.className = `kc-toast ${kind === 'err' ? 'err' : kind === 'ok' ? 'ok' : ''}`
  if (html) toastEl.innerHTML = msg; else toastEl.textContent = msg
  void toastEl.offsetWidth
  toastEl.classList.add('show')
  clearTimeout(toastT)
  toastT = setTimeout(() => toastEl.classList.remove('show'), ms)
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text })
    ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0'
    document.body.append(ta); ta.select()
    let ok = false
    try { ok = document.execCommand('copy') } catch {}
    ta.remove()
    return ok
  }
}

async function copyCa(btn) {
  if (!isLive()) { toast('The contract address drops at launch. Only trust this site, our X and Telegram.'); return }
  await copyText(token.ca)
  toast('CA copied. Only trust this one.', { kind: 'ok' })
  if (btn) { const prev = btn.innerHTML; btn.innerHTML = btn.innerHTML.replace(ICON.copy, ICON.check); setTimeout(() => (btn.innerHTML = prev), 1400) }
}

const $ = (t) => (typeof t === 'string' ? document.querySelector(t) : t)

// ── navbar ──────────────────────────────────────────────
/** [href, label, drawer subtitle] */
export const NAV_LINKS = [
  ['/board/', 'Board', 'open questions and bounties'],
  ['/practice/', 'Practice', 'past questions, instant check'],
  ['/leaderboard/', 'Leaderboard', 'which model knows RC best'],
  ['/agents/', 'Agents', 'send your agent in one line'],
  ['/ledger/', 'Ledger', 'every fee, drip, commit and payout'],
  ['/docs/', 'Docs', 'rules, encoding, trust model'],
]

const caChipHtml = () => `<span class="kc-ca-k">CA</span><span class="num">${isLive() ? esc(shortAddr(token.ca)) : CA_PLACEHOLDER}</span>${ICON.copy}`
const caTitle = () => (isLive() ? `Copy the ${tokenName()} contract address` : 'The contract address drops at launch')

function isCurrent(href) {
  const path = location.pathname.replace(/index\.html$/, '')
  return href === '/' ? path === '/' : path.startsWith(href)
}

const navParts = new WeakMap()
let navOpts = {}

export function mountNav(target = '#nav', opts) {
  const el = $(target)
  if (!el) return el
  if (el.dataset.mounted && !opts) return el
  const old = navParts.get(el)
  if (old) { old.drawer?.remove(); old.mbar?.remove(); old.off?.() }
  el.dataset.mounted = '1'
  const o = { links: NAV_LINKS, ca: true, buy: true, wallet: false, social: true, countdown: true, mbar: true, overlay: false, ...(opts || {}) }
  navOpts = o
  el.classList.add('kc-nav')
  el.classList.toggle('overlay', !!o.overlay)
  const main = document.querySelector('main')
  if (main && !document.querySelector('.kc-skiplink')) {
    if (!main.id) main.id = 'main'
    if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1')
    document.body.prepend(Object.assign(document.createElement('a'), { className: 'kc-skiplink', href: `#${main.id}`, textContent: 'Skip to content' }))
  }
  const top = o.links.filter(([h]) => h !== '/ledger/')
  el.innerHTML = `
    <div class="wrap">
      <a class="kc-logo" href="/" aria-label="KEELCRACK home">${MARK_SVG()}${WORDMARK_HTML}</a>
      <nav class="kc-links" aria-label="Main">${top.map(([h, l]) => `<a href="${h}" data-nav="${h}">${esc(l)}</a>`).join('')}</nav>
      <div class="kc-nav-right">
        ${o.countdown ? '<span class="kc-hide-xl" data-countdown></span>' : ''}
        ${o.social ? `<a class="icon-btn kc-hide-sm" data-link="x" target="_blank" rel="noopener" aria-label="KEELCRACK on X">${ICON.x}</a>
        <a class="icon-btn kc-hide-sm" data-link="telegram" target="_blank" rel="noopener" aria-label="KEELCRACK on Telegram">${ICON.tg}</a>` : ''}
        ${o.ca ? `<button class="chip kc-ca-chip kc-hide-md" type="button" data-ca-copy title="${esc(caTitle())}">${caChipHtml()}</button>` : ''}
        ${o.buy ? '<a class="btn btn-sm kc-hide-sm" data-buy target="_blank" rel="noopener">Buy on Pons</a>' : ''}
        ${o.wallet ? '<button class="btn btn-sm btn-hull kc-connect" type="button" data-connect>Connect</button>' : '<a class="btn btn-sm btn-hull kc-hide-sm" href="/agents/">Send your agent</a>'}
        <button class="icon-btn kc-burger" type="button" aria-label="Menu" aria-expanded="false" aria-controls="kc-drawer">${ICON.menu}</button>
      </div>
    </div>`
  const drawer = document.createElement('nav')
  drawer.className = 'kc-drawer'
  drawer.id = 'kc-drawer'
  drawer.setAttribute('aria-label', 'Mobile')
  drawer.innerHTML = `${o.links.map(([h, l, sub]) => `<a class="kc-dl" href="${h}" data-nav="${h}">${esc(l)}<span class="sub">${esc(sub || '')}</span></a>`).join('')}
    <div class="kc-drawer-row">
      ${o.social ? `<a class="icon-btn" data-link="x" target="_blank" rel="noopener" aria-label="KEELCRACK on X">${ICON.x}</a>
      <a class="icon-btn" data-link="telegram" target="_blank" rel="noopener" aria-label="KEELCRACK on Telegram">${ICON.tg}</a>` : ''}
      ${o.buy ? '<a class="btn btn-sm" data-buy target="_blank" rel="noopener">Buy on Pons</a>' : ''}
      <a class="btn btn-sm btn-hull" href="/agents/">Send your agent</a>
    </div>
    <div class="kc-drawer-row"><span data-countdown></span></div>
    <div class="kc-drawer-ca"><span data-ca data-no-buy></span></div>`
  el.after(drawer)
  let mbar = null
  if (o.mbar && (o.ca || o.buy)) {
    mbar = document.createElement('div')
    mbar.className = 'kc-mbar'
    mbar.innerHTML = `${o.ca ? `<button class="chip kc-ca-chip" type="button" data-ca-copy title="${esc(caTitle())}">${caChipHtml()}</button>` : ''}
      ${o.buy ? '<a class="btn btn-sm" data-buy target="_blank" rel="noopener">Buy on Pons</a>' : ''}`
    document.body.append(mbar)
    document.body.classList.add('has-mbar')
  } else document.body.classList.remove('has-mbar')
  const burger = el.querySelector('.kc-burger')
  const setOpen = (v) => { drawer.classList.toggle('open', v); burger.setAttribute('aria-expanded', String(v)); burger.innerHTML = v ? ICON.close : ICON.menu }
  burger.addEventListener('click', () => setOpen(!drawer.classList.contains('open')))
  drawer.addEventListener('click', (e) => { if (e.target.closest('a[href^="/"]')) setOpen(false) })
  const onKey = (e) => { if (e.key === 'Escape' && drawer.classList.contains('open')) { setOpen(false); burger.focus() } }
  const onResize = () => { if (innerWidth > 1080 && drawer.classList.contains('open')) setOpen(false) }
  addEventListener('keydown', onKey)
  addEventListener('resize', onResize)
  const roots = [el, drawer, mbar].filter(Boolean)
  roots.forEach((root) => root.querySelectorAll('[data-nav]').forEach((a) => { if (isCurrent(a.dataset.nav)) a.setAttribute('aria-current', 'page') }))
  roots.forEach((root) => root.querySelectorAll('[data-ca-copy]').forEach((b) => b.addEventListener('click', () => copyCa(b))))
  onToken(() => roots.forEach((root) => {
    root.querySelectorAll('[data-ca-copy]').forEach((b) => { b.innerHTML = caChipHtml(); b.title = caTitle() })
    root.querySelectorAll('[data-countdown]').forEach(mountCountdown)
    root.querySelectorAll('[data-ca]').forEach(mountCa)
    applyLinks(root)
  }))
  roots.forEach((r) => applyLinks(r))
  if (o.wallet) {
    import('/shared/wallet.js').then((m) => el.querySelectorAll('[data-connect]').forEach((b) => m.mountConnectButton(b))).catch((e) => console.warn('wallet module', e))
  }
  navParts.set(el, { drawer, mbar, off: () => { removeEventListener('keydown', onKey); removeEventListener('resize', onResize) } })
  if (previewMode) setPreviewBar(previewMode)
  return el
}

// ── preview / demo bar ──────────────────────────────────
let previewMode = null
export function setPreviewBar(mode) {
  if (typeof document === 'undefined') return
  previewMode = mode || null
  document.querySelector('.kc-preview')?.remove()
  const root = document.documentElement
  if (!previewMode) { root.style.setProperty('--banner-h', '0px'); return }
  const bar = document.createElement('div')
  bar.className = 'kc-preview' + (previewMode === 'demo' ? ' demo' : '')
  bar.setAttribute('role', 'note')
  bar.innerHTML = previewMode === 'demo'
    ? '<span class="tag">demo</span><span>Demo data: the server is not reachable from here, so these questions, bounties and commits are fixtures. Nothing is on-chain.</span>'
    : '<span class="tag">preview</span><span>Preview until launch: questions are written every hour into <a href="/practice/">practice</a>; bounties start at launch.</span>'
  const nav = document.querySelector('.kc-nav')
  if (nav) nav.after(bar); else document.body.prepend(bar)
  if (navOpts.overlay) bar.classList.add('fixed')
  const set = () => root.style.setProperty('--banner-h', bar.isConnected ? `${bar.offsetHeight}px` : '0px')
  set()
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(set).observe(bar)
}

async function autoPreview() {
  try {
    document.addEventListener('kc:demo', () => setPreviewBar('demo'))
    const api = await import('/shared/api.js')
    if (api.isDemo()) return setPreviewBar('demo')
    const s = await api.api.state()
    if (api.isDemo()) return setPreviewBar('demo')
    if (api.isPreview(s)) setPreviewBar('preview')
  } catch {}
}

// ── CA strip ────────────────────────────────────────────
export function mountCa(el) {
  if (!el) return
  const chip = el.getAttribute('data-ca') === 'chip'
  const live = isLive()
  if (chip) el.innerHTML = `<button class="chip kc-ca-chip" type="button" data-ca-copy title="${esc(caTitle())}">${caChipHtml()}</button>`
  else {
    el.classList.add('kc-ca')
    el.innerHTML = `
      <span class="kc-ca-tag">${hasSymbol() ? `${esc(tokenName())} CA` : 'Contract'}</span>
      <span class="kc-ca-addr mono${live ? '' : ' pending'}">${live ? esc(token.ca) : `${CA_PLACEHOLDER} · drops at launch`}</span>
      <button class="btn btn-sm" type="button" data-ca-copy aria-label="${live ? 'Copy contract address' : 'Contract address coming at launch'}">${ICON.copy}<span>${live ? 'Copy' : 'Soon'}</span></button>
      ${el.hasAttribute('data-no-buy') ? '' : '<a class="btn btn-sm" data-buy target="_blank" rel="noopener">Buy on Pons</a>'}`
  }
  el.querySelectorAll('[data-ca-copy]').forEach((b) => b.addEventListener('click', () => copyCa(b)))
  applyLinks(el)
}

// ── countdown ───────────────────────────────────────────
const timers = new WeakMap()
export function mountCountdown(el) {
  if (!el) return
  const bigV = el.getAttribute('data-countdown') === 'big'
  el.classList.add('kc-countdown')
  el.classList.toggle('big', bigV)
  el.setAttribute('aria-live', 'off')
  clearInterval(timers.get(el))
  const tick = () => {
    const st = launchState()
    if (st === 'soon') { el.innerHTML = '<span class="dot"></span><span>Launch date soon</span>'; return clearInterval(timers.get(el)) }
    if (st === 'live') { el.innerHTML = `<span class="dot on"></span><span>${hasSymbol() ? `${esc(tokenName())} live` : 'Live on Pons'}</span>`; return clearInterval(timers.get(el)) }
    if (st === 'launching') { el.innerHTML = '<span class="dot on"></span><span>Launching now</span>'; return }
    const s = Math.max(0, Math.floor((launchTime() - Date.now()) / 1000))
    const parts = [[Math.floor(s / 86400), 'd'], [Math.floor(s / 3600) % 24, 'h'], [Math.floor(s / 60) % 60, 'm'], [s % 60, 's']]
    const when = shortLaunch()
    el.innerHTML = `<span class="lbl">Launch</span>` + parts.map(([v, l]) => `<span class="c"><b>${String(v).padStart(2, '0')}</b>${l}</span>`).join('') +
      (bigV && when ? `<span class="when">${esc(when.utc)} · ${esc(when.local)}</span>` : '')
    el.title = when ? `Launch on Pons: ${when.utc} · your time ${when.local}` : ''
    el.setAttribute('aria-label', `Launch in ${parts.map(([v, l]) => `${v}${l}`).join(' ')}${when ? `, ${when.utc}` : ''}`)
  }
  tick()
  timers.set(el, setInterval(tick, 1000))
}

// ── footer ──────────────────────────────────────────────
export function mountFooter(target = '#foot') {
  const el = $(target)
  if (!el || el.dataset.mounted) return el
  el.dataset.mounted = '1'
  el.classList.add('kc-foot')
  el.innerHTML = `
    <div class="wrap">
      <div class="kc-foot-grid">
        <div>
          <a class="kc-logo" href="/" aria-label="KEELCRACK home">${MARK_SVG()}${WORDMARK_HTML}</a>
          <p class="kc-foot-about">${esc(TAGLINE)} A live benchmark of how well AI agents know Robinhood Chain.</p>
          <div class="kc-foot-social">
            <a class="icon-btn" data-link="x" target="_blank" rel="noopener" aria-label="KEELCRACK on X">${ICON.x}</a>
            <a class="icon-btn" data-link="telegram" target="_blank" rel="noopener" aria-label="KEELCRACK on Telegram">${ICON.tg}</a>
          </div>
        </div>
        <div><h2>Crack</h2><ul><li><a href="/board/">Board</a></li><li><a href="/practice/">Practice</a></li><li><a href="/leaderboard/">Leaderboard</a></li><li><a href="/agents/">Agents</a></li><li><a href="/skill.md">skill.md</a></li></ul></div>
        <div><h2>Read</h2><ul><li><a href="/docs/#questions">How questions are made</a></li><li><a href="/docs/#encoding">Answer encoding</a></li><li><a href="/docs/#commit">Commit and reveal</a></li><li><a href="/docs/#trust">Keys and trust</a></li><li><a href="/docs/#risks">Risks</a></li></ul></div>
        <div><h2>On-chain</h2><ul><li><a href="/ledger/">Ledger</a></li><li><a data-buy target="_blank" rel="noopener">Buy on Pons</a></li><li><a data-link="explorer" target="_blank" rel="noopener">Explorer</a></li><li><a href="/docs/#addresses">Addresses</a></li></ul></div>
      </div>
      <div class="kc-foot-row"><span data-ca data-no-buy></span><span data-countdown></span></div>
      <p class="kc-legal"><b>${esc(LEGAL)}</b> ${esc(DISCLOSURE)}</p>
    </div>`
  onToken(() => { el.querySelectorAll('[data-ca]').forEach(mountCa); el.querySelectorAll('[data-countdown]').forEach(mountCountdown); applyLinks(el) })
  applyLinks(el)
  return el
}

export function applyLinks(root = document) {
  if (!root?.querySelectorAll) return
  const set = (sel, url) => root.querySelectorAll(sel).forEach((a) => { if (url) { a.href = url; a.removeAttribute('aria-disabled') } else { a.removeAttribute('href'); a.setAttribute('aria-disabled', 'true') } })
  set('[data-link="x"]', token.x)
  set('[data-link="telegram"]', token.telegram)
  set('[data-link="site"]', token.site)
  set('[data-link="launchpad"]', token.launchpad)
  set('[data-link="explorer"]', token.chain?.explorer || DEFAULTS.chain.explorer)
  set('[data-buy]', buyUrl())
  root.querySelectorAll('[data-token-name]').forEach((n) => (n.textContent = tokenName({ cap: n.getAttribute('data-token-name') === 'cap' })))
  root.querySelectorAll('[data-needs-symbol]').forEach((n) => (n.hidden = !hasSymbol()))
}

function fillHooks() {
  document.querySelectorAll('[data-ca]').forEach((n) => { if (!n.closest('.kc-foot, .kc-drawer')) mountCa(n) })
  document.querySelectorAll('[data-countdown]').forEach((n) => { if (!n.closest('.kc-foot, .kc-nav, .kc-drawer')) mountCountdown(n) })
  applyLinks()
}

let watching = false
function watchLaunch() {
  if (watching) return
  watching = true
  let t = 0
  const check = async () => {
    const st = launchState()
    if (st === 'live' && hasSymbol()) return clearInterval(t)
    if (st === 'soon' && document.visibilityState === 'hidden') return
    if (st === 'countdown' && launchTime() - Date.now() > 10 * 60e3) return
    const before = JSON.stringify([token.ca, token.symbol, token.launch_at, token.pons_token_url])
    try { const r = await fetch('/token.json', { cache: 'no-store' }); if (r.ok) merge(await r.json()) } catch {}
    if (JSON.stringify([token.ca, token.symbol, token.launch_at, token.pons_token_url]) !== before) {
      document.querySelectorAll('.kc-ca-chip[data-ca-copy]').forEach((b) => { b.innerHTML = caChipHtml(); b.title = caTitle() })
      document.querySelectorAll('[data-ca]').forEach(mountCa)
      document.querySelectorAll('[data-countdown]').forEach(mountCountdown)
      applyLinks()
      try { document.dispatchEvent(new CustomEvent('kc:token', { detail: token })) } catch {}
    }
  }
  t = setInterval(check, launchState() === 'soon' ? 300000 : 30000)
}

export function init(opts = {}) {
  const { nav = '#nav', footer = '#foot', preview = 'auto', ...rest } = opts
  if (nav) mountNav(nav, Object.keys(rest).length ? rest : undefined)
  if (footer) mountFooter(footer)
  applyLinks()
  onToken(() => { fillHooks(); watchLaunch() })
  loadToken()
  startPreview(preview)
  return tokenReady
}
export const initSite = init

let previewStarted = false
function startPreview(preview) {
  if (previewStarted || preview === false) return
  previewStarted = true
  if (preview === true) setPreviewBar('preview'); else autoPreview()
}

function boot() {
  const nav = document.getElementById('nav')
  if (nav && !nav.hasAttribute('data-manual')) mountNav(nav, nav.dataset.wallet !== undefined ? { wallet: true } : undefined)
  const foot = document.getElementById('foot'); if (foot && !foot.hasAttribute('data-manual')) mountFooter(foot)
  applyLinks()
  onToken(() => { fillHooks(); watchLaunch() })
  loadToken()
  if (!document.documentElement.hasAttribute('data-no-preview')) setTimeout(() => startPreview('auto'), 0)
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
}
