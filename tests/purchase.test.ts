import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import { buyPack } from '../server/cc/purchase';
import type { Purchase, PurchaseStore } from '../server/cc/store';

/** A paid pack Collector Crypt hasn't registered yet: our side is done, the purchase waits on their status. */
function paidPack(paidAgoMs: number) {
  const signer = Keypair.generate(), paymentWallet = Keypair.generate().publicKey, nft = Keypair.generate().publicKey.toBase58();
  const purchase: Purchase = { id: 'p1', wallet: signer.publicKey.toBase58(), recipient: paymentWallet.toBase58(), priceUsdc: 25, packType: 'pokemon_25', memo: 'cc-memo', transaction: 'x', signedTransaction: 'x', signature: 'sig', paid: true, paidAt: Date.now() - paidAgoMs };
  const saved = new Map<string, Purchase>([['p1', purchase]]);
  const store: PurchaseStore = { get: async id => saved.get(id) ?? null, save: async p => { saved.set(p.id, { ...p }); }, locked: (_id, action) => action() };
  const cc = { registered: false, opens: 0 } as { registered: boolean; opens: number };
  const client = {
    packStatus: async () => cc.registered
      ? { pack: { status: 'confirmed', wallet: purchase.wallet, pack_type: 'pokemon_25', transaction_signature: 'sig' }, send: { status: 'confirmed', nft_address: nft, to_wallet: purchase.wallet, insured_value: '12' } }
      : { pack: { status: null } },
    // Like Collector Crypt's site does after paying: asking it to open makes it register the payment.
    openPack: async () => { cc.opens++; cc.registered = true; return { code: 'OK', nft_address: nft, nftWon: { content: { metadata: { name: 'Card' } } } }; },
  } as any;
  const run = () => buyPack({ id: 'p1', priceUsdc: 25, packType: 'pokemon_25', maxPriceUsdc: 500, enabled: true, client, connection: {} as any, signer, paymentWallet: new PublicKey(paymentWallet), store });
  return { run, cc, saved };
}

test('a paid pack Collector Crypt has not registered is not opened before 30 seconds', async () => {
  const { run, cc } = paidPack(5_000);
  assert.equal((await run()).state, 'pending');
  assert.equal(cc.opens, 0);
});

test('after 30 seconds Collector Crypt is asked to open the paid pack, once a minute, and the pack then completes', async () => {
  const { run, cc, saved } = paidPack(31_000);
  cc.registered = false;
  const first = await run();
  assert.equal(first.state, 'pending', 'its status is read again on the next step');
  assert.equal(cc.opens, 1, 'asked to open the pack');
  assert.ok(saved.get('p1')!.nudgedAt);
  const done = await run();
  assert.equal(done.state, 'complete', 'registered now: verified and delivered as usual');
  assert.equal(cc.opens, 2, 'the normal open after it is registered');
});

test('the nudge is not repeated within a minute', async () => {
  const { run, cc, saved } = paidPack(31_000);
  saved.get('p1')!.nudgedAt = Date.now() - 10_000;
  await run();
  assert.equal(cc.opens, 0);
});
