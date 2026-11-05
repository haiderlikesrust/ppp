import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settle, setup, user } from './helpers';
import { createApp } from '../server/app';
import { fetchCardImage } from '../server/remote-metadata';
import { sharePage, shareText } from '../server/share';
import type { SitePull } from '../shared/types';

const pull = (patch: Partial<SitePull> = {}): SitePull => ({
  id: '7982b2ef-f950-4f35-93d5-d464fa502bb7', code: 'pokemon_25', priceUsd: 25, valueUsd: 9.3, sellUsd: 7.9, rebateUsd: 3.92, at: 1, wallet: 'AbCd…WxYz', mint: 'mint',
  card: { name: 'Sylveon · Crown Zenith · PSA 9', image: 'https://nft.collectorcrypt.com/front/1' }, soldUsd: null, txs: { payment: null, pack: null, card: null, rebate: null, sale: null }, ...patch,
});

test('share text states the pull plainly, with the rebate only when one was paid', () => {
  assert.equal(shareText(pull()).title, 'Sylveon · Regrade');
  assert.match(shareText(pull()).description, /\$25\.00 pack, worth \$9\.30\. \$3\.92 came back/);
  assert.doesNotMatch(shareText(pull({ valueUsd: 450, rebateUsd: 0 })).description, /came back/);
});

test('the share page previews the pull, sends visitors to it, and escapes provider text', () => {
  const html = sharePage(pull({ card: { name: '"><script>alert(1)</script> · Set', image: 'https://nft.collectorcrypt.com/a"b' } }), 'https://regrade.cards');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&quot;&gt;&lt;script&gt;/);
  assert.match(html, /a&quot;b/);
  assert.match(html, /http-equiv="refresh" content="0;url=\/pull\/7982b2ef-f950-4f35-93d5-d464fa502bb7"/);
  assert.match(sharePage(pull({ card: null }), 'https://regrade.cards'), /content="https:\/\/regrade\.cards\/og\.png"/);
});

const image = (type: string, body: BodyInit = 'bytes', headers: Record<string, string> = {}) => (async () => new Response(body, { headers: { 'content-type': type, ...headers } })) as unknown as typeof fetch;

test('card images are only read from known hosts, as bitmaps, within a size limit', async () => {
  const ok = await fetchCardImage('https://d1xpxki1g4htqu.cloudfront.net/abc', image('image/png'));
  assert.equal(ok.type, 'image/png');
  assert.equal(ok.bytes.toString(), 'bytes');
  await assert.rejects(fetchCardImage('https://evil.example/a.png', image('image/png')), /not allowed/);
  await assert.rejects(fetchCardImage('http://nft.collectorcrypt.com/a.png', image('image/png')), /not allowed/);
  await assert.rejects(fetchCardImage('https://nft.collectorcrypt.com:8443/a.png', image('image/png')), /not allowed/);
  await assert.rejects(fetchCardImage('https://nft.collectorcrypt.com/a.svg', image('image/svg+xml')), /unavailable/, 'SVG can carry script');
  await assert.rejects(fetchCardImage('https://nft.collectorcrypt.com/big.png', image('image/png', 'x', { 'content-length': String(9 * 1024 * 1024) })), /too large/);
});

test('image redirects are followed only between known hosts, and only so far', async () => {
  const hop = (location: string) => new Response(null, { status: 302, headers: { location } });
  const chain = (...steps: Response[]) => (async () => steps.shift()!) as unknown as typeof fetch;
  const start = 'https://nft.collectorcrypt.com/front/1';

  const resized = await fetchCardImage(start, chain(hop('/img/1024/cc/abc'), new Response('photo', { headers: { 'content-type': 'image/webp' } })));
  assert.equal(resized.bytes.toString(), 'photo', 'Collector Crypt sends a photo on to a resized copy on its own host');
  await assert.rejects(fetchCardImage(start, chain(hop('http://169.254.169.254/latest/meta-data'))), /not allowed/, 'never to a private address');
  await assert.rejects(fetchCardImage(start, chain(hop('https://evil.example/a.png'))), /not allowed/);
  await assert.rejects(fetchCardImage(start, chain(hop('/a'), hop('/b'), hop('/c'), hop('/d'), hop('/e'))), /unavailable/, 'a redirect loop gives up');
});

test('a finished pull is public by id; unknown and malformed ids are refused', async () => {
  const s = await setup(), { wallet } = await user(s, 10_000);
  const { order } = await s.orders.create(wallet, 'pokemon_25');
  const { app } = await createApp({ services: s, timers: false, logger: false });
  assert.equal((await app.inject({ url: `/api/pulls/${order.id}` })).statusCode, 404, 'an unfinished order is not public');
  await s.orders.pay(wallet, order.id, 'practice');
  const done = await settle(s, order.id);

  const seen = await app.inject({ url: `/api/pulls/${order.id}` });
  assert.equal(seen.statusCode, 200);
  assert.equal(seen.json().valueUsd, done.valueUsd);
  assert.ok(!seen.body.includes(wallet), 'the wallet stays shortened');
  const page = await app.inject({ url: `/s/${order.id}` });
  assert.equal(page.statusCode, 200);
  assert.match(page.headers['content-type'] as string, /text\/html/);
  assert.match(page.body, new RegExp(`/pull/${order.id}`));
  assert.equal((await app.inject({ url: '/api/pulls/1a2b3c4d-0000-4000-8000-000000000000' })).statusCode, 404);
  assert.equal((await app.inject({ url: '/api/pulls/not-an-id' })).statusCode, 400);
  assert.equal((await app.inject({ url: '/s/not-an-id' })).statusCode, 400);
  assert.equal((await app.inject({ url: '/api/pulls/site' })).statusCode, 200, 'the named lists still answer');
  assert.equal((await app.inject({ url: '/api/pulls/recent' })).statusCode, 200);
  await app.close();
});
