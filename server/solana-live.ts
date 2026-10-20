import { PublicKey, type Connection } from '@solana/web3.js';
import { NATIVE_MINT, getAssociatedTokenAddressSync } from '@solana/spl-token';
import bs58 from 'bs58';
import { config } from './config';
import type { Chain } from './chain';
import { buildPayment, validatePaymentMessage, validateSignedPayment, type PaymentIntent } from './payment';
import { parseCcPayment } from './cc/history';
import { swap } from './swap';
import { collectCreatorFees, creatorFeesDue } from './fees';
import type { BuiltPayment, CcPayment, PaymentState, Solana } from './ports';
import type { Settings } from '../shared/types';

/** Turns a failed payment broadcast into one plain sentence; the raw RPC message is kept as `cause` for the logs. */
export function paymentFailure(message: string) {
  if (/debit an account but found no record|insufficient lamports|InsufficientFundsForFee|insufficient funds for fee/i.test(message)) return 'This wallet needs a little SOL (0.002 is plenty) to pay the Solana network fee. Nothing was charged.';
  if (/insufficient funds|0x1\b/i.test(message)) return 'This wallet does not have enough USDC for this pack. Nothing was charged.';
  if (/invalid account data|could not find account|AccountNotFound|0x3\b/i.test(message)) return 'This wallet has no USDC yet. Add USDC to it and try again. Nothing was charged.';
  if (/blockhash not found|block height exceeded|expired/i.test(message)) return 'The payment took too long to approve. Please try again. Nothing was charged.';
  return 'The payment could not be sent. Please try again. Nothing was charged.';
}

/** Mainnet adapter: OPS and POOL are separate signing wallets sharing one RPC. */
export class LiveSolana implements Solana {
  readonly live = config.live;
  private supplyCache: { value: bigint; at: number } | null = null;
  constructor(readonly ops: Chain, readonly pool: Chain, readonly rpc: Connection | null) {}
  /** Read-only until mainnet is enabled with both signers and an RPC: no payment is accepted before that. */
  get canSpend() { return config.live && !!this.rpc && !!this.ops.signer && !!this.pool.signer; }
  get opsAddress() { return this.ops.address; }
  get poolAddress() { return this.pool.address; }
  get holderMint() { return config.MEMECOIN_MINT || null; }
  private requireRpc() { if (!this.rpc) throw new Error('Configure SOLANA_RPC_URL.'); return this.rpc; }

  async holderBalance(owner: string) {
    if (!this.rpc || !this.holderMint) return 0n;
    const accounts = await this.rpc.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(this.holderMint) }, 'confirmed');
    return accounts.value.reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
  }
  async holderSupply() {
    if (!this.rpc || !this.holderMint) return 0n;
    if (this.supplyCache && Date.now() - this.supplyCache.at < 600_000) return this.supplyCache.value;
    const supply = BigInt((await this.rpc.getTokenSupply(new PublicKey(this.holderMint), 'confirmed')).value.amount);
    this.supplyCache = { value: supply, at: Date.now() };
    return supply;
  }
  usdcBalance(owner: string) { return this.ops.balance(config.USDC_MINT, owner); }

  async buildUserPayment(user: string, micros: number, memo: string): Promise<BuiltPayment> {
    if (!this.opsAddress) throw new Error('The OPS wallet is not configured.');
    const block = await this.requireRpc().getLatestBlockhash('confirmed');
    return buildPayment({ user, recipient: this.opsAddress, usdcMint: config.USDC_MINT, micros, memo }, block.blockhash);
  }

  async submitUserPayment(intent: PaymentIntent, signedBase64: string) {
    const tx = validateSignedPayment(signedBase64, intent);
    try { await this.requireRpc().sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 }); }
    catch (error) {
      const message = (error as Error).message;
      throw Object.assign(new Error(paymentFailure(message), { cause: message }), { statusCode: 400 });
    }
    return bs58.encode(tx.signatures[0]);
  }

  /** Finds a payment the wallet broadcast itself, by its unique reference key. */
  private async findByReference(intent: PaymentIntent) {
    const rpc = this.requireRpc();
    const signatures = await rpc.getSignaturesForAddress(new PublicKey(intent.reference), { limit: 10 }, 'confirmed');
    for (const s of signatures) {
      if (s.err) continue;
      const tx = await rpc.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
      if (!tx?.meta || tx.meta.err) continue;
      try { validatePaymentMessage(tx.transaction.message, intent); return s.signature; } catch { /* a look-alike, not our payment */ }
    }
    return null;
  }

  async paymentStatus(payment: BuiltPayment, known: string | null): Promise<PaymentState> {
    const rpc = this.requireRpc();
    const signature = known ?? await this.findByReference(payment.intent);
    if (signature) {
      const status = (await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
      if (status?.err) return { state: 'failed', reason: JSON.stringify(status.err) };
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return { state: 'confirmed', signature };
      if (status) return { state: 'pending' };
    }
    if ((await rpc.isBlockhashValid(payment.blockhash, { commitment: 'confirmed' })).value) return { state: 'pending' };
    // The blockhash is dead, so the payment can never land. Check history once more before expiring.
    const late = signature ? await rpc.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }) : null;
    if (late?.meta && !late.meta.err) return { state: 'confirmed', signature: signature! };
    if (!known && await this.findByReference(payment.intent)) return { state: 'pending' };
    return { state: 'expired' };
  }

  pay(from: 'ops' | 'pool', jobId: string, to: string, micros: number, settings: Settings) {
    return (from === 'ops' ? this.ops : this.pool).payUsdc(jobId, to, BigInt(micros), settings);
  }
  transferNft(jobId: string, mint: string, to: string, settings: Settings) { return this.ops.transferNft(jobId, mint, to, settings); }

  async scanCcPayments(wallet: string, sinceMs: number) {
    const rpc = this.requireRpc(), usdc = new PublicKey(config.USDC_MINT);
    const userAta = getAssociatedTokenAddressSync(usdc, new PublicKey(wallet), true);
    const ccAta = getAssociatedTokenAddressSync(usdc, new PublicKey(config.COLLECTOR_CRYPT_PAYMENT_WALLET), true).toBase58();
    const found: CcPayment[] = []; let before: string | undefined;
    for (let page = 0; page < 5; page++) {
      const signatures = await rpc.getSignaturesForAddress(userAta, { limit: 100, before }, 'confirmed');
      if (!signatures.length) break;
      const recent = signatures.filter(s => !s.err && (s.blockTime ?? 0) * 1000 >= sinceMs);
      for (let i = 0; i < recent.length; i += 20) {
        const txs = await rpc.getParsedTransactions(recent.slice(i, i + 20).map(s => s.signature), { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
        for (const tx of txs) { const payment = parseCcPayment(tx, wallet, userAta.toBase58(), ccAta); if (payment) found.push(payment); }
      }
      const last = signatures[signatures.length - 1];
      if (signatures.length < 100 || (last.blockTime ?? 0) * 1000 < sinceMs) break;
      before = last.signature;
    }
    return found;
  }

  async ccPaymentBySignature(wallet: string, signature: string) {
    const rpc = this.requireRpc(), usdc = new PublicKey(config.USDC_MINT);
    const userAta = getAssociatedTokenAddressSync(usdc, new PublicKey(wallet), true).toBase58();
    const ccAta = getAssociatedTokenAddressSync(usdc, new PublicKey(config.COLLECTOR_CRYPT_PAYMENT_WALLET), true).toBase58();
    const tx = await rpc.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    return parseCcPayment(tx, wallet, userAta, ccAta);
  }

  async buybackAndBurn(jobId: string, usdcMicros: number, settings: Settings) {
    if (!this.holderMint) throw new Error('Configure MEMECOIN_MINT.');
    const bought = await swap(this.ops, `${jobId}:swap`, config.USDC_MINT, this.holderMint, BigInt(usdcMicros), settings);
    const burnSignature = await this.ops.burn(`${jobId}:burn`, this.holderMint, bought.received, settings);
    return { tokens: bought.received, swapSignature: bought.signature, burnSignature };
  }

  collectCreatorFees(settings: Settings) { return collectCreatorFees(this.pool, settings); }
  creatorFeesDue(settings: Settings) { return creatorFeesDue(this.pool, settings); }

  async walletFunds(owner: string) {
    const rpc = this.requireRpc(), key = new PublicKey(owner), ata = getAssociatedTokenAddressSync(new PublicKey(config.USDC_MINT), key, true);
    const [account, lamports] = await Promise.all([rpc.getParsedAccountInfo(ata, 'confirmed'), rpc.getBalance(key, 'confirmed')]);
    const parsed = (account.value?.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } } | undefined)?.parsed;
    return { usdcAccount: !!account.value, usdcMicros: BigInt(parsed?.info?.tokenAmount?.amount ?? 0), lamports: BigInt(lamports) };
  }

  async hasUsdcAccount(wallet: 'ops' | 'pool') {
    const owner = wallet === 'ops' ? this.opsAddress : this.poolAddress; if (!owner) return false;
    return !!(await this.requireRpc().getAccountInfo(getAssociatedTokenAddressSync(new PublicKey(config.USDC_MINT), new PublicKey(owner)), 'confirmed'));
  }

  createUsdcAccount(wallet: 'ops' | 'pool', jobId: string, settings: Settings) { return (wallet === 'ops' ? this.ops : this.pool).createOwnTokenAccount(jobId, config.USDC_MINT, settings); }

  solBalance(wallet: 'ops' | 'pool') { return (wallet === 'ops' ? this.ops : this.pool).balance(NATIVE_MINT.toBase58()); }

  sendGas(jobId: string, lamports: bigint, settings: Settings) {
    if (!this.opsAddress) throw new Error('The OPS wallet is not configured.');
    return this.pool.sendSol(jobId, this.opsAddress, lamports, settings);
  }

  async buyGas(jobId: string, usdcMicros: number, settings: Settings) {
    const bought = await swap(this.pool, jobId, config.USDC_MINT, NATIVE_MINT.toBase58(), BigInt(usdcMicros), settings);
    return { lamports: bought.received, signature: bought.signature };
  }
}
