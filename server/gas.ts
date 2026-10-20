import { randomUUID } from 'node:crypto';
import { audit, record, sum, type Database } from './db';
import { Jobs, PendingOperation } from './jobs';
import type { Solana } from './ports';
import type { Pool } from './pool';
import type { SettingsStore } from './settings';
import { micros, usd } from '../shared/protection';

export const lamports = (sol: number) => BigInt(Math.round(sol * 1e9));
const sol = (value: bigint) => Number(value) / 1e9;
/** Enough for an OPS transaction's fees plus rent for a buyer's new token account. */
export const OPS_MIN_TO_SIGN = lamports(0.01);
/** Smallest top-up worth a transaction. */
const MIN_TRANSFER = lamports(0.005);

/**
 * Keeps both wallets able to pay Solana network fees:
 * - OPS below `gas.opsMinSol`: POOL sends it SOL, up to `gas.opsTargetSol`.
 * - POOL below `gas.poolMinSol` (counting that transfer): POOL first buys SOL with `gas.buyUsd` of its
 *   USDC, at most `gas.maxUsdPerDay` a day. That spend is recorded in the ledger as `gas`.
 * POOL never sends below `gasReserveSol`, so it can always sign its own payouts.
 * Each cycle is a job with fixed amounts, so a crash resumes the same swap and transfer instead of repeating them.
 */
export class Gas {
  private ops: { lamports: bigint; at: number } | null = null;
  private warnedAt = 0;
  constructor(readonly db: Database, readonly jobs: Jobs, readonly solana: Solana, readonly pool: Pool, readonly settings: SettingsStore) {}

  /** Whether OPS can pay for its next transactions. Cached briefly: the order loop asks every couple of seconds. */
  async opsReady() {
    if (!this.ops || Date.now() - this.ops.at > 10_000) this.ops = { lamports: await this.solana.solBalance('ops'), at: Date.now() };
    return this.ops.lamports >= OPS_MIN_TO_SIGN;
  }

  /** USDC the pool spent on SOL over the last 24 hours. */
  async spentToday() { return -(await sum(this.db, "bucket='pool' AND kind='gas' AND created_at>=$1", [Date.now() - 86_400_000])); }

  async status() {
    const [ops, pool, spent] = await Promise.all([this.solana.solBalance('ops'), this.solana.solBalance('pool'), this.spentToday()]);
    return { opsSol: sol(ops), poolSol: sol(pool), spentTodayUsd: usd(spent), opsReady: ops >= OPS_MIN_TO_SIGN };
  }

  async ensure() {
    const s = this.settings.current, g = s.gas;
    if (!this.solana.canSpend) return null;
    let cycle = (await this.db.query("SELECT * FROM jobs WHERE kind='gas-cycle' AND status<>'complete' ORDER BY created_at LIMIT 1")).rows[0];
    if (!cycle) {
      const [ops, pool] = await Promise.all([this.solana.solBalance('ops'), this.solana.solBalance('pool')]);
      const send = ops < lamports(g.opsMinSol) ? lamports(g.opsTargetSol) - ops : 0n;
      let buy = 0;
      if (pool - send < lamports(g.poolMinSol) && g.maxUsdPerDay > 0) {
        const room = micros(g.maxUsdPerDay) - await this.spentToday();
        buy = Math.max(0, Math.min(micros(g.buyUsd), room, await this.pool.free()));
        if (buy < micros(1)) { buy = 0; await this.warn('POOL is low on SOL and the daily budget for buying more is used up.'); }
      } else if (pool - send < lamports(g.poolMinSol)) await this.warn('POOL is low on SOL and buying SOL is turned off. Send it some SOL.');
      if (send === 0n && buy === 0) return null;
      const id = `gas:${randomUUID()}`;
      await this.jobs.put(id, 'gas-cycle', 'started', { send: send.toString(), buyMicros: buy });
      cycle = await this.jobs.get(id);
    }
    const d = cycle.data;

    if (d.buyMicros > 0 && !d.bought) {
      try {
        const bought = await this.solana.buyGas(`${cycle.id}:buy`, d.buyMicros, s);
        await record(this.db, { id: `${cycle.id}:buy`, bucket: 'pool', kind: 'gas', micros: -d.buyMicros, signature: bought.signature, data: { lamports: bought.lamports.toString() } });
        d.bought = bought.lamports.toString(); this.pool.invalidate();
        await this.jobs.put(cycle.id, 'gas-cycle', 'bought', d);
      } catch (error) {
        // A swap that never got signed (no route, stale quote) is safe to skip: still send what POOL can spare.
        if (error instanceof PendingOperation || (await this.jobs.get(`${cycle.id}:buy`))?.data?.signature) throw error;
        await audit(this.db, 'gas-buy-error', { id: cycle.id, error: (error as Error).message });
        d.buyMicros = 0; d.buyError = (error as Error).message;
        await this.jobs.put(cycle.id, 'gas-cycle', 'started', d);
      }
    }

    if (BigInt(d.send) > 0n && !d.sent) {
      if (!d.sendLamports) {
        // Fix the amount before signing so a resumed cycle sends exactly the same transfer.
        const spare = (await this.solana.solBalance('pool')) - lamports(s.gasReserveSol);
        const amount = BigInt(d.send) < spare ? BigInt(d.send) : spare;
        if (amount < MIN_TRANSFER) {
          await this.warn('OPS needs SOL for network fees but POOL has none to spare.');
          await this.jobs.put(cycle.id, 'gas-cycle', 'complete', { ...d, skipped: 'POOL had no SOL to spare' });
          return null;
        }
        d.sendLamports = amount.toString();
        await this.jobs.put(cycle.id, 'gas-cycle', 'sending', d);
      }
      d.sent = await this.solana.sendGas(`${cycle.id}:send`, BigInt(d.sendLamports), s);
      this.ops = null;
    }
    await this.jobs.put(cycle.id, 'gas-cycle', 'complete', d);
    const result = { id: cycle.id as string, boughtUsd: usd(d.buyMicros), sentSol: sol(BigInt(d.sendLamports ?? 0)) };
    await audit(this.db, 'gas-topup', result);
    return result;
  }

  /** Low-SOL warnings go to the audit log at most once an hour. */
  private async warn(message: string) {
    if (Date.now() - this.warnedAt < 3_600_000) return;
    this.warnedAt = Date.now();
    await audit(this.db, 'gas-low', { message });
  }
}
