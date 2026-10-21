import { useEffect, useState, type ReactNode } from 'react';
import { ArrowUpRight, Coins, Package, ShieldCheck, Trophy, type LucideIcon } from 'lucide-react';
import type { HolderTier, Leaderboard, PackStats, SitePull, StatsView } from '../../../shared/types';
import { packDef } from '../../../shared/packs';
import { ago, api, money, short, solscan } from '../api';
import { Link, useApp } from '../app';
import { Booster, SectionTitle, packStyle } from '../ui';
import { PullCard, useRebateTier, useRecentPulls, useSitePulls } from '../parts/pulls';

/** On-chain receipts for packs opened here, this week's Pullback leaderboards, and stats from Collector Crypt's own pull feed. */
export function StatsPage() {
  return <>
    <section className="enter py-12 md:py-16">
      <span className="tag bg-gain-soft text-gain"><i className="live-dot" />Live from Collector Crypt</span>
      <h1 className="pixel mt-5 text-4xl leading-none sm:text-6xl">PULL STATS</h1>
      <p className="mt-5 max-w-xl text-lg text-muted">Every pack opened on Pullback with its on-chain receipts, who is on top this week, and what Collector Crypt packs really pay out.</p>
    </section>
    <Receipts />
    <Leaderboards />
    <PackStatsSection />
    <RecentSection />
    <p className="text-xs text-faint">Card values are Collector Crypt's insured values at the moment of each pull, read from Collector Crypt's public feed. Pullback doesn't set the odds and never sees a pack before it opens.</p>
  </>;
}

/** "in 3d 4h" until `end`. */
function until(end: number) {
  const ms = Math.max(0, end - Date.now()), d = Math.floor(ms / 86_400_000), h = Math.floor(ms % 86_400_000 / 3_600_000), m = Math.floor(ms % 3_600_000 / 60_000);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

/** What each transaction of a Pullback pack is, in the order they happen. */
const TXS = [
  ['payment', 'Paid', "The buyer's USDC payment"],
  ['pack', 'Pack bought', 'Pullback buying the pack on Collector Crypt'],
  ['card', 'Card sent', "The card sent to the buyer's wallet"],
  ['rebate', 'Rebate', 'The rebate paid from the vault'],
  ['sale', 'Sold', 'The card sold back to Collector Crypt'],
] as const;

/** Every pack opened on Pullback, each with the transactions behind it, so anyone can check it on Solscan. */
function Receipts() {
  const pulls = useSitePulls(), { config } = useApp();
  const [all, setAll] = useState(false);
  const wallets = ([['Treasury', config?.opsAddress], ['Vault', config?.poolAddress]] as const).filter(([, address]) => address);
  return <section className="pb-14">
    <SectionTitle title="Receipts" sub="Every pack opened on Pullback, with the transactions behind it. Check any of them on Solscan." action={<span className="tag bg-gain-soft text-gain"><ShieldCheck size={12} />On-chain</span>} />
    {pulls === null ? <div className="card grid gap-3 p-5">{[0, 1, 2].map(i => <div key={i} className="h-14 animate-pulse rounded bg-raised" />)}</div>
      : pulls.length ? <div className="card overflow-hidden">
        {pulls.slice(0, all ? pulls.length : 6).map(p => <Receipt key={p.id} pull={p} />)}
        {pulls.length > 6 && <button className="pixel flex h-11 w-full items-center justify-center border-t border-line text-sm text-muted hover:bg-raised hover:text-ink" onClick={() => setAll(v => !v)}>{all ? 'Show less' : `Show all ${pulls.length}`}</button>}
      </div>
      : <div className="card px-5 py-10 text-center text-sm text-muted">No packs opened here yet. <Link href="/" className="text-volt hover:underline">Open the first one</Link>.</div>}
    {wallets.length > 0 && <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
      <span>Packs are bought from our treasury wallet. Rebates are paid from the vault.</span>
      {wallets.map(([label, address]) => <a key={label} href={solscan('account', address!)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-volt">{label} <span className="num">{short(address!)}</span><ArrowUpRight size={12} /></a>)}
    </p>}
  </section>;
}

function Receipt({ pull: p }: { pull: SitePull }) {
  const s = packStyle(p.code, p.priceUsd), [title] = (p.card?.name ?? 'Graded card').split(' · ');
  return <div className="flex gap-3 border-b border-line px-4 py-3 last:border-0 sm:px-5">
    {p.card?.image ? <img src={p.card.image} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-14 w-[34px] shrink-0 rounded-sm object-cover" /> : <i className="h-14 w-[34px] shrink-0 rounded-sm" style={{ background: s.color }} />}
    <div className="min-w-0 flex-1">
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-sm" title={p.card?.name}>{title}</span>
        {p.rebateUsd > 0 ? <span className="pixel num shrink-0 text-gain">+{money(p.rebateUsd)}</span> : p.valueUsd >= p.priceUsd ? <span className="tag shrink-0 bg-volt text-night">Hit</span> : null}
      </div>
      <div className="num text-xs text-muted">{p.wallet} · {money(p.priceUsd)} {s.name} pack · worth {money(p.valueUsd)} · {ago(p.at)}</div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {TXS.filter(([key]) => p.txs[key]).map(([key, label, about]) => <a key={key} href={solscan('tx', p.txs[key]!)} target="_blank" rel="noreferrer" title={about} className="inline-flex items-center gap-0.5 text-muted hover:text-volt">{key === 'sale' && p.soldUsd !== null ? `${label} ${money(p.soldUsd)}` : label}<ArrowUpRight size={12} /></a>)}
        {p.mint && <a href={solscan('token', p.mint)} target="_blank" rel="noreferrer" title="The card's NFT" className="inline-flex items-center gap-0.5 text-muted hover:text-volt">Card NFT<ArrowUpRight size={12} /></a>}
      </div>
    </div>
  </div>;
}

function Leaderboards() {
  const { me, version } = useApp();
  const [week, setWeek] = useState<'current' | 'last'>('current');
  const [board, setBoard] = useState<Leaderboard | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setBoard(null); }, [week]);
  useEffect(() => {
    let live = true;
    const load = () => api<Leaderboard>(`/leaderboard?week=${week}`).then(b => { if (live) { setBoard(b); setFailed(false); } }).catch(() => { if (live) setFailed(true); });
    load(); const id = setInterval(() => { if (!document.hidden && week === 'current') load(); }, 30_000);
    return () => { live = false; clearInterval(id); };
  }, [week, me.wallet, version]);

  const tabs = <div role="tablist" aria-label="Week" className="flex rounded-md border border-line bg-surface p-1">
    {(['current', 'last'] as const).map(w => <button key={w} role="tab" aria-selected={week === w} onClick={() => setWeek(w)} className={`pixel h-8 rounded px-3 text-xs ${week === w ? 'bg-volt text-night' : 'text-muted hover:text-ink'}`}>{w === 'current' ? 'This week' : 'Last week'}</button>)}
  </div>;
  const sub = week === 'current' ? `Packs opened and rebates paid on Pullback. Resets Monday 00:00 UTC${board ? `, in ${until(board.end)}` : ''}.` : 'Final standings for last week.';
  const empty = week === 'current' ? 'Nobody yet this week.' : 'Nobody last week.';

  return <section className="pb-14">
    <SectionTitle title="Leaderboard" sub={sub} action={tabs} />
    {failed && !board ? <div className="card p-6 text-sm text-muted">The leaderboard could not be loaded. It will retry shortly.</div> : <div className="grid gap-4 lg:grid-cols-3">
      <Board icon={Trophy} title="Biggest hit" note="Most valuable card pulled here" rows={board?.hits} empty={empty} render={r => <>
        {r.card?.image ? <img src={r.card.image} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-11 w-[27px] shrink-0 rounded-sm object-cover" /> : <i className="h-11 w-[27px] shrink-0 rounded-sm bg-raised" />}
        <Who wallet={r.wallet} you={r.you} sub={r.card?.name.split(' · ')[0] ?? `${packStyle(r.code, r.priceUsd).name} ${money(r.priceUsd)}`} />
        <Value main={money(r.valueUsd)} sub={`${(r.valueUsd / r.priceUsd).toFixed(1)}× a ${money(r.priceUsd)} pack`} tone="text-gain" />
      </>} />
      <Board icon={Package} title="Most packs opened" note="Packs opened on Pullback" rows={board?.packs} empty={empty} render={r => <>
        <Who wallet={r.wallet} you={r.you} sub={`${money(r.spentUsd)} in packs`} />
        <Value main={`${r.packs}`} sub={r.packs === 1 ? 'pack' : 'packs'} />
      </>} />
      <Board icon={Coins} title="Biggest rebate" note="Largest single payout" rows={board?.rebates} empty={empty} render={r => <>
        <Who wallet={r.wallet} you={r.you} sub={`${r.source === 'onsite' ? (r.cardName?.split(' · ')[0] ?? 'Opened here') : 'Off-site claim'} · ${money(r.priceUsd)} pack`} />
        <Value main={`+${money(r.rebateUsd)}`} sub={`card ${money(r.valueUsd)}`} tone="text-gain" />
      </>} />
    </div>}
  </section>;
}

/** One board: the top 5, with the rest of the top 10 a tap away. */
function Board<T>({ icon: Icon, title, note, rows, empty, render }: { icon: LucideIcon; title: string; note: string; rows: T[] | undefined; empty: string; render: (row: T) => ReactNode }) {
  const [all, setAll] = useState(false);
  return <div className="card min-w-0 overflow-hidden">
    <div className="border-b border-line bg-raised px-5 py-3"><div className="flex items-center gap-2.5"><Icon size={16} className="shrink-0 text-volt" /><span className="pixel whitespace-nowrap">{title}</span></div><div className="mt-0.5 truncate text-xs text-faint">{note}</div></div>
    {!rows ? <div className="grid gap-3 p-5">{[0, 1, 2].map(i => <div key={i} className="h-9 animate-pulse rounded bg-raised" />)}</div>
      : rows.length ? <><ol>{rows.slice(0, all ? rows.length : 5).map((r, i) => <li key={i} className={`flex min-w-0 items-center gap-3 border-b border-line px-5 py-3 last:border-0 ${(r as { you?: boolean }).you ? 'bg-volt/5' : ''}`}>
        <span className={`pixel num grid size-7 shrink-0 place-items-center rounded-sm text-xs ${i === 0 ? 'bg-volt text-night' : 'bg-raised text-muted'}`}>{i + 1}</span>
        {render(r)}
      </li>)}</ol>
        {rows.length > 5 && <button className="pixel flex h-10 w-full items-center justify-center border-t border-line text-xs text-muted hover:bg-raised hover:text-ink" onClick={() => setAll(v => !v)}>{all ? 'Show top 5' : `Show top ${rows.length}`}</button>}</>
      : <div className="px-5 py-10 text-center text-sm text-muted">{empty} <Link href="/" className="text-volt hover:underline">Open a pack</Link> to take #1.</div>}
  </div>;
}

function Who({ wallet, you, sub }: { wallet: string; you: boolean; sub: string }) {
  return <div className="min-w-0 flex-1">
    <div className="flex items-center gap-2"><span className="num truncate text-sm">{wallet}</span>{you && <span className="tag bg-volt text-night">You</span>}</div>
    <div className="truncate text-xs text-muted">{sub}</div>
  </div>;
}

function Value({ main, sub, tone = '' }: { main: string; sub: string; tone?: string }) {
  return <div className="shrink-0 text-right"><div className={`pixel num ${tone}`}>{main}</div><div className="num text-[11px] text-faint">{sub}</div></div>;
}

function PackStatsSection() {
  const [stats, setStats] = useState<StatsView | null>(null);
  const [failed, setFailed] = useState(false);
  const { tiers } = useRebateTier(), { me } = useApp();
  const read = !!stats?.packs.some(p => p.n > 0);
  useEffect(() => {
    let live = true;
    const load = () => api<StatsView>('/stats').then(s => { if (live) { setStats(s); setFailed(false); } }).catch(() => { if (live) setFailed(true); });
    load(); const id = setInterval(() => { if (!document.hidden) load(); }, read ? 60_000 : 10_000);
    return () => { live = false; clearInterval(id); };
  }, [read]);
  const groups = [['Pokémon machines', 'pokemon'], ['Watch machines', 'watch']] as const;

  return <section className="pb-14">
    <SectionTitle title="Pack stats" sub={`From each Collector Crypt machine's latest pulls (up to 5,000 per machine), refreshed every 2 minutes${stats?.updatedAt ? `, last ${ago(stats.updatedAt)}` : ''}. The same math sets our fees.`} />
    {!stats ? failed ? <div className="card p-6 text-sm text-muted">Pack stats could not be loaded. They will retry shortly.</div>
      : <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map(i => <div key={i} className="card h-96 animate-pulse" />)}</div>
      : !read ? <div className="card p-6 text-sm text-muted">Reading Collector Crypt's latest pulls. Stats appear within a couple of minutes.</div>
      : groups.map(([label, kind]) => {
        const list = stats.packs.filter(p => (packDef(p.code)?.kind ?? 'pokemon') === kind && p.n > 0);
        return list.length ? <div key={kind} className="mb-10 last:mb-0">
          <div className="label mb-4 flex items-center gap-2">{label}<span className="h-px flex-1 bg-line" /></div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{list.map(p => <PackStatCard key={p.code} p={p} tiers={tiers} mine={me.holder?.tier ?? null} />)}</div>
        </div> : null;
      })}
  </section>;
}

function PackStatCard({ p, tiers, mine }: { p: PackStats; tiers: HolderTier[]; mine: HolderTier | null }) {
  const s = packStyle(p.code, p.priceUsd);
  // The bar spans $0 to a little past the 90th percentile (or the pack price, if that is higher).
  const top = Math.max(p.p90Usd, p.priceUsd) * 1.12, at = (v: number) => Math.min(100, v / top * 100);
  return <div className="card flex min-w-0 flex-col p-5">
    <div className="flex items-center gap-4">
      <Booster code={p.code} priceUsd={p.priceUsd} className="w-16 shrink-0" />
      <div className="min-w-0">
        <div className="pixel text-lg">{s.name} {money(p.priceUsd)}</div>
        <div className="text-xs text-muted">{p.n.toLocaleString('en-US')} pulls{p.since ? ` · since ${ago(p.since)}` : ''}</div>
      </div>
    </div>

    <div className="mt-5 grid grid-cols-2 gap-4">
      <div><div className="label">Median card</div><div className="pixel num mt-1 text-2xl">{money(p.medianUsd)}</div><div className="text-xs text-muted">{Math.round(p.medianUsd / p.priceUsd * 100)}% of the pack</div></div>
      <div><div className="label">Hit rate</div><div className="pixel num mt-1 text-2xl text-gain">{Math.round(p.hitRate * 100)}%</div><div className="text-xs text-muted">worth the pack or more</div></div>
    </div>

    <div className="mt-5" role="img" aria-label={`Middle 80% of pulls worth ${money(p.p10Usd)} to ${money(p.p90Usd)}, median ${money(p.medianUsd)}, pack ${money(p.priceUsd)}`}>
      <div className="relative h-7">
        <div className="absolute inset-x-0 top-2.5 h-2 bg-raised" />
        <div className="absolute top-2.5 h-2" style={{ left: `${at(p.p10Usd)}%`, width: `${at(p.p90Usd) - at(p.p10Usd)}%`, background: s.color, opacity: 0.6 }} />
        <div className="absolute top-1 h-5 w-0.5 -translate-x-1/2 bg-ink" style={{ left: `${at(p.medianUsd)}%` }} />
        <div className="absolute top-0 h-7 -translate-x-1/2 border-l-2 border-dotted border-volt" style={{ left: `${at(p.priceUsd)}%` }} />
      </div>
      <div className="mt-1 flex justify-between gap-2 text-[11px]"><span className="text-muted">Middle 80%: <span className="num">{money(p.p10Usd)}–{money(p.p90Usd)}</span></span><span className="text-volt">┆ Pack {money(p.priceUsd)}</span></div>
    </div>

    <dl className="mt-4 grid gap-2 text-sm">
      <div className="leader"><dt className="text-muted">Average card</dt><dd className="pixel num">{money(p.meanUsd)}</dd></div>
      <div className="leader"><dt className="text-muted">Under the pack price</dt><dd className="pixel num text-loss">{Math.round((1 - p.hitRate) * 100)}%</dd></div>
    </dl>

    {tiers.length > 0 && <div className="mt-4 border-t border-line pt-4">
      <div className="label">Back per pack opened here, on average</div>
      <div className="mt-2 grid grid-cols-3 gap-2">{tiers.map(t => <div key={t.id} className={`min-w-0 rounded-md border px-2 py-1.5 text-center ${mine?.id === t.id ? 'border-volt bg-volt/5' : 'border-line'}`}>
        <div className="truncate text-[11px] text-muted">{t.name}{mine?.id === t.id ? ' · you' : ''}</div>
        <div className="pixel num text-sm text-gain">+{money(p.avgRebateUsd[t.id] ?? 0)}</div>
      </div>)}</div>
    </div>}

    {p.best?.card && <div className="mt-4 flex items-center gap-3 border-t border-line pt-4">
      <img src={p.best.card.image} alt={p.best.card.name} loading="lazy" referrerPolicy="no-referrer" className="h-14 w-[34px] shrink-0 rounded-sm object-cover" />
      <div className="min-w-0 flex-1"><div className="label">Best in 7 days</div><div className="truncate text-sm" title={p.best.card.name}>{p.best.card.name.split(' · ')[0]}</div></div>
      <div className="shrink-0 text-right"><div className="pixel num text-gain">{money(p.best.valueUsd)}</div><div className="num text-[11px] text-muted">{(p.best.valueUsd / p.priceUsd).toFixed(1)}× · {ago(p.best.at)}</div></div>
    </div>}
  </div>;
}

function RecentSection() {
  const pulls = useRecentPulls(), { tier, mine } = useRebateTier();
  return <section className="pb-14">
    <SectionTitle title="Recent pulls" sub={`The newest pulls on Collector Crypt, updated every 30 seconds.${tier ? ` Green is what ${mine ? 'your tier' : `a ${tier.name}`} gets back when it's opened on Pullback.` : ''}`} />
    {pulls === null ? <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">{Array.from({ length: 12 }, (_, i) => <div key={i} className="aspect-[3/5] animate-pulse rounded-lg bg-surface" />)}</div>
      : pulls.length ? <div className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 lg:grid-cols-6">{pulls.map(p => <PullCard key={p.id} pull={p} />)}</div>
      : <div className="card p-6 text-sm text-muted">Waiting for Collector Crypt's feed. New pulls show up here within a couple of minutes.</div>}
  </section>;
}
