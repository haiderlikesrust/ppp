import type { Card, Settings } from '../shared/types';
import type { PaymentIntent } from './payment';

/** A Collector Crypt pack payment found in a user's own transaction history. */
export type CcPayment = { memo: string; signature: string; priceMicros: number; blockTime: number };

/** A wallet's coin balance over time, from on-chain history. */
export type HolderHistory = {
  /** Balance after each change, oldest first: the last change before the requested start, then every change since. */
  changes: { at: number; balance: bigint }[];
  current: bigint;
  /** When the wallet first received the coin; null when it never has, or its history is too long to read back that far. */
  firstAt: number | null;
  /** Every change back to the first one was read. */
  complete: boolean;
};
export type PackMachine = { priceUsd: number; code: string };
export type PurchaseResult = { state: 'pending'; message: string; memo?: string; signature?: string } | { state: 'complete'; memo: string; signature: string; card: Card };
export type PaymentState = { state: 'confirmed'; signature: string } | { state: 'pending' } | { state: 'failed'; reason: string } | { state: 'expired' };
export type BuiltPayment = { intent: PaymentIntent; transaction: string; blockhash: string };

/** Collector Crypt, or the practice mock. */
export interface PackProvider {
  machines(): Promise<PackMachine[]>;
  /** Resumable and idempotent per purchase id. Buys with the OPS wallet. */
  buy(purchaseId: string, code: string, priceUsd: number): Promise<PurchaseResult>;
  /** Collector Crypt's live sell-back offer for a card still inside its 72-hour window. */
  buybackQuote(mint: string): Promise<{ available: boolean; amountMicros: number | null; expiresAt: number | null }>;
  /** A sell-back transaction for the card's owner to sign: the card goes to Collector Crypt, USDC to the owner. */
  buyback(owner: string, mint: string): Promise<{ transaction: string; amountMicros: number }>;
  /** Hands the owner-signed sale to Collector Crypt and returns its transaction signature. */
  submitBuyback(signedBase64: string): Promise<string>;
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
  /** The wallet's coin balance changes since `sinceMs` (and the last one before), and when it first got the coin. */
  holderHistory(owner: string, sinceMs: number): Promise<HolderHistory>;
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
  /** POOL: read-only check whether a claim is unfinished or enough creator fees have built up to claim. */
  creatorFeesDue(settings: Settings): Promise<boolean>;
  /** A buyer's USDC (in their associated token account) and SOL, checked before they are asked to sign. */
  walletFunds(owner: string): Promise<{ usdcAccount: boolean; usdcMicros: bigint; lamports: bigint }>;
  /** Whether OPS or POOL has its own USDC token account (needed to receive USDC). */
  hasUsdcAccount(wallet: 'ops' | 'pool'): Promise<boolean>;
  /** Creates that USDC token account, paid by the wallet itself. Idempotent per job id. */
  createUsdcAccount(wallet: 'ops' | 'pool', jobId: string, settings: Settings): Promise<string>;
  /** Native SOL balance in lamports. */
  solBalance(wallet: 'ops' | 'pool'): Promise<bigint>;
  /** POOL sends OPS SOL for network fees. Idempotent per job id. */
  sendGas(jobId: string, lamports: bigint, settings: Settings): Promise<string>;
  /** POOL swaps some of its USDC into SOL for network fees. Idempotent per job id. */
  buyGas(jobId: string, usdcMicros: number, settings: Settings): Promise<{ lamports: bigint; signature: string }>;
}
