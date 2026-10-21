import { SELLING, type PackDef } from '../shared/packs';
import { distribution, maxLiability, micros, rebateMicros, usd } from '../shared/protection';
import type { FeedPull, PackStats, StatsView } from '../shared/types';
import type { Database } from './db';
import type { SettingsStore } from './settings';
import { fromWinner, toCard } from './showcase';

type Fetch = typeof fetch;
const API = 'https://gacha.collectorcrypt.com/api';
const DAY = 86_400_000;
/** Pulls per pack the stats are computed over: tight numbers, small table. */
export const SAMPLE_PER_PACK = 5_000;
/** Pulls worth this multiple of the pack price keep their card, for each pack's best pull. */
export const HIT_MULTIPLE = 2;
/** Hits kept per pack beyond the sample, over the last 8 days: enough to always know the best of the last 7. */
const HITS_KEPT = 50;
/** Newest pulls across all machines held in memory for the live feed (they carry card photos). */
const RECENT_KEPT = 60;

/**
 * Reads Collector Crypt's public feed of recent pulls for every machine Pullback sells. Each pull's
 * value is stored compactly for the pack stats, which use the same `distribution()` as the
 * calibration script; the newest pulls, with their card photos, are kept in memory for the live feed.
 * The feed returns each machine's latest 200 pulls, so polling every 2 minutes misses almost none.
 */
export class PullFeed {
  private latest: FeedPull[] = [];
  private cache: { at: number; value: StatsView } | null = null;
  private polledAt: number | null = null;

  constructor(private readonly db: Database, private readonly settings: SettingsStore, private readonly opsAddress: () => string | null, private readonly fetcher: Fetch = fetch) {}

  /** Reads every machine's newest pulls and stores the ones not seen yet. Returns how many were new. */
  async poll(now = Date.now()) {
    let added = 0;
    const seen: FeedPull[] = [];
    for (const def of SELLING) {
      const body = await this.json(`/getAllWinners?count=200&packType=${def.code}`).catch(() => null);
      if (!body) continue;
      const entries: unknown[] = Array.isArray(body.data) ? body.data : [];
      const pulls = entries.map(w => parsePull(w, def, this.opsAddress())).filter((p): p is FeedPull => !!p);
      seen.push(...pulls);
      if (!pulls.length) continue;
      const rows = pulls.map(p => ({ id: p.id, code: p.code, value_cents: Math.round(p.valueUsd * 100), pulled_at: p.at, card: p.valueUsd >= def.priceUsd * HIT_MULTIPLE ? p.card : null }));
      const inserted = await this.db.query(
        `INSERT INTO cc_pulls(id,code,value_cents,pulled_at,card)
         SELECT id,code,value_cents,pulled_at,card FROM jsonb_to_recordset($1::jsonb) AS x(id text, code text, value_cents integer, pulled_at bigint, card jsonb)
         ON CONFLICT(id) DO NOTHING RETURNING id`, [JSON.stringify(rows)]);
      added += inserted.rows.length;
      await this.prune(def.code, now);
    }
    if (seen.length) {
      const byId = new Map([...seen, ...this.latest].map(p => [p.id, p]));
      this.latest = [...byId.values()].sort((a, b) => b.at - a.at).slice(0, RECENT_KEPT);
      this.polledAt = now;
      this.cache = null;
    }
    return added;
  }

  /** Newest pulls across every machine, with card photos. */
  recent(limit = 24) { return this.latest.filter(p => p.card).slice(0, limit); }

  /** Per-pack value spread over each pack's latest pulls, and what each tier gets back on average. */
  async stats(now = Date.now()): Promise<StatsView> {
    if (this.cache && now - this.cache.at < 60_000) return this.cache.value;
    const s = this.settings.current, packs: PackStats[] = [];
    for (const def of SELLING) {
      const rows = (await this.db.query<{ value_cents: number; pulled_at: string }>('SELECT value_cents,pulled_at::text FROM cc_pulls WHERE code=$1 ORDER BY pulled_at DESC LIMIT $2', [def.code, SAMPLE_PER_PACK])).rows;
      const best = (await this.db.query<{ id: string; value_cents: number; pulled_at: string; card: FeedPull['card'] }>('SELECT id,value_cents,pulled_at::text,card FROM cc_pulls WHERE code=$1 AND card IS NOT NULL AND pulled_at>=$2 ORDER BY value_cents DESC, pulled_at DESC LIMIT 1', [def.code, now - 7 * DAY])).rows[0];
      const [d] = distribution(rows.map(r => ({ priceUsd: def.priceUsd, valueUsd: r.value_cents / 100 })));
      const price = micros(def.priceUsd), cents = (ratio: number) => Math.round(ratio * def.priceUsd * 100) / 100;
      // The rebate each tier would have got on these exact pulls, with the same cap a real order has.
      const avgRebateUsd = Object.fromEntries(s.tiers.map(t => {
        const cap = maxLiability(price, t.onsiteCoverageBps, micros(s.maxRebateUsd));
        const total = rows.reduce((sum, r) => sum + rebateMicros(price, r.value_cents * 10_000, t.onsiteCoverageBps, cap), 0);
        return [t.id, rows.length ? Math.round(usd(total / rows.length) * 100) / 100 : 0];
      }));
      packs.push({
        code: def.code, priceUsd: def.priceUsd, n: rows.length, since: rows.length ? Number(rows[rows.length - 1].pulled_at) : null,
        medianUsd: d ? cents(d.medianValueRatio) : 0, meanUsd: d ? cents(d.meanValueRatio) : 0, p10Usd: d ? cents(d.p10) : 0, p90Usd: d ? cents(d.p90) : 0,
        hitRate: d?.hitRate ?? 0, avgRebateUsd,
        best: best ? { id: best.id, mint: best.id.split(':')[0], code: def.code, priceUsd: def.priceUsd, valueUsd: best.value_cents / 100, at: Number(best.pulled_at), card: best.card, pullback: false } : null,
      });
    }
    const value = { packs, updatedAt: this.polledAt };
    this.cache = { at: now, value };
    return value;
  }

  /** Keeps each pack's newest sample, plus its biggest recent hits so the best of the week survives. */
  private async prune(code: string, now: number) {
    await this.db.query(
      `DELETE FROM cc_pulls WHERE code=$1
         AND id NOT IN (SELECT id FROM cc_pulls WHERE code=$1 ORDER BY pulled_at DESC LIMIT $2)
         AND id NOT IN (SELECT id FROM cc_pulls WHERE code=$1 AND card IS NOT NULL AND pulled_at>=$3 ORDER BY value_cents DESC LIMIT $4)`,
      [code, SAMPLE_PER_PACK, now - 8 * DAY, HITS_KEPT]);
  }

  private async json(path: string) {
    const response = await this.fetcher(`${API}${path}`, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Collector Crypt returned HTTP ${response.status}.`);
    return response.json() as Promise<any>;
  }
}

/** One feed entry → a pull, or null when it is for another machine or is missing its value or time. */
export function parsePull(w: any, def: PackDef, opsAddress: string | null): FeedPull | null {
  const at = Date.parse(w?.created_at), value = Number(w?.insuredValue), mint = w?.nft_address;
  if (w?.pack_type !== def.code || typeof mint !== 'string' || !Number.isFinite(at) || !Number.isFinite(value) || value <= 0) return null;
  const card = toCard(fromWinner(w));
  return { id: `${mint}:${at}`, mint, code: def.code, priceUsd: def.priceUsd, valueUsd: value, at, card: card ? { name: card.name, image: card.image } : null, pullback: !!opsAddress && w?.winner === opsAddress };
}
