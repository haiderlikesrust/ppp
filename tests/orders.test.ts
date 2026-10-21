import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { setup, settle, user } from './helpers';
import { createServices } from '../server/services';
import { rebateMicros, micros, settingsProblems } from '../shared/protection';
import { settingsSchema } from '../server/settings';

test('happy path: pay, buy, deliver, auto-rebate, fee split, reservation released', async () => {
  const s = await setup(), { wallet } = await user(s, 10_000);
  const poolBefore = await s.pool.balance();
  const { order, transaction } = await s.orders.create(wallet, 'pokemon_25');
  assert.equal(order.status, 'awaiting_payment');
  assert.equal(order.totalUsd, 27.5);
  assert.equal(await s.pool.reserved(), 0, 'nothing is reserved until the user pays');
  assert.ok(VersionedTransaction.deserialize(Buffer.from(transaction, 'base64')));
  await s.orders.pay(wallet, order.id, 'practice');
  assert.equal(await s.pool.reserved(), micros(12.5), '50% of $25 reserved once paid');
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
  const s = await setup(), poor = await user(s, 0), { wallet } = await user(s, 10_000);
  await assert.rejects(s.orders.create(poor.wallet, 'pokemon_25'), /Hold more/);
  await s.orders.create(wallet, 'pokemon_25');
  await assert.rejects(s.orders.create(wallet, 'pokemon_50'), /current order/);
  await s.db.close();
});

test('protection is refused when the pool cannot reserve the maximum rebate', async () => {
  const s = await setup(), { wallet } = await user(s, 20_000);
  s.solana.usdc.set(s.solana.poolAddress, BigInt(micros(100)));
  s.pool.invalidate();
  await assert.rejects(s.orders.create(wallet, 'pokemon_500'), /pool is full/);
  const ok = await s.orders.create(wallet, 'pokemon_50');
  assert.equal(ok.order.coverageBps, 10_000);
  await s.db.close();
});

test('a tier exception lets a wallet open packs at its tier whatever it holds; a better held tier still wins', async () => {
  const s = await setup(), granted = await user(s, 0), holder = await user(s, 20_000), other = await user(s, 0);
  await s.settings.save({ ...s.settings.current, walletTiers: [{ wallet: granted.wallet, tierId: 't3' }, { wallet: holder.wallet, tierId: 't1' }] });
  await assert.rejects(s.orders.create(other.wallet, 'pokemon_50'), /Hold more|lowest balance/, 'no exception, no tier');

  const { order } = await s.orders.create(granted.wallet, 'pokemon_50');
  assert.equal(order.coverageBps, 10_000, 'quoted at the granted Whale tier with no holdings');
  assert.deepEqual([order.feeUsd, order.totalUsd], [0, 50], 'exception wallets pay no protection fee');
  assert.equal((await s.orders.quotes(granted.wallet)).find(p => p.code === 'pokemon_50')?.quote.feeMicros, 0);
  assert.equal((await s.orders.quotes(other.wallet)).find(p => p.code === 'pokemon_50')?.quote.feeMicros, 5_000_000, 'and only them');
  await s.orders.pay(granted.wallet, order.id, 'practice');
  const done = await settle(s, order.id);
  assert.equal(done.status, 'complete');
  assert.equal(done.coverageBps, 10_000, 'and settled at it');
  const view = await s.holders.view(granted.wallet, granted.activatedAt);
  assert.equal(view.tier?.id, 't3', 'the site shows the granted tier for packs opened here');
  assert.equal(view.heldTier, null, 'and the held tier for claims, which go by holdings');
  assert.equal((await s.orders.create(holder.wallet, 'pokemon_50')).order.coverageBps, 10_000, 'a Whale holder given a Shrimp exception stays a Whale');

  assert.throws(() => settingsSchema.parse({ ...s.settings.current, walletTiers: [{ wallet: 'not a wallet', tierId: 't3' }] }));
  assert.match(settingsProblems({ ...s.settings.current, walletTiers: [{ wallet: granted.wallet, tierId: 'gone' }] }).join(' '), /tier that no longer exists/);
  await s.db.close();
});

test('cooldowns: wallets wait between packs; a custom time wins; tier exceptions skip the default', async () => {
  const s = await setup(), a = await user(s, 20_000), vip = await user(s, 0), slow = await user(s, 20_000), quoter = await user(s, 20_000);
  await s.settings.save({ ...s.settings.current, walletTiers: [{ wallet: vip.wallet, tierId: 't3' }], cooldown: { minutes: 30, wallets: [{ wallet: slow.wallet, minutes: 120 }] } });
  const openOne = async (wallet: string) => { const { order } = await s.orders.create(wallet, 'pokemon_25'); await s.orders.pay(wallet, order.id, 'practice'); return settle(s, order.id); };
  const back = (wallet: string, minutes: number) => s.db.query('UPDATE orders SET created_at=created_at-$2 WHERE wallet=$1', [wallet, minutes * 60_000]);

  assert.equal(await s.orders.nextPackAt(a.wallet), null, 'no pack yet, no wait');
  assert.equal((await openOne(a.wallet)).status, 'complete');
  const next = await s.orders.nextPackAt(a.wallet);
  assert.ok(next && next > Date.now() + 29 * 60_000 && next <= Date.now() + 30 * 60_000, 'the default 30 minutes from the last pack');
  await assert.rejects(s.orders.create(a.wallet, 'pokemon_25'), /next pack in 30m\. Nothing was charged/);
  await back(a.wallet, 31);
  assert.equal(await s.orders.nextPackAt(a.wallet), null, 'free again after 30 minutes');

  await openOne(vip.wallet);
  assert.equal(await s.orders.nextPackAt(vip.wallet), null, 'a tier exception skips the default');
  await openOne(slow.wallet);
  await back(slow.wallet, 60);
  assert.ok(await s.orders.nextPackAt(slow.wallet), 'its own 2 hours, not the default 30 minutes');
  await s.db.query("UPDATE orders SET status='refunded' WHERE wallet=$1", [slow.wallet]);
  assert.equal(await s.orders.nextPackAt(slow.wallet), null, 'a refunded pack does not count');

  await s.orders.create(quoter.wallet, 'pokemon_25');
  assert.equal(await s.orders.nextPackAt(quoter.wallet), null, 'an unpaid quote does not start a wait');
  await s.db.close();
});

test('several packs open as separate orders, each with its own payment, receipt and rebate', async () => {
  const s = await setup(), { wallet } = await user(s, 20_000);
  const { orders, transactions } = await s.orders.createMany(wallet, 'pokemon_25', 3);
  assert.equal(orders.length, 3);
  assert.equal(new Set(transactions).size, 3, 'one payment per pack');
  assert.ok(orders.every(o => o.status === 'awaiting_payment' && o.totalUsd === 27.5));
  await assert.rejects(s.orders.create(wallet, 'pokemon_25'), /Finish or let your current order expire/, 'nothing else starts until they are paid');
  for (const o of orders) await s.orders.pay(wallet, o.id, 'practice');
  const done = [];
  for (const o of orders) done.push(await settle(s, o.id));
  assert.deepEqual(done.map(o => o.status), ['complete', 'complete', 'complete']);
  assert.equal(new Set(done.map(o => o.paymentSignature)).size, 3, 'three payment receipts');
  const batch = (await s.db.query<{ data: any }>('SELECT data FROM orders WHERE wallet=$1 ORDER BY (data->\'batch\'->>\'index\')::int', [wallet])).rows.map(r => r.data.batch);
  assert.deepEqual(batch.map(b => [b.index, b.count]), [[0, 3], [1, 3], [2, 3]]);
  assert.equal(new Set(batch.map(b => b.id)).size, 1, 'one batch');
  await s.db.close();
});

test('several packs are refused up front when the pool, the wallet or a cooldown cannot take them all', async () => {
  const s = await setup(), { wallet } = await user(s, 20_000), slow = await user(s, 20_000);
  await assert.rejects(s.orders.createMany(wallet, 'pokemon_25', 6), /between 1 and 5/);
  s.solana.usdc.set(s.solana.poolAddress, BigInt(micros(60)));
  s.pool.invalidate();
  await assert.rejects(s.orders.createMany(wallet, 'pokemon_25', 3), /can cover 2 of these packs right now\. Try 2/, 'each $25 Whale pack can need $25');
  assert.equal((await s.orders.createMany(wallet, 'pokemon_25', 2)).orders.length, 2);

  await s.settings.save({ ...s.settings.current, cooldown: { minutes: 0, wallets: [{ wallet: slow.wallet, minutes: 10 }] } });
  assert.equal(s.orders.maxPerOpen(slow.wallet), 1);
  assert.equal(s.orders.maxPerOpen(wallet), 5);
  await assert.rejects(s.orders.createMany(slow.wallet, 'pokemon_25', 2), /one pack at a time/);
  await s.db.close();
});

test('unpaid orders expire and release their reservation', async () => {
  const s = await setup(), { wallet } = await user(s);
  s.solana.paymentLifetimeMs = -1;
  const { order } = await s.orders.create(wallet, 'pokemon_25');
  const done = await settle(s, order.id);
  assert.equal(done.status, 'expired');
  assert.equal(await s.pool.reserved(), 0);
  await s.db.close();
});

test('a pack that sells out after payment is refunded in full', async () => {
  const s = await setup(), { wallet } = await user(s);
  const { order } = await s.orders.create(wallet, 'pokemon_25');
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
  const { order } = await s.orders.create(wallet, 'pokemon_25');
  await s.orders.pay(wallet, order.id, 'practice');
  s.solana.setHolderPpm(wallet, 10_000);
  const done = await settle(s, order.id);
  assert.equal(done.coverageBps, 5_000, 'settled at the lower tier');
  await s.db.close();
});

test('a restart mid-order resumes from the database without paying twice', async () => {
  const s = await setup(), { wallet } = await user(s);
  s.packs.pendingCalls = 2;
  const { order } = await s.orders.create(wallet, 'pokemon_25');
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
  const { order } = await s.orders.create(wallet, 'pokemon_25');
  await assert.rejects(s.orders.pay(other, order.id, 'practice'), /not found/);
  await assert.rejects(s.orders.get(order.id, other), /not found/);
  await s.db.close();
});

test('the loss-ratio breaker pauses a pack price that keeps losing money', async () => {
  const s = await setup({ breaker: { lossRatioBps: 100, minPacks: 2, windowDays: 7 } }), { wallet } = await user(s, 20_000);
  for (let i = 0; i < 6 && !s.settings.current.pausedPacks.includes('pokemon_25'); i++) {
    const { order } = await s.orders.create(wallet, 'pokemon_25');
    await s.orders.pay(wallet, order.id, 'practice');
    await settle(s, order.id);
  }
  assert.deepEqual(s.settings.current.pausedPacks, ['pokemon_25']);
  await assert.rejects(s.orders.create(wallet, 'pokemon_25'), /paused/);
  await s.db.close();
});

test('the breaker counts fee-free packs at the listed fee, so a fee waiver alone does not pause a pack', async () => {
  const s = await setup({ breaker: { lossRatioBps: 1_000_000, minPacks: 2, windowDays: 7 } }), vip = await user(s, 0);
  await s.settings.save({ ...s.settings.current, walletTiers: [{ wallet: vip.wallet, tierId: 't3' }] });
  for (let i = 0; i < 3; i++) {
    const { order } = await s.orders.create(vip.wallet, 'pokemon_100');
    await s.orders.pay(vip.wallet, order.id, 'practice');
    assert.equal((await settle(s, order.id)).feeUsd, 0);
  }
  const rebate = (usd: number) => s.db.query("UPDATE orders SET data = data || jsonb_build_object('rebateMicros', $1::bigint)", [micros(usd)]);
  await rebate(20);
  await s.settings.save({ ...s.settings.current, breaker: { lossRatioBps: 100_000, minPacks: 2, windowDays: 7 } });
  // At the listed 10% fee, each $100 pack would have put $5 into the pool: $20 back on each is 400%.
  const stats = (await s.pool.byPack()).find(r => r.code === 'pokemon_100')!;
  assert.deepEqual([stats.feesMicros, stats.lossRatioBps, stats.breakerRatioBps], [0, Infinity, 40_000], 'the real ratio stays real');
  assert.equal(await s.pool.checkBreaker('pokemon_100'), false, '400% is under the 1,000% limit');
  await rebate(60);
  assert.equal(await s.pool.checkBreaker('pokemon_100'), true, '1,200% at the listed fee still pauses it');
  await s.db.close();
});
