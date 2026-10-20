import type { ParsedTransactionWithMeta } from '@solana/web3.js';
import { packDef } from '../../shared/packs';
import type { CcPayment } from '../ports';

export const CC_OPEN_MEMO = /^(cc-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}):open$/;

/**
 * Recognizes a Collector Crypt pack payment made by `wallet` itself:
 * exactly one `cc-<uuid>:open` memo and exactly one USDC transfer from the
 * wallet's own token account, authorized by the wallet, into Collector Crypt's
 * payment account. Anything else (someone else paying, a secondary sale) is ignored.
 */
export function parseCcPayment(tx: ParsedTransactionWithMeta | null, wallet: string, userAta: string, ccAta: string): CcPayment | null {
  if (!tx?.meta || tx.meta.err || !tx.blockTime) return null;
  const memos: string[] = [], transfers: { amount: bigint }[] = [];
  let foreignTransfers = 0;
  for (const ix of tx.transaction.message.instructions) {
    if (!('parsed' in ix)) continue;
    if (ix.program === 'spl-memo' && typeof ix.parsed === 'string') memos.push(ix.parsed);
    if (ix.program === 'spl-token' && (ix.parsed?.type === 'transfer' || ix.parsed?.type === 'transferChecked')) {
      const info = ix.parsed.info, amount = info.tokenAmount?.amount ?? info.amount;
      if (info.destination !== ccAta) continue;
      if (info.source !== userAta || info.authority !== wallet) { foreignTransfers++; continue; }
      transfers.push({ amount: BigInt(amount) });
    }
  }
  const matches = memos.map(m => CC_OPEN_MEMO.exec(m)).filter(Boolean);
  if (matches.length !== 1 || transfers.length !== 1 || foreignTransfers) return null;
  const amount = transfers[0].amount;
  if (amount <= 0n || amount % 1_000_000n !== 0n || amount > 5_000_000_000n) return null;
  return { memo: matches[0]![1], signature: tx.transaction.signatures[0], priceMicros: Number(amount), blockTime: tx.blockTime * 1000 };
}

/** Problems with Collector Crypt's own record of a pack, compared against the on-chain payment. */
export function ccRecordProblem(status: any, wallet: string, payment: CcPayment): string | null {
  const pack = status?.pack, send = status?.send, price = payment.priceMicros / 1_000_000;
  if (!pack) return 'Collector Crypt has no record of this pack.';
  if (pack.refunded) return 'This pack was refunded.';
  if (pack.turbo === true || pack.turbo_mode === true) return 'Turbo-mode packs are sold back instantly and are not covered.';
  if (pack.wallet !== wallet) return 'This pack was bought by a different wallet.';
  if (pack.transaction_signature && pack.transaction_signature !== payment.signature) return 'The pack record does not match this payment.';
  const def = packDef(pack.pack_type ?? `pokemon_${price}`);
  if (!def) return 'This kind of pack is not covered.';
  if (def.priceUsd !== price) return 'The pack type does not match the amount paid.';
  if (!send || send.status !== 'confirmed' || !send.nft_address) return 'The card has not been delivered yet.';
  if (send.to_wallet !== wallet) return 'The card was delivered to a different wallet.';
  const value = Number(send.insured_value);
  if (send.insured_value == null || send.insured_value === '' || !Number.isFinite(value) || value < 0) return 'Collector Crypt has no insured value for this card yet.';
  return null;
}
