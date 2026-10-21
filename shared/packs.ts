/** Collector Crypt machines we sell, by their machine code. A code is what identifies a pack: $500 is both a Pokémon and a watch pack. */
export type PackKind = 'pokemon' | 'watch';
/** `retired`: no longer sold, but still known so past orders, claims and receipts read correctly. */
export type PackDef = { code: string; priceUsd: number; kind: PackKind; retired?: boolean };

export const PACK_CATALOG: PackDef[] = [
  { code: 'pokemon_25', priceUsd: 25, kind: 'pokemon' },
  { code: 'pokemon_50', priceUsd: 50, kind: 'pokemon' },
  { code: 'pokemon_100', priceUsd: 100, kind: 'pokemon' },
  { code: 'pokemon_151', priceUsd: 151, kind: 'pokemon' },
  { code: 'pokemon_250', priceUsd: 250, kind: 'pokemon' },
  { code: 'pokemon_500', priceUsd: 500, kind: 'pokemon' },
  // Collector Crypt's "Watch $500": the machine that actually pays out watches.
  { code: 'ewatches_500', priceUsd: 500, kind: 'watch' },
  // Listed as watch machines on Collector Crypt, but their pulls are all graded Pokémon cards.
  { code: 'ewatch_250', priceUsd: 250, kind: 'pokemon', retired: true },
  { code: 'ewatch_500', priceUsd: 500, kind: 'pokemon', retired: true },
];

/** The machines on sale now. */
export const SELLING = PACK_CATALOG.filter(p => !p.retired);

export const packDef = (code: string | null | undefined) => PACK_CATALOG.find(p => p.code === code) ?? null;
/** Orders and claims from before pack codes existed were all Pokémon packs. */
export const packCode = (code: string | null | undefined, priceUsd: number) => code || `pokemon_${priceUsd}`;
