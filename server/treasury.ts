import { randomUUID } from 'node:crypto';
import { atomic, audit, record, sum, type Database } from './db';
import { Jobs, PendingOperation } from './jobs';
import type { Solana } from './ports';
import type { Pool } from './pool';
import type { SettingsStore } from './settings';
import { micros } from '../shared/protection';

/**
 * Money movement that is not tied to one order:
 * - the pool's share of on-site fees moves OPS → POOL in batches,
 * - the burn share is swapped into our coin and burned,
 * - pump.fun creator fees are claimed into POOL as USDC.
 * Each cycle is a job with a fixed amount, so a crash resumes the same transfer.
 */
export class Treasury {
  constructor(readonly db: Database, readonly jobs: Jobs, readonly solana: Solana, readonly pool: Pool, readonly settings: SettingsStore) {}

  private async cycle(kind: string, amount: () => Promise<number>, threshold: number) {
    const open = (await this.db.query("SELECT * FROM jobs WHERE kind=$1 AND status<>'complete' ORDER BY created_at LIMIT 1", [kind])).rows[0];
    if (open) return open;
    const value = await amount();
    if (value < threshold) return null;
    const id = `${kind}:${randomUUID()}`;
    await this.jobs.put(id, kind, 'started', { amount: value });
    return this.jobs.get(id);
  }

  async owedToPool() { return (await sum(this.db, "bucket='pool' AND kind='fee-share'")) - (await sum(this.db, "bucket='transfer' AND kind='fee-transfer'")); }
  async burnBucket() { return sum(this.db, "bucket='burn'"); }

  async transferFees() {
    const s = this.settings.current, pool = this.solana.poolAddress;
    if (s.paused || !pool) return null;
    const job = await this.cycle('fee-transfer', () => this.owedToPool(), micros(s.feeTransferThresholdUsd));
    if (!job) return null;
    const amount = Number(job.data.amount);
    const signature = await this.solana.pay('ops', `${job.id}:pay`, pool, amount, s);
    await atomic(this.db, async () => {
      await record(this.db, { id: job.id, bucket: 'transfer', kind: 'fee-transfer', micros: amount, signature });
      await this.jobs.put(job.id, job.kind, 'complete', { ...job.data, signature });
    });
    this.pool.invalidate();
    return { amount, signature };
  }

  async burn() {
    const s = this.settings.current;
    if (s.paused || !this.solana.holderMint) return null;
    const job = await this.cycle('burn-cycle', () => this.burnBucket(), micros(s.burnThresholdUsd));
    if (!job) return null;
    const amount = Number(job.data.amount);
    const result = await this.solana.buybackAndBurn(job.id, amount, s);
    await atomic(this.db, async () => {
      await record(this.db, { id: job.id, bucket: 'burn', kind: 'burn', micros: -amount, signature: result.burnSignature, data: { tokens: result.tokens.toString(), swap: result.swapSignature } });
      await this.db.query('INSERT INTO burns(id,usdc_micros,tokens,swap_signature,burn_signature,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING', [job.id, amount, result.tokens.toString(), result.swapSignature, result.burnSignature, Date.now()]);
      await this.jobs.put(job.id, job.kind, 'complete', { ...job.data, ...result, tokens: result.tokens.toString() });
    });
    return { amount, tokens: result.tokens };
  }

  async creatorFees() {
    // Claiming needs the POOL signer; before mainnet is enabled there is nothing to do.
    if (this.settings.current.paused || !this.solana.live) return null;
    const result = await this.solana.collectCreatorFees(this.settings.current);
    if (result) { this.pool.invalidate(); await audit(this.db, 'creator-fees', result); }
    return result;
  }

  /** Runs every task, isolating failures so one stuck task cannot block the others. */
  async run() {
    const out: Record<string, unknown> = {};
    for (const [name, task] of [['transfer', () => this.transferFees()], ['burn', () => this.burn()], ['creatorFees', () => this.creatorFees()]] as const) {
      try { out[name] = await task(); }
      catch (error) { out[name] = { error: (error as Error).message }; if (!(error instanceof PendingOperation)) await audit(this.db, `treasury-${name}-error`, { error: (error as Error).message }); }
    }
    return out;
  }
}
