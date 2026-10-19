import type { Database } from './db';
import { audit, sum } from './db';
import type { Solana } from './ports';
import type { SettingsStore } from './settings';
import { healthBps, micros, usd } from '../shared/protection';
import type { PoolView } from '../shared/types';

const DAY = 86_400_000;

/**
 * The USDC reserve. Free balance = on-chain POOL balance − liabilities reserved for
 * open on-site orders. Off-site claims are paid only from the free balance, inside caps.
 */
export class Pool {
  private cache: { micros: number; at: number } | null = null;
  constructor(readonly db: Database, readonly solana: Solana, readonly settings: SettingsStore) {}

  invalidate() { this.cache = null; }
  async balance() {
    if (this.cache && Date.now() - this.cache.at < 15_000) return this.cache.micros;
    const value = this.solana.poolAddress ? Number(await this.solana.usdcBalance(this.solana.poolAddress)) : 0;
    this.cache = { micros: value, at: Date.now() };
    return value;
  }
  async reserved() { return Number((await this.db.query<{ total: string }>('SELECT COALESCE(SUM(micros),0)::text AS total FROM reservations WHERE released_at IS NULL')).rows[0].total); }
  async queued() { return Number((await this.db.query<{ total: string }>("SELECT COALESCE(SUM(rebate_micros),0)::text AS total FROM claims WHERE status IN ('approved','queued','paying')")).rows[0].total); }
  async free() { return (await this.balance()) - (await this.reserved()); }
  async health() { return healthBps((await this.free()) - (await this.queued()), micros(this.settings.current.offsite.targetReserveUsd)); }

  /** Callers run inside the coordinator's Serial queue, so check-then-insert cannot race. */
  async reserve(id: string, amount: number) {
    if (amount <= 0) return;
    if ((await this.free()) < amount) throw new Error('The protection pool is full right now. Try a smaller pack or check back soon.');
    await this.db.query('INSERT INTO reservations(id,micros,created_at) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING', [id, amount, Date.now()]);
  }
  async release(id: string) { await this.db.query('UPDATE reservations SET released_at=$2 WHERE id=$1 AND released_at IS NULL', [id, Date.now()]); }

  /** How much an off-site claim for this wallet can be paid right now. Caps of 0 mean no cap. */
  async offsiteRoom(wallet: string) {
    const s = this.settings.current.offsite, now = Date.now();
    const paidSince = async (since: number, onlyWallet: boolean) => Number((await this.db.query<{ total: string }>(
      `SELECT COALESCE(SUM(rebate_micros),0)::text AS total FROM claims WHERE status IN ('paying','paid') AND COALESCE(paid_at,created_at) >= $1 ${onlyWallet ? 'AND wallet=$2' : ''}`,
      onlyWallet ? [since, wallet] : [since])).rows[0].total);
    const cap = (usdCap: number, used: number) => usdCap > 0 ? Math.max(0, micros(usdCap) - used) : Infinity;
    const balance = await this.balance();
    return {
      wallet: Math.min(cap(s.perWalletWeeklyUsd, await paidSince(now - 7 * DAY, true)), cap(s.perWalletDailyUsd, await paidSince(now - DAY, true))),
      // 0 = no pool-wide daily cap; payouts are still limited by the free balance.
      global: s.dailyPoolBps > 0 ? Math.max(0, Math.floor(balance * s.dailyPoolBps / 10_000) - await paidSince(now - DAY, false)) : Infinity,
      free: Math.max(0, await this.free()),
    };
  }

  /** Claims this wallet filed in the last 24h, and when the oldest of them rolls off. */
  async claimsToday(wallet: string) {
    const row = (await this.db.query<{ n: number; oldest: string | null }>('SELECT COUNT(*)::int AS n, MIN(created_at)::text AS oldest FROM claims WHERE wallet=$1 AND created_at >= $2', [wallet, Date.now() - DAY])).rows[0];
    return { count: row.n, nextAt: row.oldest ? Number(row.oldest) + DAY : null };
  }

  /** Trailing per-price economics for completed on-site orders. */
  async byPrice(days = this.settings.current.breaker.windowDays) {
    const rows = (await this.db.query<{ price_micros: string; packs: number; fees: string; rebates: string }>(
      `SELECT price_micros::text, COUNT(*)::int AS packs, COALESCE(SUM((data->>'poolShareMicros')::bigint),0)::text AS fees, COALESCE(SUM((data->>'rebateMicros')::bigint),0)::text AS rebates
       FROM orders WHERE status='complete' AND updated_at >= $1 GROUP BY price_micros ORDER BY price_micros`, [Date.now() - days * DAY])).rows;
    return rows.map(r => {
      const fees = Number(r.fees), rebates = Number(r.rebates);
      return { priceUsd: usd(Number(r.price_micros)), packs: r.packs, feesMicros: fees, rebatesMicros: rebates, lossRatioBps: fees > 0 ? Math.floor(rebates * 10_000 / fees) : rebates > 0 ? Infinity : null };
    });
  }

  /** Pauses a pack price whose trailing rebates exceed the configured share of its pool fee income. */
  async checkBreaker(priceUsd: number) {
    const s = this.settings.current;
    if (s.pausedPrices.includes(priceUsd)) return false;
    const stats = (await this.byPrice()).find(r => r.priceUsd === priceUsd);
    if (!stats || stats.packs < s.breaker.minPacks || stats.lossRatioBps === null || stats.lossRatioBps <= s.breaker.lossRatioBps) return false;
    await this.settings.save({ ...s, pausedPrices: [...s.pausedPrices, priceUsd].sort((a, b) => a - b) });
    await audit(this.db, 'breaker-tripped', { ...stats, lossRatioBps: Number.isFinite(stats.lossRatioBps) ? stats.lossRatioBps : 'infinite' });
    return true;
  }

  /** Recent settled pulls, on-site and off-site, for the public feed. Wallets are shortened. */
  async activity(limit = 12) {
    const short = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;
    const orders = (await this.db.query<{ wallet: string; price_micros: string; data: any; updated_at: string }>("SELECT wallet,price_micros::text,data,updated_at::text FROM orders WHERE status='complete' ORDER BY updated_at DESC LIMIT $1", [limit])).rows
      .map(r => ({ kind: 'onsite' as const, wallet: short(r.wallet), priceUsd: usd(Number(r.price_micros)), valueUsd: usd(Number(r.data.valueMicros ?? 0)), rebateUsd: usd(Number(r.data.rebateMicros ?? 0)), cardName: (r.data.card?.name as string | undefined) ?? null, at: Number(r.updated_at) }));
    const claims = (await this.db.query<{ wallet: string; price_micros: string; value_micros: string; rebate_micros: string; paid_at: string }>("SELECT wallet,price_micros::text,value_micros::text,rebate_micros::text,paid_at::text FROM claims WHERE status='paid' ORDER BY paid_at DESC LIMIT $1", [limit])).rows
      .map(r => ({ kind: 'offsite' as const, wallet: short(r.wallet), priceUsd: usd(Number(r.price_micros)), valueUsd: usd(Number(r.value_micros)), rebateUsd: usd(Number(r.rebate_micros)), cardName: null, at: Number(r.paid_at) }));
    return [...orders, ...claims].sort((a, b) => b.at - a.at).slice(0, limit);
  }

  async view(): Promise<PoolView> {
    const [balance, reserved, queued, health, prices] = await Promise.all([this.balance(), this.reserved(), this.queued(), this.health(), this.byPrice(36_500)]);
    const total = (where: string) => sum(this.db, where);
    const feeShare = await total("bucket='pool' AND kind='fee-share'"), transferred = await total("bucket='transfer' AND kind='fee-transfer'");
    const burns = (await this.db.query('SELECT id,usdc_micros::text,tokens,burn_signature,created_at::text FROM burns ORDER BY created_at DESC LIMIT 10')).rows;
    const recent = await this.byPrice();
    return {
      live: this.solana.live, poolAddress: this.solana.poolAddress, opsAddress: this.solana.opsAddress,
      balanceUsd: usd(balance), reservedUsd: usd(reserved), freeUsd: usd(balance - reserved), queuedUsd: usd(queued), healthBps: health,
      pendingFeeTransferUsd: usd(feeShare - transferred), burnBucketUsd: usd(await total("bucket='burn'")),
      totals: {
        creatorFeesUsd: usd(await total("bucket='pool' AND kind='creator-fee'")), feeShareUsd: usd(feeShare),
        onsiteRebatesUsd: usd(Math.abs(await total("bucket='pool' AND kind='rebate'"))), offsiteRebatesUsd: usd(Math.abs(await total("bucket='pool' AND kind='claim'"))),
        burnedUsd: usd(Math.abs(await total("bucket='burn' AND kind='burn'"))),
        packsOpened: prices.reduce((s, p) => s + p.packs, 0),
        claimsPaid: Number((await this.db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM claims WHERE status='paid'")).rows[0].n),
      },
      byPrice: prices.map(p => { const r = recent.find(x => x.priceUsd === p.priceUsd); return { priceUsd: p.priceUsd, packs: p.packs, feesToPoolUsd: usd(p.feesMicros), rebatesUsd: usd(p.rebatesMicros), lossRatioBps: r && r.lossRatioBps !== null && Number.isFinite(r.lossRatioBps) ? r.lossRatioBps : null, paused: this.settings.current.pausedPrices.includes(p.priceUsd) }; }),
      recentBurns: burns.map(b => ({ id: b.id, usdcUsd: usd(Number(b.usdc_micros)), tokens: b.tokens, signature: b.burn_signature, createdAt: Number(b.created_at) })),
    };
  }
}
