import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, Banknote, Check, Clock, Loader2 } from 'lucide-react';
import type { ClaimCandidate, Portfolio, PortfolioItem } from '../../../shared/types';
import { ago, api, friendly, money, solscan } from '../api';
import { Link, navigate, useApp } from '../app';
import { useCashOut, useOffers } from '../parts/cashout';
import { ShareButton } from '../parts/share';
import { Empty, PageHead, SectionTitle, TradingCard, Stat, isWatch, packStyle, useCount } from '../ui';

type Filter = 'all' | 'held' | 'sold' | 'claims';
const FILTERS: [Filter, string][] = [['all', 'All'], ['held', 'Held'], ['sold', 'Sold'], ['claims', 'Off-site']];
/** Collector Crypt buys a card back for 72 hours after the pull. */
const SELL_WINDOW_MS = 72 * 3_600_000;
/** Offers read at once, newest cards first. */
const MAX_OFFERS = 12;
/** One approval sells this many, the same as opening. */
const MAX_SELL = 5;

export function PortfolioPage() {
  const { me, config, connect, notify, version, bump } = useApp();
  const [data, setData] = useState<Portfolio | null>(null), [failed, setFailed] = useState(false);
  const [claimable, setClaimable] = useState<ClaimCandidate[] | null>(null), [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all'), [picked, setPicked] = useState<string[]>([]);
  const { cashOut, busy: selling } = useCashOut();
  const scan = useCallback(() => api<{ candidates: ClaimCandidate[] }>('/claims/scan').then(r => setClaimable(r.candidates.filter(c => c.eligible))).catch(() => setClaimable([])), []);
  useEffect(() => {
    if (!me.wallet) { setData(null); setClaimable(null); setPicked([]); return; }
    setFailed(false);
    api<Portfolio>('/portfolio').then(setData).catch(() => setFailed(true));
    void scan();
  }, [me.wallet, version, scan]);

  const fresh = useMemo(() => (data?.items ?? []).filter(i => i.source === 'onsite' && i.soldUsd === null && i.card && Date.now() - i.at < SELL_WINDOW_MS).slice(0, MAX_OFFERS).map(i => i.id), [data]);
  const offers = useOffers(fresh);
  const sellable = fresh.filter(id => offers?.[id]?.available && offers[id].amountUsd !== null);
  const shown = (data?.items ?? []).filter(i => filter === 'all' || (filter === 'held' ? i.soldUsd === null : filter === 'sold' ? i.soldUsd !== null : i.source === 'offsite'));
  const total = picked.reduce((sum, id) => sum + (offers?.[id]?.amountUsd ?? 0), 0);
  const net = useCount(data?.totals.netUsd ?? null);

  async function sell() {
    const sold = await cashOut(picked);
    if (sold.length) { setPicked([]); bump(); }
  }
  async function claim(c: ClaimCandidate) {
    setBusy(c.memo);
    try { await api(`/claims/${c.memo}`, { signature: c.signature }); notify('Claim approved. The rebate is on its way.'); await scan(); bump(); }
    catch (e) { notify(friendly(e as Error)); } finally { setBusy(null); }
  }
  const toggle = (id: string) => setPicked(p => p.includes(id) ? p.filter(x => x !== id) : p.length >= MAX_SELL ? p : [...p, id]);

  if (!me.wallet) return <><PageHead kicker="Portfolio" title="Everything you've pulled." sub="Every card, rebate and sale in one place, with how it all came out." /><Empty title="Connect to see your portfolio" text="It lists every pack this wallet opened here and every off-site claim that paid." action={<button className="btn btn-primary" onClick={connect}>Connect wallet</button>} /></>;
  if (failed && !data) return <div className="py-24 text-center text-muted">Your portfolio could not be loaded. <button className="text-accent underline" onClick={() => location.reload()}>Try again</button></div>;
  if (!data) return <div className="grid gap-4 py-16">{[0, 1].map(i => <div key={i} className="shimmer h-40 rounded-xl" />)}</div>;

  const t = data.totals, windowHours: number = config?.settings?.offsite?.claimWindowHours ?? 48;
  return <>
    <header className="enter grid items-end gap-8 pb-10 pt-10 md:grid-cols-[minmax(0,1fr)_auto] md:pt-16">
      <div>
        <div className="label">Portfolio · {t.pulls} pull{t.pulls === 1 ? '' : 's'}</div>
        <div className={`font-display num mt-3 text-6xl font-bold leading-none tracking-tight sm:text-7xl ${t.netUsd >= 0 ? 'text-gain' : 'text-ink'}`}>{t.netUsd >= 0 ? '+' : '−'}{money(Math.abs(Math.round(net * 100) / 100))}</div>
        <p className="mt-3 max-w-md text-sm text-muted">Net result: what your cards are worth or sold for, plus rebates, minus what you paid. Held cards count at their insured value.</p>
      </div>
    </header>
    <dl className="card grid grid-cols-2 gap-6 p-5 sm:grid-cols-4 sm:p-6">
      <Stat label="Spent on packs" value={money(t.spentUsd)} hint={t.feesUsd ? `+ ${money(t.feesUsd)} in fees` : undefined} />
      <Stat label="Rebates" value={`+${money(t.rebatesUsd)}`} tone="gain" />
      <Stat label="Sold" value={money(t.soldUsd)} />
      <Stat label="Still held" value={money(t.heldUsd)} hint={`${t.heldCards} card${t.heldCards === 1 ? '' : 's'}`} />
    </dl>

    {!!claimable?.length && <section className="pt-12">
      <SectionTitle title="Claim before it closes" sub={`Off-site packs that qualify for a rebate. Each one can be claimed for ${windowHours} hours after the pull.`} />
      <div className="card overflow-hidden px-5">{claimable.map(c => <Claimable key={c.memo} c={c} windowHours={windowHours} busy={busy === c.memo} onClaim={() => claim(c)} />)}</div>
    </section>}

    <section className="pt-12">
      <SectionTitle title="Your pulls" action={<div role="tablist" aria-label="Filter pulls" className="flex rounded-[10px] border border-line p-0.5">
        {FILTERS.map(([key, label]) => <button key={key} role="tab" aria-selected={filter === key} onClick={() => setFilter(key)} className={`font-display h-8 rounded-lg px-3 text-sm transition ${filter === key ? 'bg-accent text-on-accent' : 'text-muted hover:text-ink'}`}>{label}</button>)}
      </div>} />
      {shown.length ? <div className="grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-3 xl:grid-cols-4">
        {shown.map(i => <PullTile key={i.id} item={i} offer={offers?.[i.id]?.available ? offers[i.id].amountUsd : null} selectable={sellable.includes(i.id)} picked={picked.includes(i.id)} onPick={() => toggle(i.id)} />)}
      </div> : <Empty title={t.pulls ? 'Nothing here' : 'No pulls yet'} text={t.pulls ? 'No pulls match this filter.' : 'Open your first pack and it will show up here.'} action={t.pulls ? undefined : <Link href="/" className="btn btn-primary">See the packs</Link>} />}
      {sellable.length > 0 && <p className="mt-6 text-xs text-muted">Tick up to {MAX_SELL} cards to cash them out with one wallet approval. Collector Crypt buys a card back for 72 hours after the pull.</p>}
    </section>

    {picked.length > 0 && <div className="enter sticky bottom-[calc(1rem+env(safe-area-inset-bottom))] z-30 mx-auto mt-8 flex w-fit max-w-full items-center gap-4 rounded-xl border border-line bg-surface py-2 pl-5 pr-2 shadow-[var(--shadow-lift)] md:bottom-5">
      <span className="font-display text-sm">{picked.length} card{picked.length === 1 ? '' : 's'} · <span className="num text-gain">{money(total)}</span></span>
      <button className="btn btn-gain btn-sm" disabled={selling} onClick={sell}>{selling ? <Loader2 size={14} className="animate-spin" /> : <Banknote size={15} />}{selling ? 'Waiting for your wallet…' : 'Cash out'}</button>
    </div>}
  </>;
}

function PullTile({ item: i, offer, selectable, picked, onPick }: { item: PortfolioItem; offer: number | null | undefined; selectable: boolean; picked: boolean; onPick: () => void }) {
  const style = packStyle(i.code, i.priceUsd), onsite = i.source === 'onsite', name = i.card?.name ?? `${style.name} ${money(i.priceUsd)} pack`;
  const slab = <TradingCard size="sm" card={{ name, image: i.card?.image ?? null, insuredValueUsd: i.valueUsd, rarity: null }} priceUsd={i.priceUsd} watch={isWatch(i.code)} />;
  return <article className="group min-w-0">
    <div className="relative transition-transform duration-700 [transition-timing-function:var(--ease-weight)] group-hover:-translate-y-1">
      {onsite ? <button className="block w-full text-left" aria-label={`See ${name.split(' · ')[0]}`} onClick={() => navigate(`/pull/${i.id}`)}>{slab}</button> : slab}
      {selectable && <button role="checkbox" aria-checked={picked} aria-label={`Select ${name.split(' · ')[0]} to cash out`} onClick={onPick} className={`absolute right-2 top-2 z-[3] grid size-8 place-items-center rounded-lg shadow-[var(--shadow-soft)] ${picked ? 'bg-accent text-on-accent' : 'bg-white/90 text-transparent hover:text-slate-400'}`}><Check size={15} /></button>}
    </div>
    <div className="mt-2.5 min-w-0">
      <div className="truncate text-sm" title={name}>{name.split(' · ')[0]}</div>
      <div className="font-display num mt-0.5 flex items-baseline justify-between gap-2 text-xs"><span className="text-muted">{i.soldUsd !== null ? `Sold ${money(i.soldUsd)}` : `Worth ${money(i.valueUsd)}`}</span><span className={`font-medium ${i.netUsd >= 0 ? 'text-gain' : 'text-loss'}`}>{i.netUsd >= 0 ? '+' : '−'}{money(Math.abs(i.netUsd))}</span></div>
      <div className="mt-0.5 flex items-baseline justify-between gap-2 text-[11px] text-muted"><span className="truncate">{i.rebateUsd > 0 ? <span className="text-gain">+{money(i.rebateUsd)} rebate</span> : onsite ? `${money(i.priceUsd)} pack` : 'Off-site'}</span><span className="shrink-0 text-faint">{ago(i.at)}</span></div>
      {selectable && offer != null && <div className="font-display num mt-0.5 text-[11px] text-accent">Offer {money(offer)}</div>}
      {onsite && i.card && <div className="mt-1.5"><ShareButton id={i.id} className="inline-flex items-center gap-1 text-[11px] font-semibold text-muted hover:text-accent [&_svg]:size-3" /></div>}
    </div>
  </article>;
}

/** An off-site pull with its clock running. */
function Claimable({ c, windowHours, busy, onClaim }: { c: ClaimCandidate; windowHours: number; busy: boolean; onClaim: () => void }) {
  const left = useCountdown(c.pulledAt + windowHours * 3_600_000), style = packStyle(c.packCode, c.priceUsd), hurry = left < 6 * 3_600_000;
  return <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-line py-3.5 last:border-0">
    <div className="min-w-0 flex-1 basis-56">
      <div className="truncate text-sm font-semibold">{style.name} {money(c.priceUsd)} · {c.card?.name?.split(' · ')[0] ?? 'Graded card'}</div>
      <div className="font-display num text-xs text-muted">Worth {money(c.valueUsd)} · <a className="hover:text-accent" href={solscan('tx', c.signature)} target="_blank" rel="noreferrer">payment <ArrowUpRight size={11} className="inline" /></a></div>
    </div>
    <span className={`font-display num inline-flex items-center gap-1.5 text-xs ${hurry ? 'text-loss' : 'text-muted'}`}><Clock size={13} />{span(left)} left</span>
    <span className="font-display num text-2xl text-gain">+{money(c.rebateUsd)}</span>
    <button className="btn btn-primary btn-sm" disabled={busy} onClick={onClaim}>{busy && <Loader2 size={14} className="animate-spin" />}Claim</button>
  </div>;
}

const span = (ms: number) => { const m = Math.max(0, Math.floor(ms / 60_000)), h = Math.floor(m / 60); return h ? `${h}h ${m % 60}m` : `${m}m`; };
function useCountdown(end: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(id); }, []);
  return end - now;
}
