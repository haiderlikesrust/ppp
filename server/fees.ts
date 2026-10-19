import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { PublicKey, ComputeBudgetProgram } from '@solana/web3.js';
import { NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import type { Chain } from './chain';
import { config } from './config';
import { swap } from './swap';
import { record } from './db';
import type { Settings } from '../shared/types';

const { OnlinePumpSdk, PUMP_SDK, feeSharingConfigPda, normalizeQuoteMint } = createRequire(import.meta.url)('@pump-fun/pump-sdk') as typeof import('@pump-fun/pump-sdk');

/**
 * Claims our coin's pump.fun creator fees into the POOL wallet and converts them to USDC.
 * The quote token is usually $CARDS; SOL works too. Adapted from grailshot Providers.collectFees.
 * Returns null when there is nothing to claim.
 */
export async function collectCreatorFees(pool: Chain, settings: Settings) {
  const { rpc, signer } = pool.require();
  const unfinished = (await pool.jobs.db.query("SELECT * FROM jobs WHERE kind='fee-cycle' AND status<>'complete' ORDER BY created_at LIMIT 1")).rows[0];
  let cycle = unfinished;
  if (!cycle) {
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
    const id = `fees:${randomUUID()}`;
    await pool.jobs.put(id, 'fee-cycle', 'claiming', { quoteMint: quoteMint.toBase58(), creator: curve.creator.toBase58(), sharing, graduated: curve.complete });
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
    d.usdcAmount = d.quoteMint === config.USDC_MINT ? d.amount : (await swap(pool, `${cycle.id}:usdc`, d.quoteMint, config.USDC_MINT, BigInt(d.amount), settings)).received.toString();
    await pool.jobs.put(cycle.id, 'fee-cycle', 'accounting', d);
  }
  await record(pool.jobs.db, { id: cycle.id, bucket: 'pool', kind: 'creator-fee', micros: Number(d.usdcAmount), signature: d.claimSignature, data: { quoteMint: d.quoteMint, quoteAmount: d.amount } });
  await pool.jobs.put(cycle.id, 'fee-cycle', 'complete', d);
  return { id: cycle.id as string, usdcMicros: Number(d.usdcAmount), signature: d.claimSignature as string };
}
