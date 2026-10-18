# web/ (APP part) — shared modules + app pages

Static ES modules, no bundler. Owner: APP. LANDING owns `index.html`, `landing/`, `shared3d/`.

- `shared/` site chrome (`site.js`, `base.css`), API client + DEMO fixtures (`api.js`, `demo.js`), wallet + KeelBoard calls
  (`wallet.js`), keccak / ABI / question encodings (`abi.js`), formatting (`fmt.js`), page helpers (`ui.js`, `app.css`).
  Every module starts with its export list.
- Pages: `board/`, `q/?id=N`, `leaderboard/`, `practice/`, `agents/`, `ledger/`, `docs/`, `skill.md`, `404.html`.
- Assets: fonts (`assets/fonts`, OFL), vendored three + rapier, favicon set, icons, `og.jpg`, `site.webmanifest`, `robots.txt`.

## Run

    python3 -m http.server 4886 -d web          # then http://127.0.0.1:4886/board/
    # or the real server, which also serves web/:  node server/index.mjs  (port 4878)

Without a reachable `/api` every page falls back to DEMO fixtures (labelled "demo"); `?demo=1` forces it, `?demo=0` resets.
In DEMO the answer flow runs against an in-browser board with a demo wallet, so commit → reveal → crack → claim is testable
without a wallet extension. On dev hosts `?api=http://127.0.0.1:4878` points the pages at another API origin.

## Test

    node --test web/shared/test/abi.test.mjs     # answer encoding, answerHash, commitHash, textHash, model tag vs cast vectors
                                                 # (+ cross-check with server/questions/vectors.json when present)

The same vectors run in the browser at `/shared/test/`.
