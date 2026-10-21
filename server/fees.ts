import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { PublicKey, ComputeBudgetProgram } from '@solana/web3.js';
import { NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import type { Chain } from './chain';
import { config } from './config';
import { PendingOperation } from './jobs';
import { PriceImpactTooHigh, quote, swap } from './swap';
import { record } from './db';
import { micros } from '../shared/protection';
import type { Settings } from '../shared/types';

const { OnlinePumpSdk, PUMP_SDK, feeSharingConfigPda, normalizeQuoteMint } = createRequire(import.meta.url)('@pump-fun/pump-sdk') as typeof import('@pump-fun/pump-sdk');

type Claimable = { quoteMint: string; amount: bigint; creator: string; sharing: boolean; graduated: boolean };

const unfinishedCycle = async (pool: Chain) => (await pool.jobs.db.query("SELECT * FROM jobs WHERE kind='fee-cycle' AND status<>'complete' ORDER BY created_at LIMIT 1")).rows[0];

/** What the POOL wallet could claim right now, or null. Read-only, so it is safe to call every few seconds. */
async function claimable(pool: Chain): Promise<Claimable | null> {
  const { rpc, signer } = pool.require();
  const mint = new PublicKey(config.MEMECOIN_MINT), sdk = new OnlinePumpSdk(rpc), curve = await sdk.fetchBondingCurve(mint);
  if (curve.isHolderReward) throw new Error('This mint routes fees to holder rewards, not its creator.');
  const quoteMint = normalizeQuoteMint(curve.quoteMint), sharing = curve.creator.equals(feeSharingConfigPda(mint));
  if (!sharing && !curve.creator.equals(signer.publicKey)) throw new Error('The POOL wallet is not this coin’s creator-fee recipient.');
  if (sharing) {
    const info = await rpc.getAccountInfo(curve.creator); if (!info) throw new Error('Fee sharing account is missing.');
    const shared = PUMP_SDK.decodeSharingConfig(info);
    if (!shared.shareholders.some(s => s.address.equals(signer.publicKey))) throw new Error('The POOL wallet is not a fee-sharing shareholder of this coin.');
  }
  const balances = await sdk.getCreatorVaultQuoteBalances(curve.creator), balance = balances.find(b => b.mint.equals(quoteMint));
  if (!balance || balance.total.isZero()) return null;
  return { quoteMint: quoteMint.toBase58(), amount: BigInt(balance.total.toString()), creator: curve.creator.toBase58(), sharing, graduated: curve.complete };
}

/** USDC per smallest unit of the fee mint, from a Jupiter quote. Reused for 30 seconds: the due check runs every second. */
let unitPrice: { mint: string; at: number; usdcPerUnit: number } | null = null;

/** Roughly what `amount` of the fee mint is worth in USDC micros. Only decides whether to claim; the swap quotes afresh. */
export async function usdcValue(mint: string, amount: bigint, now = Date.now(), getQuote = quote) {
  if (mint === config.USDC_MINT) return Number(amount);
  if (!unitPrice || unitPrice.mint !== mint || now - unitPrice.at > 30_000) {
    const out = Number((await getQuote(mint, config.USDC_MINT, amount)).outAmount ?? 0);
    unitPrice = { mint, at: now, usdcPerUnit: out / Number(amount) };
  }
  return Math.floor(Number(amount) * unitPrice.usdcPerUnit);
}

/** True when a claim cycle is unfinished, or enough fees have built up to be worth claiming (`creatorFeeMinUsd`). */
export async function creatorFeesDue(pool: Chain, settings: Settings) {
  if (await unfinishedCycle(pool)) return true;
  const c = await claimable(pool);
  if (!c) return false;
  if (settings.creatorFeeMinUsd <= 0) return true;
  return await usdcValue(c.quoteMint, c.amount) >= micros(settings.creatorFeeMinUsd);
}

/**
 * Claims our coin's pump.fun creator fees into the POOL wallet and converts them to USDC.
 * The quote token is usually $CARDS; SOL works too. Adapted from grailshot Providers.collectFees.
 * The sale is split into parts when one swap would move the price more than `maxPriceImpactBps`.
 * Returns null when there is nothing to claim.
 */
export async function collectCreatorFees(pool: Chain, settings: Settings) {
  const { rpc, signer } = pool.require();
  let cycle = await unfinishedCycle(pool);
  if (!cycle) {
    const c = await claimable(pool);
    if (!c) return null;
    const id = `fees:${randomUUID()}`;
    await pool.jobs.put(id, 'fee-cycle', 'claiming', { quoteMint: c.quoteMint, creator: c.creator, sharing: c.sharing, graduated: c.graduated });
    cycle = await pool.jobs.get(id);
  }
  const d = cycle.data, quoteMint = new PublicKey(d.quoteMint), mint = new PublicKey(config.MEMECOIN_MINT), sdk = new OnlinePumpSdk(rpc);
  if (!d.claimSignature) {
    d.claimSignature = await pool.execute(`${cycle.id}:claim`, 'fee-claim', async () => {
      const quoteTokenProgram = await sdk.fetchQuoteTokenProgram(quoteMint);
      const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 350_000 })];
      if (d.sharing) {
        const address = new PublicKey(d.creator), info = await rpc.getAccountInfo(address); if (!info) throw new Error('Sharing configuration is missing.');
        const shared = PUMP_SDK.decodeSharingConfig(info);
        if (d.graduated) ixs.push(await PUMP_SDK.transferCreatorFeesToPumpV2({ payer: signer.publicKey, mint, quoteMint, quoteTokenProgram }));
        ixs.push(await PUMP_SDK.distributeCreatorFeesV2({ mint, sharingConfig: shared, sharingConfigAddress: address, quoteMint, quoteTokenProgram, payer: signer.publicKey, shouldInitializeAta: true }));
      } else {
        if (!quoteMint.equals(NATIVE_MINT)) ixs.push(createAssociatedTokenAccountIdempotentInstruction(signer.publicKey, getAssociatedTokenAddressSync(quoteMint, signer.publicKey, false, quoteTokenProgram), signer.publicKey, quoteMint, quoteTokenProgram));
        ixs.push(...await sdk.collectCoinCreatorFeeV2Instructions(signer.publicKey, quoteMint, quoteTokenProgram, signer.publicKey));
      }
      return pool.build(ixs);
    }, settings);
    await pool.jobs.put(cycle.id, 'fee-cycle', 'routing', d);
  }
  if (!d.amount) { const delta = await pool.tokenDelta(d.claimSignature, d.quoteMint); d.amount = (delta > 0n ? delta : 0n).toString(); await pool.jobs.put(cycle.id, 'fee-cycle', 'routing', d); }
  if (BigInt(d.amount) === 0n) { await pool.jobs.put(cycle.id, 'fee-cycle', 'complete', d); return null; }
  // Losses are owed in dollars, so the pool keeps USDC rather than a volatile token.
  if (!d.usdcAmount) {
    if (d.quoteMint === config.USDC_MINT) d.usdcAmount = d.amount;
    else {
      d.parts ??= []; d.chunk ??= d.amount;
      const total = BigInt(d.amount), sold = d.parts.reduce((s: bigint, p: { amount: string }) => s + BigInt(p.amount), 0n);
      if (sold < total) {
        const chunk = BigInt(d.chunk), amount = total - sold < chunk ? total - sold : chunk;
        try {
          // The chunk is part of the job id: a part that was signed resumes as itself, a resized part starts fresh.
          const sale = await swap(pool, `${cycle.id}:usdc:${d.parts.length}:${chunk}`, d.quoteMint, config.USDC_MINT, amount, settings, 1n, settings.maxPriceImpactBps);
          d.parts.push({ amount: amount.toString(), received: sale.received.toString(), signature: sale.signature });
          await pool.jobs.put(cycle.id, 'fee-cycle', 'routing', d);
        } catch (error) {
          if (!(error instanceof PriceImpactTooHigh)) throw error;
          // Halve the part and try again on the next pass; a 32nd of the claim is as small as it gets.
          if (chunk / 2n >= total / 32n && chunk / 2n > 0n) { d.chunk = (chunk / 2n).toString(); await pool.jobs.put(cycle.id, 'fee-cycle', 'routing', d); throw new PendingOperation('Splitting the fee sale to limit price impact.'); }
          throw new PendingOperation('Price impact is too high right now; waiting for more liquidity before selling the claimed fees.');
        }
        if (sold + amount < total) throw new PendingOperation('Selling the rest of the claimed fees.');
      }
      d.usdcAmount = d.parts.reduce((s: bigint, p: { received: string }) => s + BigInt(p.received), 0n).toString();
    }
    await pool.jobs.put(cycle.id, 'fee-cycle', 'accounting', d);
  }
  await record(pool.jobs.db, { id: cycle.id, bucket: 'pool', kind: 'creator-fee', micros: Number(d.usdcAmount), signature: d.claimSignature, data: { quoteMint: d.quoteMint, quoteAmount: d.amount, parts: d.parts?.length ?? 0 } });
  await pool.jobs.put(cycle.id, 'fee-cycle', 'complete', d);
  return { id: cycle.id as string, usdcMicros: Number(d.usdcAmount), signature: d.claimSignature as string };
}
