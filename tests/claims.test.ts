import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, user } from './helpers';
import { DEFAULT_SETTINGS, micros, offsiteRebateCapMicros, rebateMicros } from '../shared/protection';

const HOUR = 3_600_000;

/** An off-site pull that lost (or won) money. Card values are random per memo, so discard the others. */
function pull(s: Awaited<ReturnType<typeof setup>>, wallet: string, loss: boolean, hoursAgo = 1) {
  for (;;) {
    const p = s.packs.offsitePull(s.solana, wallet, 25, Date.now() - hoursAgo * HOUR);
    if ((p.card.insuredValueUsd! < 25) === loss) return p;
    s.solana.ccPayments.set(wallet, s.solana.ccPayments.get(wallet)!.filter(x => x.memo !== p.memo));
  }
}
const losingPull = (s: Awaited<ReturnType<typeof setup>>, wallet: string, hoursAgo = 1) => pull(s, wallet, true, hoursAgo);

test('an eligible off-site pull is scanned, claimed and paid at the lower off-site coverage', async () => {
  const s = await setup(), { wallet, activatedAt } = await user(s, 10_000, 48);
  const pull = losingPull(s, wallet);
  const [candidate] = await s.claims.scan(wallet, activatedAt);
  assert.equal(candidate.eligible, true, candidate.reason ?? '');
  assert.equal(candidate.coverageBps, 2_000, 'Collector off-site coverage at full pool health');
  assert.equal(micros(candidate.rebateUsd), rebateMicros(micros(25), micros(pull.card.insuredValueUsd!), 2_000, offsiteRebateCapMicros(DEFAULT_SETTINGS)));
  await s.claims.claim(wallet, activatedAt, pull.memo);
  assert.equal(await s.claims.step(), 1);
  assert.equal(await s.solana.usdcBalance(wallet), BigInt(micros(candidate.rebateUsd)));
  const again = (await s.claims.scan(wallet, activatedAt))[0];
  assert.equal(again.claim?.status, 'paid');
  await assert.rejects(s.claims.claim(wallet, activatedAt, pull.memo), /Already claimed/);
  await s.db.close();
});

test('a holder who just connected is covered right away, even for a pull made before connecting; a non-holder is not', async () => {
  const s = await setup();
  const fresh = await user(s, 10_000, 0);
  const earlier = losingPull(s, fresh.wallet, 5);
  const [candidate] = await s.claims.scan(fresh.wallet, fresh.activatedAt);
  assert.equal(candidate.eligible, true, candidate.reason ?? '');
  await s.claims.claim(fresh.wallet, fresh.activatedAt, earlier.memo);
  const poor = await user(s, 0, 0);
  losingPull(s, poor.wallet);
  assert.match((await s.claims.scan(poor.wallet, poor.activatedAt))[0].reason!, /lowest balance/);
  await s.db.close();
});

test('an owner-set coverage delay still applies when configured', async () => {
  const s = await setup({ offsiteActivationHours: 24 });
  const fresh = await user(s, 10_000, 0);
  losingPull(s, fresh.wallet);
  assert.match((await s.claims.scan(fresh.wallet, fresh.activatedAt))[0].reason!, /starts 24h after you first connect/);
  await s.db.close();
});

test('the daily claim limit blocks extra claims until the 24h window rolls', async () => {
  const s = await setup({ offsite: { ...DEFAULT_SETTINGS.offsite, perWalletDailyClaims: 2 } });
  const { wallet, activatedAt } = await user(s, 10_000, 0);
  const pulls = [losingPull(s, wallet), losingPull(s, wallet), losingPull(s, wallet)];
  await s.claims.claim(wallet, activatedAt, pulls[0].memo);
  await s.claims.claim(wallet, activatedAt, pulls[1].memo);
  await assert.rejects(s.claims.claim(wallet, activatedAt, pulls[2].memo), /Daily limit reached \(2 claims per 24h\)/);
  const third = (await s.claims.scan(wallet, activatedAt)).find(c => c.memo === pulls[2].memo)!;
  assert.equal(third.eligible, false);
  assert.ok(third.rebateUsd > 0, 'the rebate it would get is still shown');
  // A day later the oldest claims roll off and the third can be claimed.
  await s.db.query('UPDATE claims SET created_at=created_at-$1', [86_400_001]);
  await s.claims.claim(wallet, activatedAt, pulls[2].memo);
  await s.db.close();
});

test('the daily payout cap queues the rest, and no single rebate exceeds it', async () => {
  const s = await setup({ offsite: { ...DEFAULT_SETTINGS.offsite, perWalletDailyUsd: 3, perWalletDailyClaims: 0 } });
  const { wallet, activatedAt } = await user(s, 20_000, 0);
  const pulls = [losingPull(s, wallet), losingPull(s, wallet)];
  for (const p of pulls) await s.claims.claim(wallet, activatedAt, p.memo);
  const claims = await s.claims.list(wallet);
  assert.ok(claims.every(c => c.rebateUsd <= 3), 'each off-site rebate is capped at the daily limit');
  await s.claims.step();
  const statuses = (await s.claims.list(wallet)).map(c => c.status).sort();
  assert.deepEqual(statuses, ['paid', 'queued']);
  assert.equal(offsiteRebateCapMicros({ ...DEFAULT_SETTINGS, offsite: { ...DEFAULT_SETTINGS.offsite, perWalletDailyUsd: 0, perWalletWeeklyUsd: 0 } }), micros(DEFAULT_SETTINGS.maxRebateUsd), '0 means no cap');
  await s.db.close();
});

test('a pack whose record belongs to another wallet cannot be claimed', async () => {
  const s = await setup(), { wallet, activatedAt } = await user(s, 10_000, 48), thief = await user(s, 10_000, 48);
  const pull = losingPull(s, wallet);
  s.solana.ccPayments.set(thief.wallet, s.solana.ccPayments.get(wallet)!);
  const [candidate] = await s.claims.scan(thief.wallet, thief.activatedAt);
  assert.match(candidate.reason!, /different wallet/);
  await assert.rejects(s.claims.claim(thief.wallet, thief.activatedAt, pull.memo), /different wallet/);
  assert.equal((await s.claims.scan(wallet, activatedAt))[0].eligible, true);
  await s.db.close();
});

test('refunded packs, winning pulls and old pulls are rejected', async () => {
  const s = await setup({ offsite: { ...DEFAULT_SETTINGS.offsite, claimWindowDays: 2 } });
  const { wallet, activatedAt } = await user(s, 10_000, 24 * 10);
  const refunded = losingPull(s, wallet);
  const record = await s.packs.status(refunded.memo);
  s.packs.setRecord(refunded.memo, { ...record, pack: { ...record.pack, refunded: true } });
  const old = losingPull(s, wallet, 24 * 3);
  pull(s, wallet, false);
  const candidates = await s.claims.scan(wallet, activatedAt);
  assert.equal(candidates.length, 2, 'pulls outside the claim window are not even scanned');
  assert.ok(!candidates.some(c => c.memo === old.memo));
  const reasons = candidates.map(c => c.reason);
  assert.ok(reasons.some(r => /refunded/.test(r!)));
  assert.ok(reasons.some(r => /worth at least/.test(r!)));
  assert.ok(candidates.every(c => !c.eligible), 'nothing eligible');
  await s.db.close();
});

test('the per-wallet weekly cap queues claims instead of paying them', async () => {
  const s = await setup({ offsite: { ...DEFAULT_SETTINGS.offsite, perWalletWeeklyUsd: 1 } });
  const { wallet, activatedAt } = await user(s, 20_000, 48);
  const first = losingPull(s, wallet), second = losingPull(s, wallet);
  await s.claims.claim(wallet, activatedAt, first.memo);
  await s.claims.claim(wallet, activatedAt, second.memo);
  await s.claims.step();
  const statuses = (await s.claims.list(wallet)).map(c => c.status).sort();
  assert.ok(statuses.every(x => x === 'queued' || x === 'paid'));
  assert.ok(statuses.includes('queued'));
  await s.db.close();
});

test('pulls opened on our site cannot also be claimed off-site', async () => {
  const s = await setup(), { wallet, activatedAt } = await user(s, 10_000, 48);
  const pull = losingPull(s, wallet);
  await s.db.query("INSERT INTO pulls(memo,source,wallet,price_micros,value_micros,nft_mint,pulled_at,data) VALUES($1,'onsite',$2,25000000,1,'m',0,'{}')", [pull.memo, wallet]);
  assert.match((await s.claims.scan(wallet, activatedAt))[0].reason!, /Opened on our site/);
  await s.db.close();
});

test('there is no pool-wide daily cap by default; if the owner sets one, claims past it queue', async () => {
  const open = await setup(), a = await user(open, 10_000, 0);
  assert.equal((await open.pool.offsiteRoom(a.wallet)).global, Infinity);
  await open.db.close();
  // 0.01% of a $10,000 pool is $1 a day across everyone.
  const capped = await setup({ offsite: { ...DEFAULT_SETTINGS.offsite, dailyPoolBps: 1 } }), b = await user(capped, 10_000, 0);
  const p = losingPull(capped, b.wallet);
  await capped.claims.claim(b.wallet, b.activatedAt, p.memo);
  await capped.claims.step();
  const [claim] = await capped.claims.list(b.wallet);
  assert.equal(claim.status, claim.rebateUsd <= 1 ? 'paid' : 'queued');
  await capped.db.close();
});
