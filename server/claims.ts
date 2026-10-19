import { atomic, audit, record, type Database } from './db';
import { PendingOperation } from './jobs';
import type { CcPayment, PackProvider, Solana } from './ports';
import type { Holders } from './holders';
import type { Pool } from './pool';
import type { SettingsStore } from './settings';
import { ccRecordProblem } from './cc/history';
import { micros, offsiteCoverageBps, offsiteRebateCapMicros, rebateMicros, usd } from '../shared/protection';
import type { ClaimCandidate } from '../shared/types';

const DAY = 86_400_000;
const until = (at: number | null) => {
  const minutes = Math.max(1, Math.ceil(((at ?? Date.now()) - Date.now()) / 60_000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
};
type ClaimRow = { memo: string; wallet: string; status: string; value_micros: string; rebate_micros: string; signature: string | null; created_at: string };

/**
 * Off-site claims for packs opened directly on Collector Crypt. A pull qualifies only when
 * the claimant's own wallet paid for it on-chain, Collector Crypt's record agrees, and the
 * wallet holds a tier balance. Each pack (memo) can be claimed once; per-wallet daily claim
 * and payout limits bound how fast any one wallet can draw on the pool.
 */
export class Claims {
  private statusCache = new Map<string, { at: number; value: any }>();
  constructor(readonly db: Database, readonly solana: Solana, readonly packs: PackProvider, readonly holders: Holders, readonly pool: Pool, readonly settings: SettingsStore) {}

  private async ccStatus(memo: string) {
    const cached = this.statusCache.get(memo);
    if (cached && Date.now() - cached.at < 300_000) return cached.value;
    const value = await this.packs.status(memo);
    if (this.statusCache.size > 2_000) this.statusCache.delete(this.statusCache.keys().next().value!);
    this.statusCache.set(memo, { at: Date.now(), value });
    return value;
  }

  private windowStart() { return Date.now() - this.settings.current.offsite.claimWindowDays * DAY; }

  async scan(wallet: string, activatedAt: number): Promise<ClaimCandidate[]> {
    const payments = await this.solana.scanCcPayments(wallet, this.windowStart());
    const health = await this.pool.health(), today = await this.pool.claimsToday(wallet);
    const results: ClaimCandidate[] = [];
    for (const p of payments.sort((a, b) => b.blockTime - a.blockTime)) results.push(await this.evaluate(wallet, activatedAt, p, health, today));
    return results;
  }

  async evaluate(wallet: string, activatedAt: number, p: CcPayment, health?: number, today?: { count: number; nextAt: number | null }): Promise<ClaimCandidate> {
    const s = this.settings.current;
    const base: ClaimCandidate = { memo: p.memo, signature: p.signature, priceUsd: usd(p.priceMicros), valueUsd: null, pulledAt: p.blockTime, card: null, eligible: false, reason: null, coverageBps: 0, rebateUsd: 0, claim: null };
    const no = (reason: string, extra: Partial<ClaimCandidate> = {}) => ({ ...base, ...extra, reason });
    const existing = (await this.db.query<ClaimRow>('SELECT * FROM claims WHERE memo=$1', [p.memo])).rows[0];
    if (existing) return { ...base, valueUsd: existing.wallet === wallet ? usd(Number(existing.value_micros)) : null, reason: existing.wallet === wallet ? 'Already claimed.' : 'Claimed by another wallet.', claim: existing.wallet === wallet ? { status: existing.status, rebateUsd: usd(Number(existing.rebate_micros)), signature: existing.signature } : null };
    if ((await this.db.query('SELECT 1 FROM pulls WHERE memo=$1', [p.memo])).rows.length) return no('Opened on our site; its protection was settled automatically.');
    if (p.blockTime < this.windowStart()) return no(`Older than the ${s.offsite.claimWindowDays}-day claim window.`);
    let status;
    try { status = await this.ccStatus(p.memo); } catch { return no('Collector Crypt could not be reached. Try again shortly.'); }
    const problem = ccRecordProblem(status, wallet, p);
    const valueMicros = problem ? null : micros(Number(status.send.insured_value));
    const card = status?.send?.nft_address ? { mint: status.send.nft_address as string, name: null, image: null } : null;
    const known = { card, valueUsd: valueMicros === null ? null : usd(valueMicros) };
    if (problem) return no(problem, known);
    if (valueMicros! >= p.priceMicros) return no('This pull was worth at least what you paid.', known);
    if (!s.offsite.enabled || s.paused) return no('Off-site claims are paused right now.', known);
    const check = await this.holders.offsiteTier(wallet, activatedAt, p.blockTime);
    if (!check.tier) return no(check.reason ?? 'Your holdings did not qualify for this pull.', known);
    const coverage = offsiteCoverageBps(check.tier, health ?? await this.pool.health());
    const rebate = rebateMicros(p.priceMicros, valueMicros!, coverage, offsiteRebateCapMicros(s));
    if (rebate <= 0) return no('The pool is below its reserve target, so off-site coverage is temporarily zero.', { ...known, coverageBps: coverage });
    // Coverage is immediate, so a per-wallet daily claim limit is what keeps new wallets in check.
    const limit = s.offsite.perWalletDailyClaims, used = today ?? await this.pool.claimsToday(wallet);
    if (limit > 0 && used.count >= limit) return no(`Daily limit reached (${limit} claim${limit > 1 ? 's' : ''} per 24h). You can claim this again in ${until(used.nextAt)}.`, { ...known, coverageBps: coverage, rebateUsd: usd(rebate) });
    return { ...base, ...known, eligible: true, coverageBps: coverage, rebateUsd: usd(rebate) };
  }

  /** Re-verifies from scratch (never trusts a cached scan) and records the claim. Payment follows in `step`. */
  async claim(wallet: string, activatedAt: number, memo: string) {
    const payment = (await this.solana.scanCcPayments(wallet, this.windowStart())).find(p => p.memo === memo);
    if (!payment) throw Object.assign(new Error('No pack payment from your wallet matches this claim.'), { statusCode: 404 });
    this.statusCache.delete(memo);
    const candidate = await this.evaluate(wallet, activatedAt, payment);
    if (!candidate.eligible) throw new Error(candidate.reason ?? 'This pull is not eligible.');
    const now = Date.now();
    const inserted = await this.db.query('INSERT INTO claims(memo,wallet,status,price_micros,value_micros,coverage_bps,rebate_micros,pulled_at,created_at,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(memo) DO NOTHING RETURNING memo',
      [memo, wallet, 'approved', payment.priceMicros, micros(candidate.valueUsd!), candidate.coverageBps, micros(candidate.rebateUsd), payment.blockTime, now, JSON.stringify({ signature: payment.signature, nft: candidate.card?.mint })]);
    if (!inserted.rows.length) throw new Error('This pack has already been claimed.');
    await audit(this.db, 'claim-approved', { memo, wallet, rebateUsd: candidate.rebateUsd });
    return { ...candidate, eligible: false, reason: 'Claim approved.', claim: { status: 'approved', rebateUsd: candidate.rebateUsd, signature: null } };
  }

  /** Pays approved claims oldest first, inside the per-wallet, daily and free-balance caps. */
  async step() {
    if (this.settings.current.paused) return 0;
    const rows = (await this.db.query<ClaimRow>("SELECT * FROM claims WHERE status IN ('approved','queued','paying') ORDER BY created_at LIMIT 50")).rows;
    let paid = 0;
    for (const row of rows) {
      const amount = Number(row.rebate_micros);
      if (row.status !== 'paying') {
        const room = await this.pool.offsiteRoom(row.wallet);
        if (amount > room.wallet) { await this.setStatus(row.memo, 'queued'); continue; }
        if (amount > room.global || amount > room.free) { await this.setStatus(row.memo, 'queued'); break; }
        await this.setStatus(row.memo, 'paying');
      }
      try {
        const signature = await this.solana.pay('pool', `claim:${row.memo}`, row.wallet, amount, this.settings.current);
        this.pool.invalidate();
        await atomic(this.db, async () => {
          await record(this.db, { id: `claim:${row.memo}`, bucket: 'pool', kind: 'claim', micros: -amount, signature, ref: row.memo });
          await this.db.query("UPDATE claims SET status='paid',signature=$2,paid_at=$3 WHERE memo=$1", [row.memo, signature, Date.now()]);
        });
        paid++;
      } catch (error) {
        if (!(error instanceof PendingOperation)) await audit(this.db, 'claim-payout-error', { memo: row.memo, error: (error as Error).message });
      }
    }
    return paid;
  }

  private setStatus(memo: string, status: string) { return this.db.query('UPDATE claims SET status=$2 WHERE memo=$1', [memo, status]); }

  async list(wallet: string) {
    return (await this.db.query("SELECT memo,status,price_micros::text,value_micros::text,rebate_micros::text,signature,created_at::text,paid_at::text FROM claims WHERE wallet=$1 ORDER BY created_at DESC LIMIT 100", [wallet])).rows
      .map(r => ({ memo: r.memo, status: r.status, priceUsd: usd(Number(r.price_micros)), valueUsd: usd(Number(r.value_micros)), rebateUsd: usd(Number(r.rebate_micros)), signature: r.signature, createdAt: Number(r.created_at), paidAt: r.paid_at ? Number(r.paid_at) : null }));
  }
}

