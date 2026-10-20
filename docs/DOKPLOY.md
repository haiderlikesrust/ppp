# Deploy Pull Protection on Dokploy

Use a **Docker Compose** service sourced from this Git repository. The stack runs three containers:

| Service | What it does | Networks |
|---|---|---|
| `gateway` | Nginx. Serves the built site and proxies `/api` to the server. The only public container. | `dokploy-network`, `app` |
| `server` | Node API and coordinator: orders, claims, holder snapshots, fee routing and burns. Holds the wallet keys. | `app`, `database` |
| `postgres` | PostgreSQL 17 with the `pull-protection-postgres` volume. | `database` (internal) |

Dokploy's Traefik terminates HTTPS in front of the gateway. The server and database publish no host ports.

## Set up

1. Push the project to your repository. In Dokploy create a **Docker Compose** service (not Docker Stack/Swarm) from it, branch `main`, and set **Compose Path** to `./compose.dokploy.yaml`. If the repository contains a `pokinsurance/` subfolder, use `pokinsurance/compose.dokploy.yaml` instead.
2. In **Environment**, paste [`deploy/dokploy.env.example`](../deploy/dokploy.env.example) and fill it in:
   - `APP_ORIGIN`: your exact public HTTPS origin, e.g. `https://app.example.com`, with no trailing slash.
   - `POSTGRES_PASSWORD`: long and alphanumeric only (`openssl rand -hex 32`). Required even before launch.
   - Leave `MAINNET_ENABLED=false` for the first deploy.
3. Add the wallet keys here when you are ready: `OPS_PRIVATE_KEY` and `POOL_PRIVATE_KEY`, two different wallets, as base58 secret keys or quoted JSON arrays of 64 bytes. They are runtime variables of the **server** container only. No keypair file, build argument or public variable is used.
4. In **Domains**, add your host, choose service **gateway**, container port **80**, path **/**, and enable **HTTPS / Let's Encrypt**. Point the domain's DNS at the VPS.
5. Deploy. In Preview Compose, confirm the gateway has both `app` and `dokploy-network`. Wait for the postgres, server and gateway health checks before opening the domain.

Compose maps each variable explicitly, so the frontend never sees the environment. `.dockerignore` keeps local `.env` files, keys, databases, the `video/` project and test files out of the images.

## Verify the deployment

- Open `/api/health`: expect `ok: true`, `database: "postgres"`, `mode: "read-only"` and `spendingEnabled: false` before launch. A database failure returns HTTP 503.
- Open `/`, `/claim`, `/pool`, `/docs` and `/admin`; check that the fonts load.
- Connect a wallet and sign in. Under HTTPS the `pp_session` cookie is Secure and HttpOnly. Sign in with `OWNER_WALLET` to open `/admin`; any other wallet gets "Owner access required".
- `/admin` → **Launch readiness** lists what is still missing.

Production never runs practice mode. Without `SOLANA_RPC_URL` the site runs **read-only**: pages and sign-in work, nothing is bought or paid, and the practice endpoints do not exist.

## Go live

1. Set `MEMECOIN_MINT`, `OWNER_WALLET`, `SOLANA_RPC_URL` (a paid RPC), `JUPITER_API_KEY` and both wallet keys, and redeploy.
2. Fund the wallets: about 0.3 SOL in POOL (and a little in OPS to start), a USDC token account in both, and starting USDC in POOL. After that POOL keeps OPS topped up with SOL automatically, and buys more SOL with a capped amount of pool USDC when it runs low itself (see **Network fees** in `/admin`). Make POOL the coin's pump.fun creator-fee recipient (or a fee-sharing shareholder).
3. Open the server container's terminal in Dokploy and run the read-only checks:
   ```sh
   npm run check
   npm run calibrate
   ```
   `check` confirms Collector Crypt's pack records, the mint's token program, the creator-fee route and both wallets. `calibrate` measures real pull values and saves `reports/calibration.json` on the `pull-protection-reports` volume, so it survives redeploys. After that, `/admin` refuses fee and coverage settings the pool can't afford.
4. Set the fee, tiers and caps in `/admin`.
5. Set `MAINNET_ENABLED=true` and redeploy. Start with tiny caps: open one $25 protected pack and claim one real off-site pull, then compare the Pool page with the wallets on Solscan.

To stop spending at any time, switch on **Pause all spending** in `/admin`. It takes effect immediately and survives redeploys. Open orders still settle or refund.

## Redeployments and storage

For a code update, open the existing Compose service, keep branch `main` and Compose Path `./compose.dokploy.yaml`, and click **Deploy**. Follow the deployment until the build succeeds and the services are healthy. Built JS and CSS have fingerprinted names and are cached for a long time; `index.html` is always revalidated, so visitors get the new version straight away.

Run **one server container**. It owns the payout jobs, and a PostgreSQL advisory lock refuses a second coordinator. Do not enable replicas, rolling overlap or blue/green deploys. Pausing in `/admin` before a planned redeploy is good practice; the server finishes or resumes every in-flight transaction from the database after a restart, so nothing is paid twice.

The `pull-protection-postgres` volume holds wallets, sessions, holder snapshots, orders, claims, the ledger, settings and every recoverable transaction. Keep the same Dokploy project and Compose identity across redeployments, never remove the volume when updating, and do not change `POSTGRES_PASSWORD` on an existing volume without also changing the database role's password. Set up backups (for example scheduled `pg_dump`) before launch and test a restore.

Containers restart after crashes. An unhealthy status alone does not restart a Compose container: read its logs and fix the failed dependency. The gateway re-resolves Docker DNS every 10 seconds, so a replaced server container needs no manual change.

The server trusts exactly two internal proxy hops (Traefik and Nginx) to see real client IPs for rate limiting. Keep port 4100 private. If you add a CDN in front of Traefik, configure Traefik's trusted forwarded-header sources; do not trust forwarding headers blanket-wide.

## Local verification

```sh
npm ci
npm test
npm run typecheck
npm run build
```

Full production stack on a Linux Docker engine (Docker Desktop works):

```sh
docker network create dokploy-network
APP_ORIGIN=http://127.0.0.1:8080 POSTGRES_PASSWORD=localTestOnly docker compose -p pull-protection-ci -f compose.dokploy.yaml -f compose.ci.yaml up -d --build --wait
SMOKE_TEST_FIXTURE=true APP_ORIGIN=http://127.0.0.1:8080 npm run smoke:dokploy
docker compose -p pull-protection-ci -f compose.dokploy.yaml -f compose.ci.yaml down -v
```

`compose.ci.yaml` only publishes the gateway on `127.0.0.1:8080` for testing. GitHub Actions (`.github/workflows/verify.yml`) runs the same steps on every push: tests, typecheck, build, then the full three-container stack against a fresh disposable database with mainnet off, checked through Nginx by `scripts/smoke-dokploy.mjs`. Wait for **Verify app and Dokploy stack** to pass before your first VPS deployment.

Reference: [Dokploy Docker Compose](https://docs.dokploy.com/docs/core/docker-compose), [Dokploy domains](https://docs.dokploy.com/docs/core/docker-compose/domains).
