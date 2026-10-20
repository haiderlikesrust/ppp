import { Keypair } from '@solana/web3.js';
import { openDatabase } from '../server/db';
import { createServices } from '../server/services';
import { MockPacks, MockSolana } from '../server/mock';
import { createSession } from '../server/auth';
import { DEFAULT_SETTINGS } from '../shared/protection';
import type { Settings } from '../shared/types';

export async function setup(settings: Partial<Settings> = {}) {
  const db = await openDatabase(undefined, 'memory://');
  const solana = new MockSolana(), packs = new MockPacks(() => solana.opsAddress);
  packs.pendingCalls = 0;
  const s = await createServices({ db, solana, packs });
  await s.settings.save({ ...DEFAULT_SETTINGS, ...settings });
  return { ...s, solana, packs };
}

export async function user(s: Awaited<ReturnType<typeof setup>>, ppm = 10_000, activatedAgoHours = 0) {
  const wallet = Keypair.generate().publicKey.toBase58();
  s.solana.setHolderPpm(wallet, ppm);
  await createSession(s.db, wallet);
  const activatedAt = Date.now() - activatedAgoHours * 3_600_000;
  await s.db.query('UPDATE wallets SET activated_at=$2 WHERE wallet=$1', [wallet, activatedAt]);
  if (activatedAgoHours) await s.holders.snapshot(wallet, activatedAt);
  await s.holders.snapshot(wallet);
  return { wallet, activatedAt };
}

/** Steps the order machine until the order stops moving or reaches a final state. */
export async function settle(s: Awaited<ReturnType<typeof setup>>, id: string, max = 20) {
  for (let i = 0; i < max; i++) {
    await s.orders.step();
    const order = await s.orders.get(id);
    if (['complete', 'refunded', 'expired', 'review'].includes(order.status)) return order;
  }
  return s.orders.get(id);
}
