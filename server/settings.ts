import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Database } from './db';
import { DEFAULT_SETTINGS } from '../shared/protection';
import type { Settings } from '../shared/types';

const bps = z.number().int().min(0).max(10_000);
const walletAddress = z.string().trim().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'Enter a Solana wallet address.');
/** Up to a week between packs. */
const cooldownMinutes = z.number().finite().min(0).max(7 * 24 * 60);
export const settingsSchema: z.ZodType<Settings> = z.object({
  paused: z.boolean(),
  feeBps: z.number().int().min(0).max(5_000),
  poolShareBps: bps,
  tiers: z.array(z.object({ id: z.string().min(1).max(16), name: z.string().trim().min(1).max(24), minSupplyPpm: z.number().int().min(1).max(1_000_000), onsiteCoverageBps: bps, offsiteCoverageBps: bps })).min(1).max(8),
  walletTiers: z.array(z.object({ wallet: walletAddress, tierId: z.string().min(1).max(16) })).max(100),
  cooldown: z.object({ minutes: cooldownMinutes, wallets: z.array(z.object({ wallet: walletAddress, minutes: cooldownMinutes })).max(200) }),
  maxRebateUsd: z.number().finite().min(0).max(100_000),
  onsiteHoldHours: z.number().finite().min(0).max(24 * 30),
  offsiteHoldHours: z.number().finite().min(0).max(24 * 30),
  offsiteActivationHours: z.number().finite().min(0).max(24 * 30),
  offsite: z.object({ enabled: z.boolean(), claimWindowHours: z.number().int().min(1).max(24 * 30), perWalletDailyClaims: z.number().int().min(0).max(1_000), perWalletDailyUsd: z.number().finite().min(0).max(100_000), perWalletWeeklyUsd: z.number().finite().min(0).max(100_000), dailyPoolBps: bps, targetReserveUsd: z.number().finite().min(0).max(10_000_000) }),
  breaker: z.object({ lossRatioBps: z.number().int().min(0).max(1_000_000), minPacks: z.number().int().min(1).max(10_000), windowDays: z.number().int().min(1).max(90) }),
  pausedPacks: z.array(z.string().min(1).max(40)).max(64),
  creatorFeeBudgetUsdPerDay: z.number().finite().min(0).max(10_000_000),
  creatorFeeMinUsd: z.number().finite().min(0).max(100_000),
  maxPriceImpactBps: z.number().int().min(10).max(5_000),
  burnThresholdUsd: z.number().finite().min(1).max(1_000_000),
  feeTransferThresholdUsd: z.number().finite().min(1).max(1_000_000),
  gasReserveSol: z.number().finite().min(0.01).max(100),
  gas: z.object({ opsMinSol: z.number().finite().min(0.02).max(100), opsTargetSol: z.number().finite().min(0.02).max(100), poolMinSol: z.number().finite().min(0.02).max(100), buyUsd: z.number().finite().min(1).max(1_000), maxUsdPerDay: z.number().finite().min(0).max(10_000) }),
  slippageBps: z.number().int().min(1).max(100),
}).superRefine((s, ctx) => {
  // OPS swaps (buyback) and POOL swaps (creator fees, gas) must leave each wallet above the reserve.
  if (s.gas.opsTargetSol <= s.gas.opsMinSol) ctx.addIssue({ code: 'custom', path: ['gas', 'opsTargetSol'], message: 'OPS refill level must be above its top-up trigger.' });
  if (s.gas.opsMinSol < s.gasReserveSol) ctx.addIssue({ code: 'custom', path: ['gas', 'opsMinSol'], message: 'OPS top-up trigger must be at least the gas reserve.' });
  if (s.gas.poolMinSol < s.gasReserveSol) ctx.addIssue({ code: 'custom', path: ['gas', 'poolMinSol'], message: 'POOL minimum must be at least the gas reserve.' });
});

/**
 * Bumped when a change of rules moves some settings. Rules 2: off-site claims check the coin's on-chain
 * history, so the 24h claim window becomes 48h and holding before the pull is no longer required.
 * Rules 3: off-site claims are unlimited (no per-wallet daily or weekly limits).
 */
const RULES = 3;

/** Earlier default tier names, renamed on load. Names an owner typed themselves are left alone. */
const RENAMED_TIERS: Record<string, string> = { Holder: 'Shrimp', Trainer: 'Shrimp', Collector: 'Dolphin', 'Gym Leader': 'Dolphin', Champion: 'Whale' };

export class SettingsStore {
  current: Settings = DEFAULT_SETTINGS;
  constructor(readonly db: Database) {}
  async load() {
    const row = (await this.db.query('SELECT data FROM settings WHERE id=1')).rows[0];
    // New fields added in later versions fall back to their defaults.
    // Paused prices from before pack codes existed were all Pokémon packs.
    const legacy = {
      ...(row && !row.data.pausedPacks && Array.isArray(row.data.pausedPrices) ? { pausedPacks: row.data.pausedPrices.map((p: number) => `pokemon_${p}`) } : {}),
      ...(row && Array.isArray(row.data.tiers) ? { tiers: row.data.tiers.map((t: any) => RENAMED_TIERS[t?.name] ? { ...t, name: RENAMED_TIERS[t.name] } : t) } : {}),
    };
    const before2 = row && (row.data.rules ?? 1) < 2;
    const moved = before2 && row.data.offsiteHoldHours === 24 ? { offsiteHoldHours: 0 } : {};
    const before3 = row && (row.data.rules ?? 1) < 3;
    const movedOffsite = {
      ...(before2 && row.data.offsite?.claimWindowHours === 24 ? { claimWindowHours: 48 } : {}),
      ...(before3 ? { perWalletDailyClaims: 0, perWalletDailyUsd: 0, perWalletWeeklyUsd: 0 } : {}),
    };
    this.current = row ? settingsSchema.parse({ ...DEFAULT_SETTINGS, ...row.data, ...legacy, ...moved, offsite: { ...DEFAULT_SETTINGS.offsite, ...row.data.offsite, ...movedOffsite }, breaker: { ...DEFAULT_SETTINGS.breaker, ...row.data.breaker }, cooldown: { ...DEFAULT_SETTINGS.cooldown, ...row.data.cooldown }, gas: { ...DEFAULT_SETTINGS.gas, ...row.data.gas } }) : DEFAULT_SETTINGS;
    return this.current;
  }
  async save(settings: Settings) {
    const parsed = settingsSchema.parse(settings);
    await this.db.query('INSERT INTO settings(id,data) VALUES(1,$1) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data', [JSON.stringify({ ...parsed, rules: RULES })]);
    this.current = parsed;
  }
}

/** A short fingerprint of the saved settings, used to refuse saves made from a stale admin page. */
export const settingsVersion = (settings: Settings) => createHash('sha256').update(JSON.stringify(settings)).digest('hex').slice(0, 16);
