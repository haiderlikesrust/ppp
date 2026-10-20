import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import type { Card } from '../../shared/types';
import { money } from './api';

/** Shield split like a capture ball: red top, white bottom, ink band and button. */
export function Logo({ size = 28 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
    <path d="M16 2 4 6.5v8.2C4 22.3 9.2 28.3 16 30c6.8-1.7 12-7.7 12-15.3V6.5z" fill="#fff" stroke="#17171c" strokeWidth="2" strokeLinejoin="round" />
    <path d="M16 2 4 6.5v8.2c0 .4 0 .9.05 1.3h23.9c.05-.4.05-.9.05-1.3V6.5z" fill="#e3350d" stroke="#17171c" strokeWidth="2" strokeLinejoin="round" />
    <circle cx="16" cy="16" r="4.2" fill="#fff" stroke="#17171c" strokeWidth="2" />
    <circle cx="16" cy="16" r="1.6" fill="#17171c" />
  </svg>;
}

/** Pack tiers borrow the capture-ball colorways. */
export const PACK_STYLE: Record<number, { name: string; top: string; bottom: string; band: string; ink: string }> = {
  25: { name: 'Starter', top: '#e3350d', bottom: '#ffffff', band: '#17171c', ink: '#17171c' },
  50: { name: 'Great', top: '#2a75bb', bottom: '#ffffff', band: '#e3350d', ink: '#17171c' },
  100: { name: 'Ultra', top: '#17171c', bottom: '#ffffff', band: '#ffcb05', ink: '#17171c' },
  500: { name: 'Master', top: '#7b3fe4', bottom: '#ffffff', band: '#f95587', ink: '#17171c' },
};
export const packStyle = (price: number) => PACK_STYLE[price] ?? { name: 'Pack', top: '#6c6c78', bottom: '#fff', band: '#17171c', ink: '#17171c' };

export function PackArt({ priceUsd, className = '' }: { priceUsd: number; className?: string }) {
  const s = packStyle(priceUsd);
  return <div className={`pack ${className}`} style={{ background: `linear-gradient(180deg, ${s.top} 0 54%, ${s.band} 54% 60%, ${s.bottom} 60%)`, border: '2px solid #17171c' }}>
    <div className="absolute left-1/2 top-[57%] z-[1] grid size-14 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-[3px] border-ink bg-white">
      <div className="size-5 rounded-full border-[3px] border-ink bg-white" />
    </div>
    <div className="absolute inset-x-0 top-6 z-[1] text-center text-white">
      <div className="text-[11px] font-semibold uppercase tracking-[.25em] opacity-80">{s.name}</div>
      <div className="num mt-1 text-3xl font-semibold">${priceUsd}</div>
    </div>
    <div className="absolute inset-x-0 bottom-4 z-[1] text-center text-[10px] font-semibold uppercase tracking-[.2em] text-ink/60">1 graded card</div>
  </div>;
}

const TYPE_COLORS = ['#e3350d', '#2a75bb', '#ffcb05', '#2f9e4f', '#7b3fe4', '#f95587', '#ee8130', '#6390f0'];
const hash = (text: string) => [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const typeColor = (name: string) => TYPE_COLORS[hash(name) % TYPE_COLORS.length];
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
  const title = name.length > 13 ? `${name.slice(0, 12)}…` : name, ink = '#17171c';
  const attack = (y: number, dots: number, label: string, dmg: number) => <g>
    {Array.from({ length: dots }, (_, i) => <circle key={i} cx={30 + i * 15} cy={y - 5} r="6.5" fill={color} stroke="#fff" strokeWidth="1.5" />)}
    <text x={30 + dots * 15} y={y} fontSize="13" fontWeight="700" fill={ink}>{label}</text>
    <text x="224" y={y + 1} textAnchor="end" fontSize="17" fontWeight="700" fill={ink}>{dmg}</text>
    <rect x="26" y={y + 9} width="176" height="4" rx="2" fill={ink} opacity=".16" /><rect x="26" y={y + 17} width="118" height="4" rx="2" fill={ink} opacity=".16" />
  </g>;
  return <svg viewBox="0 0 250 350" className="block aspect-[5/7] w-full" role="img" aria-label={`${name} card illustration`}>
    <defs>
      <linearGradient id={`${id}f`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#fae58a" /><stop offset=".5" stopColor="#e2b42a" /><stop offset="1" stopColor="#f7da6a" /></linearGradient>
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
    <rect x="20" y="47" width="210" height="140" fill="none" stroke="#c99f2e" strokeWidth="3" />
    <rect x="36" y="193" width="178" height="14" rx="7" fill="#f3d669" />
    <text x="125" y="203.5" textAnchor="middle" fontSize="8.5" fontStyle="italic" fill={ink}>{set ?? 'Collector'} · No. {number}</text>
    {attack(232, 1, ATTACKS[first], damage[0])}
    <line x1="24" x2="226" y1="266" y2="266" stroke={ink} strokeOpacity=".15" />
    {attack(288, 2, ATTACKS[second], damage[1])}
    <rect x="26" y="322" width="34" height="4" rx="2" fill={ink} opacity=".2" /><rect x="72" y="322" width="34" height="4" rx="2" fill={ink} opacity=".2" /><rect x="118" y="322" width="22" height="4" rx="2" fill={ink} opacity=".2" />
    <path d={star(222, 324, 6)} fill={ink} />
  </svg>;
}

/** A graded slab: red certification label, card window, value underneath. */
export function Slab({ card, priceUsd, size = 'md' }: { card: Pick<Card, 'name' | 'image' | 'insuredValueUsd' | 'rarity'>; priceUsd?: number; size?: 'sm' | 'md' }) {
  const [name, set, grade] = card.name.split(' · ');
  const color = typeColor(name ?? card.name), hit = priceUsd !== undefined && (card.insuredValueUsd ?? 0) >= priceUsd;
  const small = size === 'sm';
  return <div className="slab w-full">
    <div className={`flex items-center justify-between rounded-md border-2 border-red bg-white ${small ? 'px-1.5 py-0.5' : 'px-2 py-1'}`}>
      <div className="min-w-0">
        <div className={`truncate font-semibold ${small ? 'text-[9px]' : 'text-[11px]'}`}>{name}</div>
        {!small && <div className="truncate text-[9px] text-muted">{set ?? card.rarity}</div>}
      </div>
      <div className={`num shrink-0 font-semibold text-red ${small ? 'text-[9px]' : 'text-xs'}`}>{grade?.replace('PSA ', 'PSA ') ?? card.rarity}</div>
    </div>
    <div className="mt-1.5 overflow-hidden rounded-lg border border-line">
      {card.image ? <img src={card.image} alt={card.name} referrerPolicy="no-referrer" className="aspect-[5/7] w-full object-cover" />
        : <div className="relative">
          <CardArt name={name ?? card.name} set={set} color={color} />
          {hit && <div className="absolute bottom-1.5 right-1.5 rounded-full bg-yellow px-1.5 text-[9px] font-bold">HIT</div>}
        </div>}
    </div>
    {!small && <div className="num mt-1.5 text-center text-sm font-semibold">{money(card.insuredValueUsd)}</div>}
  </div>;
}

/** Price split into what the card is worth, what comes back, and what is lost. */
export function RebateBar({ priceUsd, valueUsd, rebateUsd }: { priceUsd: number; valueUsd: number; rebateUsd: number }) {
  const value = Math.min(valueUsd, priceUsd), pct = (n: number) => `${Math.max(0, n / priceUsd * 100)}%`;
  return <div>
    <div className="flex h-3 overflow-hidden rounded-full bg-red-soft">
      <div className="bg-ink" style={{ width: pct(value) }} />
      <div className="bg-grass" style={{ width: pct(rebateUsd) }} />
    </div>
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      <span className="flex items-center gap-1.5"><i className="size-2 rounded-full bg-ink" />Card {money(valueUsd)}</span>
      <span className="flex items-center gap-1.5"><i className="size-2 rounded-full bg-grass" />Back to you {money(rebateUsd)}</span>
      <span className="flex items-center gap-1.5"><i className="size-2 rounded-full bg-red-soft ring-1 ring-red/30" />Not covered {money(Math.max(0, priceUsd - value - rebateUsd))}</span>
    </div>
  </div>;
}

export function Modal({ open, onClose, children, width = 'max-w-md', dismissable = true, label }: { open: boolean; onClose: () => void; children: ReactNode; width?: string; dismissable?: boolean; label?: string }) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open || !dismissable) return;
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [open, dismissable, onClose]);
  // Move focus into the dialog, keep the page behind from scrolling, and give focus back on close.
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null, overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current?.focus();
    return () => { document.body.style.overflow = overflow; previous?.focus?.(); };
  }, [open]);
  if (!open) return null;
  return <div className="fixed inset-0 z-50 grid place-items-center bg-ink/30 p-4 backdrop-blur-sm" onClick={() => dismissable && onClose()}>
    <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label={label} className={`card rise relative max-h-[92vh] w-full overflow-auto p-6 shadow-2xl outline-none ${width}`} onClick={e => e.stopPropagation()}>
      {dismissable && <button aria-label="Close" className="absolute right-4 top-4 rounded-full p-1 text-muted hover:text-ink" onClick={onClose}><X size={18} /></button>}
      {children}
    </div>
  </div>;
}

export function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => { if (!message) return; const t = setTimeout(onClose, 6000); return () => clearTimeout(t); }, [message, onClose]);
  if (!message) return null;
  return <div role="status" className="rise fixed bottom-6 left-1/2 z-[60] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-full bg-ink py-2.5 pl-5 pr-3 text-sm text-white shadow-xl">
    <span>{message}</span><button aria-label="Dismiss" className="rounded-full p-1 opacity-70 hover:opacity-100" onClick={onClose}><X size={15} /></button>
  </div>;
}

export function Stat({ label, value, tone, hint }: { label: string; value: ReactNode; tone?: 'grass' | 'red' | 'blue'; hint?: string }) {
  return <div>
    <div className="label">{label}</div>
    <div className={`num mt-1 text-2xl font-semibold ${tone === 'grass' ? 'text-grass' : tone === 'red' ? 'text-red' : tone === 'blue' ? 'text-blue' : ''}`}>{value}</div>
    {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
  </div>;
}

export function SectionTitle({ title, sub, action }: { title: string; sub?: string; action?: ReactNode }) {
  return <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
    <div><h2 className="text-2xl font-semibold tracking-tight">{title}</h2>{sub && <p className="mt-1 text-sm text-muted">{sub}</p>}</div>{action}
  </div>;
}

export function Empty({ title, text, action }: { title: string; text: string; action?: ReactNode }) {
  return <div className="card grid place-items-center gap-2 px-6 py-12 text-center"><Logo size={36} /><h3 className="mt-2 font-semibold">{title}</h3><p className="max-w-sm text-sm text-muted">{text}</p>{action && <div className="mt-2">{action}</div>}</div>;
}
