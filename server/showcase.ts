import { PACK_CATALOG } from '../shared/packs';

type Fetch = typeof fetch;
export type ShowcaseCard = { name: string; image: string; insuredValueUsd: number; rarity: string | null };
export type Showcase = { packs: Record<string, string>; example: ShowcaseCard | null };

const API = 'https://gacha.collectorcrypt.com/api';
const HOUR = 3_600_000;
const https = (url: unknown): url is string => typeof url === 'string' && url.startsWith('https://');

/**
 * Collector Crypt's own artwork for the site: each machine's pack image and one real card for the
 * worked example. Read from their public API (no key), cached for an hour, and empty when they are
 * unreachable, in which case the site falls back to its drawn boosters and card.
 */
export class ShowcaseSource {
  private cache: { at: number; value: Promise<Showcase> } | null = null;
  constructor(private readonly fetcher: Fetch = fetch) {}

  get(): Promise<Showcase> {
    if (!this.cache || Date.now() - this.cache.at > HOUR) {
      const value = this.load().catch(() => ({ packs: {}, example: null }));
      this.cache = { at: Date.now(), value };
      // Retry sooner after a failure.
      value.then(v => { if (!Object.keys(v.packs).length && this.cache?.value === value) this.cache.at = Date.now() - HOUR + 5 * 60_000; });
    }
    return this.cache.value;
  }

  private async json(path: string) {
    const response = await this.fetcher(`${API}${path}`, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Collector Crypt returned HTTP ${response.status}.`);
    return response.json() as Promise<any>;
  }

  private async load(): Promise<Showcase> {
    // Recent real $25 pulls: about half come in under the pack price, which is what the example shows.
    const [catalog, winners] = await Promise.all([this.json('/machines'), this.json('/getAllWinners?count=100&packType=pokemon_25').catch(() => null)]);
    const packs: Record<string, string> = {};
    for (const m of catalog?.machines ?? []) if (PACK_CATALOG.some(p => p.code === m.code) && https(m.imageNobg)) packs[m.code] = m.imageNobg;
    return { packs, example: pickExample((winners?.data ?? []).map(fromWinner)) };
  }
}

/** A real $25-pack card that came in under the pack price, with its photo: a genuine bad pull for the example. */
export function pickExample(nfts: any[]): ShowcaseCard | null {
  const cards = nfts.map(toCard).filter((c): c is ShowcaseCard => !!c && c.insuredValueUsd >= 5 && c.insuredValueUsd <= 20);
  return cards.sort((a, b) => a.insuredValueUsd - b.insuredValueUsd)[Math.floor(cards.length / 2)] ?? null;
}

/** A recent-winners entry in the NFT shape `toCard` reads. */
export function fromWinner(w: any) {
  const content = w?.nft?.content ?? {};
  return { name: content.metadata?.name, image: content.files?.[0]?.cc_cdn ?? content.links?.image, insured_value: w?.insuredValue, attributes: content.metadata?.attributes, rarity: null };
}

/** Collector Crypt NFT → "Name · Year · PSA 9", the format the slab label splits on. */
export function toCard(nft: any): ShowcaseCard | null {
  const attrs: { trait_type?: string; value?: string }[] = Array.isArray(nft?.attributes) ? nft.attributes : [];
  const attr = (name: string) => attrs.find(a => a.trait_type === name)?.value?.toString().trim() ?? '';
  const value = Number(nft?.insured_value ?? attr('Insured Value'));
  const image = [nft?.image, nft?.content?.links?.image].find(https);
  if (!image || !Number.isFinite(value) || value <= 0) return null;
  // "2025 Pokemon Prismatic Evolutions #136 Eri CGC 10" → card "Eri", set "Prismatic Evolutions"; the grade has its own place on the slab.
  const raw = String(nft?.name ?? '').replace(/\s+(PSA|CGC|BGS|SGC|TAG)\s+\d.*$/i, '').trim();
  const parts = raw.match(/^(?:\d{4}\s+)?(.*?)\s*#\S+\s+(.+)$/);
  const title = (parts ? parts[2] : raw.replace(/^\d{4}\s+/, '')).trim() || 'Graded card';
  const set = (parts ? parts[1].replace(/^Pok[eé]mon\s+/i, '').trim() : '') || attr('Year');
  const grade = `${attr('Grading Company')} ${attr('The Grade').match(/\d+(\.\d+)?/)?.[0] ?? ''}`.trim();
  return { name: [title, set, grade].filter(Boolean).join(' · '), image, insuredValueUsd: value, rarity: typeof nft?.rarity === 'string' ? nft.rarity : null };
}
