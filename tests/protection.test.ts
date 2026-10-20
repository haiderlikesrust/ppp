import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, distribution, healthBps, holderTier, maxLiability, micros, offsiteCoverageBps, quote, rebateMicros, requiredFeeBps, settingsProblems, splitFee } from '../shared/protection';

const supply = 1_000_000_000_000_000n, tiers = DEFAULT_SETTINGS.tiers;
const ofSupply = (ppm: number) => supply * BigInt(ppm) / 1_000_000n;

test('holder tiers use share of supply with inclusive boundaries', () => {
  assert.equal(holderTier(0n, supply, tiers), null);
  assert.equal(holderTier(ofSupply(999), supply, tiers), null, 'just under 0.1%');
  assert.equal(holderTier(ofSupply(1_000), supply, tiers)?.id, 't1', 'Holder at 0.1%');
  assert.equal(holderTier(ofSupply(9_999), supply, tiers)?.id, 't1');
  assert.equal(holderTier(ofSupply(10_000), supply, tiers)?.id, 't2', 'Collector at 1%');
  assert.equal(holderTier(ofSupply(19_999), supply, tiers)?.id, 't2');
  assert.equal(holderTier(ofSupply(20_000), supply, tiers)?.id, 't3', 'Whale at 2%');
  assert.equal(holderTier(ofSupply(50_000), supply, tiers)?.id, 't3');
  assert.equal(holderTier(ofSupply(50_000), 0n, tiers), null);
});

test('rebate covers a share of the loss only, floors to micros and respects the cap', () => {
  assert.equal(rebateMicros(micros(25), micros(10), 5_000, micros(250)), micros(7.5));
  assert.equal(rebateMicros(micros(25), micros(25), 10_000, micros(250)), 0, 'no loss, no rebate');
  assert.equal(rebateMicros(micros(25), micros(80), 10_000, micros(250)), 0, 'hits never pay');
  assert.equal(rebateMicros(micros(500), 0, 10_000, micros(250)), micros(250), 'capped');
  assert.equal(rebateMicros(micros(25), -5, 10_000, micros(250)), micros(25), 'negative values clamp to zero');
  assert.equal(rebateMicros(3, 0, 3_333, 1_000), 0, 'floors fractional micros');
});

test('quote prices the fee on top and refuses protection it cannot reserve', () => {
  const t2 = tiers[1];
  const ok = quote(25, t2, DEFAULT_SETTINGS, micros(1_000));
  assert.deepEqual([ok.priceMicros, ok.feeMicros, ok.totalMicros, ok.coverageBps, ok.maxRebateMicros, ok.protected], [micros(25), micros(2.5), micros(27.5), 5_000, micros(12.5), true]);
  assert.equal(quote(25, null, DEFAULT_SETTINGS, micros(1_000)).protected, false);
  assert.match(quote(25, t2, DEFAULT_SETTINGS, micros(12)).reason!, /pool is full/);
  assert.match(quote(25, t2, { ...DEFAULT_SETTINGS, pausedPrices: [25] }, micros(1_000)).reason!, /paused/);
  assert.equal(quote(500, tiers[2], DEFAULT_SETTINGS, micros(1_000)).maxRebateMicros, micros(250), 'liability is capped');
  assert.equal(maxLiability(micros(100), 10_000, micros(250)), micros(100));
});

test('every default tier pays less off-site than on-site', () => {
  for (const t of DEFAULT_SETTINGS.tiers) assert.ok(t.offsiteCoverageBps < t.onsiteCoverageBps, t.name);
});

test('off-site coverage scales down with pool health', () => {
  assert.equal(healthBps(micros(10_000), micros(5_000)), 10_000);
  assert.equal(healthBps(micros(2_500), micros(5_000)), 5_000);
  assert.equal(healthBps(-5, micros(5_000)), 0);
  assert.equal(offsiteCoverageBps(tiers[1], 10_000), 3_500);
  assert.equal(offsiteCoverageBps(tiers[1], 5_000), 1_750);
  assert.equal(offsiteCoverageBps(tiers[1], 0), 0);
  assert.equal(offsiteCoverageBps(null, 10_000), 0);
});

test('fee split sends the remainder to burn so no micro is lost', () => {
  assert.deepEqual(splitFee(2_500_001, 5_000), { pool: 1_250_000, burn: 1_250_001 });
  assert.deepEqual(splitFee(1_000, 10_000), { pool: 1_000, burn: 0 });
});

test('calibration math: expected loss counts only losses, and the guardrail flags underpriced coverage', () => {
  const [d] = distribution([{ priceUsd: 25, valueUsd: 5 }, { priceUsd: 25, valueUsd: 20 }, { priceUsd: 25, valueUsd: 100 }, { priceUsd: 25, valueUsd: 25 }]);
  assert.equal(d.n, 4);
  assert.equal(d.hitRate, 0.5);
  assert.ok(Math.abs(d.expectedLossRatio - (0.8 + 0.2) / 4) < 1e-9);
  // 100% coverage × 25% expected loss, with half the fee going to the pool, needs a 50% fee.
  assert.equal(requiredFeeBps(10_000, 0.25, 5_000), 5_000);
  assert.equal(requiredFeeBps(10_000, 0.25, 5_000, 2_500), 0, 'a subsidy can cover it');
  assert.equal(requiredFeeBps(10_000, 0.25, 0), Infinity);
  const big = Array.from({ length: 40 }, (_, i) => ({ priceUsd: 25, valueUsd: i % 2 ? 10 : 40 }));
  assert.ok(settingsProblems(DEFAULT_SETTINGS, distribution(big)).some(p => /needs a fee/.test(p)));
  assert.deepEqual(settingsProblems(DEFAULT_SETTINGS), []);
});

test('settings validation keeps off-site coverage below on-site and tiers monotonic', () => {
  const bad = { ...DEFAULT_SETTINGS, tiers: [{ ...tiers[0], offsiteCoverageBps: 3_000 }, { ...tiers[1], onsiteCoverageBps: 1_000, offsiteCoverageBps: 500 }] };
  const problems = settingsProblems(bad);
  assert.ok(problems.some(p => /lower than on-site/.test(p)));
  assert.ok(problems.some(p => /cannot have lower coverage/.test(p)));
});
