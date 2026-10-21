import Fastify from 'fastify';
import { ShowcaseSource } from './showcase';
import { leaderboard, sitePulls } from './leaderboard';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { z } from 'zod';
import { config, configBlockers } from './config';
import { trustInternalProxies } from './proxy';
import { challenge, verify, sessionWallet, hashSession, createSession } from './auth';
import { audit } from './db';
import { createServices, startCoordinator, type Services } from './services';
import { MockPacks, MockSolana } from './mock';
import { loadCalibration } from './calibration';
import { settingsSchema, settingsVersion } from './settings';
import { settingsProblems } from '../shared/protection';
import { publicError, redact } from './redact';

const COOKIE = 'pp_session';
const wallet = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

export function originAllowed(method: string, origin: string | undefined, fetchSite: string | undefined, appOrigin: string) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return true;
  return fetchSite !== 'cross-site' && (!origin || origin === appOrigin);
}

const showcase = new ShowcaseSource();

export async function createApp(options: { services?: Services; timers?: boolean; logger?: boolean } = {}) {
  const app = Fastify({ logger: options.logger ?? true, bodyLimit: 16_384, requestTimeout: 30_000, trustProxy: trustInternalProxies(config.TRUST_PROXY_HOPS) });
  await app.register(cookie);
  const s = options.services ?? await createServices();
  // Per-IP request limits protect the live API from bots. Locally every tab and script shares
  // 127.0.0.1 and there is nothing to protect, so practice mode skips them.
  await app.register(rateLimit, {
    max: 120, timeWindow: '1 minute', allowList: () => s.practice,
    errorResponseBuilder: (_req, context) => ({ statusCode: 429, message: `Too many requests. Please wait ${context.after} and try again.` }),
  });
  const { db, serial } = s;

  app.addHook('onRequest', async (req, reply) => { if (!originAllowed(req.method, req.headers.origin, req.headers['sec-fetch-site'] as string | undefined, config.APP_ORIGIN)) return reply.code(403).send({ error: 'Request origin is not allowed.' }); });
  app.addHook('onSend', async (req, reply, payload) => { if (req.url.startsWith('/api')) reply.header('Cache-Control', 'no-store'); reply.header('X-Content-Type-Options', 'nosniff').header('X-Frame-Options', 'DENY').header('Referrer-Policy', 'no-referrer'); return payload; });
  app.setErrorHandler((error, req, reply) => {
    const e = error as Error & { statusCode?: number };
    if (e instanceof z.ZodError) return reply.code(400).send({ error: 'Check the submitted fields.', fields: e.issues.map(i => i.path.join('.')) });
    const { status, message } = publicError(e);
    if (status >= 500) app.log.error({ message: redact(e.message), path: req.url }, 'Request failed');
    else if (e.cause) app.log.warn({ message: e.message, cause: redact(String(e.cause)), path: req.url }, 'Request refused');
    return reply.code(status).send({ error: message });
  });

  const auth = async (req: any, owner = false) => {
    const session = await sessionWallet(db, req.cookies[COOKIE]);
    if (!session) throw Object.assign(new Error('Connect and sign in with your wallet.'), { statusCode: 401 });
    if (owner && !session.owner && !s.practice) throw Object.assign(new Error('Owner access required.'), { statusCode: 403 });
    return session;
  };
  const setSession = (reply: any, token: string) => reply.setCookie(COOKIE, token, { path: '/', httpOnly: true, sameSite: 'strict', secure: config.APP_ORIGIN.startsWith('https:'), maxAge: 86_400 });

  app.get('/api/health', { config: { rateLimit: false } }, async (_req, reply) => {
    try { await db.query('SELECT 1'); } catch { return reply.code(503).send({ ok: false, service: 'pullback' }); }
    return { ok: true, service: 'pullback', mode: s.practice ? 'practice' : config.live ? 'mainnet' : 'read-only', database: config.DATABASE_URL ? 'postgres' : 'embedded-postgres', spendingEnabled: config.live && !s.settings.current.paused };
  });
  app.get('/api/config', async () => ({ mode: s.practice ? 'practice' : config.live ? 'mainnet' : 'read-only', mint: s.solana.holderMint, poolAddress: s.solana.poolAddress, opsAddress: s.solana.opsAddress, settings: publicSettings(s) }));

  app.post('/api/auth/challenge', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async req => { const body = z.object({ wallet }).parse(req.body); return challenge(db, body.wallet); });
  app.post('/api/auth/verify', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = z.object({ id: z.string().uuid(), signature: z.string().max(100) }).parse(req.body);
    // Sign-in is a couple of single-statement DB writes; it doesn't wait behind the coordinator queue.
    const result = await verify(db, body.id, body.signature);
    // The activation snapshot is what later off-site claims measure holdings from.
    await s.holders.snapshot(result.wallet).catch(() => {});
    setSession(reply, result.token);
    return { wallet: result.wallet };
  });
  app.post('/api/auth/logout', async (req, reply) => { const token = req.cookies[COOKIE]; if (token) await db.query('DELETE FROM sessions WHERE id=$1', [hashSession(token)]); reply.clearCookie(COOKIE, { path: '/' }); return { ok: true }; });

  app.get('/api/me', async req => {
    const session = await sessionWallet(db, req.cookies[COOKIE]);
    if (!session) return { wallet: null };
    let holder = null;
    try { holder = await s.holders.view(session.wallet, session.activatedAt); } catch { /* RPC trouble should not sign anyone out */ }
    return { wallet: session.wallet, owner: session.owner || s.practice, activatedAt: session.activatedAt, holder };
  });

  app.get('/api/packs', async req => {
    const session = await sessionWallet(db, req.cookies[COOKIE]);
    return { packs: await s.orders.quotes(session?.wallet ?? null) };
  });
  app.post('/api/orders', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async req => {
    const session = await auth(req);
    // `priceUsd` alone is from older pages, which only offered Pokémon packs.
    const body = z.object({ code: z.string().min(1).max(40).optional(), priceUsd: z.number().int().positive().optional() }).refine(b => b.code || b.priceUsd, 'Choose a pack.').parse(req.body);
    // Slow provider and RPC calls run outside the queue; only the DB check-and-insert waits in it.
    return s.orders.create(session.wallet, body.code ?? `pokemon_${body.priceUsd}`, fn => serial.run(fn));
  });
  app.post('/api/orders/:id/pay', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async req => {
    const session = await auth(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { signed } = z.object({ signed: z.string().min(1).max(2_000) }).parse(req.body);
    return s.orders.pay(session.wallet, id, signed, fn => serial.run(fn));
  });
  app.post('/api/orders/:id/cancel', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async req => {
    const session = await auth(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return serial.run(() => s.orders.cancel(session.wallet, id));
  });
  app.get('/api/orders/:id', { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } }, async req => { const session = await auth(req); const { id } = z.object({ id: z.string().uuid() }).parse(req.params); return s.orders.get(id, session.wallet); });
  app.get('/api/orders', async req => { const session = await auth(req); return { orders: await s.orders.list(session.wallet) }; });

  app.get('/api/claims/scan', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async req => {
    const session = await auth(req);
    return { candidates: await s.claims.scan(session.wallet, session.activatedAt), claims: await s.claims.list(session.wallet), holding: await s.claims.holding(session.wallet) };
  });
  const txSignature = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/);
  // A pull the scan can't find (for example buried under spam transfers), looked up by its own transaction.
  app.post('/api/claims/lookup', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async req => {
    const session = await auth(req);
    const { signature } = z.object({ signature: txSignature }).parse(req.body);
    return s.claims.lookup(session.wallet, session.activatedAt, signature);
  });
  app.post('/api/claims/:memo', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async req => {
    const session = await auth(req);
    const { memo } = z.object({ memo: z.string().regex(/^[a-z0-9]{2,16}-[a-f0-9-]{36}$/) }).parse(req.params);
    const { signature } = z.object({ signature: txSignature.optional() }).parse(req.body ?? {});
    // Verification (RPC + Collector Crypt) runs outside the queue; the limit checks and insert run inside it.
    return s.claims.claim(session.wallet, session.activatedAt, memo, signature, fn => serial.run(fn));
  });

  app.get('/api/pool', async () => s.pool.view());
  app.get('/api/activity', async () => ({ items: await s.pool.activity() }));
  // Collector Crypt's pack images and one real card, for the site's artwork.
  app.get('/api/showcase', async () => showcase.get());
  app.get('/api/pulls/recent', async () => ({ items: s.feed.recent(24) }));
  app.get('/api/pulls/pullback', async () => ({ items: await sitePulls(db, 24) }));
  app.get('/api/stats', async () => s.feed.stats());
  app.get('/api/leaderboard', async req => {
    const { week } = z.object({ week: z.enum(['current', 'last']).default('current') }).parse(req.query);
    const viewer = await sessionWallet(db, req.cookies[COOKIE]).catch(() => null);
    return leaderboard(db, week, viewer?.wallet ?? null);
  });

  app.get('/api/admin', async req => {
    await auth(req, true);
    const calibration = await loadCalibration();
    return {
      settings: s.settings.current, version: settingsVersion(s.settings.current), gas: await s.gas.status().catch(() => null), blockers: s.practice ? ['Practice mode: in-memory Solana and a mocked Collector Crypt'] : configBlockers(),
      problems: settingsProblems(s.settings.current, calibration?.distributions ?? []), calibration,
      review: (await db.query("SELECT id,wallet,status,error,updated_at::text FROM orders WHERE status='review' ORDER BY updated_at DESC LIMIT 50")).rows,
      // Paid orders that keep failing a step and are waiting to retry, with the reason.
      delayed: (await db.query("SELECT id,status,error,COALESCE((data->>'failures')::int,0) AS failures,COALESCE((data->>'retryAt')::bigint,0)::text AS retry_at,updated_at::text FROM orders WHERE status IN ('paying','paid','buying','delivering','settling','refunding') AND (COALESCE((data->>'failures')::int,0) > 0 OR (data->'waiting'->>'status' = status AND (data->'waiting'->>'since')::bigint < $1)) ORDER BY updated_at DESC LIMIT 50", [Date.now() - 10 * 60_000])).rows.map(r => ({ ...r, error: r.error ? redact(r.error) : null })),
      // Includes Collector Crypt purchases that were signed but never finished, so none can hide.
      jobs: (await db.query("SELECT id,kind,status,error,updated_at::text FROM jobs WHERE status IN ('failed','retryable','submitted','prepared') OR (kind='cc-purchase' AND status IN ('signed','ordered') AND updated_at < $1) ORDER BY updated_at DESC LIMIT 50", [Date.now() - 600_000])).rows,
      audit: (await db.query('SELECT id::text,event,data,created_at::text FROM audit ORDER BY id DESC LIMIT 50')).rows,
    };
  });
  app.patch('/api/admin/settings', async req => {
    const session = await auth(req, true);
    const next = settingsSchema.parse(req.body);
    const problems = settingsProblems(next, (await loadCalibration())?.distributions ?? []);
    if (problems.length) throw Object.assign(new Error(problems.join(' ')), { statusCode: 422 });
    await serial.run(async () => {
      // Refuse a save based on stale settings, e.g. the loss breaker paused a pack after the page loaded.
      const expected = req.headers['if-match'];
      if (expected && expected !== settingsVersion(s.settings.current)) throw Object.assign(new Error('Settings changed since you opened this page (for example the automatic brake paused a pack). Reload and try again.'), { statusCode: 409 });
      await s.settings.save(next); await audit(db, 'settings-updated', { wallet: session.wallet, settings: next });
    });
    return { settings: s.settings.current, version: settingsVersion(s.settings.current) };
  });
  // Quick sell: Collector Crypt's sell-back for a card from a finished order.
  app.get('/api/orders/:id/sell', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async req => {
    const session = await auth(req); const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return s.orders.sellQuote(session.wallet, id);
  });
  app.post('/api/orders/:id/sell', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async req => {
    const session = await auth(req); const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return s.orders.sellStart(session.wallet, id);
  });
  app.post('/api/orders/:id/sell/submit', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async req => {
    const session = await auth(req); const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { signed } = z.object({ signed: z.string().min(1).max(4_000) }).parse(req.body);
    return s.orders.sellSubmit(session.wallet, id, signed);
  });
  app.post('/api/admin/orders/:id/retry-now', async req => {
    const session = await auth(req, true);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await serial.run(async () => { await s.orders.retryNow(id); await audit(db, 'order-retry-now', { wallet: session.wallet, id }); });
    return { ok: true };
  });
  app.post('/api/admin/orders/:id/resolve', async req => {
    const session = await auth(req, true);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { action } = z.object({ action: z.enum(['retry', 'refund']) }).parse(req.body);
    await serial.run(async () => { await s.orders.resolve(id, action); await audit(db, 'order-resolved', { wallet: session.wallet, id, action }); });
    return { ok: true };
  });
  app.post('/api/admin/treasury/run', async req => { await auth(req, true); return serial.run(() => s.treasury.run()); });
  app.post('/api/admin/gas/run', async req => { await auth(req, true); return serial.run(() => s.gas.ensure()); });

  // Practice-only helpers. They do not exist when real Solana is wired in.
  if (s.practice && s.solana instanceof MockSolana && s.packs instanceof MockPacks) {
    const mock = s.solana, packs = s.packs;
    app.post('/api/practice/login', async (req, reply) => {
      const body = z.object({ wallet: wallet.optional() }).parse(req.body ?? {});
      const address = body.wallet ?? Keypair.generate().publicKey.toBase58();
      const session = await serial.run(() => createSession(db, address));
      await s.holders.snapshot(address);
      setSession(reply, session.token);
      return { wallet: address };
    });
    app.post('/api/practice/holdings', async req => {
      const session = await auth(req);
      const { ppm } = z.object({ ppm: z.number().int().min(0).max(1_000_000) }).parse(req.body);
      mock.setHolderPpm(session.wallet, ppm);
      s.claims.forget(session.wallet);
      return s.holders.view(session.wallet, session.activatedAt);
    });
    // Moves activation and holdings history back in time so off-site coverage can be tried immediately.
    app.post('/api/practice/backdate', async req => {
      const session = await auth(req);
      const { hours } = z.object({ hours: z.number().min(1).max(24 * 30) }).parse(req.body);
      const at = Date.now() - hours * 3_600_000;
      await serial.run(async () => { await db.query('UPDATE wallets SET activated_at=LEAST(activated_at,$2) WHERE wallet=$1', [session.wallet, at]); await s.holders.snapshot(session.wallet, at); });
      return { activatedAt: at };
    });
    // Restarts the wallet's coin history: it first bought its current holdings `hoursAgo` hours ago.
    app.post('/api/practice/bought', async req => {
      const session = await auth(req);
      const { hoursAgo } = z.object({ hoursAgo: z.number().min(0).max(24 * 30) }).parse(req.body);
      mock.boughtAt(session.wallet, Date.now() - hoursAgo * 3_600_000);
      s.claims.forget(session.wallet);
      return { ok: true };
    });
    app.post('/api/practice/offsite-pull', async req => {
      const session = await auth(req);
      const { priceUsd, hoursAgo } = z.object({ priceUsd: z.number().int().positive(), hoursAgo: z.number().min(0).max(24 * 30) }).parse(req.body);
      s.claims.forget(session.wallet);
      return packs.offsitePull(mock, session.wallet, priceUsd, Date.now() - hoursAgo * 3_600_000);
    });
    app.post('/api/practice/fund-pool', async req => {
      await auth(req);
      const { usd } = z.object({ usd: z.number().positive().max(1_000_000) }).parse(req.body);
      mock.fundPool(Math.round(usd * 1e6)); s.pool.invalidate();
      await serial.run(() => audit(db, 'practice-pool-funded', { usd }));
      return s.pool.view();
    });
  }

  const dist = resolve('dist');
  if (existsSync(dist)) {
    await app.register(fastifyStatic, { root: dist, wildcard: false });
    app.setNotFoundHandler((req, reply) => req.url.startsWith('/api') ? reply.code(404).send({ error: 'Not found.' }) : reply.sendFile('index.html'));
  }

  const stop = options.timers === false ? () => {} : startCoordinator(s, (message, error) => app.log.error({ message: (error as Error)?.message }, message));
  app.addHook('onClose', async () => { stop(); await serial.run(() => db.close()); });
  return { app, services: s };
}

function publicSettings(s: Services) {
  const c = s.settings.current;
  return { feeBps: c.feeBps, poolShareBps: c.poolShareBps, tiers: c.tiers, maxRebateUsd: c.maxRebateUsd, offsiteHoldHours: c.offsiteHoldHours, onsiteHoldHours: c.onsiteHoldHours, offsiteActivationHours: c.offsiteActivationHours, offsite: { enabled: c.offsite.enabled, claimWindowHours: c.offsite.claimWindowHours, perWalletDailyClaims: c.offsite.perWalletDailyClaims, perWalletDailyUsd: c.offsite.perWalletDailyUsd, perWalletWeeklyUsd: c.offsite.perWalletWeeklyUsd, dailyPoolBps: c.offsite.dailyPoolBps, targetReserveUsd: c.offsite.targetReserveUsd }, breaker: c.breaker, pausedPacks: c.pausedPacks, paused: c.paused, gas: { maxUsdPerDay: c.gas.maxUsdPerDay } };
}
