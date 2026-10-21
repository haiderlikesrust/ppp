import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pacedFetch } from '../server/rpc-pace';
import { readParsedTransactions } from '../server/solana-live';
import { publicError } from '../server/redact';

/** A clock that only moves when the code under test sleeps. */
function fakeClock() {
  const clock = { t: 0, waits: [] as number[], now: () => clock.t, sleep: async (ms: number) => { clock.waits.push(ms); clock.t += ms; } };
  return clock;
}
const body = (calls: number) => JSON.stringify(calls === 1 ? { method: 'getSlot' } : Array.from({ length: calls }, () => ({ method: 'getTransaction' })));

test('RPC calls are paced under the per-second limit, a batch counting one call per item', async () => {
  const clock = fakeClock(), sent: number[] = [];
  const paced = pacedFetch(10, (async () => { sent.push(clock.t); return new Response('{}'); }) as typeof fetch, clock);
  await paced('rpc', { method: 'POST', body: body(6) });
  await paced('rpc', { method: 'POST', body: body(4) });
  assert.deepEqual(clock.waits, [], 'ten calls fit in the first second');
  await paced('rpc', { method: 'POST', body: body(5) });
  assert.deepEqual(clock.waits, [500], 'the next five wait for half a second of budget');
  await paced('rpc', { method: 'POST', body: body(1) });
  assert.equal(sent.length, 4);
  assert.ok(sent[3] >= 600, 'and the one after that waits its turn too');
});

test('a 429 is waited out, using Retry-After when given, then the call goes through', async () => {
  const clock = fakeClock(), replies = [new Response('', { status: 429, headers: { 'retry-after': '2' } }), new Response('', { status: 429 }), new Response('{"ok":1}')];
  const paced = pacedFetch(50, (async () => replies.shift()!) as typeof fetch, clock);
  const response = await paced('rpc', { method: 'POST', body: body(1) });
  assert.equal(response.status, 200);
  assert.deepEqual(clock.waits, [2000, 1000], 'Retry-After first, then a doubling backoff');
});

test('a rate-limited batch read is not retried one by one, and users see a plain message', async () => {
  let singles = 0;
  const limited = { getParsedTransactions: async () => { throw new Error('failed to get transactions: 50/second request limit reached'); }, getParsedTransaction: async () => { singles++; return null; } } as any;
  await assert.rejects(readParsedTransactions(limited, ['a', 'b', 'c']), /request limit/);
  assert.equal(singles, 0, 'reading each one would only add load');
  const shown = publicError(new Error('failed to get transactions: 50/second request limit reached'));
  assert.deepEqual(shown, { status: 503, message: 'The Solana network is busy right now. Please try again in a few seconds.' });
});
