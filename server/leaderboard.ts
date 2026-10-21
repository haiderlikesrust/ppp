import { usd } from '../shared/protection';
import type { Leaderboard, SitePull } from '../shared/types';
import type { Database } from './db';
import { cardTitle } from './showcase';

export const WEEK = 7 * 86_400_000;
const TOP = 10;

/** Monday 00:00 UTC of the week that contains `t`. Boards reset then. */
export function weekStart(t: number) {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - (d.getUTCDay() + 6) % 7);
}

const short = (wallet: string) => `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;
const packCode = (data: any, priceMicros: string) => (data?.packCode as string | undefined) ?? (data?.packType as string | undefined) ?? `pokemon_${usd(Number(priceMicros))}`;

/**
 * This week's (or last week's) Pullback boards: the most valuable cards pulled here, the wallets that
 * opened the most packs here, and the biggest single rebates, on-site and off-site. Wallets are shortened;
 * `you` marks the viewer's own rows.
 */
export async function leaderboard(db: Database, week: 'current' | 'last', viewer: string | null, now = Date.now()): Promise<Leaderboard> {
  const start = weekStart(now) - (week === 'last' ? WEEK : 0), end = start + WEEK;
  const who = (wallet: string) => ({ wallet: short(wallet), you: wallet === viewer });
  type OrderRow = { wallet: string; price_micros: string; data: any; created_at: string };

  const hits = (await db.query<OrderRow>(
    `SELECT wallet,price_micros::text,data,created_at::text FROM orders
     WHERE status='complete' AND created_at>=$1 AND created_at<$2 AND (data->>'valueMicros')::numeric >= price_micros
     ORDER BY (data->>'valueMicros')::numeric DESC, created_at ASC LIMIT $3`, [start, end, TOP])).rows
    .map(r => ({ ...who(r.wallet), code: packCode(r.data, r.price_micros), priceUsd: usd(Number(r.price_micros)), valueUsd: usd(Number(r.data.valueMicros)), card: r.data.card?.name ? { name: String(r.data.card.name), image: r.data.card.image ?? null } : null, at: Number(r.created_at) }));

  const packs = (await db.query<{ wallet: string; n: number; spent: string }>(
    `SELECT wallet,COUNT(*)::int AS n,SUM(price_micros)::text AS spent FROM orders
     WHERE status='complete' AND created_at>=$1 AND created_at<$2
     GROUP BY wallet ORDER BY COUNT(*) DESC, SUM(price_micros) DESC, MIN(created_at) ASC LIMIT $3`, [start, end, TOP])).rows
    .map(r => ({ ...who(r.wallet), packs: Number(r.n), spentUsd: usd(Number(r.spent)) }));

  const onsite = (await db.query<OrderRow>(
    `SELECT wallet,price_micros::text,data,created_at::text FROM orders
     WHERE status='complete' AND created_at>=$1 AND created_at<$2 AND (data->>'rebateMicros')::numeric > 0
     ORDER BY (data->>'rebateMicros')::numeric DESC LIMIT $3`, [start, end, TOP])).rows
    .map(r => ({ ...who(r.wallet), code: packCode(r.data, r.price_micros), priceUsd: usd(Number(r.price_micros)), valueUsd: usd(Number(r.data.valueMicros ?? 0)), rebateUsd: usd(Number(r.data.rebateMicros)), source: 'onsite' as const, cardName: r.data.card?.name ? String(r.data.card.name) : null, at: Number(r.created_at) }));
  const offsite = (await db.query<{ wallet: string; price_micros: string; value_micros: string; rebate_micros: string; paid_at: string; data: any }>(
    `SELECT wallet,price_micros::text,value_micros::text,rebate_micros::text,paid_at::text,data FROM claims
     WHERE status='paid' AND paid_at>=$1 AND paid_at<$2 AND rebate_micros>0
     ORDER BY rebate_micros DESC LIMIT $3`, [start, end, TOP])).rows
    .map(r => ({ ...who(r.wallet), code: packCode(r.data, r.price_micros), priceUsd: usd(Number(r.price_micros)), valueUsd: usd(Number(r.value_micros)), rebateUsd: usd(Number(r.rebate_micros)), source: 'offsite' as const, cardName: null, at: Number(r.paid_at) }));
  const rebates = [...onsite, ...offsite].sort((a, b) => b.rebateUsd - a.rebateUsd || a.at - b.at).slice(0, TOP);

  return { week, start, end, hits, packs, rebates };
}

/** The newest packs opened on Pullback, with the card and the rebate it sent. Collector Crypt titles are cut to the card's name. */
export async function sitePulls(db: Database, limit = 24): Promise<SitePull[]> {
  const rows = (await db.query<{ id: string; price_micros: string; data: any; created_at: string }>(
    `SELECT id,price_micros::text,data,created_at::text FROM orders
     WHERE status='complete' AND data ? 'valueMicros' ORDER BY created_at DESC LIMIT $1`, [limit])).rows;
  return rows.map(r => {
    const name = r.data.card?.name ? String(r.data.card.name) : null;
    return {
      id: r.id, code: packCode(r.data, r.price_micros), priceUsd: usd(Number(r.price_micros)), valueUsd: usd(Number(r.data.valueMicros)),
      rebateUsd: usd(Number(r.data.rebateMicros ?? 0)), at: Number(r.created_at),
      card: name ? { name: name.includes(' · ') ? name : cardTitle(name), image: r.data.card.image ?? null } : null,
    };
  });
}
