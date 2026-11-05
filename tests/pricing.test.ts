import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settle, setup, user } from './helpers';
import { DEFAULT_SETTINGS, micros, quote, rebateMicros, riskTerms } from '../shared/protection';

/** Expected loss per pack, read from Collector Crypt's feed on 2026-11-05 (up to 5,000 pulls per machine). */
const MEASURED = { pokemon_25: 0.129, pokemon_50: 0.139, pokemon_100: 0.179, pokemon_250: 0.2, ewatch_250: 0.232, pokemon_500: 0.223, ewatch_500: 0.265, ewatches_500: 0.24 };
const tiers = DEFAULT_SETTINGS.tiers;

test('at every tier on every measured pack, the fee pays the pool at least the expected rebate plus the margin', () => {
  const margin = 1 + DEFAULT_SETTINGS.pricing.marginBps / 10_000;
  for (const [code, expectedLossRatio] of Object.entries(MEASURED)) for (const tier of tiers) {
    const terms = riskTerms(tier.onsiteCoverageBps, { n: 5_000, expectedLossRatio }, DEFAULT_SETTINGS)!;
    const toPool = terms.feeBps * DEFAULT_SETTINGS.poolShareBps / 10_000, rebate = terms.coverageBps * expectedLossRatio;
    assert.ok(toPool >= rebate * margin - 1, `${code} ${tier.name}: pool gets ${toPool}bps, expects to pay ${rebate}bps`);
    assert.ok(terms.feeBps <= DEFAULT_SETTINGS.pricing.maxFeeBps, `${code} ${tier.name}: fee stays under the top fee`);
  }
});

test('a higher tier never gets less coverage on the same pack, and a riskier pack never costs less', () => {
  for (const expectedLossRatio of Object.values(MEASURED)) {
    const terms = tiers.map(t => riskTerms(t.onsiteCoverageBps, { n: 5_000, expectedLossRatio }, DEFAULT_SETTINGS)!);
    for (let i = 1; i < terms.length; i++) assert.ok(terms[i].coverageBps >= terms[i - 1].coverageBps);
  }
  const fee = (r: number) => riskTerms(5_000, { n: 5_000, expectedLossRatio: r }, DEFAULT_SETTINGS)!.feeBps;
  assert.ok(fee(0.25) > fee(0.1));
});

test('when the top fee cannot pay for a tier, coverage drops to a whole percent the fee can pay for', () => {
  const terms = riskTerms(10_000, { n: 5_000, expectedLossRatio: 0.25 }, DEFAULT_SETTINGS)!;
  assert.deepEqual(terms, { feeBps: 2_500, coverageBps: 6_900 });
});

test('a safe pack still pays the lowest fee', () => {
  assert.equal(riskTerms(2_500, { n: 5_000, expectedLossRatio: 0.01 }, DEFAULT_SETTINGS)?.feeBps, DEFAULT_SETTINGS.pricing.minFeeBps);
});

test('too few pulls, pricing off, or no pool share falls back to the flat fee', () => {
  const risk = { n: 5_000, expectedLossRatio: 0.2 };
  assert.equal(riskTerms(5_000, { ...risk, n: 499 }, DEFAULT_SETTINGS), null);
  assert.equal(riskTerms(5_000, null, DEFAULT_SETTINGS), null);
  assert.equal(riskTerms(5_000, risk, { ...DEFAULT_SETTINGS, pricing: { ...DEFAULT_SETTINGS.pricing, enabled: false } }), null);
  assert.equal(riskTerms(5_000, risk, { ...DEFAULT_SETTINGS, poolShareBps: 0 }), null);
  const q = quote(25, tiers[1], DEFAULT_SETTINGS, micros(1_000));
  assert.deepEqual([q.feeBps, q.feeMicros, q.coverageBps, q.riskPriced], [DEFAULT_SETTINGS.feeBps, micros(2.5), 5_000, false]);
});

test('a quote carries the priced fee, the cut coverage and the rebate cap that goes with them', () => {
  const q = quote(100, tiers[2], { ...DEFAULT_SETTINGS, maxRebateUsd: 1_000 }, micros(1_000), 'pokemon_100', { n: 5_000, expectedLossRatio: 0.25 });
  assert.deepEqual([q.feeBps, q.feeMicros, q.totalMicros, q.coverageBps, q.maxRebateMicros, q.riskPriced], [2_500, micros(25), micros(125), 6_900, micros(69), true]);
});

/** Half the pulls are insured at the pack price and half at half of it. On a 93% machine that sells 30.25% under the pack on average. */
async function seedPulls(s: Awaited<ReturnType<typeof setup>>, code: string, priceUsd: number, n = 600) {
  await s.db.query(`INSERT INTO cc_pulls(id,code,value_cents,pulled_at) SELECT 'seed-' || i, $1, CASE WHEN i % 2 = 0 THEN $2::int ELSE $3::int END, $4::bigint + i FROM generate_series(1, $5::int) AS i`, [code, priceUsd * 100, priceUsd * 50, Date.now() - 1_000_000, n]);
}

test('orders buy at the priced terms, and the rebate is paid at the coverage that was sold', async () => {
  const s = await setup({ maxRebateUsd: 1_000 });
  s.solana.fundPool(micros(5_000)); s.pool.invalidate();
  await seedPulls(s, 'pokemon_100', 100);
  const { wallet } = await user(s, 20_000);
  const offered = (await s.orders.quotes(wallet)).find(p => p.code === 'pokemon_100')!.quote;
  assert.deepEqual([offered.feeBps, offered.coverageBps, offered.riskPriced], [2_500, 5_700, true]);
  const { order } = await s.orders.create(wallet, 'pokemon_100');
  assert.deepEqual([order.feeUsd, order.totalUsd, order.coverageBps, order.maxRebateUsd], [25, 125, 5_700, 57]);
  await s.orders.pay(wallet, order.id, 'practice');
  const done = await settle(s, order.id);
  assert.equal(done.status, 'complete', done.message ?? '');
  assert.equal(micros(done.rebateUsd!), rebateMicros(micros(100), micros(done.sellUsd!), 5_700, micros(57)));
  await s.db.close();
});

test('tier exception wallets still pay no fee on a priced pack', async () => {
  const s = await setup({ maxRebateUsd: 1_000 });
  s.solana.fundPool(micros(5_000)); s.pool.invalidate();
  await seedPulls(s, 'pokemon_100', 100);
  const { wallet } = await user(s, 0);
  await s.settings.save({ ...s.settings.current, walletTiers: [{ wallet, tierId: 't3' }] });
  const q = (await s.orders.quotes(wallet)).find(p => p.code === 'pokemon_100')!.quote;
  assert.deepEqual([q.feeMicros, q.coverageBps, q.riskPriced], [0, 10_000, false]);
  await s.db.close();
});

test('stats show each tier the same terms an order would get, and the average rebate at those terms', async () => {
  const s = await setup({ maxRebateUsd: 1_000 });
  await seedPulls(s, 'pokemon_100', 100);
  const stat = (await s.feed.stats()).packs.find(p => p.code === 'pokemon_100')!;
  assert.ok(Math.abs(stat.expectedLossRatio - 0.3025) < 1e-9);
  assert.deepEqual(stat.terms.t3, { feeBps: 2_500, coverageBps: 5_700, riskPriced: true });
  assert.equal(stat.avgRebateUsd.t3, 17.24);
  await s.db.close();
});
