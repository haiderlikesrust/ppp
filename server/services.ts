import { PublicKey } from '@solana/web3.js';
import { config } from './config';
import { openDatabase, migrate, Serial, type Database } from './db';
import { Jobs } from './jobs';
import { SettingsStore } from './settings';
import { Chain, connection } from './chain';
import { treasurySigner } from './treasury-signer';
import { LiveSolana } from './solana-live';
import { MockPacks, MockSolana } from './mock';
import { CollectorCrypt } from './cc/client';
import { CollectorCryptPacks } from './cc/packs';
import { JobPurchaseStore } from './cc/store';
import { Holders } from './holders';
import { Pool } from './pool';
import { Orders } from './orders';
import { Claims } from './claims';
import { Treasury } from './treasury';
import { Gas } from './gas';
import type { PackProvider, Solana } from './ports';

export type Services = Awaited<ReturnType<typeof createServices>>;

function signer(name: 'OPS_PRIVATE_KEY' | 'POOL_PRIVATE_KEY') {
  try { return treasurySigner(config[name]); }
  catch { throw new Error(`${name} is invalid. Use a base58-encoded 64-byte Solana private key or a JSON array of 64 byte values.`); }
}

/**
 * Practice mode (in-memory Solana, mocked Collector Crypt, anyone may open /admin) is for local
 * development only. A production container without an RPC runs read-only instead.
 */
export const practiceAllowed = () => !config.live && !config.SOLANA_RPC_URL && process.env.NODE_ENV !== 'production';

/** Wires the app: practice mode locally, live adapters otherwise (signing only when MAINNET_ENABLED=true). */
export async function createServices(options: { db?: Database; solana?: Solana; packs?: PackProvider } = {}) {
  const db = options.db ?? await openDatabase();
  await migrate(db);
  const jobs = new Jobs(db), settings = new SettingsStore(db);
  await settings.load();
  let solana: Solana, packs: PackProvider;
  if (options.solana && options.packs) { solana = options.solana; packs = options.packs; }
  else if (practiceAllowed()) {
    const mock = new MockSolana();
    solana = options.solana ?? mock;
    packs = options.packs ?? new MockPacks(() => mock.opsAddress);
  } else {
    const rpc = connection(), ops = new Chain(jobs, signer('OPS_PRIVATE_KEY'), rpc, 'OPS'), pool = new Chain(jobs, signer('POOL_PRIVATE_KEY'), rpc, 'POOL');
    new PublicKey(config.COLLECTOR_CRYPT_PAYMENT_WALLET);
    solana = options.solana ?? new LiveSolana(ops, pool, rpc);
    packs = options.packs ?? new CollectorCryptPacks(new CollectorCrypt(config.COLLECTOR_CRYPT_API_KEY), { connection: rpc, signer: ops.signer, paymentWallet: config.COLLECTOR_CRYPT_PAYMENT_WALLET, store: new JobPurchaseStore(jobs), enabled: config.live, dasRpcUrl: config.dasRpcUrl });
  }
  const holders = new Holders(db, solana, settings), pool = new Pool(db, solana, settings);
  const gas = new Gas(db, jobs, solana, pool, settings);
  const orders = new Orders(db, jobs, solana, packs, holders, pool, settings, gas);
  const claims = new Claims(db, solana, packs, holders, pool, settings);
  const treasury = new Treasury(db, jobs, solana, pool, settings);
  return { db, jobs, settings, solana, packs, holders, pool, gas, orders, claims, treasury, serial: new Serial(), practice: solana instanceof MockSolana };
}

/** Background loops. Every financial step runs through the one Serial queue. */
export function startCoordinator(s: Services, log: (message: string, error?: unknown) => void) {
  const timers: ReturnType<typeof setInterval>[] = [];
  const every = (ms: number, name: string, task: () => Promise<unknown>, queued = true) => {
    let busy = false;
    timers.push(setInterval(() => {
      if (busy) return; busy = true;
      (queued ? s.serial.run(task) : task()).catch(error => log(`${name} failed`, error)).finally(() => { busy = false; });
    }, ms));
  };
  every(2_000, 'orders', () => s.orders.step());
  every(10_000, 'claims', () => s.claims.step());
  // One RPC call per active wallet and no money: kept out of the queue so a long sweep never delays payments.
  every(15 * 60_000, 'snapshots', async () => { await s.holders.snapshotAll(); await s.holders.prune(); }, false);
  every(5 * 60_000, 'treasury', () => s.treasury.run());
  // One balance check per wallet; a top-up only when OPS runs low.
  every(30_000, 'gas', () => s.gas.ensure());
  every(5 * 60_000, 'cleanup', async () => { await s.db.query('DELETE FROM sessions WHERE expires_at<$1', [Date.now()]); await s.db.query('DELETE FROM challenges WHERE expires_at<$1', [Date.now()]); });
  return () => timers.forEach(clearInterval);
}
