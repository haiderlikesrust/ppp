/**
 * Read-only. Measures what Collector Crypt pulls are actually worth, per pack price,
 * so the fee and coverage can be set from data instead of guesses.
 *
 * It walks recent payments into Collector Crypt's USDC account, takes each pack memo,
 * and asks /pack/status for the insured value of the card that was sent.
 *
 *   npm run calibrate -- --packs 400
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { config } from '../server/config';
import { connection } from '../server/chain';
import { CollectorCrypt } from '../server/cc/client';
import { CC_OPEN_MEMO } from '../server/cc/history';
import { CALIBRATION_FILE, type Calibration } from '../server/calibration';
import { DEFAULT_SETTINGS, distribution, requiredFeeBps, type Sample } from '../shared/protection';

const arg = (name: string, fallback: number) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? Number(process.argv[i + 1]) : fallback; };
const target = arg('packs', 300), delayMs = arg('delay', 250);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const rpc = connection();
if (!rpc) { console.error('Set SOLANA_RPC_URL (a paid RPC such as Helius is recommended).'); process.exit(1); }
const cc = new CollectorCrypt(config.COLLECTOR_CRYPT_API_KEY);
const ccAta = getAssociatedTokenAddressSync(new PublicKey(config.USDC_MINT), new PublicKey(config.COLLECTOR_CRYPT_PAYMENT_WALLET), true);
console.log(`Scanning payments into ${ccAta.toBase58()} for up to ${target} packs…`);

const samples: Sample[] = [], seen = new Set<string>();
let before: string | undefined, failures = 0;
while (samples.length < target) {
  const signatures = await rpc.getSignaturesForAddress(ccAta, { limit: 100, before }, 'confirmed');
  if (!signatures.length) break;
  before = signatures[signatures.length - 1].signature;
  const ok = signatures.filter(s => !s.err).map(s => s.signature);
  for (let i = 0; i < ok.length && samples.length < target; i += 20) {
    const txs = await rpc.getParsedTransactions(ok.slice(i, i + 20), { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    for (const tx of txs) {
      const memo = tx?.transaction.message.instructions.map(ix => 'parsed' in ix && ix.program === 'spl-memo' ? CC_OPEN_MEMO.exec(String(ix.parsed))?.[1] : null).find(Boolean);
      if (!memo || seen.has(memo)) continue;
      seen.add(memo);
      try {
        const status = await cc.packStatus(memo);
        const price = Number(String(status.pack?.pack_type ?? '').replace('pokemon_', '')), value = Number(status.send?.insured_value);
        if (status.send?.status === 'confirmed' && price > 0 && Number.isFinite(value)) { samples.push({ priceUsd: price, valueUsd: value }); process.stdout.write(`\r${samples.length} packs`); }
      } catch { if (++failures > 20) { console.error('\nToo many /pack/status failures. Does it serve packs bought by other wallets? (see npm run check)'); process.exit(1); } }
      await sleep(delayMs);
    }
  }
}
console.log('');
if (!samples.length) { console.error('No pack outcomes found.'); process.exit(1); }

const distributions = distribution(samples);
const report: Calibration = { generatedAt: new Date().toISOString(), source: ccAta.toBase58(), samples: samples.length, distributions };
await mkdir('reports', { recursive: true });
await writeFile(CALIBRATION_FILE, JSON.stringify(report, null, 2));

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
console.table(distributions.map(d => ({ pack: `$${d.priceUsd}`, n: d.n, 'avg value': pct(d.meanValueRatio), median: pct(d.medianValueRatio), p10: pct(d.p10), p90: pct(d.p90), 'hit rate': pct(d.hitRate), 'expected loss': pct(d.expectedLossRatio) })));
console.log(`\nFee needed with ${DEFAULT_SETTINGS.poolShareBps / 100}% of the fee going to the pool and no creator-fee subsidy:`);
console.table(distributions.map(d => Object.fromEntries([['pack', `$${d.priceUsd}`], ...[2_500, 5_000, 10_000].map(c => [`${c / 100}% coverage`, `${(requiredFeeBps(c, d.expectedLossRatio, DEFAULT_SETTINGS.poolShareBps) / 100).toFixed(1)}%`])])));
console.log(`\nSaved ${CALIBRATION_FILE}. The admin page now enforces these numbers when you change fees or coverage.`);
