import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settle, setup, user } from './helpers';
import { createApp } from '../server/app';
import { portfolio } from '../server/portfolio';
import { micros } from '../shared/protection';

async function opened(s: Awaited<ReturnType<typeof setup>>, wallet: string, code = 'pokemon_25') {
  const { order } = await s.orders.create(wallet, code);
  await s.orders.pay(wallet, order.id, 'practice');
  return settle(s, order.id);
}

test('a held card counts at its insured value; a sold one counts at its sale, and each pull nets out', async () => {
  const s = await setup(), { wallet } = await user(s, 10_000);
  const held = await opened(s, wallet), sold = await opened(s, wallet);
  const offer = await s.orders.sellStart(wallet, sold.id);
  await s.orders.sellSubmit(wallet, sold.id, `practice-sale:${sold.card!.mint}`);

  const { items, totals } = await portfolio(s.db, wallet);
  assert.equal(items.length, 2);
  const keep = items.find(i => i.id === held.id)!, gone = items.find(i => i.id === sold.id)!;
  assert.equal(keep.soldUsd, null);
  assert.equal(keep.netUsd, Math.round((held.valueUsd! + held.rebateUsd! - held.totalUsd) * 100) / 100);
  assert.equal(gone.soldUsd, offer.amountUsd);
  assert.equal(gone.netUsd, Math.round((offer.amountUsd + sold.rebateUsd! - sold.totalUsd) * 100) / 100);
  assert.equal(totals.pulls, 2);
  assert.equal(totals.spentUsd, 50);
  assert.equal(totals.feesUsd, 5);
  assert.equal(totals.heldCards, 1);
  assert.equal(totals.heldUsd, held.valueUsd);
  assert.equal(totals.soldUsd, Math.round(offer.amountUsd * 100) / 100);
  assert.equal(totals.netUsd, Math.round((keep.netUsd + gone.netUsd) * 100) / 100);
  await s.db.close();
});

test('paid off-site claims are in the portfolio, with no fee; unpaid ones and refunds are not', async () => {
  const s = await setup(), { wallet } = await user(s, 10_000), now = Date.now();
  const claim = (memo: string, status: string) => s.db.query('INSERT INTO claims(memo,wallet,status,price_micros,value_micros,coverage_bps,rebate_micros,pulled_at,created_at,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$9)',
    [memo, wallet, status, micros(50), micros(30), 3_500, micros(7), now, JSON.stringify({ nft: 'mint', packType: 'pokemon_50' })]);
  await claim('paid-one', 'paid'); await claim('still-queued', 'queued');
  const { items, totals } = await portfolio(s.db, wallet);
  assert.deepEqual(items.map(i => [i.id, i.source, i.code, i.feeUsd, i.netUsd]), [['paid-one', 'offsite', 'pokemon_50', 0, -13]]);
  assert.equal(totals.rebatesUsd, 7);
  await s.db.close();
});

test('a portfolio belongs to its wallet: sign-in required, and nobody else\'s pulls show', async () => {
  const s = await setup(), { wallet } = await user(s, 10_000), other = await user(s, 10_000);
  await opened(s, wallet);
  assert.equal((await portfolio(s.db, other.wallet)).items.length, 0);
  const { app } = await createApp({ services: s, timers: false, logger: false });
  assert.equal((await app.inject({ url: '/api/portfolio' })).statusCode, 401);
  await app.close();
});
