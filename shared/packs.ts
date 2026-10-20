/** Collector Crypt machines we sell, by their machine code. A code is what identifies a pack: $500 is both a Pokémon and a watch pack. */
export type PackKind = 'pokemon' | 'watch';
export type PackDef = { code: string; priceUsd: number; kind: PackKind };

export const PACK_CATALOG: PackDef[] = [
  { code: 'pokemon_25', priceUsd: 25, kind: 'pokemon' },
  { code: 'pokemon_50', priceUsd: 50, kind: 'pokemon' },
  { code: 'pokemon_100', priceUsd: 100, kind: 'pokemon' },
  { code: 'pokemon_500', priceUsd: 500, kind: 'pokemon' },
  { code: 'ewatch_250', priceUsd: 250, kind: 'watch' },
  { code: 'ewatch_500', priceUsd: 500, kind: 'watch' },
];

export const packDef = (code: string | null | undefined) => PACK_CATALOG.find(p => p.code === code) ?? null;
/** Orders and claims from before pack codes existed were all Pokémon packs. */
export const packCode = (code: string | null | undefined, priceUsd: number) => code || `pokemon_${priceUsd}`;
