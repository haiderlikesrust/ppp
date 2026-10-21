import { randomUUID } from 'node:crypto';
import { atomic, audit, record, type Database } from './db';
import { Jobs, PendingOperation, ReviewRequired } from './jobs';
import { redact } from './redact';
import type { BuiltPayment, PackProvider, Solana } from './ports';
import type { Holders } from './holders';
import type { Pool } from './pool';
import type { Gas } from './gas';
import type { SettingsStore } from './settings';
import { ApiError } from './cc/client';
import { quote, rebateMicros, splitFee, usd, micros } from '../shared/protection';
import type { Card, OrderStatus, OrderView, Quote } from '../shared/types';
import { packCode, packDef } from '../shared/packs';
import { checkSaleTransaction } from './sale';

/** Runs a critical section; the app passes the coordinator's Serial queue, tests run it directly. */
export type Runner = <T>(fn: () => Promise<T>) => Promise<T>;
const direct: Runner = fn => fn();
const PAYMENT_WINDOW_MS = 120_000;
// Transient failures back off up to 5 minutes, so ~40 attempts ride out a couple of hours of
// provider or RPC trouble before an order is handed to the owner for review.
/** Enough SOL for the payment's fee while the wallet stays rent-exempt. */
const BUYER_MIN_LAMPORTS = 1_000_000n;
/** Order steps where the OPS wallet signs a transaction and so pays network fees. */
const OPS_SIGNS: OrderStatus[] = ['paid', 'buying', 'delivering', 'refunding'];
const MAX_FAILURES = 40;
/** Consecutive Collector Crypt failures (about 4 minutes with backoff) before an order that never paid it is refunded. */
const PROVIDER_FAILURES_BEFORE_REFUND = 7;
const backoffMs = (failures: number) => Math.min(300_000, 2_000 * 2 ** Math.min(failures, 8));
/** "45s", "12m" or "2h 5m". */
const wait = (ms: number) => { const s = Math.max(1, Math.ceil(ms / 1000)), m = Math.ceil(s / 60); return s < 60 ? `${s}s` : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`; };

/** Network trouble or a provider 5xx/429: worth retrying, not worth a human's attention yet. */
export function isTransient(error: unknown) {
  const e = error as Error & { status?: number };
  if (e instanceof ApiError) return e.status >= 500 || e.status === 429;
  return ['AbortError', 'TimeoutError'].includes(e?.name) || /fetch failed|network|ECONN|ETIMEDOUT|EAI_AGAIN|socket hang up|timed out|already being processed|Order locked|\b429\b|too many requests|rate.?limit/i.test(e?.message ?? '');
}
const OPEN: OrderStatus[] = ['awaiting_payment', 'paying', 'paid', 'buying', 'delivering', 'settling', 'refunding'];

type OrderData = {
  payment: BuiltPayment; quote: Quote; poolShareBps: number; quotedAt: number; expiresAt: number;
  /** Collector Crypt machine code. Orders from before codes existed are Pokémon packs (see packCode). */
  packCode?: string;
  /** Quick sell: the offer the buyer is signing, then the completed sale. */
  saleOffer?: { amountMicros: number; at: number };
  sale?: { amountMicros: number; signature: string; at: number };
  attempt?: number; purchaseId?: string; memo?: string; packSignature?: string; card?: Card; valueMicros?: number;
  nftSignature?: string; settleCoverageBps?: number; rebateMicros?: number; rebateSignature?: string | null;
  poolShareMicros?: number; refundSignature?: string; refundReason?: string; message?: string | null; failures?: number; retryAt?: number; cancelled?: boolean;
  /** Pack-purchase attempts proven not to have moved USDC (expired or failed on-chain). */
  unpaidAttempts?: number[];
  /** When the order started waiting in its current status (gas, pool USDC), so long waits show up for the owner. */
  waiting?: { status: OrderStatus; since: number };
  /** The status an order had when it was handed to review, so Retry resumes exactly there. */
  reviewFrom?: OrderStatus;
};
type Row = { id: string; wallet: string; status: OrderStatus; price_micros: string; fee_micros: string; coverage_bps: number; max_rebate_micros: string; payment_signature: string | null; data: OrderData; created_at: string; error: string | null };

/**
 * On-site protected packs. The user pays price + fee in one USDC transfer to OPS;
 * OPS buys and opens the pack on Collector Crypt, sends the card to the user, and
 * POOL pays the rebate immediately when the card is worth less than the price.
 */
export class Orders {
  constructor(readonly db: Database, readonly jobs: Jobs, readonly solana: Solana, readonly packs: PackProvider, readonly holders: Holders, readonly pool: Pool, readonly settings: SettingsStore, readonly gas: Gas) {}

  /** A personalized quote for every available pack. */
  async quotes(wallet: string | null) {
    const machines = await this.packs.machines();
    const tier = wallet ? (await this.holders.onsiteTier(wallet, { fresh: false })).tier : null;
    const free = await this.pool.free();
    return machines.map(m => {
      const q = quote(m.priceUsd, tier, this.settings.current, free, m.code);
      // Before mainnet is enabled nothing can be bought, so nothing is offered as protected.
      return { code: m.code, priceUsd: m.priceUsd, quote: this.solana.canSpend ? q : { ...q, protected: false, coverageBps: 0, maxRebateMicros: 0, reason: 'Protected packs open at launch.' } };
    });
  }

  /**
   * When this wallet can open its next pack, or null if it can now. The wait runs from its last paid pack
   * (refunded ones don't count): its own cooldown from Admin, else the default, which tier-exception wallets skip.
   */
  async nextPackAt(wallet: string, now = Date.now()) {
    const s = this.settings.current, own = s.cooldown.wallets.find(c => c.wallet === wallet);
    const minutes = own ? own.minutes : s.walletTiers.some(e => e.wallet === wallet) ? 0 : s.cooldown.minutes;
    if (minutes <= 0) return null;
    const last = (await this.db.query<{ at: string | null }>(
      "SELECT MAX(created_at)::text AS at FROM orders WHERE wallet=$1 AND payment_signature IS NOT NULL AND status NOT IN ('refunded','expired')", [wallet])).rows[0]?.at;
    const at = last ? Number(last) + minutes * 60_000 : 0;
    return at > now ? at : null;
  }

  /**
   * Provider and RPC calls (pack catalog, holder snapshot, blockhash) happen first; only the DB
   * check-and-insert runs inside `run` (the coordinator's Serial queue in production), so a slow
   * call never holds up other buyers. No pool money is reserved until the buyer actually pays.
   */
  async create(wallet: string, code: string, run: Runner = direct) {
    const def = packDef(code);
    if (!def) throw new Error('That pack is not available here.');
    const priceUsd = def.priceUsd;
    const s = this.settings.current;
    if (!this.solana.canSpend) throw new Error('Protected packs open at launch. Nothing was charged.');
    if (s.paused) throw new Error('Protected packs are paused right now.');
    // OPS signs every step after payment; never take money it could not act on right away.
    if (!(await this.gas.opsReady())) throw Object.assign(new Error('Pack opening is paused for a minute while network fees are topped up. Nothing was charged.'), { statusCode: 503 });
    if (!(await this.packs.machines()).some(m => m.code === code)) throw new Error('That pack is not available right now.');
    const next = await this.nextPackAt(wallet);
    if (next) throw Object.assign(new Error(`This wallet can open its next pack in ${wait(next - Date.now())}. Nothing was charged.`), { statusCode: 429 });
    const check = await this.holders.onsiteTier(wallet);
    const first = quote(priceUsd, check.tier, s, await this.pool.free(), code);
    if (!first.protected) throw new Error(first.reason ?? check.reason ?? 'This pack cannot be protected right now.');
    if (!(await this.gas.opsUsdcReady())) throw Object.assign(new Error('Payments are being set up. Please try again in a minute. Nothing was charged.'), { statusCode: 503 });
    // Catch an unpayable order here, with a clear reason, instead of as a failed simulation after signing.
    const funds = await this.solana.walletFunds(wallet), dollars = (m: bigint | number) => `$${usd(Number(m)).toFixed(2)}`;
    if (!funds.usdcAccount || funds.usdcMicros < BigInt(first.totalMicros)) throw new Error(`This pack costs ${dollars(first.totalMicros)} in USDC and this wallet has ${dollars(funds.usdcMicros)}. Add USDC to this wallet and try again.`);
    if (funds.lamports < BUYER_MIN_LAMPORTS) throw new Error('This wallet needs a little SOL (0.002 is plenty) to pay the Solana network fee.');
    const id = randomUUID();
    const payment = await this.solana.buildUserPayment(wallet, first.totalMicros, `pp-${id}`);
    return run(async () => {
      // A cancelled unpaid order no longer blocks a new one; it still settles if a payment lands before it expires.
      const waiting = (await this.db.query<Row>("SELECT * FROM orders WHERE wallet=$1 AND status IN ('awaiting_payment','paying') AND NOT COALESCE((data->>'cancelled')::boolean, FALSE)", [wallet])).rows[0];
      if (waiting) throw Object.assign(new Error('Finish or let your current order expire before starting another.'), { statusCode: 409 });
      const q = quote(priceUsd, check.tier, this.settings.current, await this.pool.free(), code);
      if (!q.protected) throw new Error(q.reason ?? 'This pack cannot be protected right now.');
      if (q.totalMicros !== first.totalMicros || q.coverageBps !== first.coverageBps) throw new Error('The price or coverage just changed. Please try again.');
      const now = Date.now();
      const data: OrderData = { packCode: code, payment, quote: q, poolShareBps: this.settings.current.poolShareBps, quotedAt: now, expiresAt: now + PAYMENT_WINDOW_MS };
      await this.db.query('INSERT INTO orders(id,wallet,status,price_micros,fee_micros,coverage_bps,max_rebate_micros,data,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)',
        [id, wallet, 'awaiting_payment', q.priceMicros, q.feeMicros, q.coverageBps, q.maxRebateMicros, JSON.stringify(data), now]);
      return { order: await this.get(id, wallet), transaction: payment.transaction };
    });
  }

  /**
   * Reserves the order's largest possible rebate (refused if the pool can't cover it, before any
   * money moves), then validates and broadcasts the buyer's signed payment outside `run`.
   */
  async pay(wallet: string, id: string, signed: string, run: Runner = direct) {
    const row = await run(async () => {
      const row = await this.row(id);
      if (!row || row.wallet !== wallet) throw Object.assign(new Error('Order not found.'), { statusCode: 404 });
      if (row.status !== 'awaiting_payment') throw new Error('This order is no longer waiting for payment.');
      if (Date.now() > row.data.expiresAt) throw new Error('This order expired. Start a new one.');
      if (!this.solana.canSpend) throw new Error('Protected packs open at launch. Nothing was charged.');
      if (signed === 'practice' && this.solana.live) throw new Error('Sign the payment with your wallet.');
      await this.pool.reserve(id, Number(row.max_rebate_micros));
      return row;
    });
    let signature: string;
    // A failed submit may still have been broadcast, so the reservation stays: expiry releases it if no payment lands.
    signature = await this.solana.submitUserPayment(row.data.payment.intent, signed);
    await run(() => this.db.query("UPDATE orders SET status='paying',payment_signature=$2,updated_at=$3 WHERE id=$1 AND status='awaiting_payment'", [id, signature, Date.now()]));
    return this.get(id, wallet);
  }

  /**
   * The buyer backed out before paying (for example rejected it in their wallet). The order keeps
   * watching for a payment until its blockhash expires, so nothing paid can be lost, but it no longer
   * blocks a new order.
   */
  async cancel(wallet: string, id: string) {
    const row = await this.row(id);
    if (!row || row.wallet !== wallet) throw Object.assign(new Error('Order not found.'), { statusCode: 404 });
    if (row.status !== 'awaiting_payment' || row.payment_signature) return view(row);
    await this.save(row, row.status, { cancelled: true, message: 'Cancelled. Nothing was charged.' });
    return view(row);
  }

  async row(id: string) { return (await this.db.query<Row>('SELECT * FROM orders WHERE id=$1', [id])).rows[0] ?? null; }
  async get(id: string, wallet?: string) {
    const row = await this.row(id);
    if (!row || (wallet && row.wallet !== wallet)) throw Object.assign(new Error('Order not found.'), { statusCode: 404 });
    return view(row);
  }
  async list(wallet: string, limit = 50) { return (await this.db.query<Row>('SELECT * FROM orders WHERE wallet=$1 AND status<>$2 ORDER BY created_at DESC LIMIT $3', [wallet, 'expired', limit])).rows.map(view); }
  async open() { return (await this.db.query<Row>(`SELECT * FROM orders WHERE status = ANY($1) ORDER BY created_at`, [OPEN])).rows; }

  /** Advances every open order by at most one step. Call from the coordinator's Serial queue. */
  async step() {
    let changed = 0;
    for (const row of await this.open()) {
      const before = row.status;
      if ((row.data.retryAt ?? 0) > Date.now()) continue;
      try { await this.advance(row); }
      catch (error) {
        const e = error as Error, failures = (row.data.failures ?? 0) + 1;
        if (e instanceof PendingOperation) await this.save(row, row.status, { message: e.message, failures: 0, retryAt: 0, waiting: row.data.waiting?.status === row.status ? row.data.waiting : { status: row.status, since: Date.now() } });
        else if (e instanceof ReviewRequired || failures >= MAX_FAILURES) { await this.save(row, 'review', { message: e.message, retryAt: 0, reviewFrom: before }, e.message); await audit(this.db, 'order-review', { id: row.id, status: before, error: e.message }); }
        else {
          const message = e instanceof ApiError ? 'Collector Crypt is not responding right now. Retrying automatically; your payment is safe.' : 'Temporarily delayed. Retrying automatically; your payment is safe.';
          await this.save(row, row.status, { message, failures, retryAt: Date.now() + backoffMs(failures) }, e.message);
          // The owner sees why in the audit log: on the first failure and whenever the reason changes.
          if (failures === 1 || e.message !== row.error) await audit(this.db, 'order-delayed', { id: row.id, status: before, failures, error: redact(e.message) });
        }
      }
      if ((await this.row(row.id))?.status !== before) changed++;
    }
    return changed;
  }

  private async save(row: Row, status: OrderStatus, patch: Partial<OrderData>, error: string | null = null) {
    row.data = { ...row.data, ...patch }; row.status = status;
    await this.db.query('UPDATE orders SET status=$2,data=$3,updated_at=$4,error=$5,payment_signature=COALESCE(payment_signature,$6) WHERE id=$1', [row.id, status, JSON.stringify(row.data), Date.now(), error, row.payment_signature]);
  }

  private async advance(row: Row) {
    const d = row.data, price = Number(row.price_micros), fee = Number(row.fee_micros), s = this.settings.current;
    // Waits for the gas top-up instead of failing (and landing in review) on an empty OPS wallet.
    if (OPS_SIGNS.includes(row.status) && !(await this.gas.opsReady())) throw new PendingOperation('Topping up network fees. Your order continues automatically.');
    switch (row.status) {
      case 'awaiting_payment':
      case 'paying': {
        const state = await this.solana.paymentStatus(d.payment, row.payment_signature);
        if (state.state === 'pending') return;
        if (state.state !== 'confirmed') {
          await this.pool.release(row.id);
          return this.save(row, 'expired', { message: state.state === 'failed' ? 'The payment failed on-chain. Nothing was charged.' : 'The payment window closed. Nothing was charged.' });
        }
        row.payment_signature = state.signature;
        // pay() normally reserved already; a payment the wallet broadcast on its own (or after a failed
        // submit) reserves now if the pool still can. If it can't, the rebate waits for funds at settlement.
        await this.pool.reserve(row.id, Number(row.max_rebate_micros)).catch(() => {});
        await record(this.db, { id: `order:${row.id}:sale`, bucket: 'ops', kind: 'sale', micros: price + fee, signature: state.signature, ref: row.id });
        return this.save(row, 'paid', { message: 'Payment confirmed. Buying your pack.', failures: 0 });
      }
      case 'paid':
      case 'buying': {
        const attempt = d.attempt ?? 0, purchaseId = `${row.id}-${attempt}`;
        // Record the attempt before any money can move, so review and refund always know to check it.
        if (d.purchaseId !== purchaseId) await this.save(row, row.status, { purchaseId });
        let result;
        try { result = await this.packs.buy(purchaseId, packCode(d.packCode, usd(price)), usd(price)); }
        catch (error) {
          const message = (error as Error).message, signed = !!(await this.jobs.get(`cc:${purchaseId}`))?.data?.signature;
          // Nothing was signed for this attempt, so retrying or refunding cannot double-pay.
          if (!signed && /Unsigned order expired/.test(message) && attempt < 3) return this.save(row, 'buying', { attempt: attempt + 1, message: 'Refreshing the pack order.' });
          // Our pack payment provably never moved USDC: try a fresh purchase, then refund.
          if (/no USDC moved/.test(message)) {
            const unpaidAttempts = [...(d.unpaidAttempts ?? []), attempt];
            return attempt < 3
              ? this.save(row, 'buying', { attempt: attempt + 1, unpaidAttempts, message: 'Retrying the pack purchase.' })
              : this.save(row, 'refunding', { unpaidAttempts, refundReason: 'The pack could not be bought.' });
          }
          if (!signed && /not in the public catalog|not available|sold out/i.test(message)) return this.save(row, 'refunding', { refundReason: /not available/i.test(message) ? 'Collector Crypt paused this pack, so it could not be bought.' : 'The pack sold out before it could be bought.' });
          if (/refunded/i.test(message)) return this.save(row, 'refunding', { refundReason: 'Collector Crypt refunded the pack.' });
          // A provider or RPC hiccup retries with backoff; anything else needs a human.
          // Collector Crypt keeps failing and none of our USDC reached it: refund now instead of making the buyer wait hours.
          if (isTransient(error) && (d.failures ?? 0) + 1 >= PROVIDER_FAILURES_BEFORE_REFUND && (await this.sentToProvider(row)) === null) {
            await audit(this.db, 'order-provider-refund', { id: row.id, failures: (d.failures ?? 0) + 1, error: redact(message) });
            return this.save(row, 'refunding', { refundReason: 'Collector Crypt could not sell this pack right now.', failures: 0, retryAt: 0 });
          }
          if (isTransient(error)) throw error;
          throw new ReviewRequired(message);
        }
        if (result.state === 'pending') return this.save(row, 'buying', { purchaseId, message: 'Collector Crypt is opening your pack.', failures: 0 });
        const value = result.card.insuredValueUsd;
        // No insured value yet: deliver the card anyway and read the value again when settling.
        await atomic(this.db, async () => {
          await this.db.query('INSERT INTO pulls(memo,source,wallet,order_id,price_micros,value_micros,nft_mint,pulled_at,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(memo) DO NOTHING',
            [result.memo, 'onsite', row.wallet, row.id, price, value === null ? 0 : micros(value), result.card.mint, Date.now(), JSON.stringify({ card: result.card })]);
          await record(this.db, { id: `order:${row.id}:pack`, bucket: 'ops', kind: 'pack', micros: -price, signature: result.signature, ref: row.id });
        });
        return this.save(row, 'delivering', { purchaseId, memo: result.memo, packSignature: result.signature, card: result.card, valueMicros: value === null ? undefined : micros(value), message: 'Sending your card.', failures: 0 });
      }
      case 'delivering': {
        const signature = await this.solana.transferNft(`order:${row.id}:nft`, d.card!.mint, row.wallet, s);
        return this.save(row, 'settling', { nftSignature: signature, message: 'Card delivered. Working out your rebate.', failures: 0 });
      }
      case 'settling': {
        if (d.valueMicros === undefined) {
          const value = Number((await this.packs.status(d.memo!))?.send?.insured_value);
          if (!Number.isFinite(value) || value < 0) throw new ReviewRequired('Collector Crypt has not recorded this card\'s insured value yet; the card was delivered and only the rebate needs a manual check.');
          await this.db.query('UPDATE pulls SET value_micros=$2 WHERE order_id=$1', [row.id, micros(value)]);
          await this.save(row, 'settling', { valueMicros: micros(value) });
        }
        // Coverage is the lower of the quoted tier and the tier now, fixed once so retries pay the same amount.
        if (row.data.settleCoverageBps === undefined) {
          await this.holders.snapshot(row.wallet);
          const now = await this.holders.tierFor(row.wallet, d.quotedAt - s.onsiteHoldHours * 3_600_000, Date.now());
          const coverage = Math.min(row.coverage_bps, now.tier?.onsiteCoverageBps ?? 0);
          const rebate = rebateMicros(price, row.data.valueMicros!, coverage, Number(row.max_rebate_micros));
          await this.save(row, 'settling', { settleCoverageBps: coverage, rebateMicros: rebate, poolShareMicros: splitFee(fee, d.poolShareBps).pool });
        }
        const rebate = row.data.rebateMicros!;
        let rebateSignature: string | null = null;
        if (rebate > 0) {
          rebateSignature = await this.solana.pay('pool', `order:${row.id}:rebate`, row.wallet, rebate, s);
          this.pool.invalidate();
        }
        const split = splitFee(fee, d.poolShareBps);
        await atomic(this.db, async () => {
          if (rebate > 0) await record(this.db, { id: `order:${row.id}:rebate`, bucket: 'pool', kind: 'rebate', micros: -rebate, signature: rebateSignature, ref: row.id });
          await record(this.db, { id: `order:${row.id}:fee-pool`, bucket: 'pool', kind: 'fee-share', micros: split.pool, ref: row.id });
          await record(this.db, { id: `order:${row.id}:fee-burn`, bucket: 'burn', kind: 'fee-share', micros: split.burn, ref: row.id });
          await this.db.query('UPDATE pulls SET rebate_micros=$2 WHERE order_id=$1', [row.id, rebate]);
          await this.pool.release(row.id);
        });
        await this.save(row, 'complete', { rebateSignature, message: rebate > 0 ? `Rebate of $${(Math.round(rebate / 10_000) / 100).toFixed(2)} sent.` : 'This pull beat the pack price, so no rebate was needed.' });
        // The order is done either way; a breaker hiccup must not mark it delayed.
        try { await this.pool.checkBreaker(packCode(d.packCode, usd(price))); }
        catch (error) { await audit(this.db, 'breaker-check-error', { id: row.id, error: (error as Error).message }); }
        return;
      }
      case 'refunding': {
        const signature = await this.solana.pay('ops', `order:${row.id}:refund`, row.wallet, price + fee, s);
        await record(this.db, { id: `order:${row.id}:refund`, bucket: 'ops', kind: 'refund', micros: -(price + fee), signature, ref: row.id });
        await this.pool.release(row.id);
        return this.save(row, 'refunded', { refundSignature: signature, message: `${d.refundReason ?? 'The order could not be completed.'} You were refunded in full.` });
      }
    }
  }

  /** The buyer's payment is confirmed only once its `sale` ledger entry exists. */
  private async paid(id: string) { return (await this.db.query('SELECT 1 FROM ledger WHERE id=$1', [`order:${id}:sale`])).rows.length > 0; }

  /**
   * The attempt whose pack payment to Collector Crypt was signed (and so may have moved USDC), or null
   * when none was: attempts known to have moved nothing, and packs Collector Crypt refunded, do not count.
   */
  private async sentToProvider(row: Row) {
    const d = row.data, providerRefunded = /refunded/i.test(row.error ?? '');
    if (providerRefunded) return null;
    for (let attempt = 0; attempt <= (d.attempt ?? 0); attempt++) {
      if ((d.unpaidAttempts ?? []).includes(attempt)) continue;
      if ((await this.jobs.get(`cc:${row.id}-${attempt}`))?.data?.signature) return attempt;
    }
    return null;
  }

  /** A finished order's card that the buyer can still sell back. */
  private async sellable(wallet: string, id: string) {
    const row = await this.row(id);
    if (!row || row.wallet !== wallet) throw Object.assign(new Error('Order not found.'), { statusCode: 404 });
    if (row.status !== 'complete' || !row.data.card) throw new Error('Only a card that reached your wallet can be sold.');
    if (row.data.sale) throw new Error('This card was already sold back.');
    return row;
  }

  /** Collector Crypt's live sell-back offer for this order's card. */
  async sellQuote(wallet: string, id: string) {
    const row = await this.sellable(wallet, id), q = await this.packs.buybackQuote(row.data.card!.mint);
    return { available: q.available, amountUsd: q.amountMicros === null ? null : usd(q.amountMicros), expiresAt: q.expiresAt };
  }

  /** Gets a sale transaction for the buyer to sign. The card goes back to Collector Crypt and USDC to the buyer. */
  async sellStart(wallet: string, id: string) {
    const row = await this.sellable(wallet, id), offer = await this.packs.buyback(wallet, row.data.card!.mint);
    await this.save(row, row.status, { saleOffer: { amountMicros: offer.amountMicros, at: Date.now() } }, row.error);
    return { transaction: offer.transaction, amountUsd: usd(offer.amountMicros) };
  }

  /** Checks the signed sale is the buyer selling this card, then hands it to Collector Crypt. */
  async sellSubmit(wallet: string, id: string, signed: string) {
    const row = await this.sellable(wallet, id), offer = row.data.saleOffer;
    if (!offer || Date.now() - offer.at > 5 * 60_000) throw new Error('This offer expired. Ask for a fresh one.');
    if (!(signed.startsWith('practice-sale:') && !this.solana.live)) checkSaleTransaction(signed, wallet, row.data.card!.mint);
    const signature = await this.packs.submitBuyback(signed);
    await this.save(row, row.status, { sale: { amountMicros: offer.amountMicros, signature, at: Date.now() } }, row.error);
    await audit(this.db, 'quick-sell', { id, wallet, amountUsd: usd(offer.amountMicros), signature });
    return this.get(id, wallet);
  }

  /** Owner action: skip the backoff wait so a delayed order is tried again on the next pass. */
  async retryNow(id: string) {
    const row = await this.row(id);
    if (!row || !OPEN.includes(row.status)) throw new Error('Only orders that are still in progress can be retried.');
    await this.save(row, row.status, { retryAt: 0 }, row.error);
  }

  /**
   * Owner actions for an order in review. Refund only moves money that provably arrived and was
   * not already spent on a pack; Retry resumes where the order stopped, never past an unconfirmed payment.
   */
  async resolve(id: string, action: 'retry' | 'refund') {
    const row = await this.row(id);
    if (!row || row.status !== 'review') throw new Error('Only orders in review can be resolved.');
    const d = row.data, paid = await this.paid(row.id);
    if (action === 'refund') {
      if (!paid) throw new Error('This payment was never confirmed, so there is nothing to refund. Use Retry to re-check it.');
      if (d.card) throw new Error('The card was bought; use Retry to finish delivery instead of refunding.');
      const sent = await this.sentToProvider(row);
      if (sent !== null) throw new Error(`A pack payment was sent to Collector Crypt for this order (attempt ${sent}). Check it on Solscan; use Retry instead of refunding.`);
      return this.save(row, 'refunding', { refundReason: 'The order could not be completed.', failures: 0, retryAt: 0 });
    }
    const after = (status?: OrderStatus) => status && !['awaiting_payment', 'paying', 'review'].includes(status);
    const resume: OrderStatus = !paid ? (row.payment_signature ? 'paying' : 'awaiting_payment')
      : after(d.reviewFrom) ? d.reviewFrom!
      : d.nftSignature ? 'settling' : d.card ? 'delivering' : 'buying';
    return this.save(row, resume, { failures: 0, retryAt: 0, message: 'Retrying.' });
  }
}

function view(row: Row): OrderView {
  const d = row.data, price = Number(row.price_micros), fee = Number(row.fee_micros);
  return {
    id: row.id, status: row.status, wallet: row.wallet, packCode: packCode(d.packCode, usd(price)), priceUsd: usd(price), feeUsd: usd(fee), totalUsd: usd(price + fee),
    coverageBps: d.settleCoverageBps ?? row.coverage_bps, maxRebateUsd: usd(Number(row.max_rebate_micros)), card: d.card ?? null,
    valueUsd: d.valueMicros !== undefined ? usd(d.valueMicros) : null, rebateUsd: d.rebateMicros !== undefined ? usd(d.rebateMicros) : null,
    paymentSignature: row.payment_signature, rebateSignature: d.rebateSignature ?? null, refundSignature: d.refundSignature ?? null, nftSignature: d.nftSignature ?? null,
    // Review reasons can be internal (RPC or provider errors); the buyer only sees that it is being checked.
    message: row.status === 'review' ? 'This order needs a manual check. Your payment is safe and the team has been alerted.' : d.message ?? null, createdAt: Number(row.created_at),
    sale: d.sale ? { amountUsd: usd(d.sale.amountMicros), signature: d.sale.signature } : null,
  };
}
