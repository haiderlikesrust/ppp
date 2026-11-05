import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { Card } from '../../shared/types';
import { BRAND } from '../../shared/brand';
import { packDef } from '../../shared/packs';
import { money } from './api';
import { useShowcase } from './showcase';

/** The bolt from the wordmark, on its own for tight spots. `size` is its height. */
export function Logo({ size = 30 }: { size?: number }) {
  return <svg height={size} width={size * 2 / 3} viewBox="0 0 16 24" aria-hidden="true" className="shrink-0"><path d="M10.2 1 1.5 13.5h5.3L5.4 23l9.1-13.2H9.1L10.2 1Z" fill="#ffcb05" /></svg>;
}
/** The logo: the name with a yellow bolt beside it. Size it with a text size. */
export function Wordmark({ size = 'text-2xl' }: { size?: string }) {
  return <span className={`font-display ${size} inline-flex items-center gap-[0.05em] font-bold leading-none tracking-tight`}>{BRAND.name}<svg viewBox="0 0 16 24" aria-hidden="true" className="h-[1em] w-auto shrink-0"><path d="M10.2 1 1.5 13.5h5.3L5.4 23l9.1-13.2H9.1L10.2 1Z" fill="#ffcb05" /></svg></span>;
}

/** Each Collector Crypt machine wears an element of its own. */
export type PackType = 'grass' | 'water' | 'fire' | 'fairy' | 'dragon' | 'psychic' | 'steel';
type PackStyle = { name: string; type: PackType; color: string; item: string };
export const PACKS: Record<string, PackStyle> = {
  pokemon_25: { name: 'Leaf', type: 'grass', color: '#2fbf71', item: 'graded card' },
  pokemon_50: { name: 'Tide', type: 'water', color: '#2e8bff', item: 'graded card' },
  pokemon_100: { name: 'Ember', type: 'fire', color: '#ff6b3d', item: 'graded card' },
  pokemon_151: { name: 'Pixie', type: 'fairy', color: '#ff6fae', item: 'graded card' },
  pokemon_250: { name: 'Drake', type: 'dragon', color: '#6f5cff', item: 'graded card' },
  pokemon_500: { name: 'Mystic', type: 'psychic', color: '#b14dff', item: 'graded card' },
  ewatches_500: { name: 'Timepiece', type: 'steel', color: '#46557a', item: 'luxury watch' },
  // Collector Crypt calls these watch machines, but they pay out graded cards.
  ewatch_250: { name: 'Steel', type: 'steel', color: '#7c8ba1', item: 'graded card' },
  ewatch_500: { name: 'Gold', type: 'steel', color: '#e8a21a', item: 'graded card' },
};
/** Styling by machine code. Records from before codes existed only carry a price, and were Pokémon packs. */
export const packStyle = (code: string | null | undefined, priceUsd?: number): PackStyle => PACKS[code ?? ''] ?? PACKS[`pokemon_${priceUsd}`] ?? { name: 'Mystery', type: 'psychic', color: '#76829e', item: 'collectible' };
/** Whether the machine pays out watches (shown in watch frames), going by what it actually pays. */
export const isWatch = (code: string | null | undefined) => packDef(code)?.kind === 'watch';

const ENERGY: Record<PackType, ReactNode> = {
  grass: <path d="M5 19C5 10.5 10 5.5 19 5c-.5 9-5.5 14-14 14Zm0 0 8-8" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />,
  water: <path d="M12 3c4.2 5 6.3 8.6 6.3 11.2a6.3 6.3 0 0 1-12.6 0C5.7 11.6 7.8 8 12 3Z" fill="currentColor" />,
  fire: <path d="M12.2 2.5c.9 3.2 5.3 5.4 5.3 10.6a5.5 5.5 0 0 1-11 0c0-2.3 1-3.9 2.2-5 .3 2 1.3 3.2 2.6 3.7-.7-3.3-.3-6.4.9-9.3Z" fill="currentColor" />,
  fairy: <><path d="M12 2.5l2.4 7.1 7.1 2.4-7.1 2.4L12 21.5l-2.4-7.1L2.5 12l7.1-2.4Z" fill="currentColor" /><circle cx="19" cy="5" r="1.6" fill="currentColor" /></>,
  dragon: <path d="M3.5 20.5c2.2-5 2-9.7-.4-14.2 3.5 1.3 6 3.5 7.4 6.6.9-4.4 4-7.7 9.4-9.4-1.8 3.8-2.1 7.4-.8 10.9-2.5-.9-4.9-.6-7.1.9-2.6 1.8-5.4 3.5-8.5 5.2Z" fill="currentColor" />,
  psychic: <><path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12Z" fill="none" stroke="currentColor" strokeWidth="2.2" /><circle cx="12" cy="12" r="2.8" fill="currentColor" /></>,
  steel: <><rect x="8.5" y="1.5" width="7" height="4" rx="1" fill="currentColor" /><rect x="8.5" y="18.5" width="7" height="4" rx="1" fill="currentColor" /><circle cx="12" cy="12" r="6.6" fill="none" stroke="currentColor" strokeWidth="2.2" /><path d="M12 8.6V12l2.6 1.6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></>,
};
export function Energy({ type, className = '', style }: { type: PackType; className?: string; style?: CSSProperties }) {
  return <svg viewBox="0 0 24 24" className={className} style={style} aria-hidden="true">{ENERGY[type]}</svg>;
}

/** A round badge in the pack's element: its color and a small white icon. */
export function TypeBadge({ code, priceUsd, size = 26 }: { code?: string | null; priceUsd?: number; size?: number }) {
  const p = packStyle(code, priceUsd);
  return <span className="type-badge" style={{ width: size, height: size, background: p.color }} aria-hidden="true"><Energy type={p.type} style={{ width: size * 0.62, height: size * 0.62 }} /></span>;
}

/** A sealed pack: Collector Crypt's own machine image when it loads, otherwise a clean sleeve in the pack's color. */
export function Booster({ code, priceUsd, className = '', style }: { code?: string; priceUsd: number; className?: string; style?: CSSProperties }) {
  const image = useShowcase()?.packs[code ?? `pokemon_${priceUsd}`];
  const [broken, setBroken] = useState(false), [loaded, setLoaded] = useState(false);
  const p = packStyle(code, priceUsd);
  if (image && !broken) return <div className={`pack-art ${className}`} style={style}>
    {!loaded && <div aria-hidden="true" className="shimmer absolute inset-[14%] rounded-3xl" />}
    <img src={image} alt={`${p.name} $${priceUsd} pack`} referrerPolicy="no-referrer" onLoad={() => setLoaded(true)} onError={() => setBroken(true)} className={`aspect-square w-full object-contain drop-shadow-[0_18px_22px_rgb(16_25_53/0.22)] transition-opacity duration-500 ${loaded ? 'opacity-100' : 'opacity-0'}`} />
  </div>;
  // Collector Crypt has no picture of its watch machine, so draw one that stands beside the other machines' photos.
  if (packDef(code)?.kind === 'watch') return <WatchMachine priceUsd={priceUsd} className={className} style={style} />;
  return <div className={`pack-art grid aspect-square place-items-center ${className}`} style={style}>
    <div className="grid h-[86%] w-[64%] place-items-center rounded-[20px] text-white shadow-[0_18px_34px_-14px_rgb(16_25_53/0.45)]" style={{ background: `linear-gradient(150deg, color-mix(in srgb, ${p.color} 55%, white), ${p.color} 55%, color-mix(in srgb, ${p.color} 70%, #101935))` }}>
      <div className="text-center"><Energy type={p.type} className="mx-auto w-10" /><div className="font-display mt-2 text-2xl leading-none">${priceUsd}</div></div>
    </div>
  </div>;
}

/** Dial, hands and strap colors for the watches on display: steel, blue, green, black and gold. */
const DIALS = [['#f2f0ea', '#1b1e25', '#8d939c'], ['#1f4fa8', '#e9edf2', '#2a2f39'], ['#1c6b4c', '#e9edf2', '#c9cdd3'], ['#15171c', '#e8c46a', '#4a3a22'], ['#e8c46a', '#2a2116', '#6b4e2a']];

/** A luxury watch display machine, drawn at the same square footprint as Collector Crypt's machine photos. */
function WatchMachine({ priceUsd, className = '', style }: { priceUsd: number; className?: string; style?: CSSProperties }) {
  const id = useId().replace(/:/g, '');
  const watch = (x: number, y: number, i: number) => {
    const [dial, hands, strap] = DIALS[i % DIALS.length];
    return <g key={`${x}-${y}`}>
      <rect x={x - 4} y={y - 15} width="8" height="30" rx="3" fill={strap} />
      <circle cx={x} cy={y} r="9.5" fill={`url(#${id}-case)`} />
      <circle cx={x} cy={y} r="7.4" fill={dial} />
      <path d={`M${x} ${y}V${y - 5.2}M${x} ${y}L${x + 3.6} ${y + 1.6}`} stroke={hands} strokeWidth="1.3" strokeLinecap="round" />
      <rect x={x + 9} y={y - 1.5} width="2.4" height="3" rx="0.8" fill="#c9cdd3" />
    </g>;
  };
  return <div className={`pack-art ${className}`} style={style}>
    <svg viewBox="0 0 240 240" className="block aspect-square w-full" role="img" aria-label={`Luxury watch machine, $${priceUsd} pack`}>
      <defs>
        <linearGradient id={`${id}-body`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#2a2e37" /><stop offset="1" stopColor="#101217" /></linearGradient>
        <linearGradient id={`${id}-gold`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#f6dc93" /><stop offset=".55" stopColor="#e2b85c" /><stop offset="1" stopColor="#b8862f" /></linearGradient>
        <linearGradient id={`${id}-glass`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#2b2416" /><stop offset=".18" stopColor="#14120e" /><stop offset="1" stopColor="#0b0c0f" /></linearGradient>
        <radialGradient id={`${id}-case`} cx=".35" cy=".3" r=".8"><stop offset="0" stopColor="#ffffff" /><stop offset=".5" stopColor="#c9cdd3" /><stop offset="1" stopColor="#7d838c" /></radialGradient>
        <linearGradient id={`${id}-shine`} x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#fff" stopOpacity="0" /><stop offset=".5" stopColor="#fff" stopOpacity=".12" /><stop offset="1" stopColor="#fff" stopOpacity="0" /></linearGradient>
      </defs>
      {/* Cabinet, with a gold edge */}
      <rect x="38" y="10" width="164" height="214" rx="15" fill={`url(#${id}-gold)`} />
      <rect x="41" y="13" width="158" height="208" rx="12" fill={`url(#${id}-body)`} />
      {/* Marquee */}
      <rect x="50" y="21" width="140" height="24" rx="6" fill={`url(#${id}-gold)`} />
      <text x="120" y="36.5" textAnchor="middle" fontFamily="Outfit Variable, ui-sans-serif, sans-serif" fontSize="9" fontWeight="700" letterSpacing="1" fill="#2a2116">LUXURY WATCH</text>
      {/* Lit display case: three shelves of watches */}
      <rect x="50" y="52" width="104" height="114" rx="6" fill={`url(#${id}-glass)`} stroke="#3a3324" strokeWidth="1.5" />
      <rect x="55" y="56" width="94" height="3" rx="1.5" fill="#ffe7a8" opacity=".85" />
      {[86, 118, 150].map((y, row) => <g key={y}>
        {[70, 102, 134].map((x, col) => watch(x, y - 9, row * 3 + col))}
        <rect x="54" y={y + 7} width="96" height="2.5" rx="1" fill={`url(#${id}-gold)`} opacity=".9" />
      </g>)}
      <path d="M52 54h30L62 164H52Z" fill={`url(#${id}-shine)`} />
      {/* Control column: screen, keypad, card reader, emblem */}
      <rect x="159" y="52" width="31" height="114" rx="5" fill="#15181e" stroke="#2c303a" strokeWidth="1.2" />
      <rect x="164" y="58" width="21" height="14" rx="2" fill="#1d2a24" />
      <rect x="166" y="61" width="12" height="2" rx="1" fill="#45d483" opacity=".8" />
      <rect x="166" y="66" width="8" height="2" rx="1" fill="#45d483" opacity=".5" />
      {[0, 1, 2, 3].flatMap(r => [0, 1, 2].map(c => <circle key={`${r}${c}`} cx={167 + c * 7.5} cy={82 + r * 7.5} r="2.2" fill="#3a3f4a" />))}
      <rect x="166" y="114" width="17" height="3" rx="1.5" fill="#0b0c0f" />
      <circle cx="174.5" cy="140" r="9" fill="none" stroke={`url(#${id}-gold)`} strokeWidth="2" />
      <path d="M174.5 140v-5M174.5 140l3.5 2" stroke="#e2b85c" strokeWidth="1.6" strokeLinecap="round" />
      {/* Gold price plate and the opening the watch drops into */}
      <rect x="50" y="173" width="140" height="13" rx="3" fill={`url(#${id}-gold)`} />
      <text x="120" y="182.5" textAnchor="middle" fontFamily="Outfit Variable, ui-sans-serif, sans-serif" fontSize="7.5" fontWeight="700" letterSpacing="1.2" fill="#2a2116">${priceUsd} · 1 WATCH</text>
      <rect x="92" y="192" width="56" height="20" rx="7" fill="#0b0c0f" stroke="#e2b85c" strokeWidth="1.4" />
      <rect x="56" y="224" width="22" height="6" rx="2" fill="#0d0f13" />
      <rect x="162" y="224" width="22" height="6" rx="2" fill="#0d0f13" />
    </svg>
  </div>;
}

const TYPE_COLORS = ['#45d483', '#4aa3ff', '#ff8a4c', '#c77dff', '#ffd23f', '#ff5c8a', '#5ee0d0', '#a3a8b5'];
const hash = (text: string) => [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
export const typeColor = (name: string) => TYPE_COLORS[hash(name) % TYPE_COLORS.length];
/** Mixes a hex color toward white (t > 0) or black (t < 0). */
function shade(hex: string, t: number) {
  const n = parseInt(hex.slice(1), 16), target = t > 0 ? 255 : 0, k = Math.abs(t);
  return `rgb(${[n >> 16, (n >> 8) & 255, n & 255].map(v => Math.round(v + (target - v) * k)).join(',')})`;
}
/** Deterministic numbers from a seed, so a card always draws the same way. */
function seeded(seed: number) {
  let s = seed || 1;
  return (n: number) => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return Math.floor(s / 4294967296 * n); };
}
const ATTACKS = ['Sparkle Burst', 'Moon Tackle', 'Ribbon Lash', 'Quick Strike', 'Static Pulse', 'Leaf Dance', 'Ember Rush', 'Tidal Spin', 'Shadow Step', 'Star Fall'];
const star = (x: number, y: number, r: number) => `M${x} ${y - r}L${x + r * .28} ${y - r * .28}L${x + r} ${y}L${x + r * .28} ${y + r * .28}L${x} ${y + r}L${x - r * .28} ${y + r * .28}L${x - r} ${y}L${x - r * .28} ${y - r * .28}Z`;

/**
 * An original trading-card illustration for cards without a photo (practice mode, examples).
 * Deliberately not official artwork; real pulls show Collector Crypt's photo of the card.
 */
export function CardArt({ name, set, color }: { name: string; set?: string; color: string }) {
  const id = useId().replace(/:/g, ''), rand = seeded(hash(`${name}|${set ?? ''}`));
  const hp = 60 + rand(15) * 10, number = 1 + rand(250);
  const first = rand(ATTACKS.length), second = (first + 1 + rand(ATTACKS.length - 1)) % ATTACKS.length;
  const damage = [10 + rand(5) * 10, 0]; damage[1] = damage[0] + 30 + rand(8) * 10;
  const sparkles = Array.from({ length: 7 }, () => ({ x: 32 + rand(186), y: 58 + rand(96), r: 3 + rand(4) }));
  const title = name.length > 13 ? `${name.slice(0, 12)}…` : name, ink = '#14161b';
  const attack = (y: number, dots: number, label: string, dmg: number) => <g>
    {Array.from({ length: dots }, (_, i) => <circle key={i} cx={30 + i * 15} cy={y - 5} r="6.5" fill={color} stroke="#fff" strokeWidth="1.5" />)}
    <text x={30 + dots * 15} y={y} fontSize="13" fontWeight="700" fill={ink}>{label}</text>
    <text x="224" y={y + 1} textAnchor="end" fontSize="17" fontWeight="700" fill={ink}>{dmg}</text>
    <rect x="26" y={y + 9} width="176" height="4" rx="2" fill={ink} opacity=".16" /><rect x="26" y={y + 17} width="118" height="4" rx="2" fill={ink} opacity=".16" />
  </g>;
  return <svg viewBox="0 0 250 350" className="block aspect-[5/7] w-full" role="img" aria-label={`${name} card illustration`}>
    <defs>
      <linearGradient id={`${id}f`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#f2f5f9" /><stop offset=".5" stopColor="#a9b2bf" /><stop offset="1" stopColor="#e6eaf0" /></linearGradient>
      <linearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={shade(color, .62)} /><stop offset="1" stopColor={shade(color, .3)} /></linearGradient>
      <radialGradient id={`${id}a`} cx=".5" cy=".45" r=".8"><stop offset="0" stopColor={shade(color, .85)} /><stop offset=".5" stopColor={shade(color, .15)} /><stop offset="1" stopColor={shade(color, -.4)} /></radialGradient>
      <linearGradient id={`${id}h`} x1="0" y1="0" x2="1" y2=".6"><stop offset=".35" stopColor="#fff" stopOpacity="0" /><stop offset=".5" stopColor="#fff" stopOpacity=".6" /><stop offset=".65" stopColor="#fff" stopOpacity="0" /></linearGradient>
      <clipPath id={`${id}c`}><rect x="20" y="47" width="210" height="140" /></clipPath>
    </defs>
    <rect width="250" height="350" rx="14" fill={`url(#${id}f)`} />
    <rect x="9" y="9" width="232" height="332" rx="8" fill={`url(#${id}b)`} />
    <text x="20" y="36" fontSize="18" fontWeight="700" fill={ink}>{title}</text>
    <text x="211" y="36" textAnchor="end" fontWeight="700" fill={ink}><tspan fontSize="9">HP </tspan><tspan fontSize="18">{hp}</tspan></text>
    <circle cx="224" cy="30" r="8.5" fill={color} stroke="#fff" strokeWidth="2" />
    <g clipPath={`url(#${id}c)`}>
      <rect x="20" y="47" width="210" height="140" fill={`url(#${id}a)`} />
      {Array.from({ length: 12 }, (_, i) => <rect key={i} x="124" y="0" width="2.5" height="230" fill="#fff" opacity=".13" transform={`rotate(${i * 15} 125 110)`} />)}
      <circle cx="125" cy="108" r="44" fill="#fff" opacity=".22" /><circle cx="125" cy="108" r="26" fill="#fff" opacity=".42" />
      <path d="M20 187C58 150 98 172 138 160S206 148 230 164V187Z" fill={shade(color, -.3)} opacity=".6" />
      <path d="M20 187C70 168 118 184 168 172S218 170 230 178V187Z" fill={shade(color, -.55)} opacity=".7" />
      {sparkles.map((p, i) => <path key={i} d={star(p.x, p.y, p.r)} fill="#fff" opacity=".9" />)}
      <rect className="card-holo" x="20" y="47" width="210" height="140" fill={`url(#${id}h)`} />
    </g>
    <rect x="20" y="47" width="210" height="140" fill="none" stroke="#8d97a6" strokeWidth="3" />
    <rect x="36" y="193" width="178" height="14" rx="7" fill="#dfe4ea" />
    <text x="125" y="203.5" textAnchor="middle" fontSize="8.5" fontStyle="italic" fill={ink}>{set ?? 'Collector'} · No. {number}</text>
    {attack(232, 1, ATTACKS[first], damage[0])}
    <line x1="24" x2="226" y1="266" y2="266" stroke={ink} strokeOpacity=".15" />
    {attack(288, 2, ATTACKS[second], damage[1])}
    <rect x="26" y="322" width="34" height="4" rx="2" fill={ink} opacity=".2" /><rect x="72" y="322" width="34" height="4" rx="2" fill={ink} opacity=".2" /><rect x="118" y="322" width="22" height="4" rx="2" fill={ink} opacity=".2" />
    <path d={star(222, 324, 6)} fill={ink} />
  </svg>;
}

/** A plain watch illustration for watches without a photo (practice mode). Real pulls show Collector Crypt's photo. */
export function WatchArt({ name, color }: { name: string; color: string }) {
  return <svg viewBox="0 0 250 350" className="block aspect-[5/7] w-full" role="img" aria-label={`${name} watch illustration`}>
    <rect width="250" height="350" fill="#14171d" />
    <rect x="95" y="0" width="60" height="350" rx="8" fill="#22262e" />
    {Array.from({ length: 9 }, (_, i) => <rect key={i} x="95" y={8 + i * 38} width="60" height="2" fill="#2c313b" />)}
    <circle cx="125" cy="175" r="78" fill={color} />
    <circle cx="125" cy="175" r="66" fill="#0f1115" />
    {Array.from({ length: 12 }, (_, i) => <rect key={i} x="123" y="115" width="4" height={i % 3 ? 7 : 13} fill="#e9edf2" transform={`rotate(${i * 30} 125 175)`} />)}
    <rect x="123" y="132" width="4" height="46" rx="2" fill="#e9edf2" transform="rotate(-55 125 175)" />
    <rect x="123.5" y="122" width="3" height="56" rx="1.5" fill={color} transform="rotate(70 125 175)" />
    <circle cx="125" cy="175" r="5" fill="#e9edf2" />
    <rect x="200" y="167" width="9" height="16" rx="2" fill={color} />
  </svg>;
}

/** Tilts an element toward the pointer and steers its sheen. Leaves touch screens and reduced motion alone. */
export function useTilt<T extends HTMLElement>(enabled = true) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled || matchMedia('(prefers-reduced-motion: reduce)').matches || !matchMedia('(hover: hover)').matches) return;
    const set = (rx: number, ry: number, mx: number, my: number) => { el.style.setProperty('--rx', `${rx}deg`); el.style.setProperty('--ry', `${ry}deg`); el.style.setProperty('--mx', `${mx}%`); el.style.setProperty('--my', `${my}%`); };
    const move = (e: PointerEvent) => { const r = el.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height; el.dataset.tilting = ''; set((0.5 - y) * 12, (x - 0.5) * 15, x * 100, y * 100); };
    const leave = () => { delete el.dataset.tilting; set(0, 0, 50, 30); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerleave', leave);
    return () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerleave', leave); };
  }, [enabled]);
  return ref;
}

/** A trading card with its grade on a small round badge. With `tilt` it leans toward the pointer and its foil follows; `holo` keeps the foil lit. */
export function TradingCard({ card, priceUsd, size = 'md', watch = false, tilt = false, holo = false }: { card: Pick<Card, 'name' | 'image' | 'insuredValueUsd' | 'rarity'>; priceUsd?: number; size?: 'sm' | 'md'; watch?: boolean; tilt?: boolean; holo?: boolean }) {
  const [name, set, grade] = card.name.split(' · ');
  const color = typeColor(name ?? card.name), hit = priceUsd !== undefined && (card.insuredValueUsd ?? 0) >= priceUsd;
  const small = size === 'sm', ref = useTilt<HTMLDivElement>(tilt), label = grade ?? card.rarity;
  return <div ref={ref} className={`tcard ${small ? 'tcard-sm' : ''}`} {...(holo ? { 'data-foil': '' } : {})}>
    {card.image ? <img src={card.image} alt={card.name} referrerPolicy="no-referrer" className="block aspect-[5/7] w-full object-cover" /> : watch ? <WatchArt name={name ?? card.name} color={color} /> : <CardArt name={name ?? card.name} set={set} color={color} />}
    {hit && <span className={`tag absolute bottom-2 left-2 z-[3] bg-spark text-[#1a1500] ${small ? 'h-5 px-1.5 text-[0.62rem]' : ''}`}>Hit</span>}
    {!card.image && label && !small && <span className="tag absolute bottom-2 right-2 z-[3] bg-white/90 text-[#101935]">{label}</span>}
  </div>;
}

/** The pack price split into what the card is worth, what comes back, and what is lost. */
export function RebateBar({ priceUsd, valueUsd, rebateUsd }: { priceUsd: number; valueUsd: number; rebateUsd: number }) {
  const value = Math.min(valueUsd, priceUsd), pct = (n: number) => `${Math.max(0, n / priceUsd * 100)}%`;
  return <div>
    <div className="flex h-2 overflow-hidden rounded-full bg-loss-soft">
      <div className="bg-info" style={{ width: pct(value) }} />
      <div className="bg-gain" style={{ width: pct(rebateUsd) }} />
    </div>
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      <span className="flex items-center gap-1.5"><i className="size-2 rounded-full bg-info" />Sells for {money(valueUsd)}</span>
      <span className="flex items-center gap-1.5"><i className="size-2 rounded-full bg-gain" />Back to you {money(rebateUsd)}</span>
      <span className="flex items-center gap-1.5"><i className="size-2 rounded-full bg-loss/40" />Not covered {money(Math.max(0, priceUsd - value - rebateUsd))}</span>
    </div>
  </div>;
}

/**
 * The grade ring: how much of the pack price came back. Blue fills to the card's value, then mint adds the rebate
 * on top, so a bad pull visibly gets topped up. A pull above the pack price fills the ring in gold.
 */
export function GradeRing({ priceUsd, valueUsd, rebateUsd, size = 132 }: { priceUsd: number; valueUsd: number; rebateUsd: number; size?: number }) {
  const stroke = 10, r = (size - stroke) / 2, c = 2 * Math.PI * r, hit = valueUsd >= priceUsd;
  const value = Math.min(1, valueUsd / priceUsd), total = Math.min(1, value + rebateUsd / priceUsd);
  const [shown, setShown] = useState({ value: 0, total: 0 });
  useEffect(() => { const id = requestAnimationFrame(() => setShown({ value, total })); return () => cancelAnimationFrame(id); }, [value, total]);
  const arc = (k: number, color: string) => <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - k)} className="ring-arc" />;
  return <div className="relative inline-grid shrink-0 place-items-center" style={{ width: size, height: size }} role="img" aria-label={`${Math.round(total * 100)}% of the pack price back`}>
    <svg width={size} height={size} className="-rotate-90" aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-raised)" strokeWidth={stroke} />
      {hit ? arc(shown.value, 'var(--color-spark)') : <>{arc(shown.total, 'var(--color-gain)')}{arc(shown.value, 'var(--color-info)')}</>}
    </svg>
    <div className="absolute inset-0 grid place-content-center text-center"><div className="font-display num text-2xl leading-none">{hit ? `${(valueUsd / priceUsd).toFixed(1)}×` : `${Math.round(total * 100)}%`}</div><div className="mt-0.5 text-[11px] text-muted">{hit ? 'of the pack' : 'back'}</div></div>
  </div>;
}

/** Counts up to a dollar amount once it appears. */
export function useCount(target: number | null, ms = 1100) {
  const [shown, setShown] = useState(target ?? 0), from = useRef(0);
  useEffect(() => {
    if (target === null) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { setShown(target); return; }
    const start = performance.now(), origin = from.current;
    let frame = 0;
    const tick = (t: number) => { const k = Math.min(1, (t - start) / ms), eased = 1 - (1 - k) ** 4; setShown(origin + (target - origin) * eased); if (k < 1) frame = requestAnimationFrame(tick); else from.current = target; };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, ms]);
  return shown;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** A dialog that keeps keyboard focus inside and makes the page behind it inert until it closes. */
export function Modal({ open, onClose, children, width = 'max-w-md', dismissable = true, label }: { open: boolean; onClose: () => void; children: ReactNode; width?: string; dismissable?: boolean; label?: string }) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissable) onClose();
      if (e.key !== 'Tab' || !dialog.current) return;
      const items = [...dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [open, dismissable, onClose]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null, overflow = document.body.style.overflow;
    const chrome = [...document.querySelectorAll<HTMLElement>('[data-app-chrome]')];
    document.body.style.overflow = 'hidden';
    chrome.forEach(el => { el.inert = true; });
    dialog.current?.focus();
    return () => { document.body.style.overflow = overflow; chrome.forEach(el => { el.inert = false; }); previous?.focus?.(); };
  }, [open]);
  if (!open) return null;
  // Rendered under <body>: the page behind is made inert while a modal is open, and a modal inside it would go inert too.
  return createPortal(<div className="fixed inset-0 z-50 grid place-items-center bg-[#0b1124]/55 p-3 backdrop-blur-sm sm:p-4" onClick={() => dismissable && onClose()}>
    <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label={label} className={`card enter relative max-h-[94vh] w-full overflow-auto p-5 shadow-2xl outline-none sm:p-7 ${width}`} onClick={e => e.stopPropagation()}>
      {dismissable && <button aria-label="Close" className="absolute right-3 top-3 z-10 rounded-full p-1.5 text-muted hover:bg-raised hover:text-ink" onClick={onClose}><X size={18} /></button>}
      {children}
    </div>
  </div>, document.body);
}

export function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => { if (!message) return; const t = setTimeout(onClose, 6000); return () => clearTimeout(t); }, [message, onClose]);
  if (!message) return null;
  return <div role="status" className="enter fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] left-4 right-4 z-[60] flex items-center gap-3 rounded-xl border border-line bg-surface py-3 pl-4 pr-2 text-sm font-medium shadow-[var(--shadow-lift)] sm:left-auto sm:right-6 sm:max-w-md md:bottom-5">
    <span className="min-w-0 flex-1">{message}</span><button aria-label="Dismiss" className="rounded-full p-1 text-muted hover:text-ink" onClick={onClose}><X size={15} /></button>
  </div>;
}

export function Stat({ label, value, tone, hint }: { label: string; value: ReactNode; tone?: 'gain' | 'loss' | 'accent'; hint?: string }) {
  return <div className="min-w-0">
    <div className="label">{label}</div>
    <div className={`font-display num mt-1 truncate text-2xl sm:text-3xl ${tone === 'gain' ? 'text-gain' : tone === 'loss' ? 'text-loss' : tone === 'accent' ? 'text-accent' : ''}`}>{value}</div>
    {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
  </div>;
}

/** The top of a page. */
export function PageHead({ kicker, title, sub, action }: { kicker: string; title: ReactNode; sub?: ReactNode; action?: ReactNode }) {
  return <header className="enter pb-8 pt-10 md:pb-10 md:pt-14">
    <div className="label">{kicker}</div>
    <div className="mt-3 flex flex-wrap items-end justify-between gap-5">
      <div className="min-w-0"><h1 className="font-display text-5xl font-bold leading-[1.05] tracking-tight sm:text-6xl">{title}</h1>{sub && <p className="mt-4 max-w-xl text-lg text-muted">{sub}</p>}</div>
      {action}
    </div>
  </header>;
}

export function SectionTitle({ title, sub, action, n }: { title: string; sub?: string; action?: ReactNode; n?: string }) {
  return <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
    <div className="min-w-0">{n && <div className="label mb-1.5">{n}</div>}<h2 className="font-display text-3xl font-bold leading-tight tracking-tight sm:text-4xl">{title}</h2>{sub && <p className="mt-1.5 max-w-2xl text-muted">{sub}</p>}</div>{action}
  </div>;
}

export function Empty({ title, text, action }: { title: string; text: string; action?: ReactNode }) {
  return <div className="card grid place-items-center gap-2 px-6 py-14 text-center"><Logo size={40} /><h3 className="font-display mt-2 text-2xl">{title}</h3><p className="max-w-sm text-sm text-muted">{text}</p>{action && <div className="mt-2">{action}</div>}</div>;
}
