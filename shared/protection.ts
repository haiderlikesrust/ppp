import type { HolderTier, Quote, Settings } from './types';

/** All money is integer micro-USDC (6 decimals). */
export const MICROS = 1_000_000;
export const usd = (micros: number) => micros / MICROS;
export const micros = (dollars: number) => Math.round(dollars * MICROS);
const bps = (amount: number, rate: number) => Math.floor(amount * rate / 10_000);

export const DEFAULT_SETTINGS: Settings = {
  paused: false,
  feeBps: 1_000,
  poolShareBps: 5_000,
  tiers: [
    { id: 't1', name: 'Holder', minSupplyPpm: 1_000, onsiteCoverageBps: 2_500, offsiteCoverageBps: 2_000 },
    { id: 't2', name: 'Collector', minSupplyPpm: 10_000, onsiteCoverageBps: 5_000, offsiteCoverageBps: 3_500 },
    { id: 't3', name: 'Whale', minSupplyPpm: 20_000, onsiteCoverageBps: 10_000, offsiteCoverageBps: 6_000 },
  ],
  maxRebateUsd: 250,
  onsiteHoldHours: 0,
  offsiteHoldHours: 24,
  offsiteActivationHours: 0,
  offsite: { enabled: true, claimWindowDays: 7, perWalletDailyClaims: 3, perWalletDailyUsd: 25, perWalletWeeklyUsd: 100, dailyPoolBps: 0, targetReserveUsd: 1_000 },
  breaker: { lossRatioBps: 20_000, minPacks: 20, windowDays: 7 },
  pausedPrices: [],
  creatorFeeBudgetUsdPerDay: 0,
  burnThresholdUsd: 25,
  feeTransferThresholdUsd: 5,
  gasReserveSol: 0.05,
  gas: { opsMinSol: 0.1, opsTargetSol: 0.25, poolMinSol: 0.15, buyUsd: 15, maxUsdPerDay: 50 },
  slippageBps: 100,
};

/** Highest tier whose minimum share of supply the balance meets. */
export function holderTier(balance: bigint, supply: bigint, tiers: HolderTier[]): HolderTier | null {
  if (supply <= 0n || balance <= 0n) return null;
  return [...tiers].sort((a, b) => b.minSupplyPpm - a.minSupplyPpm)
    .find(t => balance * 1_000_000n >= supply * BigInt(t.minSupplyPpm)) ?? null;
}

export const supplyPpm = (balance: bigint, supply: bigint) => supply > 0n ? Number(balance * 1_000_000n / supply) : 0;

/** coverage × max(0, price − value), floored to a whole micro and capped. */
export function rebateMicros(priceMicros: number, valueMicros: number, coverageBps: number, capMicros: number) {
  const loss = Math.max(0, priceMicros - Math.max(0, valueMicros));
  return Math.max(0, Math.min(capMicros, bps(loss, coverageBps)));
}

/** Pool health: free balance relative to the off-site reserve target, clamped to [0, 1] as basis points. */
export function healthBps(freeMicros: number, targetReserveMicros: number) {
  if (targetReserveMicros <= 0) return 10_000;
  return Math.max(0, Math.min(10_000, Math.floor(freeMicros * 10_000 / targetReserveMicros)));
}

/** Off-site coverage shrinks as the pool drains below its reserve target. */
export function offsiteCoverageBps(tier: HolderTier | null, poolHealthBps: number) {
  if (!tier) return 0;
  return bps(tier.offsiteCoverageBps, Math.max(0, Math.min(10_000, poolHealthBps)));
}

export function splitFee(feeMicros: number, poolShareBps: number) {
  const pool = bps(feeMicros, poolShareBps);
  return { pool, burn: feeMicros - pool };
}

/**
 * Largest single off-site rebate. Never above a per-wallet payout cap, otherwise a claim
 * bigger than the cap could never be paid and would sit in the queue forever. 0 = no cap.
 */
export function offsiteRebateCapMicros(s: Settings) {
  return Math.min(...[s.maxRebateUsd, s.offsite.perWalletDailyUsd, s.offsite.perWalletWeeklyUsd].filter((cap, i) => i === 0 || cap > 0).map(micros));
}

/** The largest rebate an on-site order can ever cost: coverage of the whole price, capped. */
export const maxLiability = (priceMicros: number, coverageBps: number, capMicros: number) => Math.min(capMicros, bps(priceMicros, coverageBps));

export function quote(priceUsd: number, tier: HolderTier | null, settings: Settings, poolFreeMicros: number): Quote {
  const priceMicros = micros(priceUsd), feeMicros = bps(priceMicros, settings.feeBps);
  const base = { priceMicros, feeMicros, totalMicros: priceMicros + feeMicros, tier };
  const none = (reason: string): Quote => ({ ...base, coverageBps: 0, maxRebateMicros: 0, protected: false, reason });
  if (settings.paused) return none('Protection is paused.');
  if (settings.pausedPrices.includes(priceUsd)) return none('Protection for this pack is paused.');
  if (!tier) return none('Hold more of the token to qualify for protection.');
  const coverageBps = tier.onsiteCoverageBps, maxRebate = maxLiability(priceMicros, coverageBps, micros(settings.maxRebateUsd));
  if (maxRebate > poolFreeMicros) return none('The protection pool is full right now. Try a smaller pack or check back soon.');
  return { ...base, coverageBps, maxRebateMicros: maxRebate, protected: true, reason: null };
}

export type Sample = { priceUsd: number; valueUsd: number };
export type Distribution = { priceUsd: number; n: number; meanValueRatio: number; medianValueRatio: number; p10: number; p90: number; hitRate: number; expectedLossRatio: number };

const percentile = (sorted: number[], p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;

/** Summarizes pulls for one pack price. expectedLossRatio = E[max(0, P − V)] / P. */
export function distribution(samples: Sample[]): Distribution[] {
  const groups = new Map<number, number[]>();
  for (const s of samples) if (s.priceUsd > 0 && Number.isFinite(s.valueUsd)) groups.set(s.priceUsd, [...(groups.get(s.priceUsd) ?? []), s.valueUsd / s.priceUsd]);
  return [...groups].sort(([a], [b]) => a - b).map(([priceUsd, ratios]) => {
    const sorted = [...ratios].sort((a, b) => a - b), n = sorted.length;
    return {
      priceUsd, n,
      meanValueRatio: sorted.reduce((s, r) => s + r, 0) / n,
      medianValueRatio: percentile(sorted, 0.5), p10: percentile(sorted, 0.1), p90: percentile(sorted, 0.9),
      hitRate: sorted.filter(r => r >= 1).length / n,
      expectedLossRatio: sorted.reduce((s, r) => s + Math.max(0, 1 - r), 0) / n,
    };
  });
}

/**
 * Smallest fee (bps of pack price) at which the pool's share of the fee, plus any
 * per-pack creator-fee subsidy, covers the expected rebate at this coverage.
 */
export function requiredFeeBps(coverageBps: number, expectedLossRatio: number, poolShareBps: number, subsidyBpsPerPack = 0) {
  const cost = coverageBps * expectedLossRatio - subsidyBpsPerPack;
  if (cost <= 0) return 0;
  if (poolShareBps <= 0) return Infinity;
  return Math.ceil(cost * 10_000 / poolShareBps);
}

/** Problems that make a settings change unsafe to save. */
export function settingsProblems(s: Settings, calibration: Distribution[] = [], packsPerDay = 0): string[] {
  const problems: string[] = [];
  if (!s.tiers.length) problems.push('Define at least one holder tier.');
  const sorted = [...s.tiers].sort((a, b) => a.minSupplyPpm - b.minSupplyPpm);
  for (const [i, t] of sorted.entries()) {
    if (t.offsiteCoverageBps >= t.onsiteCoverageBps && t.onsiteCoverageBps > 0) problems.push(`${t.name}: off-site coverage must be lower than on-site coverage.`);
    if (t.onsiteCoverageBps > 10_000 || t.offsiteCoverageBps > 10_000) problems.push(`${t.name}: coverage cannot exceed 100%.`);
    const prev = sorted[i - 1];
    if (prev && (t.onsiteCoverageBps < prev.onsiteCoverageBps || t.offsiteCoverageBps < prev.offsiteCoverageBps)) problems.push(`${t.name}: a larger tier cannot have lower coverage than ${prev.name}.`);
    if (prev && t.minSupplyPpm === prev.minSupplyPpm) problems.push(`${t.name} and ${prev.name} have the same minimum balance.`);
  }
  if (new Set(s.tiers.map(t => t.id)).size !== s.tiers.length) problems.push('Tier IDs must be unique.');
  if (s.poolShareBps < 0 || s.poolShareBps > 10_000) problems.push('Pool share must be between 0% and 100%.');
  // Fee guardrail: only enforced once calibration data exists for a price.
  const subsidy = packsPerDay > 0 ? Math.floor(s.creatorFeeBudgetUsdPerDay * 10_000 / packsPerDay) : 0;
  for (const d of calibration) {
    if (d.n < 30) continue;
    const top = Math.max(0, ...s.tiers.map(t => t.onsiteCoverageBps));
    const needed = requiredFeeBps(top, d.expectedLossRatio, s.poolShareBps, Math.floor(subsidy / d.priceUsd));
    if (needed > s.feeBps) problems.push(`$${d.priceUsd} packs: ${top / 100}% coverage needs a fee of at least ${(needed / 100).toFixed(1)}% at a ${s.poolShareBps / 100}% pool share (expected loss ${(d.expectedLossRatio * 100).toFixed(1)}% of price).`);
  }
  return problems;
}
