import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

// Creates disposable wallet sessions. Never run against an operator's database.
assert.equal(process.env.SMOKE_TEST_FIXTURE, 'true', 'Only run in the isolated CI fixture stack');
const base = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:8080';
const origin = process.env.APP_ORIGIN;
assert.ok(origin, 'Set APP_ORIGIN to the same value the stack was started with');
// SMOKE_DIRECT=true tests the production server without Docker or Nginx: gateway-only checks
// (CSP, gzip, cache headers, Postgres) are skipped.
const gateway = process.env.SMOKE_DIRECT !== 'true';
const passed = [];

const health = await (await fetch(`${base}/api/health`)).json();
assert.equal(health.ok, true);
if (gateway) assert.equal(health.database, 'postgres');
assert.equal(health.spendingEnabled, false);
assert.equal(health.mode, 'read-only', 'Production never runs practice mode');
passed.push('health');

// Every app route is served by the single-page app.
const homepage = await fetch(base);
const html = await homepage.text();
assert.match(html, /<div id="root"><\/div>/);
assert.equal(homepage.headers.get('x-frame-options'), 'DENY');
if (gateway) {
  assert.match(homepage.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(homepage.headers.get('cache-control') ?? '', /no-cache/, 'index.html is revalidated so deploys show up at once');
}
for (const path of ['/claim', '/pool', '/how-it-works', '/docs', '/admin', '/favicon.png', '/site.webmanifest']) {
  const response = await fetch(base + path);
  assert.equal(response.status, 200, path);
  assert.ok((await response.arrayBuffer()).byteLength, path);
}
const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(m => m[1]);
assert.ok(assets.some(a => a.endsWith('.js')) && assets.some(a => a.endsWith('.css')), 'index.html links the built JS and CSS');
for (const asset of assets) {
  const response = await fetch(base + asset, { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(response.status, 200, asset);
  if (gateway) {
    assert.match(response.headers.get('cache-control') ?? '', /max-age=\d{7,}/, `${asset} is cached long-term`);
    assert.equal(response.headers.get('content-encoding'), 'gzip', `${asset} is compressed`);
  }
  await response.arrayBuffer();
}
if (gateway) assert.equal((await fetch(`${base}/assets/does-not-exist.js`)).status, 404, 'Missing assets are 404s, not index.html');
passed.push('pages and assets');

// Public API through the gateway.
const appConfig = await (await fetch(`${base}/api/config`)).json();
assert.equal(appConfig.mode, 'read-only');
assert.equal((await fetch(`${base}/api/pool`)).status, 200);
assert.equal((await fetch(`${base}/api/activity`)).status, 200);
const practice = await fetch(`${base}/api/practice/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', origin }, body: '{}' });
assert.equal(practice.status, 404, 'Practice endpoints do not exist in production');
const crossSite = await fetch(`${base}/api/auth/challenge`, { method: 'POST', headers: { 'Content-Type': 'application/json', origin: 'https://evil.example' }, body: '{}' });
assert.equal(crossSite.status, 403, 'Writes from other origins are refused');

// A real signed wallet session over the proxy.
const post = async (path, body, cookie) => {
  const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', origin, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`);
  return response;
};
const key = Keypair.generate();
const challenge = await (await post('/api/auth/challenge', { wallet: key.publicKey.toBase58() })).json();
const login = await post('/api/auth/verify', { id: challenge.id, signature: bs58.encode(nacl.sign.detached(new TextEncoder().encode(challenge.message), key.secretKey)) });
const cookie = login.headers.get('set-cookie').split(';')[0];
assert.ok(cookie.startsWith('pp_session='));
assert.match(login.headers.get('set-cookie'), /HttpOnly/i);
const me = await (await fetch(`${base}/api/me`, { headers: { cookie } })).json();
assert.equal(me.wallet, key.publicKey.toBase58());
assert.equal(me.owner, false);
assert.equal((await fetch(`${base}/api/admin`, { headers: { cookie } })).status, 403, 'Only OWNER_WALLET can open the admin API');
assert.equal((await fetch(`${base}/api/claims/scan`, { headers: { cookie } })).status < 500, true, 'Claim scan answers without crashing when no RPC is configured');

console.log(gateway
  ? 'Production stack: pages, cached assets, security headers, PostgreSQL, origin checks and signed wallet sessions passed.'
  : 'Production server (direct, no gateway): read-only mode, pages, assets, origin checks, signed wallet sessions and admin lock passed.');
