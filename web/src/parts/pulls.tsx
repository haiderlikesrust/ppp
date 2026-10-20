import { useEffect, useState } from 'react';
import type { FeedPull, HolderTier } from '../../../shared/types';
import { ago, api, money } from '../api';
import { Link, useApp } from '../app';
import { SectionTitle, packStyle } from '../ui';

/** The tier a bad pull is priced at: the visitor's own, or the top tier for visitors without one. */
export function useRebateTier() {
  const { me, config } = useApp();
  const tiers: HolderTier[] = config?.settings?.tiers ?? [];
  const mine = me.holder?.tier ?? null;
  const tier = mine ?? [...tiers].sort((a, b) => b.onsiteCoverageBps - a.onsiteCoverageBps)[0] ?? null;
  return { tier, mine: !!mine, tiers, maxRebateUsd: Number(config?.settings?.maxRebateUsd ?? Infinity) };
}

/** What an on-site pack with this pull would have sent back: coverage of the shortfall, capped like a real order. */
export function rebateFor(priceUsd: number, valueUsd: number, tier: HolderTier | null, maxRebateUsd: number) {
  if (!tier || valueUsd >= priceUsd) return 0;
  const cap = Math.min(maxRebateUsd, Math.floor(priceUsd * tier.onsiteCoverageBps / 100) / 100);
  return Math.min(cap, Math.floor((priceUsd - valueUsd) * tier.onsiteCoverageBps / 100) / 100);
}

/** Collector Crypt's newest pulls, shared by every component on the page and refreshed while it is visible. */
export function useRecentPulls(every = 30_000) {
  const [items, setItems] = useState<FeedPull[] | null>(null);
  const empty = !items?.length;
  useEffect(() => {
    let live = true;
    const load = () => api<{ items: FeedPull[] }>('/pulls/recent').then(r => { if (live) setItems(r.items); }).catch(() => { if (live) setItems(i => i ?? []); });
    // The first read always runs; refreshes wait while the tab is in the background.
    load(); const id = setInterval(() => { if (!document.hidden) load(); }, empty ? 10_000 : every);
    return () => { live = false; clearInterval(id); };
  }, [every, empty]);
  return items;
}

/** One real pull: the graded card's photo, its value against the pack, and what Pullback would send back. */
export function PullCard({ pull, className = '' }: { pull: FeedPull; className?: string }) {
  const { tier, maxRebateUsd } = useRebateTier();
  const s = packStyle(pull.code, pull.priceUsd), up = pull.valueUsd >= pull.priceUsd;
  const change = Math.round((pull.valueUsd / pull.priceUsd - 1) * 100), back = rebateFor(pull.priceUsd, pull.valueUsd, tier, maxRebateUsd);
  const [title] = (pull.card?.name ?? 'Graded card').split(' · ');
  return <figure className={`min-w-0 ${className}`}>
    <div className="relative aspect-[3/5] overflow-hidden rounded-lg border border-line bg-raised">
      {pull.card && <img src={pull.card.image} alt={pull.card.name} loading="lazy" decoding="async" referrerPolicy="no-referrer" className="h-full w-full scale-[1.04] object-cover" />}
      <span className="tag absolute left-1.5 top-1.5 bg-night/85 text-ink"><i className="size-2" style={{ background: s.color }} />{money(pull.priceUsd)}</span>
      {pull.pullback && <span className="tag absolute bottom-1.5 left-1.5 bg-volt text-night">Pullback</span>}
    </div>
    <figcaption className="mt-2 min-w-0">
      <div className="truncate text-xs" title={pull.card?.name}>{title}</div>
      <div className="mt-0.5 flex items-baseline justify-between gap-2">
        <span className={`pixel num text-sm ${up ? 'text-gain' : ''}`}>{money(pull.valueUsd)}</span>
        <span className={`num text-[11px] ${up ? 'text-gain' : 'text-loss'}`}>{change >= 0 ? '+' : '−'}{Math.abs(change)}%</span>
      </div>
      <div className="mt-0.5 flex justify-between gap-2 text-[11px]">
        <span className="truncate">{back > 0 && tier ? <span className="text-gain" title={`What a ${tier.name} gets back when this pack is opened on Pullback`}>+{money(back)} back</span> : up ? <span className="pixel text-volt">Hit</span> : null}</span>
        <span className="shrink-0 text-faint">{ago(pull.at)}</span>
      </div>
    </figcaption>
  </figure>;
}

/** Homepage strip: the latest real pulls, scrolling sideways. */
export function RecentPullsStrip() {
  const pulls = useRecentPulls(), { tier, mine } = useRebateTier();
  if (pulls && !pulls.length) return null;
  return <section className="pb-16">
    <SectionTitle title="Just pulled" sub={`Real pulls on Collector Crypt, live.${tier ? ` Green is what ${mine ? 'your tier' : `a ${tier.name}`} gets back when it's opened here.` : ''}`} action={<Link href="/stats" className="pixel text-sm text-volt hover:underline">Pack stats →</Link>} />
    <div className="no-scrollbar -mx-4 flex snap-x scroll-px-4 gap-3 overflow-x-auto px-4 pb-1 sm:-mx-6 sm:scroll-px-6 sm:px-6">
      {pulls ? pulls.slice(0, 14).map(p => <PullCard key={p.id} pull={p} className="w-[118px] shrink-0 snap-start sm:w-[136px]" />)
        : Array.from({ length: 8 }, (_, i) => <div key={i} className="aspect-[3/5] w-[118px] shrink-0 animate-pulse rounded-lg bg-surface sm:w-[136px]" />)}
    </div>
  </section>;
}
