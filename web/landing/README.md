# KEELCRACK landing (owner: LANDING)

`web/index.html` + `web/landing/` + `web/shared3d/`. Static ES modules, importmap, no bundler.
Reads `/api/state`, `/api/questions?status=all&limit=48`, `/api/leaderboard?by=model` and SSE `/api/live`. Until the
server has answered once it goes through `/shared/api.js` (DEMO fixtures from `/shared/demo.js` when the server is
unreachable, site.js shows the "demo" bar). After that it reads the server directly (9 s timeout, own EventSource with
backoff): a slow or briefly unreachable server keeps the last field on screen, the ruler says "reconnecting", retries back
off 4 s → 60 s, and the field catches up when it is back (it never swaps real data for demo data mid-session). Navbar, CA + copy, Buy, X, TG and countdown come from `/shared/site.js` (`init({ overlay: true })`).

## Run
```
python3 -m http.server 4880 -d web          # then http://127.0.0.1:4880/
```
URL switches: `?gate=1` force the gate · `?gate=0` skip it · `?demo=1` fixtures (sticky per tab, `?demo=0` resets) ·
`?api=http://127.0.0.1:4878` point at a local server · `?debug` exposes `window.KC` (field, state, pan) for testing.

## What is on the page
- **Gate**: a frozen plate in front of the icebreaker bow and one callout: "What is Robinhood Chain's chain ID?". `4663`
  (or `0x1237`) + Enter → the ship drives through, the pre-fractured plate breaks (rapier) and the camera pans into the
  field. Wrong → card shake, the ship bumps the ice, hints get more direct. "Skip" link; `localStorage kc.gate = 1`
  skips it next time (returning visitors land at "now").
- **Field** (x = hour, oldest left → newest right; it starts one hour before the oldest question and spans at least 10
  hours, so a handful of pre-launch questions does not leave a day of empty pack ice): one floe per question. Open = whole floe, thickness = live bounty
  (`thicknessFor(loadEth)`, log scale). Cracked = pre-fractured pieces drifting on soft springs. Unsolved after 24 h = flat
  grey slab. The next hour is skim ice that grows through the hour. Hours without a question are frozen pack ice.
  New question (`posted` / new id on refresh) freezes in; `settled` cracks or melts; `commit`/`reveal`/`topup` ripple.
  Pre-launch the server's preview questions (`preview: true`, bounty 0) are shown as **practice** floes ("try it free ·
  bounty at launch", panel: "Practice until launch …", "Practice it, no wallet" + the question page); with an empty
  `/api/questions` the practice pool is laid out instead. Next-question countdown = `state.nextQuestionAt`; while this
  hour's question is still being written (it can land a minute or two after :00:45) the skim ice keeps its slot and says
  "any moment"; when it lands it freezes in, the skim moves on and a "Now" view follows.
- **Callouts** pinned to every floe (status, Q#, tier, hour, bounty / solve time + model) with leader lines. Collision
  avoidance per frame: selected / focused first, then the skim, open → practice → cracked → unsolved (newer first); a
  callout without room is nudged sideways (≤ 45 %), stacked, or shrinks to a "• Q12" tag (full again when focused or
  selected; click/tap selects; tooltip = title). The side panel (desktop, and short landscape screens ≤ 560 px tall as a
  290 px docked panel) / bottom sheet (portrait ≤ 1000 px) shows the selected floe with a link to `/q/?id=N`, "Replay the
  crack" for cracked floes.
- **Six buoys** with pinned cards that never rise over the ship's lane on their own: a card hangs below its buoy; if it
  does not fit above the ruler (or sits on another buoy's card, or the screen is ≤ 560 px tall) it folds to its title chip
  beside the buoy (crowded: just the number). The title is a button (`aria-expanded`) that unfolds / folds it; an unfolded
  card on a short screen scrolls inside. Buoy 6 first tries a slim one-column layout (CA + countdown are in the navbar).
  Buoys: 1 every hour (next-question countdown, counts) · 2 answer locked on-chain (newest hash)
  · 3 the bounty grows (pool, next drip; "at launch" in preview) · 4 commit, reveal, crack · 5 top 5 models (7 d, falls
  back to all) · 6 send your agent (one line + copy, Practice/Board/Docs, X/TG, CA strip + Buy, countdown, disclosure).
- **Time ruler** at the bottom: hour ticks, a mark per floe by status, buoy numbers, the view window; click/drag to jump,
  "Now →".
- Input: wheel / trackpad (either axis), drag with inertia, horizontal swipe on phones, ← → (next stop), Shift+← →,
  PageUp/Down, Home/End, Esc closes the panel. Click/tap a floe or its callout to select.
- Keyboard / a11y: callouts and buoys share one container kept in field order, so Tab walks the field left → right and
  focusing an off-screen item pans to it (off-screen items stay focusable, invisible, parked inside the viewport). Enter on
  a callout opens the panel and moves focus to its title; Esc (or the close button) returns focus to the callout. Visible
  focus ring (hull orange) everywhere; the gate input is labelled by the question and described by the hint.
- **Gate aftermath**: the broken plate sinks back under while pack ice rises around the ship's open channel (≈ 4 s), so no
  loose plates linger at the start of the field; skip / returning visitors get the settled pack at once and land at "now".

## Render rules (BRIEF "The landing")
Orthographic camera tilted 54°, it only pans (x; z eases between the gate and field framing on portrait phones).
Low-poly flat-shaded Lambert ice with vertex colours, a thin cold bevel rim and an analytic outline (inner rim, outer
rim, corners, waterline). Flat water `ShaderMaterial` with contour-line ripples, a ship wake and splash rings. One accent:
the orange hull (and the selected floe outline). No PBR / environment map / bloom / grain / vignette / particles / 3D type.
`prefers-reduced-motion`: no drift, no water motion, instant gate, static pieces. Adaptive quality: DPR ≤ 1.75 and
dropped (×0.72, at most twice) when the average frame is over 24 ms. ~57 draw calls / 15k triangles at 1440×900.

## shared3d (APP may import, never edit)
- `ice.js`: `COLORS`, `rng`, `hashSeed`, `floeOutline`, `fracture` (Voronoi pre-fracture), `voronoiMosaic` (pack ice),
  `buildFloe`, `floeObject` (`group.userData.rebuild(h)`), `mergeFloes`, `iceMaterial`, `lineMaterial`, `waterMaterial`,
  `thicknessFor`, `loadRapier` (lazy 2 MB import, resolves `null` on failure), `planarWorld(R | null)` (bodies locked to the
  water plane, kinematic hull, walls; a no-physics integrator when rapier is missing).
- `stage.js`: `createStage()` (one WebGL context, many views via scissor) and `mountFloePreview(el, qitem)` for board cards
  (open / cracked / unsolved from the QItem). Example: `import { mountFloePreview } from '/shared3d/stage.js'`.

## Files
`main.js` data, gate, panning, overlay (callouts, buoys, panel, ruler) · `field.js` the 3D scene and physics ·
`landing.css` · `../index.html`. No `_tmp/` stand-ins were needed (APP's shared files existed in time).

## Test
No unit tests for the landing; it was checked in headless Chrome (CDP script) at 1440×900, 1280×720 (reduced motion),
1920×1080 and 390×844 (mobile emulation, touch swipe + tap), with `?demo=1` and with no server (auto demo): no console
errors, rapier active, 60 fps headless. Polish pass (16-10-2026): against the real preview server at 1440×900, 1920×1080,
390×844 and 844×390 (touch), plus: hour boundary (real `posted` at 21:01 and a simulated one with a shifted page clock),
server killed / restarted mid-session, 6 s API latency, Tab order, reduced motion; 60 fps at 1440×900 in a GPU browser.
