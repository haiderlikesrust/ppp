import type { Database } from './db';
import type { HolderHistory, Solana } from './ports';
import { balanceAt } from './coin-history';
import type { SettingsStore } from './settings';
import { holderTier, supplyPpm } from '../shared/protection';
import type { HolderTier, HolderView } from '../shared/types';

export const SNAPSHOT_INTERVAL_MS = 15 * 60_000;
const HOUR = 3_600_000;

export type TierCheck = { tier: HolderTier | null; minBalance: bigint; supply: bigint; reason: string | null };

/** "3h" or "2d 4h". */
const span = (ms: number) => { const h = Math.max(1, Math.round(ms / HOUR)); return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d ${h % 24}h`; };

/**
 * Balance snapshots for activated wallets. A wallet's tier for a pull is its
 * *lowest* balance over the hold window, so buying just before a pull (or moving
 * one bag between wallets) does not count.
 */
export class Holders {
  private histories = new Map<string, { at: number; since: number; value: Promise<HolderHistory> }>();
  constructor(readonly db: Database, readonly solana: Solana, readonly settings: SettingsStore) {}

  /**
   * The wallet's on-chain coin history, far enough back for every pull in the claim window. Cached for a
   * minute: a scan checks every pull against the same history, and a claim re-checks right after.
   */
  history(wallet: string, now = Date.now(), from?: number) {
    const s = this.settings.current, since = from ?? now - (s.offsite.claimWindowHours + s.offsiteHoldHours) * HOUR;
    const cached = this.histories.get(wallet);
    if (cached && now - cached.at < 60_000 && cached.since <= since) return cached.value;
    const value = this.solana.holderHistory(wallet, since);
    if (this.histories.size > 5_000) this.histories.delete(this.histories.keys().next().value!);
    this.histories.set(wallet, { at: now, since, value });
    value.catch(() => this.histories.delete(wallet));
    return value;
  }

  /** Drops a wallet's cached history (a payout re-check, or practice tools changing it). */
  forget(wallet: string) { this.histories.delete(wallet); }

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
   * Off-site tier for a pull, from the wallet's on-chain coin history: it must already have held the coin
   * when the pack was opened (and for `offsiteHoldHours` before, if set), and its tier is the lowest
   * balance from then until now. Buying after a pull, or selling down since, lowers or removes cover.
   */
  async offsiteTier(wallet: string, activatedAt: number, pulledAt: number, now = Date.now()): Promise<TierCheck> {
    const s = this.settings.current, start = pulledAt - s.offsiteHoldHours * HOUR;
    const none = (reason: string): TierCheck => ({ tier: null, minBalance: 0n, supply: 0n, reason });
    if (s.offsiteActivationHours > 0 && activatedAt > pulledAt - s.offsiteActivationHours * HOUR) return none(`Off-site coverage starts ${s.offsiteActivationHours}h after you first connect your wallet. This pull happened before that.`);
    const history = await this.history(wallet, now);
    const held = balanceAt(history.changes, start) ?? (history.complete ? 0n : null);
    if (held === null) return none('This wallet trades the coin too often to check automatically. Contact us to claim.');
    if (held <= 0n) {
      const first = history.firstAt;
      if (first !== null && first > pulledAt) return none(`You first bought the coin ${span(first - pulledAt)} after this pack was opened. Only packs opened after you bought in are covered.`);
      if (first !== null && s.offsiteHoldHours > 0 && first > start) return none(`You bought the coin ${span(pulledAt - first)} before this pack was opened; you need to have held it for ${s.offsiteHoldHours}h first.`);
      return none('This wallet held none of the coin when this pack was opened. Only packs opened after you bought in are covered.');
    }
    const minBalance = [held, ...history.changes.filter(c => c.at > start).map(c => c.balance), history.current].reduce((a, b) => b < a ? b : a);
    const supply = await this.solana.holderSupply();
    const tier = holderTier(minBalance, supply, s.tiers);
    const lowest = [...s.tiers].sort((a, b) => a.minSupplyPpm - b.minSupplyPpm)[0];
    return { tier, minBalance, supply, reason: tier ? null : `Your lowest balance since this pull was ${(supplyPpm(minBalance, supply) / 10_000).toFixed(3)}% of supply; ${lowest ? `${(lowest.minSupplyPpm / 10_000).toFixed(3)}%` : 'a tier'} is needed.` };
  }

  /** Tier from the lowest on-chain balance between `from` and now, read fresh: the check before a claim pays. */
  async heldSince(wallet: string, from: number): Promise<TierCheck> {
    this.forget(wallet);
    const history = await this.history(wallet, Date.now(), from);
    const start = balanceAt(history.changes, from) ?? (history.complete ? 0n : history.current);
    const minBalance = [start, ...history.changes.filter(c => c.at > from).map(c => c.balance), history.current].reduce((a, b) => b < a ? b : a);
    const supply = await this.solana.holderSupply();
    return { tier: holderTier(minBalance, supply, this.settings.current.tiers), minBalance, supply, reason: null };
  }

  async view(wallet: string, activatedAt: number): Promise<HolderView> {
    if (!this.solana.holderMint) return { configured: false, balance: '0', supply: '0', ppm: 0, tier: null, activatedAt, offsiteCoverageFrom: null };
    const { balance, supply } = await this.recent(wallet);
    return { configured: true, balance: balance.toString(), supply: supply.toString(), ppm: supplyPpm(balance, supply), tier: holderTier(balance, supply, this.settings.current.tiers), activatedAt, offsiteCoverageFrom: this.settings.current.offsiteActivationHours > 0 ? activatedAt + this.settings.current.offsiteActivationHours * HOUR : null };
  }
}
