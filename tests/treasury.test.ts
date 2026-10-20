import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, settle, user } from './helpers';

test('fee shares move to the pool, the burn share is bought back and burned, and the pool view adds up', async () => {
  const s = await setup({ feeTransferThresholdUsd: 1, burnThresholdUsd: 1 }), { wallet } = await user(s);
  const { order } = await s.orders.create(wallet, 'pokemon_25');
  await s.orders.pay(wallet, order.id, 'practice');
  const done = await settle(s, order.id);
  assert.equal(done.status, 'complete');
  const before = await s.pool.view();
  assert.equal(before.pendingFeeTransferUsd, 1.25);
  assert.equal(before.burnBucketUsd, 1.25);
  const result: any = await s.treasury.run();
  assert.equal(result.transfer.amount, 1_250_000);
  assert.equal(result.burn.amount, 1_250_000);
  const after = await s.pool.view();
  assert.equal(after.pendingFeeTransferUsd, 0);
  assert.equal(after.burnBucketUsd, 0);
  assert.equal(after.totals.burnedUsd, 1.25);
  assert.equal(after.recentBurns.length, 1);
  assert.equal(after.totals.onsiteRebatesUsd, done.rebateUsd);
  // A second run has nothing left to move.
  const again: any = await s.treasury.run();
  assert.equal(again.transfer, null);
  assert.equal(again.burn, null);
  await s.db.close();
});
