import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, settle, user } from './helpers';
import { HIT_MULTIPLE, PullFeed, SAMPLE_PER_PACK } from '../server/pull-feed';
import { leaderboard, sitePulls, weekStart, WEEK } from '../server/leaderboard';
import { createApp } from '../server/app';
import { distribution, micros } from '../shared/protection';

const HOUR = 3_600_000, DAY = 24 * HOUR;

/** A Collector Crypt recent-winners entry, in the shape their feed returns. */
function winner(code: string, value: number, at: number, extra: { wallet?: string; mint?: string } = {}) {
  return {
    winner: extra.wallet ?? 'Buyer1111111111111111111111111111111111111', nft_address: extra.mint ?? `mint-${code}-${at}-${value}`, insuredValue: value,
    created_at: new Date(at).toISOString(), pack_type: code, prize_tier: 4,
    nft: { content: { files: [{ cc_cdn: `https://d1xpxki1g4htqu.cloudfront.net/${code}-${at}` }], metadata: { name: '2023 #175 Psyduck PSA 10 Mew EN-1', json_name: '2023 #175 Psyduck PSA 10 Mew EN-151', attributes: [{ trait_type: 'Grading Company', value: 'PSA' }, { trait_type: 'The Grade', value: 'GEM MT 10' }] } } },
  };
}
function feedOf(entries: Record<string, unknown[]>) {
  const calls: string[] = [];
  const fetcher = (async (url: string) => {
    calls.push(url);
    const code = new URL(url).searchParams.get('packType')!;
    return new Response(JSON.stringify({ success: true, data: entries[code] ?? [] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

test('the pull feed stores each pull once and keeps the newest, with photos, for the live feed', async () => {
  const s = await setup(), now = Date.now();
  const { fetcher, calls } = feedOf({
    pokemon_50: [winner('pokemon_50', 31, now - 60_000), winner('pokemon_50', 140, now - 30_000, { wallet: s.solana.opsAddress! })],
    pokemon_25: [winner('pokemon_25', 22, now - 10_000), { pack_type: 'pokemon_25', insuredValue: 'n/a' }, winner('pokemon_100', 90, now)],
  });
  const feed = new PullFeed(s.db, s.settings, () => s.solana.opsAddress, fetcher);
  assert.equal(await feed.poll(now), 3, 'entries without a value, or for another machine, are skipped');
  assert.equal(await feed.poll(now), 0, 'a second read of the same feed adds nothing');
  assert.ok(calls.every(u => u.startsWith('https://gacha.collectorcrypt.com/api/getAllWinners?count=200&packType=')));
  assert.equal(calls.length, 12, 'every machine is read on every poll');

  const recent = feed.recent();
  assert.deepEqual(recent.map(p => p.valueUsd), [22, 140, 31], 'newest first');
  assert.equal(recent[0].card?.name, 'Psyduck · Mew EN-151 · PSA 10', 'the full name is used, not the cut-off one');
  assert.ok(recent[1].pullback, 'a pack opened by our OPS wallet is marked');
  assert.ok(!recent[0].pullback);

  const stored = (await s.db.query<{ code: string; value_cents: number; card: unknown }>('SELECT code,value_cents,card FROM cc_pulls ORDER BY value_cents')).rows;
  assert.deepEqual(stored.map(r => [r.code, r.value_cents, !!r.card]), [['pokemon_25', 2200, false], ['pokemon_50', 3100, false], ['pokemon_50', 14000, true]], `only pulls over ${HIT_MULTIPLE}× the pack keep their card`);
  await s.db.close();
});

test('pack stats use the calibration math and price each tier with the same rebate and cap as a real order', async () => {
  const s = await setup(), now = Date.now();
  const values = [10, 20, 40, 50, 60, 120];
  const { fetcher } = feedOf({ pokemon_50: [...values.map((v, i) => winner('pokemon_50', v, now - (i + 1) * 60_000)), winner('pokemon_50', 900, now - 8 * DAY)] });
  const feed = new PullFeed(s.db, s.settings, () => null, fetcher);
  await feed.poll(now);
  const p = (await feed.stats(now)).packs.find(x => x.code === 'pokemon_50')!;

  const [d] = distribution([...values, 900].map(v => ({ priceUsd: 50, valueUsd: v })));
  assert.equal(p.n, 7);
  assert.equal(p.medianUsd, d.medianValueRatio * 50);
  assert.equal(p.p10Usd, d.p10 * 50);
  assert.equal(p.p90Usd, d.p90 * 50);
  assert.equal(p.hitRate, d.hitRate);
  assert.equal(p.meanUsd, Math.round(d.meanValueRatio * 50 * 100) / 100);
  // Shortfalls 40 + 30 + 10 = 80 over 7 pulls: Whale (100%) gets 80/7, Shrimp (25%) a quarter of it.
  assert.deepEqual(p.avgRebateUsd, { t1: 2.86, t2: 5.71, t3: 11.43 });
  assert.equal(p.best?.valueUsd, 120, 'the $900 hit is over a week old, so the best of the last 7 days is $120');
  assert.equal(p.best?.card?.name, 'Psyduck · Mew EN-151 · PSA 10');

  const empty = (await feed.stats(now)).packs.find(x => x.code === 'pokemon_500')!;
  assert.equal(empty.n, 0);
  assert.equal(empty.best, null);

  // The $500 cap binds for a Whale on a $500 pack.
  await s.settings.save({ ...s.settings.current, maxRebateUsd: 100 });
  const big = new PullFeed(s.db, s.settings, () => null, feedOf({ pokemon_500: [winner('pokemon_500', 100, now - 1000)] }).fetcher);
  await big.poll(now);
  assert.equal((await big.stats(now)).packs.find(x => x.code === 'pokemon_500')!.avgRebateUsd.t3, 100);
  await s.db.close();
});

test('the stored sample is capped per pack but the week’s biggest hits survive', async () => {
  const s = await setup(), now = Date.now();
  await s.db.query(`INSERT INTO cc_pulls(id,code,value_cents,pulled_at,card) SELECT 'old-'||g,'pokemon_25',1000,$1::bigint-g*1000,NULL FROM generate_series(1,$2::int) g`, [now - HOUR, SAMPLE_PER_PACK + 40]);
  await s.db.query(`INSERT INTO cc_pulls(id,code,value_cents,pulled_at,card) VALUES('old-hit','pokemon_25',90000,$1,'{"name":"Charizard","image":"https://x/y"}'),('stale-hit','pokemon_25',95000,$2,'{"name":"Mew","image":"https://x/z"}')`, [now - 3 * DAY, now - 9 * DAY]);
  const feed = new PullFeed(s.db, s.settings, () => null, feedOf({ pokemon_25: [winner('pokemon_25', 20, now)] }).fetcher);
  await feed.poll(now);
  const ids = new Set((await s.db.query<{ id: string }>("SELECT id FROM cc_pulls WHERE code='pokemon_25'")).rows.map(r => r.id));
  assert.equal(ids.size, SAMPLE_PER_PACK + 1, 'the newest sample plus one recent hit');
  assert.ok(ids.has('old-hit'), 'a 3-day-old hit is kept for the best-of-the-week');
  assert.ok(!ids.has('stale-hit'), 'a 9-day-old hit is dropped');
  assert.equal((await feed.stats(now)).packs.find(p => p.code === 'pokemon_25')!.best?.card?.name, 'Charizard');
  await s.db.close();
});

test('weeks start Monday 00:00 UTC', () => {
  assert.equal(weekStart(Date.UTC(2026, 9, 21, 15)), Date.UTC(2026, 9, 19), 'a Wednesday');
  assert.equal(weekStart(Date.UTC(2026, 9, 19)), Date.UTC(2026, 9, 19), 'Monday midnight is the new week');
  assert.equal(weekStart(Date.UTC(2026, 9, 25, 23, 59)), Date.UTC(2026, 9, 19), 'Sunday night is still the same week');
  assert.equal(weekStart(Date.UTC(2026, 10, 1, 12)), Date.UTC(2026, 9, 26), 'across a month end');
});

test('leaderboards rank this week’s hits, packs opened and rebates, and mark the viewer', async () => {
  const s = await setup(), a = await user(s), b = await user(s);
  const open = async (wallet: string, code: string, valueUsd: number, rebateUsd: number) => {
    const { order } = await s.orders.create(wallet, code);
    await s.orders.pay(wallet, order.id, 'practice');
    assert.equal((await settle(s, order.id)).status, 'complete');
    await s.db.query("UPDATE orders SET data = data || jsonb_build_object('valueMicros', $2::bigint, 'rebateMicros', $3::bigint) WHERE id=$1", [order.id, micros(valueUsd), micros(rebateUsd)]);
    return order.id;
  };
  await open(a.wallet, 'pokemon_25', 300, 0);
  await open(a.wallet, 'pokemon_25', 10, 7.5);
  await open(a.wallet, 'pokemon_50', 20, 15);
  await open(b.wallet, 'pokemon_100', 400, 0);
  const lastWeek = await open(b.wallet, 'pokemon_500', 2000, 0);
  await s.db.query('UPDATE orders SET created_at=created_at-$2 WHERE id=$1', [lastWeek, WEEK]);
  await s.db.query("INSERT INTO claims(memo,wallet,status,price_micros,value_micros,coverage_bps,rebate_micros,pulled_at,created_at,paid_at,data) VALUES('cc-1',$1,'paid',$2,$3,2000,$4,$5,$5,$5,'{\"packType\":\"pokemon_100\"}')", [b.wallet, micros(100), micros(20), micros(16), Date.now()]);

  const board = await leaderboard(s.db, 'current', a.wallet);
  assert.deepEqual(board.hits.map(h => h.valueUsd), [400, 300], 'cards worth less than their pack are not hits; last week’s $2,000 is not this week’s');
  assert.equal(board.hits[1].you, true);
  assert.equal(board.hits[0].you, false);
  assert.match(board.hits[0].wallet, /^\w{4}…\w{4}$/, 'wallets are shortened');
  assert.deepEqual(board.packs.map(p => [p.packs, p.spentUsd]), [[3, 100], [1, 100]]);
  assert.deepEqual(board.rebates.map(r => [r.rebateUsd, r.source]), [[16, 'offsite'], [15, 'onsite'], [7.5, 'onsite']]);
  assert.equal(board.rebates[0].code, 'pokemon_100');

  const last = await leaderboard(s.db, 'last', null);
  assert.deepEqual(last.hits.map(h => h.valueUsd), [2000]);
  assert.equal(last.end, board.start);
  assert.equal(last.packs[0].you, false);
  await s.db.close();
});

test('Just pulled lists packs finished on Pullback, newest first, with the rebate sent and a short card name', async () => {
  const s = await setup(), a = await user(s);
  const open = async (code: string, valueUsd: number, rebateUsd: number, name?: string) => {
    const { order } = await s.orders.create(a.wallet, code);
    await s.orders.pay(a.wallet, order.id, 'practice');
    assert.equal((await settle(s, order.id)).status, 'complete');
    await s.db.query("UPDATE orders SET data = data || jsonb_build_object('valueMicros', $2::bigint, 'rebateMicros', $3::bigint) WHERE id=$1", [order.id, micros(valueUsd), micros(rebateUsd)]);
    if (name) await s.db.query("UPDATE orders SET data = jsonb_set(data, '{card,name}', to_jsonb($2::text)) WHERE id=$1", [order.id, name]);
    return order.id;
  };
  const first = await open('pokemon_25', 10, 7.5, '2019 #69 Full Art/Moltres GX PSA 10 Hidden Fates Pokemon');
  const second = await open('pokemon_100', 400, 0);
  await s.db.query('UPDATE orders SET created_at=created_at-1000 WHERE id=$1', [first]);
  const unfinished = (await s.orders.create(a.wallet, 'pokemon_50')).order.id;

  const pulls = await sitePulls(s.db);
  assert.deepEqual(pulls.map(p => p.id), [second, first], 'newest first; an order still waiting for payment is left out');
  assert.equal(pulls.some(p => p.id === unfinished), false);
  assert.deepEqual([pulls[1].code, pulls[1].priceUsd, pulls[1].valueUsd, pulls[1].rebateUsd], ['pokemon_25', 25, 10, 7.5]);
  assert.equal(pulls[1].card?.name, 'Moltres GX', 'a Collector Crypt title is cut to the card');
  assert.equal(pulls[0].rebateUsd, 0);
  const row = (await s.db.query<{ payment_signature: string; data: any }>('SELECT payment_signature,data FROM orders WHERE id=$1', [first])).rows[0];
  assert.deepEqual(pulls[1].txs, { payment: row.payment_signature, pack: row.data.packSignature, card: row.data.nftSignature, rebate: row.data.rebateSignature ?? null, sale: null }, 'every transaction behind the pack, for Solscan');
  assert.ok(pulls[1].txs.payment && pulls[1].txs.pack && pulls[1].txs.card);
  assert.equal(pulls[1].mint, row.data.card.mint);
  assert.match(pulls[1].wallet, /^\w{4}…\w{4}$/, 'wallets are shortened');

  const { app } = await createApp({ services: s, timers: false, logger: false });
  assert.deepEqual((await app.inject({ url: '/api/pulls/pullback' })).json().items.map((p: { id: string }) => p.id), [second, first]);
  await app.close();
});

test('the stats, recent pulls and leaderboard routes answer for anyone', async () => {
  const s = await setup(), now = Date.now();
  const feed = new PullFeed(s.db, s.settings, () => null, feedOf({ pokemon_25: [winner('pokemon_25', 60, now)] }).fetcher);
  await feed.poll(now);
  const { app } = await createApp({ services: { ...s, feed }, timers: false, logger: false });
  const stats = (await app.inject({ url: '/api/stats' })).json();
  assert.equal(stats.packs.length, 6);
  assert.equal(stats.packs.find((p: { code: string }) => p.code === 'pokemon_25').best.valueUsd, 60);
  const recent = (await app.inject({ url: '/api/pulls/recent' })).json().items[0];
  assert.deepEqual([recent.valueUsd, recent.mint], [60, `mint-pokemon_25-${now}-60`], 'each pull carries its NFT, to look it up on-chain');
  assert.equal((await app.inject({ url: '/api/leaderboard' })).json().week, 'current');
  assert.equal((await app.inject({ url: '/api/leaderboard?week=last' })).json().week, 'last');
  assert.equal((await app.inject({ url: '/api/leaderboard?week=forever' })).statusCode, 400);
  await app.close();
});
