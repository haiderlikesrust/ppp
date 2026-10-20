import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readParsedTransactions } from '../server/solana-live';
import { ccRecordProblem, parseCcPayment } from '../server/cc/history';

const wallet = 'BXej5ZYyNU521jd94YvmhCL1nudc2iGBEnRQ2n5o24J4', userAta = 'UserAta1111111111111111111111111111111111111', ccAta = 'D9CEogjHA6CpS12F8St9zpSco7pQKJB5uR1RqDsuzQZk';
const memo = 'cc-044bfa12-24b6-43b5-aae4-e0595d8fa9d7';
function tx(instructions: any[], extra: any = {}) {
  return { blockTime: 1_760_000_000, meta: { err: null }, transaction: { signatures: ['sig1'], message: { instructions } }, ...extra } as any;
}
const memoIx = (text = `${memo}:open`) => ({ program: 'spl-memo', programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', parsed: text });
const transfer = (info: any = {}) => ({ program: 'spl-token', parsed: { type: 'transferChecked', info: { source: userAta, destination: ccAta, authority: wallet, mint: 'EPj', tokenAmount: { amount: '25000000' }, ...info } } });

test('recognizes a pack payment made by the wallet itself', () => {
  assert.deepEqual(parseCcPayment(tx([memoIx(), transfer()]), wallet, userAta, ccAta), { memo, signature: 'sig1', priceMicros: 25_000_000, blockTime: 1_760_000_000_000 });
  assert.equal(parseCcPayment(tx([memoIx(), { program: 'spl-token', parsed: { type: 'transfer', info: { source: userAta, destination: ccAta, authority: wallet, amount: '50000000' } } }]), wallet, userAta, ccAta)?.priceMicros, 50_000_000);
});

test('packs opened through other apps that sell Collector Crypt packs are recognized too', () => {
  for (const app of ['jupiter', '6hjcq', 'slabz']) {
    const other = `${app}-d2a58146-0b78-44b2-a318-6e1e3558c9a0`;
    assert.equal(parseCcPayment(tx([memoIx(`${other}:open`), transfer()]), wallet, userAta, ccAta)?.memo, other, app);
  }
  assert.equal(parseCcPayment(tx([memoIx('jupiter-d2a58146-0b78-44b2-a318-6e1e3558c9a0:buyback'), transfer()]), wallet, userAta, ccAta), null, 'a sell-back is not a pack');
  assert.equal(parseCcPayment(tx([memoIx('Jupiter Exchange-d2a58146-0b78-44b2-a318-6e1e3558c9a0:open'), transfer()]), wallet, userAta, ccAta), null, 'app tags are short lowercase words');
});

test('ignores payments by someone else, failed transactions and look-alikes', () => {
  assert.equal(parseCcPayment(tx([memoIx(), transfer({ authority: 'Someone' })]), wallet, userAta, ccAta), null, 'another authority');
  assert.equal(parseCcPayment(tx([memoIx(), transfer({ source: 'OtherAta' })]), wallet, userAta, ccAta), null, 'another source');
  assert.equal(parseCcPayment(tx([memoIx(), transfer({ destination: 'NotCc' })]), wallet, userAta, ccAta), null, 'not paid to Collector Crypt');
  assert.equal(parseCcPayment(tx([memoIx('cc-nope:open'), transfer()]), wallet, userAta, ccAta), null, 'bad memo');
  assert.equal(parseCcPayment(tx([memoIx(), memoIx(), transfer()]), wallet, userAta, ccAta), null, 'two memos');
  assert.equal(parseCcPayment(tx([memoIx(), transfer(), transfer()]), wallet, userAta, ccAta), null, 'two packs in one transaction');
  assert.equal(parseCcPayment(tx([memoIx(), transfer({ tokenAmount: { amount: '25000001' } })]), wallet, userAta, ccAta), null, 'not a whole-dollar pack');
  assert.equal(parseCcPayment(tx([memoIx(), transfer()], { meta: { err: { InstructionError: [0, 'x'] } } }), wallet, userAta, ccAta), null, 'failed');
});

test('Collector Crypt record must match the claimant and the payment', () => {
  const payment = { memo, signature: 'sig1', priceMicros: 25_000_000, blockTime: 0 };
  const good = { pack: { wallet, transaction_signature: 'sig1', pack_type: 'pokemon_25', refunded: false, status: 'confirmed' }, send: { status: 'confirmed', nft_address: 'Mint', to_wallet: wallet, insured_value: 12.5 } };
  assert.equal(ccRecordProblem(good, wallet, payment), null);
  assert.match(ccRecordProblem({ ...good, pack: { ...good.pack, wallet: 'X' } }, wallet, payment)!, /different wallet/);
  assert.match(ccRecordProblem({ ...good, pack: { ...good.pack, refunded: true } }, wallet, payment)!, /refunded/);
  assert.match(ccRecordProblem({ ...good, pack: { ...good.pack, transaction_signature: 'other' } }, wallet, payment)!, /does not match this payment/);
  assert.match(ccRecordProblem({ ...good, pack: { ...good.pack, pack_type: 'pokemon_50' } }, wallet, payment)!, /pack type/);
  assert.match(ccRecordProblem({ ...good, send: { ...good.send, to_wallet: 'X' } }, wallet, payment)!, /delivered to a different/);
  assert.match(ccRecordProblem({ ...good, send: null }, wallet, payment)!, /not been delivered/);
  assert.match(ccRecordProblem({ ...good, send: { ...good.send, insured_value: null } }, wallet, payment)!, /insured value/);
  assert.match(ccRecordProblem({ pack: null }, wallet, payment)!, /no record/);
});

test('one unreadable transaction does not fail a wallet scan, but an RPC outage still does', async () => {
  const good = { slot: 1 } as any;
  const versionError = new Error('failed to get transactions: Transaction version (2) is not supported by the requesting client.');
  const rpc = {
    getParsedTransactions: async () => { throw versionError; },
    getParsedTransaction: async (signature: string) => { if (signature === 'odd') throw versionError; return good; },
  } as any;
  assert.deepEqual(await readParsedTransactions(rpc, ['a', 'odd', 'b']), [good, null, good]);
  const down = { getParsedTransactions: async () => { throw new Error('fetch failed'); }, getParsedTransaction: async () => { throw new Error('fetch failed'); } } as any;
  await assert.rejects(readParsedTransactions(down, ['a', 'b']), /fetch failed/);
  const options: any[] = [];
  await readParsedTransactions({ getParsedTransactions: async (_s: string[], o: any) => { options.push(o); return []; } } as any, ['a']);
  assert.equal(options[0].maxSupportedTransactionVersion, 1, 'asks for version 1 transactions');
});
