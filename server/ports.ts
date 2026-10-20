import type { Card, Settings } from '../shared/types';
import type { PaymentIntent } from './payment';

/** A Collector Crypt pack payment found in a user's own transaction history. */
export type CcPayment = { memo: string; signature: string; priceMicros: number; blockTime: number };
export type PackMachine = { priceUsd: number; code: string };
export type PurchaseResult = { state: 'pending'; message: string; memo?: string; signature?: string } | { state: 'complete'; memo: string; signature: string; card: Card };
export type PaymentState = { state: 'confirmed'; signature: string } | { state: 'pending' } | { state: 'failed'; reason: string } | { state: 'expired' };
export type BuiltPayment = { intent: PaymentIntent; transaction: string; blockhash: string };

/** Collector Crypt, or the practice mock. */
export interface PackProvider {
  machines(): Promise<PackMachine[]>;
  /** Resumable and idempotent per purchase id. Buys with the OPS wallet. */
  buy(purchaseId: string, priceUsd: number): Promise<PurchaseResult>;
  /** Raw `/pack/status?memo=` response. */
  status(memo: string): Promise<any>;
  asset(mint: string): Promise<{ name: string | null; image: string | null } | null>;
}

/** Everything the services need from Solana. `LiveSolana` and `MockSolana` implement it. */
export interface Solana {
  readonly live: boolean;
  /** True only when real money can move end to end (mainnet on, both wallets and RPC set) or in practice mode. */
  readonly canSpend: boolean;
  readonly opsAddress: string | null;
  readonly poolAddress: string | null;
  readonly holderMint: string | null;
  holderBalance(owner: string): Promise<bigint>;
  holderSupply(): Promise<bigint>;
  usdcBalance(owner: string): Promise<bigint>;
  buildUserPayment(user: string, micros: number, memo: string): Promise<BuiltPayment>;
  /** Validates the wallet-signed bytes against the intent, broadcasts, and returns the signature. */
  submitUserPayment(intent: PaymentIntent, signedBase64: string): Promise<string>;
  paymentStatus(payment: BuiltPayment, signature: string | null): Promise<PaymentState>;
  /** Idempotent per job id. Throws PendingOperation until confirmed. */
  pay(from: 'ops' | 'pool', jobId: string, to: string, micros: number, settings: Settings): Promise<string>;
  transferNft(jobId: string, mint: string, to: string, settings: Settings): Promise<string>;
  scanCcPayments(wallet: string, sinceMs: number): Promise<CcPayment[]>;
  /** One Collector Crypt payment by its transaction signature, only if `wallet` itself made it. */
  ccPaymentBySignature(wallet: string, signature: string): Promise<CcPayment | null>;
  /** OPS: swaps USDC into our coin and burns it. Returns tokens burned. */
  buybackAndBurn(jobId: string, usdcMicros: number, settings: Settings): Promise<{ tokens: bigint; swapSignature: string; burnSignature: string }>;
  /** POOL: claims pump.fun creator fees and converts them to USDC. */
  collectCreatorFees(settings: Settings): Promise<{ id: string; usdcMicros: number; signature: string } | null>;
}
