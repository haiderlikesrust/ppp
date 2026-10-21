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
  /** Approved claims not yet sent. Payouts in flight are already taken out of `free`. */
  async queued() { return Number((await this.db.query<{ total: string }>("SELECT COALESCE(SUM(rebate_micros),0)::text AS total FROM claims WHERE status IN ('approved','queued')")).rows[0].total); }
  /** Claim payouts sent but not yet confirmed: the cached balance does not reflect them yet. */
  async inFlight() { return Number((await this.db.query<{ total: string }>("SELECT COALESCE(SUM(rebate_micros),0)::text AS total FROM claims WHERE status='paying'")).rows[0].total); }
  async free() { return (await this.balance()) - (await this.reserved()) - (await this.inFlight()); }
  async health() { return healthBps((await this.free()) - (await this.queued()), micros(this.settings.current.offsite.targetReserveUsd)); }

  /** Callers run inside the coordinator's Serial queue, so check-then-insert cannot race. */
  async reserve(id: string, amount: number) {
    if (amount <= 0) return;
    // Idempotent: an order that already holds its reservation keeps it.
    if ((await this.db.query('SELECT 1 FROM reservations WHERE id=$1 AND released_at IS NULL', [id])).rows.length) return;
    if ((await this.free()) < amount) throw new Error('The protection pool is full right now. Try a smaller pack or check back soon.');
    await this.db.query('INSERT INTO reservations(id,micros,created_at) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET micros=EXCLUDED.micros,created_at=EXCLUDED.created_at,released_at=NULL', [id, amount, Date.now()]);
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

  /**
   * Trailing per-pack economics for completed on-site orders. Orders from before pack codes were Pokémon packs.
   * `lossRatioBps` is against the fees the pool really got. `breakerRatioBps` counts packs sold without a fee
   * (tier exception wallets) at the listed fee, so a fee waiver alone doesn't read as an infinite loss.
   */
  async byPack(days = this.settings.current.breaker.windowDays) {
    const s = this.settings.current;
    const rows = (await this.db.query<{ code: string; price_micros: string; packs: number; fees: string; listed_fees: string; rebates: string }>(
      `SELECT COALESCE(data->>'packCode', 'pokemon_' || (price_micros / 1000000)::text) AS code, MIN(price_micros)::text AS price_micros, COUNT(*)::int AS packs,
         COALESCE(SUM((data->>'poolShareMicros')::bigint),0)::text AS fees,
         COALESCE(SUM(CASE WHEN fee_micros = 0 THEN price_micros * $2 / 10000 * COALESCE((data->>'poolShareBps')::bigint, $3) / 10000 ELSE COALESCE((data->>'poolShareMicros')::bigint, 0) END),0)::text AS listed_fees,
         COALESCE(SUM((data->>'rebateMicros')::bigint),0)::text AS rebates
       FROM orders WHERE status='complete' AND updated_at >= $1 GROUP BY 1 ORDER BY MIN(price_micros), 1`, [Date.now() - days * DAY, s.feeBps, s.poolShareBps])).rows;
    const ratio = (fees: number, rebates: number) => fees > 0 ? Math.floor(rebates * 10_000 / fees) : rebates > 0 ? Infinity : null;
    return rows.map(r => {
      const fees = Number(r.fees), rebates = Number(r.rebates);
      return { code: r.code, priceUsd: usd(Number(r.price_micros)), packs: r.packs, feesMicros: fees, rebatesMicros: rebates, lossRatioBps: ratio(fees, rebates), breakerRatioBps: ratio(Number(r.listed_fees), rebates) };
    });
  }

  /** Pauses a pack whose trailing rebates exceed the configured share of its pool fee income, waived fees counted at the listed fee. */
  async checkBreaker(code: string) {
    const s = this.settings.current;
    if (s.pausedPacks.includes(code)) return false;
    const stats = (await this.byPack()).find(r => r.code === code);
    if (!stats || stats.packs < s.breaker.minPacks || stats.breakerRatioBps === null || stats.breakerRatioBps <= s.breaker.lossRatioBps) return false;
    await this.settings.save({ ...s, pausedPacks: [...s.pausedPacks, code] });
    const finite = (n: number | null) => n !== null && !Number.isFinite(n) ? 'infinite' : n;
    await audit(this.db, 'breaker-tripped', { ...stats, lossRatioBps: finite(stats.lossRatioBps), breakerRatioBps: finite(stats.breakerRatioBps) });
    return true;
  }

  /** Recent settled pulls, on-site and off-site, for the public feed. Wallets are shortened. */
  async activity(limit = 12) {
    const short = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;
    const orders = (await this.db.query<{ wallet: string; price_micros: string; data: any; updated_at: string }>("SELECT wallet,price_micros::text,data,updated_at::text FROM orders WHERE status='complete' ORDER BY updated_at DESC LIMIT $1", [limit])).rows
      .map(r => ({ kind: 'onsite' as const, wallet: short(r.wallet), code: (r.data.packCode as string | undefined) ?? `pokemon_${usd(Number(r.price_micros))}`, priceUsd: usd(Number(r.price_micros)), valueUsd: usd(Number(r.data.valueMicros ?? 0)), rebateUsd: usd(Number(r.data.rebateMicros ?? 0)), cardName: (r.data.card?.name as string | undefined) ?? null, at: Number(r.updated_at) }));
    const claims = (await this.db.query<{ wallet: string; price_micros: string; value_micros: string; rebate_micros: string; paid_at: string; data: any }>("SELECT wallet,price_micros::text,value_micros::text,rebate_micros::text,paid_at::text,data FROM claims WHERE status='paid' ORDER BY paid_at DESC LIMIT $1", [limit])).rows
      .map(r => ({ kind: 'offsite' as const, wallet: short(r.wallet), code: (r.data?.packType as string | undefined) ?? `pokemon_${usd(Number(r.price_micros))}`, priceUsd: usd(Number(r.price_micros)), valueUsd: usd(Number(r.value_micros)), rebateUsd: usd(Number(r.rebate_micros)), cardName: null, at: Number(r.paid_at) }));
    return [...orders, ...claims].sort((a, b) => b.at - a.at).slice(0, limit);
  }

  async view(): Promise<PoolView> {
    const [balance, reserved, queued, health, prices] = await Promise.all([this.balance(), this.reserved(), this.queued(), this.health(), this.byPack(36_500)]);
    const total = (where: string) => sum(this.db, where);
    const feeShare = await total("bucket='pool' AND kind='fee-share'"), transferred = await total("bucket='transfer' AND kind='fee-transfer'");
    const burns = (await this.db.query('SELECT id,usdc_micros::text,tokens,burn_signature,created_at::text FROM burns ORDER BY created_at DESC LIMIT 10')).rows;
    const recent = await this.byPack();
    return {
      live: this.solana.live, poolAddress: this.solana.poolAddress, opsAddress: this.solana.opsAddress,
      balanceUsd: usd(balance), reservedUsd: usd(reserved), freeUsd: usd(balance - reserved), queuedUsd: usd(queued), healthBps: health,
      pendingFeeTransferUsd: usd(feeShare - transferred), burnBucketUsd: usd(await total("bucket='burn'")),
      totals: {
        creatorFeesUsd: usd(await total("bucket='pool' AND kind='creator-fee'")), feeShareUsd: usd(feeShare),
        onsiteRebatesUsd: usd(Math.abs(await total("bucket='pool' AND kind='rebate'"))), offsiteRebatesUsd: usd(Math.abs(await total("bucket='pool' AND kind='claim'"))), networkFeesUsd: usd(Math.abs(await total("bucket='pool' AND kind='gas'"))),
        burnedUsd: usd(Math.abs(await total("bucket='burn' AND kind='burn'"))),
        packsOpened: prices.reduce((s, p) => s + p.packs, 0),
        claimsPaid: Number((await this.db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM claims WHERE status='paid'")).rows[0].n),
      },
      byPack: prices.map(p => { const r = recent.find(x => x.code === p.code); return { code: p.code, priceUsd: p.priceUsd, packs: p.packs, feesToPoolUsd: usd(p.feesMicros), rebatesUsd: usd(p.rebatesMicros), lossRatioBps: r && r.lossRatioBps !== null && Number.isFinite(r.lossRatioBps) ? r.lossRatioBps : null, paused: this.settings.current.pausedPacks.includes(p.code) }; }),
      recentBurns: burns.map(b => ({ id: b.id, usdcUsd: usd(Number(b.usdc_micros)), tokens: b.tokens, signature: b.burn_signature, createdAt: Number(b.created_at) })),
    };
  }
}
