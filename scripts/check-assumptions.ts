/**
 * Read-only launch checks. Nothing is signed or sent.
 *  1. Does Collector Crypt's /pack/status serve packs bought by other wallets? (off-site claims depend on it)
 *  2. Is our coin an SPL Token or Token-2022 mint? (burn instruction)
 *  3. Where do our pump.fun creator fees go, and in which token? (pool funding)
 *  4. Do the OPS and POOL wallets have USDC accounts and SOL for fees?
 *
 *   npm run check
 */
import { createRequire } from 'node:module';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { config } from '../server/config';
import { connection } from '../server/chain';
import { treasurySigner } from '../server/treasury-signer';
import { CollectorCrypt } from '../server/cc/client';
import { CC_OPEN_MEMO } from '../server/cc/history';

const rpc = connection();
if (!rpc) { console.error('Set SOLANA_RPC_URL first.'); process.exit(1); }
const ok = (m: string) => console.log(`  ✓ ${m}`), warn = (m: string) => console.log(`  ✗ ${m}`);

console.log('1. Collector Crypt pack records for other wallets');
try {
  const ccAta = getAssociatedTokenAddressSync(new PublicKey(config.USDC_MINT), new PublicKey(config.COLLECTOR_CRYPT_PAYMENT_WALLET), true);
  const signatures = (await rpc.getSignaturesForAddress(ccAta, { limit: 25 }, 'confirmed')).filter(s => !s.err);
  const txs = await rpc.getParsedTransactions(signatures.map(s => s.signature), { maxSupportedTransactionVersion: 1 });
  const memo = txs.flatMap(tx => tx?.transaction.message.instructions ?? []).map(ix => 'parsed' in ix && ix.program === 'spl-memo' ? CC_OPEN_MEMO.exec(String(ix.parsed))?.[1] : null).find(Boolean);
  if (!memo) warn('No recent pack payment found to test with.');
  else {
    const status = await new CollectorCrypt(config.COLLECTOR_CRYPT_API_KEY).packStatus(memo);
    const fields = ['wallet', 'pack_type', 'transaction_signature', 'refunded'].filter(k => status.pack && k in status.pack);
    const send = ['status', 'nft_address', 'to_wallet', 'insured_value'].filter(k => status.send && k in status.send);
    if (status.pack && status.send?.insured_value !== undefined) ok(`/pack/status works for ${memo} (pack: ${fields.join(', ')}; send: ${send.join(', ')})`);
    else warn(`/pack/status returned no usable record for ${memo}. Off-site verification needs the on-chain fallback. Response keys: ${Object.keys(status).join(', ')}`);
  }
} catch (error) { warn(`Pack status check failed: ${(error as Error).message}`); }

console.log('2. Coin mint program');
if (!config.MEMECOIN_MINT) warn('MEMECOIN_MINT is not set.');
else {
  const info = await rpc.getAccountInfo(new PublicKey(config.MEMECOIN_MINT));
  if (!info) warn('Mint account not found.');
  else if (info.owner.equals(TOKEN_PROGRAM_ID)) ok('SPL Token mint: burns use the classic token program.');
  else if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) ok('Token-2022 mint: burns use Token-2022 (handled automatically).');
  else warn(`Unknown mint program ${info.owner.toBase58()}.`);
}

console.log('3. Creator fees');
if (config.MEMECOIN_MINT) {
  try {
    const { OnlinePumpSdk, feeSharingConfigPda, normalizeQuoteMint } = createRequire(import.meta.url)('@pump-fun/pump-sdk') as typeof import('@pump-fun/pump-sdk');
    const mint = new PublicKey(config.MEMECOIN_MINT), curve = await new OnlinePumpSdk(rpc).fetchBondingCurve(mint);
    const quote = normalizeQuoteMint(curve.quoteMint).toBase58(), sharing = curve.creator.equals(feeSharingConfigPda(mint));
    ok(`Quote token: ${quote === config.CARDS_MINT ? '$CARDS' : quote}. Creator: ${curve.creator.toBase58()}${sharing ? ' (fee-sharing config)' : ''}. Graduated: ${curve.complete}.`);
    const pool = config.POOL_PRIVATE_KEY ? treasurySigner(config.POOL_PRIVATE_KEY)?.publicKey : null;
    if (pool && !sharing && !curve.creator.equals(pool)) warn(`The POOL wallet ${pool.toBase58()} is not the creator. Point creator fees at it before launch.`);
    if (curve.isHolderReward) warn('This coin routes fees to holder rewards, not the creator.');
  } catch (error) { warn(`Could not read the pump.fun curve: ${(error as Error).message}`); }
}

console.log('4. Wallets');
for (const [name, key] of [['OPS', config.OPS_PRIVATE_KEY], ['POOL', config.POOL_PRIVATE_KEY]] as const) {
  const signer = key ? treasurySigner(key) : null;
  if (!signer) { warn(`${name}_PRIVATE_KEY is not set.`); continue; }
  const ata = getAssociatedTokenAddressSync(new PublicKey(config.USDC_MINT), signer.publicKey);
  const [sol, account] = await Promise.all([rpc.getBalance(signer.publicKey), rpc.getAccountInfo(ata)]);
  (account ? ok : warn)(`${name} ${signer.publicKey.toBase58()}: ${(sol / 1e9).toFixed(3)} SOL, USDC account ${account ? 'exists' : 'MISSING (create it before launch)'}`);
}
