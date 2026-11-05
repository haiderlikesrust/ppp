import { packCode } from '../shared/packs';
import { usd } from '../shared/protection';
import type { Portfolio, PortfolioItem } from '../shared/types';
import type { Database } from './db';
import { cardTitle } from './showcase';

/** Most pulls listed. A wallet past this still gets correct totals only for these, so the cap is generous. */
const MAX_ITEMS = 500;
const cents = (n: number) => Math.round(n * 100) / 100;

/**
 * Every finished pull of one wallet, newest first, and how it came out overall. A pull's net is what it brought
 * back (the sale, or the card at its insured value while it is held, plus the rebate) minus what it cost.
 * Refunded and unfinished orders cost nothing, so they are left out. Off-site packs count once a claim paid.
 */
export async function portfolio(db: Database, wallet: string): Promise<Portfolio> {
  const orders = (await db.query<{ id: string; price_micros: string; fee_micros: string; data: any; created_at: string }>(
    `SELECT id,price_micros::text,fee_micros::text,data,created_at::text FROM orders WHERE wallet=$1 AND status='complete' ORDER BY created_at DESC LIMIT $2`, [wallet, MAX_ITEMS])).rows;
  const claims = (await db.query<{ memo: string; price_micros: string; value_micros: string; rebate_micros: string; pulled_at: string; data: any }>(
    `SELECT memo,price_micros::text,value_micros::text,rebate_micros::text,pulled_at::text,data FROM claims WHERE wallet=$1 AND status='paid' ORDER BY pulled_at DESC LIMIT $2`, [wallet, MAX_ITEMS])).rows;

  const items: PortfolioItem[] = [
    ...orders.map(r => {
      const d = r.data, priceUsd = usd(Number(r.price_micros)), feeUsd = usd(Number(r.fee_micros));
      const valueUsd = usd(Number(d.valueMicros ?? 0)), rebateUsd = usd(Number(d.rebateMicros ?? 0));
      const soldUsd = d.sale ? usd(Number(d.sale.amountMicros)) : null, name = d.card?.name ? String(d.card.name) : null;
      return {
        id: r.id, source: 'onsite' as const, code: packCode(d.packCode, priceUsd), priceUsd, feeUsd, valueUsd, rebateUsd, soldUsd,
        netUsd: cents((soldUsd ?? valueUsd) + rebateUsd - priceUsd - feeUsd), at: Number(r.created_at),
        card: name ? { name: name.includes(' · ') ? name : cardTitle(name), image: d.card.image ?? null, mint: d.card.mint ?? null } : null,
      };
    }),
    ...claims.map(r => {
      const priceUsd = usd(Number(r.price_micros)), valueUsd = usd(Number(r.value_micros)), rebateUsd = usd(Number(r.rebate_micros));
      return {
        id: r.memo, source: 'offsite' as const, code: packCode(r.data?.packType, priceUsd), priceUsd, feeUsd: 0, valueUsd, rebateUsd, soldUsd: null,
        netUsd: cents(valueUsd + rebateUsd - priceUsd), at: Number(r.pulled_at), card: r.data?.nft ? { name: 'Opened off-site', image: null, mint: String(r.data.nft) } : null,
      };
    }),
  ].sort((a, b) => b.at - a.at);

  const add = (f: (i: PortfolioItem) => number) => cents(items.reduce((sum, i) => sum + f(i), 0));
  const held = items.filter(i => i.soldUsd === null);
  return {
    items,
    totals: {
      pulls: items.length, spentUsd: add(i => i.priceUsd), feesUsd: add(i => i.feeUsd), rebatesUsd: add(i => i.rebateUsd), soldUsd: add(i => i.soldUsd ?? 0),
      heldUsd: cents(held.reduce((sum, i) => sum + i.valueUsd, 0)), heldCards: held.length, hits: items.filter(i => i.valueUsd >= i.priceUsd).length, netUsd: add(i => i.netUsd),
    },
  };
}
