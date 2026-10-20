import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { setup } from './helpers';

const HOUR = 3_600_000;

test('tier is the lowest balance across the window, so a flash buy does not qualify', async () => {
  const s = await setup(), wallet = Keypair.generate().publicKey.toBase58(), now = Date.now();
  s.solana.setHolderPpm(wallet, 0); await s.holders.snapshot(wallet, now - 30 * HOUR);
  s.solana.setHolderPpm(wallet, 20_000); await s.holders.snapshot(wallet, now - HOUR);
  const check = await s.holders.tierFor(wallet, now - 24 * HOUR, now);
  assert.equal(check.tier, null, 'held nothing at the start of the window');
  assert.match(check.reason!, /lowest balance/);
  assert.equal((await s.holders.tierFor(wallet, now - 30 * 60_000, now)).tier?.id, 't3', 'a window after the buy qualifies');
  await s.db.close();
});

test('moving one bag between wallets leaves a dip that drops the tier', async () => {
  const s = await setup(), a = Keypair.generate().publicKey.toBase58(), now = Date.now();
  s.solana.setHolderPpm(a, 10_000); await s.holders.snapshot(a, now - 25 * HOUR);
  s.solana.setHolderPpm(a, 0); await s.holders.snapshot(a, now - 10 * HOUR);
  s.solana.setHolderPpm(a, 10_000); await s.holders.snapshot(a, now - HOUR);
  assert.equal((await s.holders.tierFor(a, now - 24 * HOUR, now)).tier, null);
  await s.db.close();
});

test('a steady holder keeps their tier; no record before the window means no tier', async () => {
  const s = await setup(), wallet = Keypair.generate().publicKey.toBase58(), now = Date.now();
  s.solana.setHolderPpm(wallet, 10_000);
  await s.holders.snapshot(wallet, now - 48 * HOUR); await s.holders.snapshot(wallet, now - 12 * HOUR);
  assert.equal((await s.holders.tierFor(wallet, now - 24 * HOUR, now)).tier?.id, 't2');
  assert.match((await s.holders.tierFor(wallet, now - 72 * HOUR, now)).reason!, /no record/);
  await s.db.close();
});

test('off-site coverage comes from the on-chain coin history, not from when the wallet connected', async () => {
  const s = await setup(), wallet = Keypair.generate().publicKey.toBase58(), now = Date.now();
  s.solana.setHolderPpm(wallet, 10_000);
  s.solana.boughtAt(wallet, now - 10 * HOUR);
  assert.equal((await s.holders.offsiteTier(wallet, now, now - 6 * HOUR)).tier?.id, 't2', 'a pull after buying in counts, even before the wallet ever connected');
  assert.match((await s.holders.offsiteTier(wallet, now, now - 12 * HOUR)).reason!, /first bought the coin 2h after this pack was opened/);
  // A dip after the pull lowers the tier, even if the wallet bought back since.
  s.solana.setHolderPpm(wallet, 0, now - 3 * HOUR); s.solana.setHolderPpm(wallet, 10_000);
  s.holders.forget(wallet);
  assert.equal((await s.holders.offsiteTier(wallet, now, now - 6 * HOUR)).tier, null);
  await s.db.close();
});

test('an owner-set holding time before the pull is enforced from the same history', async () => {
  const s = await setup({ offsiteHoldHours: 24 }), wallet = Keypair.generate().publicKey.toBase58(), now = Date.now();
  s.solana.setHolderPpm(wallet, 10_000);
  s.solana.boughtAt(wallet, now - 30 * HOUR);
  assert.equal((await s.holders.offsiteTier(wallet, now, now - 2 * HOUR)).tier?.id, 't2', 'held 28h before the pull');
  s.solana.boughtAt(wallet, now - 12 * HOUR); s.holders.forget(wallet);
  assert.match((await s.holders.offsiteTier(wallet, now, now - 2 * HOUR)).reason!, /bought the coin 10h before this pack was opened; you need to have held it for 24h/);
  await s.db.close();
});

test('an activation delay, when the owner sets one, blocks pulls from before it', async () => {
  const s = await setup({ offsiteActivationHours: 24 }), wallet = Keypair.generate().publicKey.toBase58(), now = Date.now();
  s.solana.setHolderPpm(wallet, 10_000); await s.holders.snapshot(wallet, now - 48 * HOUR);
  assert.match((await s.holders.offsiteTier(wallet, now - 10 * HOUR, now - HOUR)).reason!, /starts 24h/);
  assert.equal((await s.holders.offsiteTier(wallet, now - 48 * HOUR, now - HOUR)).tier?.id, 't2');
  await s.db.close();
});
