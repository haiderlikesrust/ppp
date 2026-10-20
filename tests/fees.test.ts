import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers';
import { PriceImpactTooHigh, swap } from '../server/swap';
import { DEFAULT_SETTINGS } from '../shared/protection';
import type { Chain } from '../server/chain';

test('creator fees are claimed when due; a failing claim backs off and is logged once', async () => {
  const s = await setup();
  Object.defineProperty(s.solana, 'live', { value: true });
  assert.equal(await s.treasury.creatorFeesDue(), false, 'nothing has built up');
  s.solana.feeResults.push({ id: 'fees:1', usdcMicros: 5_000_000, signature: 'sig' });
  assert.equal(await s.treasury.creatorFeesDue(), true);
  assert.equal((await s.treasury.creatorFees(true))?.usdcMicros, 5_000_000);

  s.solana.feeResults.push(new Error('No supported swap route.'), new Error('No supported swap route.'));
  await assert.rejects(s.treasury.creatorFees(true), /No supported swap route/);
  assert.equal(await s.treasury.creatorFeesDue(), false, 'waits before retrying');
  (s.treasury as unknown as { fees: { until: number } }).fees.until = 0;
  await assert.rejects(s.treasury.creatorFees(true), /No supported swap route/);
  const logged = (await s.db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM audit WHERE event='creator-fees-error'")).rows[0].n;
  assert.equal(logged, 1, 'the same error is logged once');
  await s.db.close();
});

test('a fee sale is refused before signing when it would move the price too much', async () => {
  const jobs = new Map<string, any>();
  const chain = {
    address: 'Pool1111111111111111111111111111111111111111',
    jobs: { get: async (id: string) => jobs.get(id) ?? null, put: async (id: string, kind: string, status: string, data: any) => { jobs.set(id, { id, kind, status, data }); } },
    execute: async (_id: string, _kind: string, build: () => Promise<unknown>) => { await build(); return 'signature'; },
    tokenDelta: async () => 1_000_000n,
  } as unknown as Chain;
  const original = globalThis.fetch;
  const order = (impact: string) => ({ router: 'metis', inputMint: 'CARDS', outputMint: 'USDC', inAmount: '500', outAmount: '1000000', otherAmountThreshold: '990000', slippageBps: 100, priceImpactPct: impact, transaction: null, errorMessage: 'stop before building' });
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify(order('-0.051')))) as typeof fetch;
    await assert.rejects(swap(chain, 'a', 'CARDS', 'USDC', 500n, DEFAULT_SETTINGS, 1n, 300), PriceImpactTooHigh);
    globalThis.fetch = (async () => new Response(JSON.stringify(order('-0.004')))) as typeof fetch;
    // 0.4% is under the 3% cap, so it gets past the impact check (and stops at the missing transaction).
    await assert.rejects(swap(chain, 'b', 'CARDS', 'USDC', 500n, DEFAULT_SETTINGS, 1n, 300), /stop before building/);
  } finally { globalThis.fetch = original; }
});
