#!/usr/bin/env bash
# Ship KEELCRACK to the VPS: ticker leak guard → checks + offline tests → rsync web/ + server/ (+ contracts/abi,
# contracts/deployments) → npm ci (viem) → restart → health check.
#   ./deploy.sh            full deploy
#   ./deploy.sh --web      static files only (no restart)
#   ./deploy.sh --check    leak guard + checks + tests only (nothing leaves this machine)
# One-time setup first: PORT=… ./deploy/provision.sh (check `ssh <your-vps> 'ss -ltnp'` for a free port).
# HOST/DOMAIN default to .deploy-host/.deploy-domain, else <your-vps>/keelcrack.xyz. The lead runs this; agents never deploy.
#
# Ticker leak guard (BRIEF "Identity" + "Work rules"): the secret ticker lives only in the untracked file .ticker (project
# root, one line, never rsynced). While web/token.json "symbol" is null, web/ and server/ (minus node_modules/ and data/)
# are grepped case-insensitively for "$<ticker>" and for the bare ticker as a word; any hit aborts the deploy. Only file
# names are printed, never the value. NO_TICKER_GUARD=1 skips the guard when .ticker is missing (not recommended).
set -euo pipefail
cd "$(dirname "$0")"
HOST=${HOST:-$(cat .deploy-host 2>/dev/null || echo vps)}
DOMAIN=${DOMAIN:-$(cat .deploy-domain 2>/dev/null || echo keelcrack.xyz)}
MODE=full; [[ "${1:-}" == "--web" ]] && MODE=web; [[ "${1:-}" == "--check" ]] && MODE=check

# ---------------------------------------------------------------- ticker leak guard
SYMBOL=$(node -e 'const t=JSON.parse(require("fs").readFileSync("web/token.json","utf8")); process.stdout.write(t.symbol == null ? "" : String(t.symbol))')
if [[ -z "$SYMBOL" ]]; then
  if [[ -f .ticker ]]; then
    TICKER=$(tr -d '[:space:]' < .ticker); TICKER=${TICKER#\$}
    [[ -n "$TICKER" ]] || { echo "✗ .ticker is empty — the leak guard cannot run"; exit 1; }
    [[ "$TICKER" =~ ^[A-Za-z0-9]+$ ]] || { echo "✗ .ticker must be letters/digits only (optionally with a leading \$)"; exit 1; }
    # -w: the ticker as a whole word (this also catches "$TICKER", since $ is not a word character); -F: literal
    HITS=$(grep -rIilwF --exclude-dir=node_modules --exclude-dir=data --exclude-dir=.git --exclude-dir=_shots -e "$TICKER" -e "\$$TICKER" web server 2>/dev/null || true)
    unset TICKER
    if [[ -n "$HITS" ]]; then
      echo "✗ TICKER LEAK: the secret ticker appears in these files while token.json symbol is null (value not shown):"
      echo "$HITS" | sed 's/^/    /'
      echo "  remove it (say \"the token\"), then deploy again. Nothing was shipped."
      exit 1
    fi
    echo "✓ ticker leak guard: web/ and server/ are clean"
  elif [[ "${NO_TICKER_GUARD:-0}" == "1" ]]; then
    echo "! .ticker missing — leak guard SKIPPED (NO_TICKER_GUARD=1)"
  else
    echo "✗ .ticker missing at the project root while token.json symbol is null — cannot run the leak guard (NO_TICKER_GUARD=1 to skip)"; exit 1
  fi
else
  echo "· token.json symbol is set (launched) — leak guard not needed"
fi

# ---------------------------------------------------------------- checks + offline tests
for f in web/shared/*.js; do [[ -f $f ]] && node --check "$f" >/dev/null; done
node -e 'for (const f of ["web/token.json","web/contracts.json"]) JSON.parse(require("fs").readFileSync(f,"utf8"))'
for f in server/*.mjs server/lib/*.mjs server/questions/*.mjs server/questions/templates/*.mjs; do node --check "$f"; done
[[ -d server/node_modules/viem ]] || (cd server && npm ci --no-audit --no-fund --silent)
# offline tests (+ the anvil e2e when anvil is installed), hard-capped at 240 s (macOS has no coreutils `timeout` → perl alarm)
if command -v timeout >/dev/null; then TMO=(timeout 240); elif command -v gtimeout >/dev/null; then TMO=(gtimeout 240); else TMO=(perl -e 'alarm shift; exec @ARGV' 240); fi
(cd server && NO_DOTENV=1 NO_NETWORK=1 QUIET=1 "${TMO[@]}" node --test --test-timeout=120000 'test/*.test.mjs' >/dev/null) || { echo "✗ offline tests fail or hang — not deploying (cd server && npm test)"; exit 1; }
echo "✓ checks + offline tests"
[[ $MODE == check ]] && exit 0

# ---------------------------------------------------------------- web
rsync -az --delete --exclude '.DS_Store' --exclude '_shots/' --exclude 'test/' --exclude '*.test.mjs' --exclude '*.test.js' --exclude '.ticker' web/ "$HOST:/srv/keelcrack/web/"
echo "✓ web synced"
ssh "$HOST" 'if nginx -V 2>&1 | grep -q http_gzip_static_module; then find /srv/keelcrack/web/assets/vendor -type f \( -name "*.js" -o -name "*.mjs" -o -name "*.json" -o -name "*.css" -o -name "*.wasm" \) -exec gzip -9 -kf {} \; 2>/dev/null; echo "✓ vendor pre-compressed for gzip_static"; else echo "· nginx has no gzip_static module, skipping pre-compression"; fi'
[[ $MODE == web ]] && exit 0

# ---------------------------------------------------------------- server
rsync -az --delete --exclude 'node_modules/' --exclude 'data/' --exclude '.env' --exclude '.ticker' --exclude '.DS_Store' --exclude 'test/' --exclude 'questions/fixtures/' server/ "$HOST:/srv/keelcrack/server/"
if [[ -d contracts/deployments ]]; then rsync -az --delete contracts/deployments/ "$HOST:/srv/keelcrack/contracts/deployments/"; fi
if [[ -d contracts/abi ]]; then rsync -az --delete contracts/abi/ "$HOST:/srv/keelcrack/contracts/abi/"; fi
ssh "$HOST" 'set -e; cd /srv/keelcrack/server && npm ci --omit=dev --no-audit --no-fund --silent && chown -R keelcrack:keelcrack /srv/keelcrack/server/data && systemctl restart keelcrack'
echo "✓ server restarted"
# Health = our JSON ({"ok":true,"mode":...}), never just HTTP 200 (a parked domain answers 200 to everything).
PORT_REMOTE=$(ssh "$HOST" "sed -n 's/^Environment=PORT=//p' /etc/systemd/system/keelcrack.service")
for i in $(seq 1 20); do
  LOCAL=$(ssh "$HOST" "curl -fsS http://127.0.0.1:$PORT_REMOTE/api/health" 2>/dev/null || true)
  if [[ $LOCAL == *'"ok":true'* && $LOCAL == *'"mode":"'* ]]; then
    echo "✓ service on VPS port $PORT_REMOTE OK · mode $(sed -n 's/.*"mode":"\([a-z]*\)".*/\1/p' <<<"$LOCAL")"
    PUB=$(curl -fsS --max-time 10 "https://$DOMAIN/api/health" 2>/dev/null || true)
    if [[ $PUB == *'"ok":true'* && $PUB == *'"mode":"'* ]]; then echo "✓ https://$DOMAIN/api/health OK"
    else echo "· https://$DOMAIN not serving KEELCRACK yet (DNS → VPS, then: ./deploy/provision.sh)"; fi
    exit 0
  fi
  sleep 2
done
echo "✗ health check failed — ssh $HOST journalctl -u keelcrack -n 80"; exit 1
