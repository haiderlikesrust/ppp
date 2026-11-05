/** Collector Crypt machines we sell, by their machine code. A code is what identifies a pack: $500 is both a Pokémon and a watch pack. */
export type PackKind = 'pokemon' | 'watch';
/**
 * `retired`: no longer sold, but still known so past orders, claims and receipts read correctly.
 * `unlisted`: Collector Crypt keeps the machine off its public menu (`public: false`) but it is open and selling; sold here anyway.
 */
export type PackDef = { code: string; priceUsd: number; kind: PackKind; retired?: boolean; unlisted?: boolean; sellBps?: number };

/**
 * `sellBps`: the share of insured value Collector Crypt's sell-back pays on that machine. It is fixed per machine,
 * measured from its live offers on 2026-11-05. Rebates use the live offer; this prices each pack and fills in when
 * there is no offer. A machine without a measured rate uses the lowest one seen, the safe side for the pool.
 */
const LOWEST_SELL_BPS = 8_500;

/** In price order. Collector Crypt's "WATCH 250" and "WATCH 500" pay out graded Pokémon cards, so they sell as card packs. */
export const PACK_CATALOG: PackDef[] = [
  { code: 'pokemon_25', priceUsd: 25, kind: 'pokemon', sellBps: 8_500 },
  { code: 'pokemon_50', priceUsd: 50, kind: 'pokemon', sellBps: 8_500 },
  { code: 'pokemon_100', priceUsd: 100, kind: 'pokemon', sellBps: 9_300 },
  { code: 'pokemon_250', priceUsd: 250, kind: 'pokemon', sellBps: 9_000 },
  { code: 'ewatch_250', priceUsd: 250, kind: 'pokemon', sellBps: 9_000 },
  { code: 'pokemon_500', priceUsd: 500, kind: 'pokemon', sellBps: 9_000 },
  { code: 'ewatch_500', priceUsd: 500, kind: 'pokemon', sellBps: 9_300 },
  // Collector Crypt's "Watch $500": the machine that actually pays out watches. It has no machine image there, so the site draws one.
  { code: 'ewatches_500', priceUsd: 500, kind: 'watch', unlisted: true, sellBps: 9_000 },
  // Off sale: Collector Crypt has no machine image for it. Kept so any orders on it still read.
  { code: 'pokemon_151', priceUsd: 151, kind: 'pokemon', unlisted: true, retired: true },
];

/** The machines on sale now. */
export const SELLING = PACK_CATALOG.filter(p => !p.retired);

export const packDef = (code: string | null | undefined) => PACK_CATALOG.find(p => p.code === code) ?? null;
/** The share of insured value a machine's sell-back pays. */
export const sellBpsFor = (code: string | null | undefined) => packDef(code)?.sellBps ?? LOWEST_SELL_BPS;
/** Orders and claims from before pack codes existed were all Pokémon packs. */
export const packCode = (code: string | null | undefined, priceUsd: number) => code || `pokemon_${priceUsd}`;
