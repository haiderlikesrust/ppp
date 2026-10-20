import type { Database } from './db';
import type { Solana } from './ports';
import type { SettingsStore } from './settings';
import { holderTier, supplyPpm } from '../shared/protection';
import type { HolderTier, HolderView } from '../shared/types';

export const SNAPSHOT_INTERVAL_MS = 15 * 60_000;
const HOUR = 3_600_000;

export type TierCheck = { tier: HolderTier | null; minBalance: bigint; supply: bigint; reason: string | null };

/**
 * Balance snapshots for activated wallets. A wallet's tier for a pull is its
 * *lowest* balance over the hold window, so buying just before a pull (or moving
 * one bag between wallets) does not count.
 */
export class Holders {
  constructor(readonly db: Database, readonly solana: Solana, readonly settings: SettingsStore) {}

  async snapshot(wallet: string, at = Date.now()) {
    const [balance, supply] = await Promise.all([this.solana.holderBalance(wallet), this.solana.holderSupply()]);
    await this.db.query('INSERT INTO snapshots(wallet,taken_at,balance,supply) VALUES($1,$2,$3,$4) ON CONFLICT(wallet,taken_at) DO UPDATE SET balance=EXCLUDED.balance,supply=EXCLUDED.supply', [wallet, at, balance.toString(), supply.toString()]);
    return { balance, supply, takenAt: at };
  }

  /** The latest snapshot if it is newer than `maxAgeMs`, otherwise a fresh one. For display, not for payouts. */
  async recent(wallet: string, maxAgeMs = 60_000) {
    const row = (await this.db.query<{ taken_at: string; balance: string; supply: string }>('SELECT taken_at::text, balance, supply FROM snapshots WHERE wallet=$1 ORDER BY taken_at DESC LIMIT 1', [wallet])).rows[0];
    if (row && Date.now() - Number(row.taken_at) < maxAgeMs) return { balance: BigInt(row.balance), supply: BigInt(row.supply), takenAt: Number(row.taken_at) };
    return this.snapshot(wallet);
  }

  /** Snapshots every wallet active in the last 30 days. Sequential to stay inside RPC limits. */
  async snapshotAll() {
    const wallets = (await this.db.query<{ wallet: string }>('SELECT wallet FROM wallets WHERE COALESCE(last_seen_at, activated_at) > $1', [Date.now() - 30 * 86_400_000])).rows;
    let taken = 0;
    for (const { wallet } of wallets) { try { await this.snapshot(wallet); taken++; } catch { /* one RPC failure must not stop the sweep */ } }
    return taken;
  }

  /**
   * Lowest balance from the last snapshot at or before `from` through `to`.
   * With `knownHistoryOnly`, a wallet first seen after `from` is judged on the snapshots
   * since it connected (a new wallet: its current balance) instead of failing outright.
   */
  async tierFor(wallet: string, from: number, to: number, options: { knownHistoryOnly?: boolean } = {}): Promise<TierCheck> {
    const rows = (await this.db.query<{ taken_at: string; balance: string; supply: string }>(
      `SELECT taken_at::text, balance, supply FROM snapshots WHERE wallet=$1 AND taken_at <= $3
         AND taken_at >= COALESCE((SELECT MAX(taken_at) FROM snapshots WHERE wallet=$1 AND taken_at <= $2), $2)
       ORDER BY taken_at`, [wallet, from, to])).rows;
    const empty = { tier: null, minBalance: 0n, supply: 0n };
    if (!rows.length || (!options.knownHistoryOnly && Number(rows[0].taken_at) > from)) return { ...empty, reason: 'There is no record of your holdings at the start of the coverage window.' };
    const minBalance = rows.reduce((min, r) => BigInt(r.balance) < min ? BigInt(r.balance) : min, BigInt(rows[0].balance));
    const supply = BigInt(rows[rows.length - 1].supply);
    const tier = holderTier(minBalance, supply, this.settings.current.tiers);
    const lowest = [...this.settings.current.tiers].sort((a, b) => a.minSupplyPpm - b.minSupplyPpm)[0];
    return { tier, minBalance, supply, reason: tier ? null : `Your lowest balance in the window was ${(supplyPpm(minBalance, supply) / 10_000).toFixed(3)}% of supply; ${lowest ? `${(lowest.minSupplyPpm / 10_000).toFixed(3)}%` : 'a tier'} is needed.` };
  }

  /**
   * On-site tier: a snapshot now (or, for display-only quotes, one from the last minute), plus the
   * hold window if one is configured. Orders always use a fresh snapshot.
   */
  async onsiteTier(wallet: string, options: { fresh?: boolean } = { fresh: true }) {
    const now = Date.now();
    const taken = options.fresh ? await this.snapshot(wallet, now) : await this.recent(wallet);
    return this.tierFor(wallet, Math.min(taken.takenAt, now - this.settings.current.onsiteHoldHours * HOUR), now);
  }

  /** Keeps 45 days of history (claims look back at most 30 days plus the hold window) and each wallet's latest snapshot. */
  async prune(keepMs = 45 * 86_400_000) {
    await this.db.query('DELETE FROM snapshots s WHERE taken_at < $1 AND taken_at < (SELECT MAX(taken_at) FROM snapshots t WHERE t.wallet=s.wallet)', [Date.now() - keepMs]);
  }

  /**
   * Off-site tier for a pull: the lowest balance we have seen from the hold window's start
   * (or from the first connect, if later) until now. Coverage is immediate unless the owner
   * sets an activation delay; daily claim limits are what bound new wallets.
   */
  async offsiteTier(wallet: string, activatedAt: number, pulledAt: number, now = Date.now()): Promise<TierCheck> {
    const s = this.settings.current, start = pulledAt - s.offsiteHoldHours * HOUR;
    if (s.offsiteActivationHours > 0 && activatedAt > pulledAt - s.offsiteActivationHours * HOUR) return { tier: null, minBalance: 0n, supply: 0n, reason: `Off-site coverage starts ${s.offsiteActivationHours}h after you first connect your wallet. This pull happened before that.` };
    await this.snapshot(wallet, now);
    return this.tierFor(wallet, start, now, { knownHistoryOnly: true });
  }

  async view(wallet: string, activatedAt: number): Promise<HolderView> {
    if (!this.solana.holderMint) return { configured: false, balance: '0', supply: '0', ppm: 0, tier: null, activatedAt, offsiteCoverageFrom: null };
    const { balance, supply } = await this.recent(wallet);
    return { configured: true, balance: balance.toString(), supply: supply.toString(), ppm: supplyPpm(balance, supply), tier: holderTier(balance, supply, this.settings.current.tiers), activatedAt, offsiteCoverageFrom: this.settings.current.offsiteActivationHours > 0 ? activatedAt + this.settings.current.offsiteActivationHours * HOUR : null };
  }
}
