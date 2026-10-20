import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { CollectorCrypt, normalizeCard, USDC_MINT, type Card } from './client';
import type { PurchaseStore } from './store';
import { validatePackPayment } from './pack-policy';

export type PurchaseResult = { state: 'pending'; memo?: string; signature?: string; message: string } | { state: 'complete'; memo: string; signature: string; card: Card };
/** Call again with the SAME order ID to resume. No replacement payment is generated after signing. */
export async function buyPack(options: {
  id: string; priceUsdc: number; maxPriceUsdc: number; enabled: boolean;
  client: CollectorCrypt; connection: Connection; signer: Keypair; paymentWallet: PublicKey; store: PurchaseStore;
}): Promise<PurchaseResult> {
  const { id, priceUsdc, maxPriceUsdc, client, connection, signer, paymentWallet, store } = options;
  if (!options.enabled) throw new Error('Purchases are disabled.');
  if (!Number.isSafeInteger(priceUsdc) || priceUsdc <= 0 || !Number.isSafeInteger(maxPriceUsdc) || priceUsdc > maxPriceUsdc) throw new Error('Pack exceeds the explicit per-purchase limit.');
  return store.locked(id, async () => {
    let order = await store.get(id);
    if (!order) { order = { id, wallet: signer.publicKey.toBase58(), recipient: paymentWallet.toBase58(), priceUsdc }; await store.save(order); }
    if (order.wallet !== signer.publicKey.toBase58() || order.recipient !== paymentWallet.toBase58() || order.priceUsdc !== priceUsdc) throw new Error('Existing order intent does not match.');
    if (order.card) return { state: 'complete', memo: order.memo!, signature: order.signature!, card: order.card };
    if (!order.memo) { Object.assign(order, await client.generatePack(order.wallet, priceUsdc)); await store.save(order); }
    const pending = (message: string): PurchaseResult => ({ state: 'pending', memo: order!.memo, signature: order!.signature, message });
    if (!order.signedTransaction) {
      const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction!, 'base64'));
      validatePackPayment(tx, signer.publicKey, paymentWallet, USDC_MINT, BigInt(priceUsdc) * 1_000_000n, order.memo!);
      if (!(await connection.isBlockhashValid(tx.message.recentBlockhash, { commitment: 'confirmed' })).value) throw new Error('Unsigned order expired. Check its provider status before starting a new order ID.');
      tx.sign([signer]);
      const simulation = await connection.simulateTransaction(tx, { sigVerify: true, commitment: 'confirmed' });
      if (simulation.value.err) throw new Error('Payment simulation failed. Check USDC/SOL funding and the order.');
      order.signedTransaction = Buffer.from(tx.serialize()).toString('base64');
      order.signature = bs58.encode(tx.signatures[0]);
      // Save the exact signed bytes before any network submission; retries reuse this signature.
      await store.save(order);
    }
    if (!order.paid) {
      const status = (await connection.getSignatureStatuses([order.signature!], { searchTransactionHistory: true })).value[0];
      // "no USDC moved" is a contract with the caller: this purchase can be retried or refunded safely.
      if (status?.err) throw new Error('Pack payment failed on-chain; no USDC moved.');
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') { order.paid = true; await store.save(order); }
      else {
        const tx = VersionedTransaction.deserialize(Buffer.from(order.signedTransaction, 'base64'));
        if ((await connection.isBlockhashValid(tx.message.recentBlockhash, { commitment: 'confirmed' })).value) {
          await connection.sendRawTransaction(Buffer.from(order.signedTransaction, 'base64'), { skipPreflight: false, maxRetries: 2 });
          return pending('Payment submitted. Resume this order to check confirmation.');
        }
        // The blockhash is dead, so the payment can never land later. Chain history decides what happened.
        const landed = await connection.getTransaction(order.signature!, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
        if (landed && !landed.meta) return pending('Waiting for complete transaction history.');
        if (landed?.meta?.err) throw new Error('Pack payment failed on-chain; no USDC moved.');
        if (!landed) throw new Error('Pack payment expired before landing; no USDC moved.');
        order.paid = true; await store.save(order);
      }
    }
    const status = await client.packStatus(order.memo!);
    if (status.pack?.refunded) throw new Error('Provider refunded this pack. No new payment will be made.');
    if (status.pack?.status !== 'confirmed') return pending('Waiting for the provider to see the confirmed payment.');
    if (status.pack.wallet !== order.wallet || status.pack.pack_type !== `pokemon_${priceUsdc}` || status.pack.transaction_signature !== order.signature) throw new Error('Provider purchase record does not match the saved payment.');
    const opened = await client.openPack(order.memo!);
    if (['WAITING_FOR_WEBHOOK', 'SEND_PENDING'].includes(opened.code)) return pending('Card delivery pending. Resume this same order.');
    if (opened.code === 'TURBO_MODE_BUYBACK' || !opened.nft_address) throw new Error('Unexpected pack result. Inspect provider status.');
    const delivered = await client.packStatus(order.memo!);
    if (delivered.send?.status !== 'confirmed') return pending('Waiting for confirmed NFT delivery.');
    if (delivered.send.nft_address !== opened.nft_address || delivered.send.to_wallet !== order.wallet) throw new Error('Card delivery does not match the purchase wallet.');
    order.card = normalizeCard(opened, delivered); await store.save(order);
    return { state: 'complete', memo: order.memo!, signature: order.signature!, card: order.card };
  });
}

export function loadKeypair(value: string): Keypair {
  try {
    const text = value.trim(), decoded = text.startsWith('[') ? JSON.parse(text) : bs58.decode(text);
    if (Array.isArray(decoded) && decoded.some(v => !Number.isInteger(v) || v < 0 || v > 255)) throw new Error();
    const bytes = Uint8Array.from(decoded);
    if (bytes.length !== 64) throw new Error();
    return Keypair.fromSecretKey(bytes);
  } catch { throw new Error('TREASURY_PRIVATE_KEY must be a valid base58 or JSON 64-byte Solana secret key.'); }
}
