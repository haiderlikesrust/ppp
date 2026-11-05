import { useEffect, useState, type CSSProperties } from 'react';
import { ArrowUpRight, ShieldCheck } from 'lucide-react';
import type { HolderTier, Leaderboard, PackStats, SitePull, StatsView } from '../../../shared/types';
import { ago, api, money, pct, short, solscan } from '../api';
import { Link, useApp } from '../app';
import { PageHead, SectionTitle, TypeBadge, packStyle } from '../ui';
import { PullCard, useRebateTier, useRecentPulls, useSitePulls } from '../parts/pulls';

/** What Collector Crypt's packs really pay, who is on top this week, and the on-chain receipts behind every pack opened here. */
export function StatsPage() {
  return <>
    <PageHead kicker="Live from Collector Crypt" title="What packs really pay." sub="Pick a pack to see where its pulls land against the price you paid. It's all read from Collector Crypt's public feed." />
    <PackExplorer />
    <ThisWeek />
    <Receipts />
    <JustPulled />
    <p className="pb-4 text-xs text-faint">Regrade doesn't set the odds and never sees a pack before it opens. Insured values are Collector Crypt's at the moment of each pull, and sell-back prices come from what each machine pays.</p>
  </>;
}

/** One pack at a time: where its pulls land, and what each grade gets for it. */
function PackExplorer() {
  const [stats, setStats] = useState<StatsView | null>(null);
  const [failed, setFailed] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const { tiers } = useRebateTier(), { me } = useApp();
  const packs = stats?.packs.filter(p => p.n > 0) ?? [], read = packs.length > 0;
  useEffect(() => {
    let live = true;
    const load = () => api<StatsView>('/stats').then(s => { if (live) { setStats(s); setFailed(false); } }).catch(() => { if (live) setFailed(true); });
    load(); const id = setInterval(() => { if (!document.hidden) load(); }, read ? 60_000 : 10_000);
    return () => { live = false; clearInterval(id); };
  }, [read]);

  if (!read) return <section className="pb-16">{stats ? <div className="card p-6 text-sm text-muted">Reading Collector Crypt's latest pulls. Stats appear within a couple of minutes.</div>
    : failed ? <div className="card p-6 text-sm text-muted">Pack stats could not be loaded. They will retry shortly.</div> : <div className="card h-[30rem] animate-pulse" />}</section>;

  const p = packs.find(x => x.code === code) ?? packs[0], s = packStyle(p.code, p.priceUsd), hit = Math.round(p.hitRate * 100);
  return <section className="pb-16">
    <div role="tablist" aria-label="Pack" className="pack-tabs -mx-4 mb-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
      {packs.map(x => { const t = packStyle(x.code, x.priceUsd); return <button key={x.code} role="tab" aria-selected={x === p} onClick={() => setCode(x.code)} className="pack-tab" style={{ '--pack': t.color } as CSSProperties}>
        <TypeBadge code={x.code} priceUsd={x.priceUsd} size={26} />{t.name}<span className="num text-faint">{money(x.priceUsd)}</span>
      </button>; })}
    </div>
    <div role="tabpanel" className="card grid overflow-hidden lg:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
      <div className="min-w-0 p-5 sm:p-7">
        <h2 className="font-display text-2xl font-bold leading-tight tracking-tight sm:text-3xl"><span className="num">{hit}%</span> of {s.name} pulls sell back for the pack or more.</h2>
        <p className="mt-1.5 text-sm text-muted">The other {100 - hit}% sell for less, and that gap is what a rebate covers.</p>
        <Histogram key={p.code} p={p} />
      </div>
      <aside className="min-w-0 border-t border-line p-5 sm:p-7 lg:border-l lg:border-t-0">
        <dl className="grid gap-2.5 text-sm">
          <div className="leader"><dt className="text-muted">Median insured value</dt><dd className="font-display num">{money(p.medianUsd)}</dd></div>
          <div className="leader"><dt className="text-muted">Average insured value</dt><dd className="font-display num">{money(p.meanUsd)}</dd></div>
          <div className="leader"><dt className="text-muted">Middle 80% insured at</dt><dd className="font-display num">{money(p.p10Usd)}–{money(p.p90Usd)}</dd></div>
          <div className="leader"><dt className="text-muted">Sells back at</dt><dd className="font-display num">{pct(p.sellBps)} of insured</dd></div>
        </dl>
        {tiers.length > 0 && <Grades p={p} tiers={tiers} mine={me.holder?.tier ?? null} />}
        {p.best?.card && <div className="mt-6 flex items-center gap-3 border-t border-line pt-5">
          <img src={p.best.card.image} alt={p.best.card.name} loading="lazy" referrerPolicy="no-referrer" className="h-14 w-[34px] shrink-0 rounded-md object-cover" />
          <div className="min-w-0 flex-1"><div className="label">Best in 7 days</div><div className="truncate text-sm" title={p.best.card.name}>{p.best.card.name.split(' · ')[0]}</div></div>
          <div className="shrink-0 text-right"><div className="font-display num text-gain">{money(p.best.valueUsd)}</div><div className="num text-[11px] text-muted">{(p.best.valueUsd / p.priceUsd).toFixed(1)}× · {ago(p.best.at)}</div></div>
        </div>}
      </aside>
    </div>
    <p className="mt-3 text-xs text-faint">From {p.n.toLocaleString('en-US')} of this machine's latest pulls, refreshed every 2 minutes{stats?.updatedAt ? `, last ${ago(stats.updatedAt)}` : ''}. These same pulls set each pack's fee.</p>
  </section>;
}

const BINS_TO_PACK = 10;

/** Pulls by sell-back price, from $0 to twice the pack, split where the pack price falls. */
function Histogram({ p }: { p: PackStats }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const s = packStyle(p.code, p.priceUsd), step = p.priceUsd / BINS_TO_PACK, tallest = Math.max(1, ...p.bins), total = Math.max(1, p.bins.reduce((a, b) => a + b, 0));
  const share = (n: number) => `${(n / total * 100).toFixed(1)}%`;
  const range = (i: number) => i === p.bins.length - 1 ? `${money(step * i)} or more` : `${money(step * i)} to ${money(step * (i + 1))}`;
  const under = p.bins.slice(0, BINS_TO_PACK).reduce((a, b) => a + b, 0), over = total - under;
  const edge = hover === null ? '' : hover < 3 ? 'translate-x-0' : hover > 16 ? '-translate-x-full' : '-translate-x-1/2';
  return <figure className="mt-5">
    <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-1.5">
      <figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5"><i className="size-2.5 rounded-[3px] bg-chart-rest" />Sells under the pack <span className="num text-ink">{share(under)}</span></span>
        <span className="inline-flex items-center gap-1.5"><i className="size-2.5 rounded-[3px]" style={{ background: s.color }} />Sells for the pack or more <span className="num text-ink">{share(over)}</span></span>
      </figcaption>
      <button aria-pressed={table} onClick={() => setTable(v => !v)} className="text-xs text-muted hover:text-accent">{table ? 'Show chart' : 'Show as a table'}</button>
    </div>
    {table ? <div className="mt-4 max-h-[17.5rem] overflow-y-auto"><table className="w-full text-sm">
      <thead><tr className="text-left">{['Sell-back price', 'Pulls', 'Share'].map(h => <th key={h} className="label bg-surface pb-2 font-normal">{h}</th>)}</tr></thead>
      <tbody>{p.bins.map((n, i) => <tr key={i} className="border-t border-line"><td className="num py-1.5">{range(i)}</td><td className="num">{n.toLocaleString('en-US')}</td><td className="num">{share(n)}</td></tr>)}</tbody>
    </table></div> : <>
      <div className="relative mt-9">
        <span className="absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap text-xs text-muted">Pack price <span className="num text-ink">{money(p.priceUsd)}</span></span>
        <div className="hist" role="img" aria-label={`${s.name} pulls by sell-back price. ${share(under)} sell under the pack price of ${money(p.priceUsd)}, ${share(over)} sell for it or more.`} onMouseLeave={() => setHover(null)}>
          {p.bins.map((n, i) => <div key={i} className="hist-slot" onMouseEnter={() => setHover(i)}>
            <i className="hist-bar" style={{ height: n ? `max(2px, ${n / tallest * 100}%)` : 0, background: i < BINS_TO_PACK ? 'var(--color-chart-rest)' : s.color, animationDelay: `${i * 14}ms` }} />
          </div>)}
        </div>
        <i className="pointer-events-none absolute bottom-0 left-1/2 top-0 -translate-x-1/2 border-l-[1.5px] border-dashed border-ink" />
        {hover !== null && <div className={`hist-tip ${edge}`} style={{ left: `${(hover + 0.5) / p.bins.length * 100}%` }}>
          <div className="font-display num whitespace-nowrap">{range(hover)}</div>
          <div className="num whitespace-nowrap opacity-75">{p.bins[hover].toLocaleString('en-US')} pulls · {share(p.bins[hover])}</div>
        </div>}
      </div>
      <div className="num relative mt-2 flex justify-between text-xs text-faint"><span>$0</span><span>{money(p.priceUsd * 2)}+</span></div>
    </>}
  </figure>;
}

function Grades({ p, tiers, mine }: { p: PackStats; tiers: HolderTier[]; mine: HolderTier | null }) {
  return <table className="mt-6 w-full text-sm">
    <thead><tr className="text-left">{['Grade', 'Fee', 'Coverage', 'Avg back'].map((h, i) => <th key={h} className={`label pb-2 font-normal ${i ? 'text-right' : ''}`}>{h}</th>)}</tr></thead>
    <tbody>{tiers.map(t => { const terms = p.terms[t.id]; return <tr key={t.id} className={`border-t border-line ${mine?.id === t.id ? 'bg-accent-soft' : ''}`}>
      <td className="truncate py-2.5">{t.name}{mine?.id === t.id && <span className="tag ml-2 bg-ink text-paper">You</span>}</td>
      <td className="num text-right">{terms ? pct(terms.feeBps) : '—'}</td>
      <td className="num text-right">{terms ? pct(terms.coverageBps) : '—'}</td>
      <td className="font-display num text-right text-gain">+{money(p.avgRebateUsd[t.id] ?? 0)}</td>
    </tr>; })}</tbody>
  </table>;
}

/** "in 3d 4h" until `end`. */
function until(end: number) {
  const ms = Math.max(0, end - Date.now()), d = Math.floor(ms / 86_400_000), h = Math.floor(ms % 86_400_000 / 3_600_000), m = Math.floor(ms % 3_600_000 / 60_000);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

const BOARDS = [['hits', 'Biggest hit'], ['packs', 'Most packs'], ['rebates', 'Biggest rebate']] as const;
type BoardKey = typeof BOARDS[number][0];
/** One place on a board, whichever board it came from. */
type Place = { wallet: string; you: boolean; image: string | null; code: string | null; priceUsd: number | undefined; sub: string; value: string; note: string; gain: boolean };

function places(board: Leaderboard, kind: BoardKey): Place[] {
  if (kind === 'hits') return board.hits.map(r => ({ wallet: r.wallet, you: r.you, image: r.card?.image ?? null, code: r.code, priceUsd: r.priceUsd, sub: r.card?.name.split(' · ')[0] ?? `${packStyle(r.code, r.priceUsd).name} ${money(r.priceUsd)}`, value: money(r.valueUsd), note: `${(r.valueUsd / r.priceUsd).toFixed(1)}× a ${money(r.priceUsd)} pack`, gain: true }));
  if (kind === 'packs') return board.packs.map(r => ({ wallet: r.wallet, you: r.you, image: null, code: null, priceUsd: undefined, sub: `${money(r.spentUsd)} in packs`, value: `${r.packs}`, note: r.packs === 1 ? 'pack' : 'packs', gain: false }));
  return board.rebates.map(r => ({ wallet: r.wallet, you: r.you, image: null, code: r.code, priceUsd: r.priceUsd, sub: `${r.source === 'onsite' ? (r.cardName?.split(' · ')[0] ?? 'Opened here') : 'Off-site claim'} · ${money(r.priceUsd)} pack`, value: `+${money(r.rebateUsd)}`, note: `card ${money(r.valueUsd)}`, gain: true }));
}

function ThisWeek() {
  const { me, version } = useApp();
  const [week, setWeek] = useState<'current' | 'last'>('current');
  const [kind, setKind] = useState<BoardKey>('hits');
  const [board, setBoard] = useState<Leaderboard | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setBoard(null); }, [week]);
  useEffect(() => {
    let live = true;
    const load = () => api<Leaderboard>(`/leaderboard?week=${week}`).then(b => { if (live) { setBoard(b); setFailed(false); } }).catch(() => { if (live) setFailed(true); });
    load(); const id = setInterval(() => { if (!document.hidden && week === 'current') load(); }, 30_000);
    return () => { live = false; clearInterval(id); };
  }, [week, me.wallet, version]);

  const rows = board ? places(board, kind) : [], rest = rows.slice(3);
  const sub = week === 'current' ? `Packs opened and rebates paid on Regrade. Resets Monday 00:00 UTC${board ? `, in ${until(board.end)}` : ''}.` : 'Final standings for last week.';
  return <section className="pb-16">
    <SectionTitle title={week === 'current' ? 'This week' : 'Last week'} sub={sub} action={<div role="tablist" aria-label="Week" className="flex rounded-[11px] border border-line p-0.5">
      {(['current', 'last'] as const).map(w => <button key={w} role="tab" aria-selected={week === w} onClick={() => setWeek(w)} className={`font-display h-8 rounded-lg px-3 text-sm transition ${week === w ? 'bg-accent text-on-accent' : 'text-muted hover:text-ink'}`}>{w === 'current' ? 'This week' : 'Last week'}</button>)}
    </div>} />
    <div role="tablist" aria-label="Board" className="mb-3 flex gap-5 border-b border-line">
      {BOARDS.map(([key, label]) => <button key={key} role="tab" aria-selected={kind === key} onClick={() => setKind(key)} className="board-tab">{label}</button>)}
    </div>
    {failed && !board ? <div className="card p-6 text-sm text-muted">The leaderboard could not be loaded. It will retry shortly.</div> : <div className={`grid gap-6 ${rest.length ? 'lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]' : ''}`}>
      <div className="grid grid-cols-1 items-end gap-3 pt-3 sm:grid-cols-3">{[1, 0, 2].map(i => <Step key={i} place={rows[i]} rank={i + 1} loading={!board} />)}</div>
      {rest.length > 0 && <ol className="min-w-0 self-end">{rest.map((r, i) => <li key={i} className={`flex items-center gap-3 border-b border-line px-1 py-2.5 ${r.you ? 'bg-accent-soft' : ''}`}>
        <span className="font-display num w-5 shrink-0 text-right text-sm text-faint">{i + 4}</span>
        <div className="min-w-0 flex-1"><div className="num truncate text-sm">{r.wallet}{r.you && ' · you'}</div><div className="truncate text-xs text-muted">{r.sub}</div></div>
        <div className="shrink-0 text-right"><div className={`font-display num text-sm ${r.gain ? 'text-gain' : ''}`}>{r.value}</div><div className="num text-[11px] text-faint">{r.note}</div></div>
      </li>)}</ol>}
    </div>}
  </section>;
}

const STEP = [
  { order: 'order-1 sm:order-2', height: 'sm:h-28', tone: 'bg-spark text-[#1a1500]' },
  { order: 'order-2 sm:order-1', height: 'sm:h-[4.5rem]', tone: 'bg-raised text-muted' },
  { order: 'order-3', height: 'sm:h-12', tone: 'bg-raised text-muted' },
];

/** One place on the podium, standing on its step. An open place invites someone to take it. */
function Step({ place, rank, loading }: { place: Place | undefined; rank: number; loading: boolean }) {
  const s = STEP[rank - 1];
  return <div className={`flex min-w-0 flex-row-reverse items-center gap-3 sm:block sm:text-center ${s.order}`}>
    <div className="min-w-0 flex-1 sm:px-2 sm:pb-3">
      {loading ? <div className="shimmer mx-auto h-20 w-full max-w-[9rem] rounded-lg" />
        : place ? <>
          {place.image ? <img src={place.image} alt="" loading="lazy" referrerPolicy="no-referrer" className="hidden h-24 w-[58px] rounded-lg object-cover sm:mx-auto sm:mb-2 sm:block" />
            : place.code ? <span className="hidden sm:mb-2 sm:inline-block"><TypeBadge code={place.code} priceUsd={place.priceUsd} size={40} /></span> : null}
          <div className={`font-display num text-2xl leading-none ${place.gain ? 'text-gain' : ''}`}>{place.value}<span className="ml-1 text-xs text-faint">{place.gain ? '' : place.note}</span></div>
          <div className="mt-1.5 truncate text-sm" title={place.sub}>{place.sub}</div>
          <div className="num truncate text-xs text-muted">{place.wallet}{place.you && ' · you'}</div>
        </> : rank === 1 ? <div className="text-sm text-muted">Nobody yet. <Link href="/" className="text-accent hover:underline">Open a pack</Link> to take it.</div> : <div className="text-sm text-faint">Open</div>}
    </div>
    <div className={`font-display grid size-11 shrink-0 place-items-center rounded-[11px] text-xl sm:w-full sm:rounded-b-none sm:rounded-t-[11px] sm:text-2xl ${s.height} ${s.tone}`}>{rank}</div>
  </div>;
}

/** What each transaction of a Regrade pack is, in the order they happen. */
const TXS = [
  ['payment', 'Paid', "The buyer's USDC payment"],
  ['pack', 'Pack', 'Regrade buying the pack on Collector Crypt'],
  ['card', 'Card', "The card sent to the buyer's wallet"],
  ['rebate', 'Rebate', 'The rebate paid from the vault'],
  ['sale', 'Sold', 'The card sold back to Collector Crypt'],
] as const;

/** Every pack opened on Regrade, each with the transactions behind it, so anyone can check it on Solscan. */
function Receipts() {
  const pulls = useSitePulls(), { config } = useApp();
  const [all, setAll] = useState(false);
  const wallets = ([['Treasury', config?.opsAddress], ['Vault', config?.poolAddress]] as const).filter(([, address]) => address);
  return <section className="pb-16">
    <SectionTitle title="Receipts" sub="Every pack opened on Regrade, with the transactions behind it." action={<span className="tag bg-gain-soft text-gain"><ShieldCheck size={12} />On-chain</span>} />
    {pulls === null ? <div className="grid gap-px">{[0, 1, 2].map(i => <div key={i} className="shimmer h-12 rounded" />)}</div>
      : pulls.length ? <>
        <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-sm">
          <thead><tr className="border-b border-line text-left">{['Card', 'Buyer', 'Result', 'Proof', ''].map((h, i) => <th key={i} className="label pb-2 pr-4 font-normal">{h}</th>)}</tr></thead>
          <tbody>{pulls.slice(0, all ? pulls.length : 6).map(p => <Receipt key={p.id} pull={p} />)}</tbody>
        </table></div>
        {pulls.length > 6 && <button className="font-semibold mt-3 text-sm text-muted hover:text-accent" onClick={() => setAll(v => !v)}>{all ? 'Show less' : `Show all ${pulls.length}`}</button>}
      </> : <div className="border-y border-line py-10 text-center text-sm text-muted">No packs opened here yet. <Link href="/" className="text-accent hover:underline">Open the first one</Link>.</div>}
    {wallets.length > 0 && <p className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
      <span>Packs are bought from our treasury wallet. Rebates are paid from the vault.</span>
      {wallets.map(([label, address]) => <a key={label} href={solscan('account', address!)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-accent">{label} <span className="num">{short(address!)}</span><ArrowUpRight size={12} /></a>)}
    </p>}
  </section>;
}

function Receipt({ pull: p }: { pull: SitePull }) {
  const s = packStyle(p.code, p.priceUsd), [title] = (p.card?.name ?? 'Graded card').split(' · ');
  const hit = p.rebateUsd === 0 && (p.sellUsd ?? p.valueUsd) >= p.priceUsd;
  return <tr className="border-b border-line">
    <td className="max-w-[16rem] py-2.5 pr-4"><Link href={`/pull/${p.id}`} className="group flex min-w-0 items-center gap-2.5">
      <TypeBadge code={p.code} priceUsd={p.priceUsd} size={24} />
      <span className="min-w-0"><span className="block truncate group-hover:text-accent" title={p.card?.name}>{title}</span><span className="num block truncate text-xs text-muted">{s.name} {money(p.priceUsd)} · insured {money(p.valueUsd)}</span></span>
    </Link></td>
    <td className="num whitespace-nowrap pr-4 text-xs text-muted">{p.wallet}</td>
    <td className="whitespace-nowrap pr-4">{p.rebateUsd > 0 ? <span className="font-display num text-gain">+{money(p.rebateUsd)}</span> : hit ? <span className="tag bg-ink text-paper">Hit</span> : <span className="text-faint">—</span>}</td>
    <td className="pr-4"><div className="flex flex-wrap gap-x-2.5 gap-y-0.5 text-xs">
      {TXS.filter(([key]) => p.txs[key]).map(([key, label, about]) => <a key={key} href={solscan('tx', p.txs[key]!)} target="_blank" rel="noreferrer" title={about} className="inline-flex items-center gap-0.5 whitespace-nowrap text-muted hover:text-accent">{key === 'sale' && p.soldUsd !== null ? `${label} ${money(p.soldUsd)}` : label}<ArrowUpRight size={11} /></a>)}
      {p.mint && <a href={solscan('token', p.mint)} target="_blank" rel="noreferrer" title="The card's NFT" className="inline-flex items-center gap-0.5 whitespace-nowrap text-muted hover:text-accent">NFT<ArrowUpRight size={11} /></a>}
    </div></td>
    <td className="num whitespace-nowrap text-right text-xs text-faint">{ago(p.at)}</td>
  </tr>;
}

function JustPulled() {
  const pulls = useRecentPulls(), { tier, mine } = useRebateTier();
  return <section className="pb-12">
    <SectionTitle title="Just pulled" sub={`The newest pulls on Collector Crypt, updated every 30 seconds.${tier ? ` Green is what ${mine ? 'your grade' : tier.name} gets back at full coverage when it's opened on Regrade.` : ''}`} />
    {pulls === null ? <div className="flex gap-4 overflow-hidden">{Array.from({ length: 7 }, (_, i) => <div key={i} className="shimmer aspect-[3/5] w-40 shrink-0 rounded-lg" />)}</div>
      : pulls.length ? <div className="pull-strip" tabIndex={0} role="region" aria-label="Recent pulls, scroll sideways for more">{pulls.map(p => <PullCard key={p.id} pull={p} className="w-40 shrink-0 snap-start" />)}</div>
      : <div className="border-y border-line py-10 text-center text-sm text-muted">Waiting for Collector Crypt's feed. New pulls show up here within a couple of minutes.</div>}
  </section>;
}
