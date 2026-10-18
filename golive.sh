#!/usr/bin/env bash
# Launch day: put the token live everywhere, in one go (the lead runs this with the user; agents never deploy).
#   ./golive.sh 0xTOKEN [PONS_TOKEN_URL]
#   env: SYMBOL (default: the one-line .ticker file) · LAUNCH_AT (ISO, default: the value already in token.json, else now) ·
#        DRY=1 (checks only) · FORCE=1 (skip the chain checks) · STRICT=1 (Pons creatorFeeRecipient must be the board) ·
#        RPC (default publicnode)
# Checks on Robinhood Chain (cast): the token exists and its symbol() equals SYMBOL; Pons getLaunchedToken(token) printed
# (creatorFeeRecipient = board → Pons mode: the owner calls board.bind(token) once; else manual fee mode: the founder forwards
# fees by plain transfer → receive() splits 80/20); board.token(); board.poster() vs the keeper key's address (if cast can
# read KEEPER_ADDRESS). Then writes web/token.json "ca" + "symbol" + "launch_at" together (+ pons_token_url),
# web/contracts.json "4663.token", and runs ./deploy.sh (the server restarts and leaves preview mode: board + CA → live).
set -euo pipefail
cd "$(dirname "$0")"
CA=${1:?usage: ./golive.sh 0xTOKEN_ADDRESS [PONS_TOKEN_URL]}
PONS_URL=${2:-}
[[ $CA =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "✗ not a contract address: $CA"; exit 1; }
DOMAIN=${DOMAIN:-$(cat .deploy-domain 2>/dev/null || echo keelcrack.xyz)}
RPC=${RPC:-https://robinhood-rpc.publicnode.com}
PONS_FACTORY=0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e
SYMBOL=${SYMBOL:-$(tr -d '[:space:]' < .ticker 2>/dev/null || true)}; SYMBOL=${SYMBOL#\$}
[[ -n "$SYMBOL" ]] || { echo "✗ no SYMBOL and no .ticker file"; exit 1; }
LAUNCH_AT=${LAUNCH_AT:-$(node -e 'const t=JSON.parse(require("fs").readFileSync("web/token.json","utf8")); process.stdout.write(t.launch_at || "")')}
LAUNCH_AT=${LAUNCH_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}
[[ $LAUNCH_AT =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T ]] || { echo "✗ LAUNCH_AT must be ISO 8601 (e.g. 2026-10-18T15:00:00Z)"; exit 1; }
BOARD=$(node -e 'const c=JSON.parse(require("fs").readFileSync("web/contracts.json","utf8")); process.stdout.write((c["4663"]||{}).board||"")')
lc() { echo "$1" | tr "[:upper:]" "[:lower:]"; }

if [ "${FORCE:-0}" != "1" ]; then
  command -v cast >/dev/null || { echo "✗ cast (Foundry) missing — FORCE=1 to skip the chain checks"; exit 1; }
  echo "→ checking $CA on Robinhood Chain ($RPC)"
  sym=$(cast call "$CA" 'symbol()(string)' --rpc-url "$RPC" 2>/dev/null | tr -d '"' || true)
  dec=$(cast call "$CA" 'decimals()(uint8)' --rpc-url "$RPC" 2>/dev/null || true)
  [ "$(lc "$sym")" = "$(lc "$SYMBOL")" ] || { echo "✗ symbol() on chain does not match the expected ticker (not launched yet? wrong CA? SYMBOL=… or FORCE=1)"; exit 1; }
  echo "   ✓ token exists, symbol matches, decimals $dec"
  if [ -n "$BOARD" ]; then
    echo "   board (contracts.json): $BOARD"
    poster=$(cast call "$BOARD" 'poster()(address)' --rpc-url "$RPC" 2>/dev/null || echo "?")
    echo "   board.poster(): $poster  (the server's KEEPER key must be this address, and SALT_KEY must be set)"
  else echo "   ! web/contracts.json has no board address → the site stays in preview mode"; fi
  rec=$(cast call "$PONS_FACTORY" 'getLaunchedToken(address)' "$CA" --rpc-url "$RPC" 2>/dev/null || true)
  if [ ${#rec} -ge 258 ]; then
    fee="0x$(echo "${rec#0x}" | cut -c 217-256)"
    echo "   Pons creator fee recipient: $fee"
    if [ -n "$BOARD" ] && [ "$(lc "$fee")" = "$(lc "$BOARD")" ]; then echo "   ✓ Pons creator fees go straight to the board (owner: board.bind(token) once; harvest() sweeps them)"
    else
      echo "   ! creatorFeeRecipient is not the board → MANUAL fee mode: the founder forwards Pons creator fees to the board (plain transfer, split 80/20 at once)"
      [ "${STRICT:-0}" = "1" ] && { echo "✗ STRICT=1: stopping"; exit 1; }
    fi
  else echo "   ! not a Pons V2 launch record → manual fee mode"; fi
  if [ -n "$BOARD" ]; then
    bound=$(cast call "$BOARD" 'token()(address)' --rpc-url "$RPC" 2>/dev/null || echo "")
    if [ "$(lc "$bound")" = "$(lc "$CA")" ]; then echo "   ✓ board bound to $CA"; else echo "   · board.token() is '${bound:-<unreadable>}' (bind() is for Pons mode only)"; fi
  fi
fi
[ "${DRY:-0}" = "1" ] && { echo "→ DRY=1: nothing written or deployed"; exit 0; }

node - "$CA" "$SYMBOL" "$LAUNCH_AT" "${dec:-}" "$PONS_URL" <<'JS'
const fs = require('fs')
const [ca, symbol, launchAt, dec, ponsUrl] = process.argv.slice(2)
const t = JSON.parse(fs.readFileSync('web/token.json', 'utf8'))
t.ca = ca; t.symbol = symbol; t.launch_at = launchAt
if (/^\d+$/.test(dec) && Number(dec) !== t.decimals) { console.log(`→ decimals ${t.decimals} → ${dec}`); t.decimals = Number(dec) }
if (ponsUrl) t.pons_token_url = ponsUrl
fs.writeFileSync('web/token.json', JSON.stringify(t, null, 2) + '\n')
const c = JSON.parse(fs.readFileSync('web/contracts.json', 'utf8'))
c['4663'] = { ...(c['4663'] || {}), token: ca }
fs.writeFileSync('web/contracts.json', JSON.stringify(c, null, 2) + '\n')
const buy = t.pons_token_url || `${t.launchpad.replace(/\/$/, '')}/${t.ca}`
console.log(`→ token.json: ca ${t.ca} · symbol set · launch_at ${t.launch_at}\n→ contracts.json: 4663.token\n→ buy = ${buy}`)
JS
./deploy.sh
live=$(curl -s -m 20 "https://$DOMAIN/token.json?$(date +%s)")
echo "$live" | grep -qi "$CA" && echo "   ✓ LIVE token.json has the CA" || { echo "   ✗ live token.json lacks the CA"; exit 1; }
health=$(curl -fsS -m 20 "https://$DOMAIN/api/health" || true)
mode=$(sed -n 's/.*"mode":"\([a-z]*\)".*/\1/p' <<<"$health")
echo "   API mode: $mode $( [ "$mode" = live ] && echo '✓' || echo '(still preview: board missing in contracts.json?)')"
grep -q '"canPost":true' <<<"$health" && echo "   ✓ keeper can post (poster key + SALT_KEY)" || echo "   ! keeper cannot post yet: set KEEPER_KEYSTORE/KEEPER_PASSWORD_FILE (+ SALT_KEY) in /etc/keelcrack.env, restart"
code=$(curl -s -o /dev/null -L -m 20 -w '%{http_code}' -A 'Mozilla/5.0' "https://www.ponsfamily.com/launchpad/$CA")
echo "   Pons page https://www.ponsfamily.com/launchpad/$CA → HTTP $code"
