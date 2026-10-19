import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { createApp } from '../server/app';
import { config } from '../server/config';
import { openDatabase, type Database } from '../server/db';
import { createServices, practiceAllowed } from '../server/services';
import { MockPacks, MockSolana } from '../server/mock';
import { createSession } from '../server/auth';

async function services(db?: Database) {
  const solana = new MockSolana();
  return createServices({ db: db ?? await openDatabase(undefined, 'memory://'), solana, packs: new MockPacks(() => solana.opsAddress) });
}

test('health checks the database and stays available under frequent probes', async () => {
  const memory = await openDatabase(undefined, 'memory://');
  let unavailable = false;
  const db: Database = { query: (sql, params) => { if (unavailable) throw new Error('Database unavailable'); return memory.query(sql, params); }, close: () => memory.close() };
  const { app } = await createApp({ services: await services(db), timers: false, logger: false });
  try {
    for (let i = 0; i < 150; i++) assert.equal((await app.inject('/api/health')).statusCode, 200, 'health is never rate limited');
    unavailable = true;
    const failure = await app.inject('/api/health');
    assert.equal(failure.statusCode, 503);
    assert.deepEqual(failure.json(), { ok: false, service: 'pull-protection' });
    unavailable = false;
    const ok = (await app.inject('/api/health')).json();
    assert.equal(ok.spendingEnabled, false);
    assert.equal(ok.database, 'embedded-postgres');
  } finally { await app.close(); }
});

test('two trusted proxy hops (Traefik -> nginx) keep the real client IP without trusting a forged one', async () => {
  const original = config.TRUST_PROXY_HOPS;
  config.TRUST_PROXY_HOPS = 2;
  const { app } = await createApp({ services: await services(), timers: false, logger: false });
  app.get('/test-client-ip', async req => ({ ip: req.ip }));
  try {
    const proxied = await app.inject({ url: '/test-client-ip', remoteAddress: '172.20.0.2', headers: { 'x-forwarded-for': '198.51.100.99, 203.0.113.10, 172.21.0.2' } });
    assert.equal(proxied.json().ip, '203.0.113.10');
    const direct = await app.inject({ url: '/test-client-ip', remoteAddress: '203.0.113.20', headers: { 'x-forwarded-for': '198.51.100.99, 172.21.0.2' } });
    assert.equal(direct.json().ip, '203.0.113.20', 'a public client cannot claim to be a proxy');
  } finally { config.TRUST_PROXY_HOPS = original; await app.close(); }
});

test('production never runs practice mode, even with no RPC configured', () => {
  const original = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    assert.equal(practiceAllowed(), false);
    process.env.NODE_ENV = 'development';
    assert.equal(practiceAllowed(), true);
  } finally { process.env.NODE_ENV = original; }
});

test('outside practice mode the practice API does not exist and admin needs the owner wallet', async () => {
  const s = { ...(await services()), practice: false };
  const { app } = await createApp({ services: s, timers: false, logger: false });
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/practice/login', payload: {} })).statusCode, 404);
    const { token } = await createSession(s.db, Keypair.generate().publicKey.toBase58());
    const admin = await app.inject({ url: '/api/admin', cookies: { pp_session: token } });
    assert.equal(admin.statusCode, 403);
  } finally { await app.close(); }
});
