# deploy/ — KEELCRACK on a VPS

Pattern: rsync → `npm ci` on the server → systemd unit → nginx (static + `/api/` proxy, SSE `/api/live` unbuffered) → certbot.
The lead runs this with the user; agents never deploy.

1. **Pick the port** (`PORT_PLACEHOLDER` in `keelcrack.service` / `nginx.conf` until provision substitutes it):
   `ssh <your-vps> 'ss -ltnp'` and choose a free one (4878 is the local default; it may be taken on the VPS).
2. **DNS:** `keelcrack.xyz` + `www` A records → your VPS IP.
3. **Provision once:** `PORT=… ./deploy/provision.sh` — user `keelcrack`, `/srv/keelcrack/…`, `/etc/keelcrack.env` with a random
   **`SALT_KEY`** (seals the answers + salts of open questions; back it up with the DB, never rotate it while questions are
   open), certbot webroot for keelcrack.xyz + www, unit, site. Re-run any time to apply a changed conf (the port is
   remembered from the running unit). `SKIP_CERT=1` while DNS still points elsewhere (unit only).
4. **Poster key (live mode):** copy the Foundry keystore of the board's `poster` + its password file to `/etc/keelcrack/`
   (root:keelcrack 640) and append to `/etc/keelcrack.env`: `KEEPER_KEYSTORE=/etc/keelcrack/poster.json`
   `KEEPER_PASSWORD_FILE=/etc/keelcrack/poster.password`. Without a key (or without SALT_KEY) the live server is read-only
   and the hourly question still goes to practice. `KEEPER_DRY_RUN=1` simulates every tx. Then `systemctl restart keelcrack`.
   The poster needs a little ETH for gas (post + drip + settle ≈ 3 tx/hour at ~0.01 gwei).
5. **Deploy:** `./deploy.sh` — ticker leak guard (reads `.ticker` itself, prints only file names) + `node --check` + offline
   tests first; `--web` static only; `--check` guard + tests only (nothing leaves the machine). Ships `web/` (without tests),
   `server/` (without `node_modules/`, `data/`, `.env`, `test/`, `questions/fixtures/`), `contracts/abi` + `contracts/deployments`.
6. **Launch:** deploy KeelBoard, fill `web/contracts.json` `4663.board` (+ `4663.deployBlock` = the **L2** block of the deploy
   receipt), then `./golive.sh 0xTOKEN [PONS_TOKEN_URL]` (`SYMBOL` defaults to `.ticker`, `LAUNCH_AT` to token.json's value,
   `DRY=1` checks only) → writes token.json `ca` + `symbol` + `launch_at` and contracts.json `4663.token`, then `./deploy.sh`.
   With board + CA the server leaves preview mode on that restart; the first question is posted at the next hh:00:45.
   Practice questions generated during preview stay in the pool (same database).

Files: `nginx.conf` (static site, `/api/` proxy GET, `/api/practice/` GET + POST 2 KB, SSE `/api/live`, caching tiers,
`skill.md` as text/markdown, `gzip_static`), `keelcrack-headers.conf` (security headers, included per location),
`keelcrack-proxy.conf`, `keelcrack.service`, `provision.sh`. Logs: `ssh <your-vps> journalctl -u keelcrack -f`.
Data: `/srv/keelcrack/server/data/keelcrack.db` (back it up together with SALT_KEY). Health: `/api/health`
(`mode`, `keeper.canPost`, `keeper.lastError`, `rc`, `boardIndexer`, `rpc`).

The VPS resolves `rpc.mainnet.chain.robinhood.com` normally; `RPC_PIN=auto` (default) switches to the pinned Cloudflare IPs
only if DNS/TLS fails. `RPC_URLS` / `LOG_RPC_URLS` / `TAIL_RPC_URLS` override the mirror lists.
