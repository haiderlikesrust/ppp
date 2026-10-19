import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { setup, settle, user } from './helpers';
import { createServices } from '../server/services';
import { rebateMicros, micros } from '../shared/protection';

test('happy path: pay, buy, deliver, auto-rebate, fee split, reservation released', async () => {
  const s = await setup(), { wallet } = await user(s, 3_000);
  const poolBefore = await s.pool.balance();
  const { order, transaction } = await s.orders.create(wallet, 25);
  assert.equal(order.status, 'awaiting_payment');
  assert.equal(order.totalUsd, 27.5);
  assert.equal(await s.pool.reserved(), micros(12.5), '50% of $25 reserved');
  assert.ok(VersionedTransaction.deserialize(Buffer.from(transaction, 'base64')));
  await s.orders.pay(wallet, order.id, 'practice');
  const done = await settle(s, order.id);
  assert.equal(done.status, 'complete', done.message ?? '');
  assert.ok(done.card);
  const expected = rebateMicros(micros(25), micros(done.valueUsd!), 5_000, micros(12.5));
  assert.equal(micros(done.rebateUsd!), expected);
  assert.equal(await s.pool.reserved(), 0);
  s.pool.invalidate();
  assert.equal(await s.pool.balance(), poolBefore - expected, 'rebate paid from the pool');
  const ledger = (await s.db.query("SELECT bucket,kind,amount_micros::text AS a FROM ledger WHERE ref=$1 ORDER BY id", [order.id])).rows;
  assert.deepEqual(ledger.filter(r => r.kind === 'fee-share').map(r => [r.bucket, Number(r.a)]).sort(), [['burn', 1_250_000], ['pool', 1_250_000]]);
  assert.equal(Number((await s.db.query("SELECT rebate_micros::text AS r FROM pulls WHERE order_id=$1", [order.id])).rows[0].r), expected);
  await s.db.close();
});

test('a wallet without a tier cannot buy protection, and only one unpaid order is allowed', async () => {
  const s = await setup(), poor = await user(s, 0), { wallet } = await user(s, 3_000);
  await assert.rejects(s.orders.create(poor.wallet, 25), /Hold more/);
  await s.orders.create(wallet, 25);
  await assert.rejects(s.orders.create(wallet, 50), /current order/);
  await s.db.close();
});

test('protection is refused when the pool cannot reserve the maximum rebate', async () => {
  const s = await setup(), { wallet } = await user(s, 20_000);
  s.solana.usdc.set(s.solana.poolAddress, BigInt(micros(100)));
  s.pool.invalidate();
  await assert.rejects(s.orders.create(wallet, 500), /pool is full/);
  const ok = await s.orders.create(wallet, 50);
  assert.equal(ok.order.coverageBps, 10_000);
  await s.db.close();
});

test('unpaid orders expire and release their reservation', async () => {
  const s = await setup(), { wallet } = await user(s);
  s.solana.paymentLifetimeMs = -1;
  const { order } = await s.orders.create(wallet, 25);
  const done = await settle(s, order.id);
  assert.equal(done.status, 'expired');
  assert.equal(await s.pool.reserved(), 0);
  await s.db.close();
});

test('a pack that sells out after payment is refunded in full', async () => {
  const s = await setup(), { wallet } = await user(s);
  const { order } = await s.orders.create(wallet, 25);
  await s.orders.pay(wallet, order.id, 'practice');
  s.packs.soldOut.add(25);
  const done = await settle(s, order.id);
  assert.equal(done.status, 'refunded');
  assert.equal(await s.solana.usdcBalance(wallet), BigInt(micros(27.5)));
  assert.equal(await s.pool.reserved(), 0);
  await s.db.close();
});

test('selling tokens between quote and settlement lowers the rebate', async () => {
  const s = await setup(), { wallet } = await user(s, 20_000);
  const { order } = await s.orders.create(wallet, 25);
  await s.orders.pay(wallet, order.id, 'practice');
  s.solana.setHolderPpm(wallet, 3_000);
  const done = await settle(s, order.id);
  assert.equal(done.coverageBps, 5_000, 'settled at the lower tier');
  await s.db.close();
});

test('a restart mid-order resumes from the database without paying twice', async () => {
  const s = await setup(), { wallet } = await user(s);
  s.packs.pendingCalls = 2;
  const { order } = await s.orders.create(wallet, 25);
  await s.orders.pay(wallet, order.id, 'practice');
  await s.orders.step(); await s.orders.step();
  assert.equal((await s.orders.get(order.id)).status, 'buying');
  // Same database and adapters, new service objects: like a process restart.
  const restarted = await createServices({ db: s.db, solana: s.solana, packs: s.packs });
  const done = await settle({ ...s, orders: restarted.orders }, order.id);
  assert.equal(done.status, 'complete');
  const rebates = (await s.db.query("SELECT COUNT(*)::int AS n FROM ledger WHERE kind='rebate' AND ref=$1", [order.id])).rows[0].n;
  assert.ok(rebates <= 1);
  await s.db.close();
});

test('someone else cannot pay or read your order', async () => {
  const s = await setup(), { wallet } = await user(s), other = Keypair.generate().publicKey.toBase58();
  const { order } = await s.orders.create(wallet, 25);
  await assert.rejects(s.orders.pay(other, order.id, 'practice'), /not found/);
  await assert.rejects(s.orders.get(order.id, other), /not found/);
  await s.db.close();
});

test('the loss-ratio breaker pauses a pack price that keeps losing money', async () => {
  const s = await setup({ breaker: { lossRatioBps: 100, minPacks: 2, windowDays: 7 } }), { wallet } = await user(s, 20_000);
  for (let i = 0; i < 6 && !s.settings.current.pausedPrices.includes(25); i++) {
    const { order } = await s.orders.create(wallet, 25);
    await s.orders.pay(wallet, order.id, 'practice');
    await settle(s, order.id);
  }
  assert.deepEqual(s.settings.current.pausedPrices, [25]);
  await assert.rejects(s.orders.create(wallet, 25), /paused/);
  await s.db.close();
});
