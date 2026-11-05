import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settle, setup, user } from './helpers';
import { sellBpsFor, SELLING } from '../shared/packs';
import { micros, rebateMicros, sellValueMicros } from '../shared/protection';

test('every pack on sale has a sell-back rate, and a machine without one uses the lowest seen', () => {
  for (const pack of SELLING) assert.ok(sellBpsFor(pack.code) >= 8_500 && sellBpsFor(pack.code) <= 9_300, pack.code);
  assert.equal(sellBpsFor('pokemon_25'), 8_500);
  assert.equal(sellBpsFor('pokemon_100'), 9_300);
  assert.equal(sellBpsFor('something_new'), 8_500);
});

test('a live offer sets the sell price; without one the machine\'s usual rate does', () => {
  assert.equal(sellValueMicros(micros(100), 9_000, micros(91)), micros(91));
  assert.equal(sellValueMicros(micros(100), 9_000, null), micros(90));
  assert.equal(sellValueMicros(micros(100), 9_000), micros(90));
});

test('a bad offer can\'t inflate a rebate: one far too low or above insured value is ignored', () => {
  assert.equal(sellValueMicros(micros(100), 9_000, micros(1)), micros(90), 'a near-zero quote would pay out almost the whole pack');
  assert.equal(sellValueMicros(micros(100), 9_000, micros(76.5)), micros(76.5), 'the lowest offer still trusted');
  assert.equal(sellValueMicros(micros(100), 9_000, micros(76)), micros(90));
  assert.equal(sellValueMicros(micros(100), 9_000, micros(120)), micros(90));
});

test('a card insured above the pack can still earn a rebate when it sells for less than the pack', () => {
  const sell = sellValueMicros(micros(26), 8_500, null);
  assert.equal(sell, micros(22.1));
  assert.equal(rebateMicros(micros(25), micros(26), 5_000, micros(25)), 0, 'the old rule paid nothing');
  assert.equal(rebateMicros(micros(25), sell, 5_000, micros(25)), micros(1.45));
});

test('an order uses the live offer, keeps it on the order, and pays that gap', async () => {
  const s = await setup(), { wallet } = await user(s, 10_000);
  const quote = s.packs.buybackQuote.bind(s.packs);
  s.packs.buybackQuote = (async (mint: string) => { const q = await quote(mint); return { ...q, amountMicros: Math.round(q.amountMicros! * 1.02) }; }) as typeof s.packs.buybackQuote;
  const { order } = await s.orders.create(wallet, 'pokemon_25');
  await s.orders.pay(wallet, order.id, 'practice');
  const done = await settle(s, order.id);
  assert.equal(done.status, 'complete', done.message ?? '');
  assert.equal(micros(done.sellUsd!), Math.round(Math.round(micros(done.valueUsd!) * 0.85) * 1.02));
  assert.equal(micros(done.rebateUsd!), rebateMicros(micros(25), micros(done.sellUsd!), 5_000, micros(12.5)));
  await s.db.close();
});

test('an outage at Collector Crypt can\'t hold up a rebate: it falls back to the machine\'s rate', async () => {
  const s = await setup(), { wallet } = await user(s, 10_000);
  s.packs.buybackQuote = async () => { throw new TypeError('fetch failed'); };
  const { order } = await s.orders.create(wallet, 'pokemon_25');
  await s.orders.pay(wallet, order.id, 'practice');
  const done = await settle(s, order.id);
  assert.equal(done.status, 'complete', done.message ?? '');
  assert.equal(micros(done.sellUsd!), Math.floor(micros(done.valueUsd!) * 8_500 / 10_000));
  await s.db.close();
});

test('a paid rebate doesn\'t change if the offer moves after settling', async () => {
  const s = await setup(), { wallet } = await user(s, 10_000);
  const { order } = await s.orders.create(wallet, 'pokemon_25');
  await s.orders.pay(wallet, order.id, 'practice');
  const done = await settle(s, order.id);
  s.packs.buybackQuote = async () => ({ available: true, amountMicros: 1, expiresAt: Date.now() });
  assert.equal((await s.orders.get(order.id)).sellUsd, done.sellUsd);
  await s.db.close();
});

test('stats price risk and rebates from the sell price, and spread pulls across 20 bins', async () => {
  const s = await setup();
  await s.db.query(`INSERT INTO cc_pulls(id,code,value_cents,pulled_at) SELECT 'b-' || i, 'pokemon_100', 10000, $1::bigint + i FROM generate_series(1, 20) AS i`, [Date.now() - 1_000_000]);
  const stat = (await s.feed.stats()).packs.find(p => p.code === 'pokemon_100')!;
  assert.equal(stat.sellBps, 9_300);
  assert.ok(Math.abs(stat.expectedLossRatio - 0.07) < 1e-9, 'a card insured at the pack price sells 7% under it on a 93% machine');
  assert.equal(stat.hitRate, 0, 'so it is not a hit');
  assert.equal(stat.bins.length, 20);
  assert.equal(stat.bins[9], 20, '$93 falls in the $90 to $100 bin');
  await s.db.close();
});
