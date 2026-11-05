import { useEffect, useState } from 'react';
import type { FeedPull, HolderTier, SitePull } from '../../../shared/types';
import { ago, api, money, solscan } from '../api';
import { Link, navigate, useApp } from '../app';
import { SectionTitle, TradingCard, isWatch } from '../ui';

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

/** Packs just opened on Regrade, refreshed while the page is visible and whenever an order finishes here. */
export function useSitePulls(every = 30_000) {
  const { version } = useApp();
  const [items, setItems] = useState<SitePull[] | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => api<{ items: SitePull[] }>('/pulls/site').then(r => { if (live) setItems(r.items); }).catch(() => { if (live) setItems(i => i ?? []); });
    load(); const id = setInterval(() => { if (!document.hidden) load(); }, every);
    return () => { live = false; clearInterval(id); };
  }, [every, version]);
  return items;
}

/**
 * One real pull in a small slab, its value against the pack, and the rebate. A pack opened on Regrade shows what it
 * actually sent back and opens its own page; a Collector Crypt pull shows what it would have sent, and opens on Solscan.
 */
export function PullCard({ pull, className = '' }: { pull: FeedPull | SitePull; className?: string }) {
  const { tier, maxRebateUsd } = useRebateTier();
  const up = pull.valueUsd >= pull.priceUsd, paid = 'rebateUsd' in pull ? pull.rebateUsd : null, ours = 'txs' in pull;
  const change = Math.round((pull.valueUsd / pull.priceUsd - 1) * 100), back = paid ?? rebateFor(pull.priceUsd, pull.valueUsd, tier, maxRebateUsd);
  const name = pull.card?.name ?? 'Graded card', [title] = name.split(' · ');
  const proof = ours ? null : solscan('token', pull.mint);
  const slab = <TradingCard size="sm" card={{ name, image: pull.card?.image ?? null, insuredValueUsd: pull.valueUsd, rarity: null }} watch={isWatch(pull.code)} />;
  return <figure className={`group min-w-0 ${className}`}>
    <div className="transition-transform duration-700 [transition-timing-function:var(--ease-weight)] group-hover:-translate-y-1">
      {ours ? <button className="block w-full text-left" onClick={() => navigate(`/pull/${(pull as SitePull).id}`)} aria-label={`${title}: see this pull`}>{slab}</button>
        : <a href={proof!} target="_blank" rel="noreferrer" title="Check it on Solscan" aria-label={`${title} on Solscan`} className="block">{slab}</a>}
    </div>
    <figcaption className="mt-2 min-w-0">
      <div className="truncate text-xs" title={name}>{title}</div>
      <div className="mt-0.5 flex items-baseline justify-between gap-2">
        <span className={`font-display num text-[13px] ${up ? 'text-gain' : ''}`}>{money(pull.valueUsd)}</span>
        <span className={`font-display num text-[11px] ${up ? 'text-gain' : 'text-loss'}`}>{change >= 0 ? '+' : '−'}{Math.abs(change)}%</span>
      </div>
      <div className="mt-0.5 flex justify-between gap-2 text-[11px]">
        <span className="truncate">{back > 0 ? <span className="text-gain" title={paid !== null ? 'Sent back in USDC' : `What ${tier?.name} gets back at full coverage when this pack is opened on Regrade`}>+{money(back)} back</span> : up ? <span className="font-display text-warn">Hit</span> : null}</span>
        <span className="shrink-0 text-faint">{ago(pull.at)}</span>
      </div>
    </figcaption>
  </figure>;
}

/** Homepage strip: the latest packs opened on Regrade, scrolling sideways. Hidden until the first one. */
export function RecentPullsStrip() {
  const pulls = useSitePulls();
  if (!pulls?.length) return null;
  return <section className="pb-16">
    <SectionTitle title="Just opened" sub="Packs just opened here. Green is the USDC sent back on a bad pull." action={<Link href="/stats" className="font-display text-accent hover:underline">All receipts →</Link>} />
    <div className="no-scrollbar -mx-4 flex snap-x scroll-px-4 gap-4 overflow-x-auto px-4 pb-3 pt-1 sm:-mx-6 sm:scroll-px-6 sm:px-6">
      {pulls.slice(0, 14).map(p => <PullCard key={p.id} pull={p} className="w-[128px] shrink-0 snap-start sm:w-[150px]" />)}
    </div>
  </section>;
}
