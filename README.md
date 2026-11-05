# Regrade

Every pack gets a second grade. A loss rebate for people who hold our pump.fun coin and open Collector Crypt Pokémon packs. The name, tagline and origin live in [shared/brand.ts](shared/brand.ts).

- **On-site packs.** You pay the pack price plus a protection fee in one USDC payment. Our OPS wallet buys and opens the pack on Collector Crypt and sends you the card. If the card's insured value is below the pack price, the POOL wallet pays `coverage% × (price − value)` straight away.
- **Risk-priced fees.** Each pack's fee and coverage come from its own recent pulls, so the pool expects to collect more than it pays out on every pack, at every tier. See [The economics](#the-economics-read-this).
- **Cash out.** Sell one card or a whole batch back to Collector Crypt with one wallet approval. The sale and the rebate show as one total.
- **Portfolio and share cards.** Every pull with its net result, off-site packs with their claim window counting down, and a public page and share image for each pull.
- **Off-site packs.** You connect the wallet that opened a pack on Collector Crypt. We find your own payment on-chain, check Collector Crypt's record of the card it sent you, and pay a smaller share of the loss. You keep the card. Each pack can be claimed once.
- **Funding.** Creator fees from the coin ($CARDS or SOL) are swapped to USDC for the pool. Each protection fee is split by a fixed percentage: one part goes to the pool, the rest to buyback-and-burn of the coin.

The UI calls this a "rebate", not "insurance" (insurance is a regulated term). Get legal advice before launch.

## Run it locally (practice mode)

```bash
npm install
npm run dev
```

Open http://localhost:5173.

With no `.env`, the app runs in **practice mode**: Solana balances are kept in memory and Collector Crypt is mocked (pull values follow a realistic loss-heavy distribution). You can:
- connect with a practice wallet,
- set your holdings,
- open protected packs,
- simulate off-site pulls,
- watch the pool page.

No keys or money are involved.

```bash
npm test          # 129 tests: math, pricing, payment validation, history parsing, tiers, orders, claims, portfolio, sharing, treasury
npm run typecheck
npm run build     # builds the frontend into dist/, which the API server then serves
```

## Deploy

Production runs on Dokploy as a Docker Compose stack: an Nginx gateway serving the site, the Node server, and PostgreSQL 17. Follow [docs/DOKPLOY.md](docs/DOKPLOY.md); the environment template is [deploy/dokploy.env.example](deploy/dokploy.env.example).

## Before mainnet

1. **Fill in `.env`** from `.env.example`. Use two different wallets:
   - `OPS` receives payments, buys packs, sends cards, and holds the burn bucket.
   - `POOL` holds the USDC reserve, pays rebates, and is the coin's pump.fun creator or fee-sharing shareholder.
2. **`npm run check`** (read-only) checks that:
   - Collector Crypt's `/pack/status` serves packs bought by other wallets (off-site claims depend on this),
   - the coin is SPL Token or Token-2022,
   - creator fees go to POOL, and in which token,
   - both wallets have USDC accounts and SOL.
3. **`npm run calibrate`** (read-only) measures real pull values per pack price from Collector Crypt's payment history and saves `reports/calibration.json`. With risk pricing off, the admin page refuses fee/coverage settings the pool can't afford and shows the fee each tier needs. With it on (the default), each pack is priced live from the pull feed instead.
4. **Set the fee, tiers and caps** on `/admin` (owner = `OWNER_WALLET`).
5. **Smoke test:** set `MAINNET_ENABLED=true`, keep the caps tiny, and open one $25 pack and claim one real off-site pull. Then compare the ledger with the on-chain balances.

## The economics: read this

Big hits don't offset bad pulls, so the pool's cost per pack is `coverage × E[max(0, price − value)]`. That can be large even when packs are fair on average.
- **Example:** if the expected loss is 25% of price, 50% coverage costs 12.5% of each pack.
- A 10% fee split 50/50 only puts 5% in the pool. The other 7.5% must come from creator fees. Otherwise more on-site volume drains the pool *faster*.

That is why fees are risk-priced: `fee = coverage × expected loss × (1 + margin) ÷ pool share`, worked out per pack from its latest pulls (up to 5,000), between a lowest and a highest fee. When the highest fee can't pay for a tier's coverage on a pack, coverage on that pack is cut to what it can pay for, and the pack shows that before anyone buys. A pack with too few pulls keeps the flat fee. Tier exception wallets still pay nothing, so every exception is a cost the pool carries. All of it is set under Pricing in `/admin`.

**Safeguards:**
- **Risk-priced fees:** on-site packs are priced so the pool's share of the fee covers the expected rebate.
- **Reserved rebates:** every on-site order reserves its maximum rebate before it's sold, so on-site rebates are always payable.
- **Capped off-site claims:** off-site claims have per-claim and per-wallet daily and weekly caps. There is no pool-wide daily cap by default (it can be set in Admin), but payouts never exceed the pool's free balance. Off-site coverage also shrinks as the pool falls below its reserve target.
- **Loss-ratio breaker:** it pauses a pack price whose rebates exceed the set multiple of its pool fee income.
- **Holder tier is the lowest balance across the window.** Buying right before a pull, or moving one bag between wallets, doesn't count once we have the wallet's history.
- **Off-site coverage is immediate, with daily limits.** A wallet can file 3 claims and be paid $25 in any 24 hours (both set in Admin; 0 = no limit), and no single off-site rebate is bigger than that daily cap. A coverage delay after first connect can be switched back on in Admin (default 0).

## Layout

| Path | What it does |
|---|---|
| `shared/brand.ts` | The name, tagline and public origin |
| `shared/protection.ts` | Pure math: tiers, quotes, risk pricing, rebates, fee split, pool health, calibration and fee guardrail |
| `server/orders.ts` | On-site state machine: quote → pay → buy → deliver → rebate, plus refunds and review |
| `server/claims.ts` | Off-site scan, verify, claim, and capped first-in-first-out payouts |
| `server/holders.ts` | Balance snapshots; tier = lowest balance over the window |
| `server/pool.ts` | Free balance, reservations, caps, breaker, transparency view |
| `server/pull-feed.ts` | Collector Crypt's public pull feed: pack stats, and the risk data fees are priced from |
| `server/portfolio.ts` | One wallet's pulls and net result |
| `server/share.ts` | The link-preview page behind each share link |
| `server/treasury.ts` | Fee share OPS → POOL, buyback-and-burn, creator-fee collection |
| `server/payment.ts` | Builds and strictly validates the user's USDC payment (Solana Pay reference key) |
| `server/cc/*` | Collector Crypt client, purchase flow and payment validator (from `collector-crypt-starter`), plus parsing of on-chain pack payments |
| `server/chain.ts`, `swap.ts`, `fees.ts` | Persist-then-broadcast transactions, Jupiter swaps and pump.fun fee claims (adapted from grailshot) |
| `server/mock.ts` | Practice-mode Solana and Collector Crypt |
| `web/src` | Vite + React frontend: packs, portfolio, claim, stats, vault, admin |
