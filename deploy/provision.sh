#!/usr/bin/env bash
# One-time VPS setup for KEELCRACK (idempotent; re-run any time to apply a changed nginx.conf / headers / unit — the port is
# remembered from the running unit): user + dirs, /etc/keelcrack.env (+ a random SALT_KEY once), certbot (webroot),
# systemd unit, nginx site (with the unbuffered /api/live).
# The port is chosen HERE: PORT=… ./deploy/provision.sh — first check what is free on the VPS: `ssh <your-vps> 'ss -ltnp'`.
# The script refuses a taken port unless it is this service's own.
# Env: HOST (ssh alias, default .deploy-host or vps), DOMAIN (default .deploy-domain or keelcrack.xyz), PORT (required
#      on the first run), CERTBOT_EMAIL (optional), SKIP_CERT=1 (DNS not pointed yet: unit only, no nginx/cert).
# The lead runs this with the user; agents never deploy.
set -euo pipefail
cd "$(dirname "$0")/.."
HOST=${HOST:-$(cat .deploy-host 2>/dev/null || echo vps)}
DOMAIN=${DOMAIN:-$(cat .deploy-domain 2>/dev/null || echo keelcrack.xyz)}
PORT=${PORT:-}

scp -q deploy/keelcrack.service "$HOST:/tmp/keelcrack.service.tpl"
scp -q deploy/nginx.conf "$HOST:/tmp/keelcrack.nginx.tpl"
scp -q deploy/keelcrack-proxy.conf "$HOST:/etc/nginx/keelcrack-proxy.conf"
scp -q deploy/keelcrack-headers.conf "$HOST:/etc/nginx/keelcrack-headers.conf"

ssh "$HOST" PORT="$PORT" DOMAIN="$DOMAIN" CERTBOT_EMAIL="${CERTBOT_EMAIL:-}" SKIP_CERT="${SKIP_CERT:-0}" bash -s <<'REMOTE'
set -euo pipefail
command -v node >/dev/null || { echo "✗ node missing on the VPS"; exit 1; }
node -e 'require("node:sqlite")' 2>/dev/null || { echo "✗ this node has no node:sqlite (need ≥ 22.13)"; exit 1; }
command -v npm >/dev/null || { echo "✗ npm missing"; exit 1; }
command -v nginx >/dev/null || { echo "✗ nginx missing"; exit 1; }

id keelcrack >/dev/null 2>&1 || useradd --system --home /srv/keelcrack --shell /usr/sbin/nologin keelcrack
mkdir -p /srv/keelcrack/web /srv/keelcrack/server/data /srv/keelcrack/contracts/deployments /srv/keelcrack/contracts/abi /etc/keelcrack /var/www/html/.well-known/acme-challenge
chown -R keelcrack:keelcrack /srv/keelcrack/server/data
chown root:keelcrack /etc/keelcrack; chmod 750 /etc/keelcrack
if [ ! -f /etc/keelcrack.env ]; then
  umask 077
  # The poster key is NOT set here. To let the keeper post: copy the Foundry keystore + password file to /etc/keelcrack/
  # (root:keelcrack 640) and add  KEEPER_KEYSTORE=/etc/keelcrack/poster.json  KEEPER_PASSWORD_FILE=/etc/keelcrack/poster.password
  # (or KEEPER_PRIVATE_KEY=0x…). Without a key the live server is read-only (the hourly question still goes to practice).
  # RPC: the VPS resolves rpc.mainnet.chain.robinhood.com normally; RPC_PIN=auto (default) pins the IP only if DNS fails.
  printf '# KEELCRACK settings (root:keelcrack 640). Never commit.\n' > /etc/keelcrack.env
  chown root:keelcrack /etc/keelcrack.env; chmod 640 /etc/keelcrack.env
fi
# SALT_KEY seals the answers + salts of open questions at rest. Generated once; NEVER rotate it while questions are open
# (their salts could not be opened → no settle; the contract's abandon() returns everything after 7 days).
if ! grep -q '^SALT_KEY=' /etc/keelcrack.env; then
  printf 'SALT_KEY=%s\n' "$(openssl rand -hex 32)" >> /etc/keelcrack.env
  echo "✓ SALT_KEY generated in /etc/keelcrack.env (back it up with the database)"
fi

# ---- port: ours if the unit already runs on it, else $PORT must be given and free ----
taken() { ss -ltnH "( sport = :$1 )" | grep -q .; }
CUR=$(sed -n 's/^Environment=PORT=//p' /etc/systemd/system/keelcrack.service 2>/dev/null || true)
if [ -n "$CUR" ] && [ "$CUR" != "PORT_PLACEHOLDER" ] && systemctl is-active --quiet keelcrack; then PORT=$CUR
elif [ -z "$PORT" ]; then echo "✗ PORT not set — pick a free one: ss -ltnp (below), then PORT=… ./deploy/provision.sh"; ss -ltnp | head -40; exit 1
elif taken "$PORT"; then echo "✗ port $PORT is taken on the VPS — pick another: PORT=… ./deploy/provision.sh"; ss -ltnp | head -40; exit 1
fi
echo "→ port $PORT · domain $DOMAIN"

if [ "$SKIP_CERT" = "1" ] && [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  sed "s/PORT_PLACEHOLDER/$PORT/g" /tmp/keelcrack.service.tpl > /etc/systemd/system/keelcrack.service
  systemctl daemon-reload; systemctl enable keelcrack >/dev/null 2>&1 || true
  rm -f /tmp/keelcrack.service.tpl /tmp/keelcrack.nginx.tpl
  echo "✓ unit installed on port $PORT (no nginx/cert yet: point DNS, then re-run without SKIP_CERT)"
  exit 0
fi

# ---- certificate (webroot) ----
if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  command -v certbot >/dev/null || { echo "✗ certbot missing (apt install certbot)"; exit 1; }
  cat > /etc/nginx/sites-available/keelcrack <<EOF2
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN www.$DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 404; }
}
EOF2
  ln -sf /etc/nginx/sites-available/keelcrack /etc/nginx/sites-enabled/keelcrack
  nginx -t && systemctl reload nginx
  if [ -n "$CERTBOT_EMAIL" ]; then EMAIL=(-m "$CERTBOT_EMAIL"); else EMAIL=(--register-unsafely-without-email); fi
  certbot certonly --webroot -w /var/www/html -d "$DOMAIN" -d "www.$DOMAIN" --non-interactive --agree-tos "${EMAIL[@]}"
  echo "✓ certificate for $DOMAIN + www"
fi

# ---- systemd unit ----
sed "s/PORT_PLACEHOLDER/$PORT/g" /tmp/keelcrack.service.tpl > /etc/systemd/system/keelcrack.service
systemctl daemon-reload
systemctl enable keelcrack >/dev/null 2>&1 || true

# ---- final nginx site ----
SITE=/etc/nginx/sites-available/keelcrack
[ -f "$SITE" ] && cp -f "$SITE" "$SITE.bak"
sed -e "s/PORT_PLACEHOLDER/$PORT/g" -e "s/keelcrack\.xyz/$DOMAIN/g" /tmp/keelcrack.nginx.tpl > "$SITE"
ln -sf "$SITE" /etc/nginx/sites-enabled/keelcrack
if nginx -t; then systemctl reload nginx; echo "✓ nginx reloaded with the final keelcrack site"
else
  echo "✗ nginx -t failed — restoring the previous site"; [ -f "$SITE.bak" ] && mv -f "$SITE.bak" "$SITE"; nginx -t && systemctl reload nginx; exit 1
fi
rm -f /tmp/keelcrack.service.tpl /tmp/keelcrack.nginx.tpl
REMOTE
echo "→ provisioned. Next: ./deploy.sh"
