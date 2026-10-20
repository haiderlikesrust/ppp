import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Database } from './db';
import { DEFAULT_SETTINGS } from '../shared/protection';
import type { Settings } from '../shared/types';

const bps = z.number().int().min(0).max(10_000);
export const settingsSchema: z.ZodType<Settings> = z.object({
  paused: z.boolean(),
  feeBps: z.number().int().min(0).max(5_000),
  poolShareBps: bps,
  tiers: z.array(z.object({ id: z.string().min(1).max(16), name: z.string().trim().min(1).max(24), minSupplyPpm: z.number().int().min(1).max(1_000_000), onsiteCoverageBps: bps, offsiteCoverageBps: bps })).min(1).max(8),
  maxRebateUsd: z.number().finite().min(0).max(100_000),
  onsiteHoldHours: z.number().finite().min(0).max(24 * 30),
  offsiteHoldHours: z.number().finite().min(0).max(24 * 30),
  offsiteActivationHours: z.number().finite().min(0).max(24 * 30),
  offsite: z.object({ enabled: z.boolean(), claimWindowHours: z.number().int().min(1).max(24 * 30), perWalletDailyClaims: z.number().int().min(0).max(1_000), perWalletDailyUsd: z.number().finite().min(0).max(100_000), perWalletWeeklyUsd: z.number().finite().min(0).max(100_000), dailyPoolBps: bps, targetReserveUsd: z.number().finite().min(0).max(10_000_000) }),
  breaker: z.object({ lossRatioBps: z.number().int().min(0).max(1_000_000), minPacks: z.number().int().min(1).max(10_000), windowDays: z.number().int().min(1).max(90) }),
  pausedPrices: z.array(z.number().int().positive()).max(32),
  creatorFeeBudgetUsdPerDay: z.number().finite().min(0).max(10_000_000),
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

export class SettingsStore {
  current: Settings = DEFAULT_SETTINGS;
  constructor(readonly db: Database) {}
  async load() {
    const row = (await this.db.query('SELECT data FROM settings WHERE id=1')).rows[0];
    // New fields added in later versions fall back to their defaults.
    this.current = row ? settingsSchema.parse({ ...DEFAULT_SETTINGS, ...row.data, offsite: { ...DEFAULT_SETTINGS.offsite, ...row.data.offsite }, breaker: { ...DEFAULT_SETTINGS.breaker, ...row.data.breaker }, gas: { ...DEFAULT_SETTINGS.gas, ...row.data.gas } }) : DEFAULT_SETTINGS;
    return this.current;
  }
  async save(settings: Settings) {
    const parsed = settingsSchema.parse(settings);
    await this.db.query('INSERT INTO settings(id,data) VALUES(1,$1) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data', [JSON.stringify(parsed)]);
    this.current = parsed;
  }
}

/** A short fingerprint of the saved settings, used to refuse saves made from a stale admin page. */
export const settingsVersion = (settings: Settings) => createHash('sha256').update(JSON.stringify(settings)).digest('hex').slice(0, 16);
