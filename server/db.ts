import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { mkdir } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from './config';

export interface Database {
  query<T = Record<string, any>>(sql: string, params?: any[]): Promise<{ rows: T[]; command?: string }>;
  close(): Promise<void>;
  /** Runs `fn` in a transaction that unrelated queries cannot slip into (see `gated`). */
  transaction?<T>(fn: () => Promise<T>): Promise<T>;
}

const inTransaction = new AsyncLocalStorage<true>();

/**
 * Everything shares one connection, and BEGIN…COMMIT on a shared connection would absorb any query
 * sent meanwhile by unrelated work (a sign-in, a balance snapshot), which a ROLLBACK would then undo.
 * While a transaction is open, queries from outside it wait at this gate; queries inside it pass.
 */
function gated(raw: Database): Database {
  let gate: Promise<void> = Promise.resolve();
  return {
    query: async (sql, params) => { if (!inTransaction.getStore()) await gate; return raw.query(sql, params); },
    close: () => raw.close(),
    transaction: async fn => {
      let release!: () => void;
      const previous = gate; gate = new Promise(resolve => { release = resolve; });
      await previous;
      try {
        return await inTransaction.run(true, async () => {
          await raw.query('BEGIN');
          try {
            const result = await fn();
            // Postgres answers COMMIT on an aborted transaction with ROLLBACK and no error.
            if ((await raw.query('COMMIT')).command === 'ROLLBACK') throw new Error('The database rolled this transaction back.');
            return result;
          } catch (error) { await raw.query('ROLLBACK').catch(() => {}); throw error; }
        });
      } finally { release(); }
    },
  };
}

export async function openDatabase(url = config.DATABASE_URL, directory = config.PGLITE_DIR): Promise<Database> {
  if (url) {
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 8000, query_timeout: 15000 });
    let connected = false;
    client.on('error', () => { connected = false; });
    await client.connect();
    // One durable coordinator owns every financial transition.
    const lock = await client.query('SELECT pg_try_advisory_lock(713531923) AS acquired');
    if (!lock.rows[0].acquired) { await client.end(); throw new Error('Another coordinator is already running.'); }
    connected = true;
    // A pool can silently reconnect without owning the advisory lock. Stop instead; restart reconciles.
    return gated({
      query: async <T>(sql: string, params?: any[]) => {
        if (!connected) throw new Error('Database coordinator connection lost. Restart to reconcile.');
        const result = await client.query(sql, params);
        return { rows: result.rows as T[], command: result.command };
      },
      close: async () => { connected = false; await client.end(); },
    });
  }
  if (directory !== 'memory://') await mkdir(directory, { recursive: true });
  const database = new PGlite(directory);
  await database.waitReady;
  return gated({ query: async (sql, params) => database.query(sql, params), close: () => database.close() });
}

export async function migrate(db: Database) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS wallets (wallet TEXT PRIMARY KEY, activated_at BIGINT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, wallet TEXT NOT NULL, message TEXT NOT NULL, expires_at BIGINT NOT NULL, consumed BOOLEAN NOT NULL DEFAULT FALSE)`,
    `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, wallet TEXT NOT NULL REFERENCES wallets(wallet), expires_at BIGINT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), data JSONB NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS snapshots (wallet TEXT NOT NULL, taken_at BIGINT NOT NULL, balance TEXT NOT NULL, supply TEXT NOT NULL, PRIMARY KEY(wallet, taken_at))`,
    `CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, wallet TEXT NOT NULL, status TEXT NOT NULL, price_micros BIGINT NOT NULL, fee_micros BIGINT NOT NULL, coverage_bps INTEGER NOT NULL, max_rebate_micros BIGINT NOT NULL, payment_signature TEXT UNIQUE, data JSONB NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, error TEXT)`,
    `CREATE TABLE IF NOT EXISTS pulls (memo TEXT PRIMARY KEY, source TEXT NOT NULL, wallet TEXT NOT NULL, order_id TEXT, price_micros BIGINT NOT NULL, value_micros BIGINT NOT NULL, rebate_micros BIGINT NOT NULL DEFAULT 0, nft_mint TEXT NOT NULL, pulled_at BIGINT NOT NULL, data JSONB NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS claims (memo TEXT PRIMARY KEY, wallet TEXT NOT NULL, status TEXT NOT NULL, price_micros BIGINT NOT NULL, value_micros BIGINT NOT NULL, coverage_bps INTEGER NOT NULL, rebate_micros BIGINT NOT NULL, signature TEXT, pulled_at BIGINT NOT NULL, created_at BIGINT NOT NULL, paid_at BIGINT, data JSONB NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, micros BIGINT NOT NULL, created_at BIGINT NOT NULL, released_at BIGINT)`,
    // Signed amounts: inflows positive, outflows negative. Buckets: pool, burn, ops, transfer.
    `CREATE TABLE IF NOT EXISTS ledger (id TEXT PRIMARY KEY, bucket TEXT NOT NULL, kind TEXT NOT NULL, amount_micros BIGINT NOT NULL, signature TEXT, ref TEXT, created_at BIGINT NOT NULL, data JSONB NOT NULL DEFAULT '{}')`,
    `CREATE TABLE IF NOT EXISTS burns (id TEXT PRIMARY KEY, usdc_micros BIGINT NOT NULL, tokens TEXT NOT NULL, swap_signature TEXT, burn_signature TEXT, created_at BIGINT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, data JSONB NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, error TEXT)`,
    `CREATE TABLE IF NOT EXISTS audit (id BIGSERIAL PRIMARY KEY, event TEXT NOT NULL, data JSONB NOT NULL, created_at BIGINT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS ledger_time ON ledger(bucket, created_at)`,
    `CREATE INDEX IF NOT EXISTS orders_open ON orders(status) WHERE status NOT IN ('complete','refunded','expired')`,
    `CREATE INDEX IF NOT EXISTS claims_wallet ON claims(wallet, created_at)`,
    `CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at)`,
    // Added after launch: when a wallet was last active, so balance snapshots keep covering returning holders.
    `ALTER TABLE wallets ADD COLUMN IF NOT EXISTS last_seen_at BIGINT`,
    `UPDATE wallets SET last_seen_at=activated_at WHERE last_seen_at IS NULL`,
    `CREATE INDEX IF NOT EXISTS snapshots_time ON snapshots(taken_at)`,
  ];
  for (const statement of statements) await db.query(statement);
}

export class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.pending >= 256) return Promise.reject(Object.assign(new Error('The server is busy. Try again shortly.'), { statusCode: 503 }));
    this.pending++;
    const next = this.tail.then(fn, fn).finally(() => { this.pending--; });
    this.tail = next.catch(() => {});
    return next;
  }
}

export async function atomic<T>(db: Database, fn: () => Promise<T>) {
  // Nested calls are part of the transaction already open.
  if (inTransaction.getStore()) return fn();
  if (db.transaction) return db.transaction(fn);
  await db.query('BEGIN');
  try { const result = await fn(); await db.query('COMMIT'); return result; } catch (error) { await db.query('ROLLBACK'); throw error; }
}

export const audit = (db: Database, event: string, data: unknown) => db.query('INSERT INTO audit(event,data,created_at) VALUES($1,$2,$3)', [event, JSON.stringify(data), Date.now()]);

/** Records a ledger entry once; the id makes every financial event idempotent. */
export const record = (db: Database, entry: { id: string; bucket: 'pool' | 'burn' | 'ops' | 'transfer'; kind: string; micros: number; signature?: string | null; ref?: string | null; data?: unknown }) =>
  db.query('INSERT INTO ledger(id,bucket,kind,amount_micros,signature,ref,created_at,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING',
    [entry.id, entry.bucket, entry.kind, Math.trunc(entry.micros), entry.signature ?? null, entry.ref ?? null, Date.now(), JSON.stringify(entry.data ?? {})]);

export async function sum(db: Database, where: string, params: any[] = []) {
  const row = (await db.query<{ total: string }>(`SELECT COALESCE(SUM(amount_micros),0)::text AS total FROM ledger WHERE ${where}`, params)).rows[0];
  return Number(row.total);
}
