import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { config } from './config';
import { buildPayment, validateSignedPayment, type PaymentIntent } from './payment';
import { PendingOperation } from './jobs';
import type { BuiltPayment, CcPayment, PackMachine, PackProvider, PaymentState, PurchaseResult, Solana } from './ports';
import type { Settings } from '../shared/types';

const fakeSignature = () => bs58.encode(randomBytes(64));
const fakeAddress = () => Keypair.generate().publicKey.toBase58();

/**
 * Practice-mode Solana: in-memory balances, instant confirmations, no keys or RPC.
 * Every new wallet starts with a Collector-tier balance so the site is usable locally.
 */
export class MockSolana implements Solana {
  readonly live = false;
  readonly opsAddress = fakeAddress();
  readonly poolAddress = fakeAddress();
  readonly holderMint = 'PRACTICE';
  readonly supply = 1_000_000_000n * 1_000_000n;
  readonly usdc = new Map<string, bigint>();
  readonly holders = new Map<string, bigint>();
  readonly ccPayments = new Map<string, CcPayment[]>();
  private submitted = new Map<string, { signature: string; at: number }>();
  private paid = new Map<string, string>();
  /** Number of status checks before a payment confirms; 0 makes tests deterministic. */
  confirmAfterChecks = 0;
  private checks = new Map<string, number>();
  defaultHolderPpm = 3_000;

  constructor() { this.usdc.set(this.poolAddress, 10_000_000_000n); }
  async holderBalance(owner: string) { return this.holders.get(owner) ?? this.supply * BigInt(this.defaultHolderPpm) / 1_000_000n; }
  async holderSupply() { return this.supply; }
  async usdcBalance(owner: string) { return this.usdc.get(owner) ?? 0n; }
  setHolderPpm(owner: string, ppm: number) { this.holders.set(owner, this.supply * BigInt(ppm) / 1_000_000n); }
  private move(from: string | null, to: string, amount: bigint) {
    if (from) { const balance = this.usdc.get(from) ?? 0n; if (balance < amount) throw new PendingOperation('Waiting for USDC to cover this payout.'); this.usdc.set(from, balance - amount); }
    this.usdc.set(to, (this.usdc.get(to) ?? 0n) + amount);
  }

  private built = new Map<string, number>();
  /** Unsigned payments expire like a real blockhash would. */
  paymentLifetimeMs = 120_000;
  async buildUserPayment(user: string, micros: number, memo: string): Promise<BuiltPayment> {
    const payment = buildPayment({ user, recipient: this.opsAddress, usdcMint: config.USDC_MINT, micros, memo }, fakeAddress());
    this.built.set(payment.intent.reference, Date.now());
    return payment;
  }
  /** Accepts a real wallet signature, or the literal `practice` in practice mode. */
  async submitUserPayment(intent: PaymentIntent, signedBase64: string) {
    const signature = signedBase64 === 'practice' ? fakeSignature() : bs58.encode(validateSignedPayment(signedBase64, intent).signatures[0]);
    this.submitted.set(intent.reference, { signature, at: Date.now() });
    return signature;
  }
  async paymentStatus(payment: BuiltPayment, known: string | null): Promise<PaymentState> {
    const sent = this.submitted.get(payment.intent.reference);
    if (!sent || (known && known !== sent.signature)) return Date.now() - (this.built.get(payment.intent.reference) ?? 0) > this.paymentLifetimeMs ? { state: 'expired' } : { state: 'pending' };
    const n = (this.checks.get(sent.signature) ?? 0) + 1; this.checks.set(sent.signature, n);
    if (n <= this.confirmAfterChecks) return { state: 'pending' };
    if (!this.paid.has(sent.signature)) { this.paid.set(sent.signature, payment.intent.user); this.move(null, this.opsAddress, BigInt(payment.intent.micros)); }
    return { state: 'confirmed', signature: sent.signature };
  }

  private done = new Map<string, string>();
  async pay(from: 'ops' | 'pool', jobId: string, to: string, micros: number, _settings: Settings) {
    const existing = this.done.get(jobId); if (existing) return existing;
    this.move(from === 'ops' ? this.opsAddress : this.poolAddress, to, BigInt(micros));
    const signature = fakeSignature(); this.done.set(jobId, signature); return signature;
  }
  async transferNft(jobId: string) { const existing = this.done.get(jobId); if (existing) return existing; const s = fakeSignature(); this.done.set(jobId, s); return s; }
  async scanCcPayments(wallet: string, sinceMs: number) { return (this.ccPayments.get(wallet) ?? []).filter(p => p.blockTime >= sinceMs); }
  async buybackAndBurn(jobId: string, usdcMicros: number) {
    this.move(this.opsAddress, fakeAddress(), BigInt(usdcMicros));
    const signature = this.done.get(jobId) ?? fakeSignature(); this.done.set(jobId, signature);
    return { tokens: BigInt(usdcMicros) * 4_000n, swapSignature: signature, burnSignature: signature };
  }
  async collectCreatorFees() { return null; }
  /** Practice helper: pretend creator fees arrived in the pool. */
  fundPool(micros: number) { this.move(null, this.poolAddress, BigInt(micros)); }
}

const NAMES = ['Charizard', 'Pikachu', 'Umbreon', 'Mewtwo', 'Gengar', 'Rayquaza', 'Lugia', 'Eevee', 'Blastoise', 'Snorlax', 'Gyarados', 'Dragonite', 'Mew', 'Sylveon', 'Greninja', 'Lucario'];
const SETS = ['Base Set', 'Evolving Skies', 'Hidden Fates', 'Crown Zenith', '151', 'Paldean Fates', 'Lost Origin', 'Celebrations'];

/** Deterministic pseudo-random numbers from a seed string. */
function seeded(seed: string) {
  let state = createHash('sha256').update(seed).digest().readUInt32LE(0) || 1;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return ((state >>> 0) % 1_000_000) / 1_000_000; };
}

/** Value relative to price: mostly losses, some near-misses, a few big hits. Mean is about 1.0. */
export function mockValueRatio(rand: () => number) {
  const u = rand();
  if (u < 0.6) return 0.35 + 0.55 * rand();
  if (u < 0.88) return 0.9 + 0.5 * rand();
  return 1.4 + 3.6 * rand() ** 2;
}

/** Practice-mode Collector Crypt: instant packs with a realistic loss distribution. */
export class MockPacks implements PackProvider {
  private purchases = new Map<string, { calls: number; result?: PurchaseResult }>();
  private records = new Map<string, any>();
  /** Calls to `buy` that return pending before the card arrives. */
  pendingCalls = 1;
  soldOut = new Set<number>();
  constructor(readonly ops: () => string) {}

  async machines(): Promise<PackMachine[]> { return [25, 50, 100, 500].filter(p => !this.soldOut.has(p)).map(priceUsd => ({ priceUsd, code: `pokemon_${priceUsd}` })); }

  async buy(purchaseId: string, priceUsd: number): Promise<PurchaseResult> {
    const entry = this.purchases.get(purchaseId) ?? { calls: 0 };
    this.purchases.set(purchaseId, entry);
    if (entry.result) return entry.result;
    if (this.soldOut.has(priceUsd)) throw new Error('That single-card Pokémon pack is not in the public catalog.');
    if (entry.calls++ < this.pendingCalls) return { state: 'pending', message: 'Payment submitted. Resume this order to check confirmation.' };
    const memo = `cc-${randomUUID()}`, signature = fakeSignature();
    const card = this.card(purchaseId, priceUsd);
    entry.result = { state: 'complete', memo, signature, card };
    this.records.set(memo, { pack: { status: 'confirmed', wallet: this.ops(), pack_type: `pokemon_${priceUsd}`, transaction_signature: signature, refunded: false }, send: { status: 'confirmed', nft_address: card.mint, to_wallet: this.ops(), insured_value: card.insuredValueUsd } });
    return entry.result;
  }

  card(seed: string, priceUsd: number) {
    const rand = seeded(seed), value = Math.round(priceUsd * mockValueRatio(rand) * 100) / 100;
    const name = NAMES[Math.floor(rand() * NAMES.length)], set = SETS[Math.floor(rand() * SETS.length)], grade = 7 + Math.floor(rand() * 4);
    return { mint: new PublicKey(createHash('sha256').update(`mint:${seed}`).digest()).toBase58(), name: `${name} · ${set} · PSA ${grade}`, image: null, insuredValueUsd: value, rarity: value >= priceUsd * 1.4 ? 'Epic' : value >= priceUsd ? 'Rare' : 'Common', transferSignature: null };
  }

  /** Practice helper: a pack someone opened directly on Collector Crypt. */
  offsitePull(solana: MockSolana, wallet: string, priceUsd: number, pulledAt: number) {
    const memo = `cc-${randomUUID()}`, signature = fakeSignature(), card = this.card(memo, priceUsd);
    solana.ccPayments.set(wallet, [...(solana.ccPayments.get(wallet) ?? []), { memo, signature, priceMicros: priceUsd * 1_000_000, blockTime: pulledAt }]);
    this.records.set(memo, { pack: { status: 'confirmed', wallet, pack_type: `pokemon_${priceUsd}`, transaction_signature: signature, refunded: false }, send: { status: 'confirmed', nft_address: card.mint, to_wallet: wallet, insured_value: card.insuredValueUsd } });
    return { memo, card };
  }
  setRecord(memo: string, record: any) { this.records.set(memo, record); }
  async status(memo: string) { return this.records.get(memo) ?? { pack: null, send: null }; }
  async asset(mint: string) {
    for (const r of this.records.values()) if (r.send?.nft_address === mint) return { name: `Card ${mint.slice(0, 4)}`, image: null };
    return null;
  }
}
