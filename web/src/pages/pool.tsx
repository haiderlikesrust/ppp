import { useEffect, useState } from 'react';
import { ArrowUpRight, Flame } from 'lucide-react';
import type { PoolView } from '../../../shared/types';
import { ago, api, money, pct, short, solscan } from '../api';
import { useApp } from '../app';
import { PageHead, SectionTitle, TypeBadge, packStyle } from '../ui';

type Part = { label: string; value: number; color: string };
type Stream = { label: string; value: number; note?: string };

/** The vault: the public USDC every rebate is paid from, drawn as what flows in, what it holds, and what flows out. */
export function PoolPage() {
  const { config, version } = useApp();
  const [pool, setPool] = useState<PoolView | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const load = () => api<PoolView>('/pool').then(p => { setPool(p); setFailed(false); }).catch(() => setFailed(true));
    load(); const id = setInterval(() => { if (!document.hidden) load(); }, 15_000); return () => clearInterval(id);
  }, [version]);
  if (!pool) return <div className="font-display py-24 text-center text-2xl text-muted">{failed ? <>The vault could not be loaded. <button className="text-accent underline" onClick={() => location.reload()}>Try again</button></> : 'Opening the vault…'}</div>;

  const t = pool.totals, share = config?.settings.poolShareBps;
  const held = pool.reservedUsd, owed = Math.min(pool.queuedUsd, Math.max(0, pool.freeUsd)), ready = Math.max(0, pool.freeUsd - pool.queuedUsd);
  const parts: Part[] = [
    { label: 'Held for packs opening now', value: held, color: 'var(--color-chart-held)' },
    { label: 'Owed to off-site claims', value: owed, color: 'var(--color-chart-owed)' },
    { label: 'Ready for rebates', value: ready, color: 'var(--color-chart-out)' },
  ];
  const incoming: Stream[] = [{ label: 'Creator fees', value: t.creatorFeesUsd }, { label: 'Protection fees', value: t.feeShareUsd, note: share ? `${pct(share)} of every fee` : undefined }];
  const outgoing: Stream[] = [{ label: 'Rebates on packs', value: t.onsiteRebatesUsd }, { label: 'Off-site claims', value: t.offsiteRebatesUsd }, ...(t.networkFeesUsd > 0 ? [{ label: 'Network fees', value: t.networkFeesUsd }] : [])];
  const inTotal = incoming.reduce((s, r) => s + r.value, 0), outTotal = outgoing.reduce((s, r) => s + r.value, 0), net = inTotal - outTotal;
  const widest = Math.max(0.01, ...incoming.map(r => r.value), ...outgoing.map(r => r.value));

  return <>
    <PageHead kicker="Rebate vault" title="Where every dollar goes." sub="Every rebate is paid from this USDC. It sits in a public wallet, so you can check it whenever you like." action={pool.poolAddress ? <a className="font-display num inline-flex items-center gap-1.5 text-xs hover:text-accent" href={solscan('account', pool.poolAddress)} target="_blank" rel="noreferrer">Vault wallet {short(pool.poolAddress)}<ArrowUpRight size={13} /></a> : undefined} />
    <section className="pb-16">
      <div className="card overflow-hidden">
        <div className="hidden items-baseline justify-between gap-4 px-7 pt-6 md:flex">
          <Total label="Comes in" value={money(inTotal)} />
          <Total label="Net since launch" value={`${net >= 0 ? '+' : '−'}${money(Math.abs(net))}`} tone={net >= 0 ? 'text-gain' : 'text-loss'} center />
          <Total label="Goes out" value={money(outTotal)} end />
        </div>
        <div className="grid gap-y-5 p-5 sm:p-7 md:h-[22rem] md:grid-cols-[minmax(0,1fr)_minmax(3rem,9rem)_auto_minmax(3rem,9rem)_minmax(0,1fr)] md:gap-y-0 md:pt-3">
          <Streams title="Comes in" total={money(inTotal)} rows={incoming} side="in" />
          <Pipes rows={incoming} side="in" widest={widest} />
          <Drop className="flow-in" />
          <Balance parts={parts} total={pool.balanceUsd} />
          <Drop className="flow-out" />
          <Pipes rows={outgoing} side="out" widest={widest} />
          <Streams title="Goes out" total={money(outTotal)} rows={outgoing} side="out" />
        </div>
        <dl className="flex flex-wrap gap-x-8 gap-y-2 border-t border-line px-5 py-4 text-sm sm:px-7">
          {parts.map(p => <div key={p.label} className="flex items-center gap-2"><i className="size-2.5 shrink-0 rounded-[3px]" style={{ background: p.color }} /><dt className="text-muted">{p.label}</dt><dd className="font-display num">{money(p.value)}</dd></div>)}
        </dl>
        <Level ready={ready} healthBps={pool.healthBps} target={config?.settings?.offsite?.targetReserveUsd ?? 0} />
      </div>
    </section>
    <PackBalance rows={pool.byPack} />
    <Burn pool={pool} share={share} />
  </>;
}

function Total({ label, value, tone = '', center, end }: { label: string; value: string; tone?: string; center?: boolean; end?: boolean }) {
  return <div className={center ? 'text-center' : end ? 'text-right' : ''}><div className="label">{label}</div><div className={`font-display num text-lg ${tone}`}>{value}</div></div>;
}

function Streams({ title, total, rows, side }: { title: string; total: string; rows: Stream[]; side: 'in' | 'out' }) {
  return <div className="min-w-0 md:flex md:h-full md:flex-col md:justify-around">
    <div className="mb-3 flex items-baseline justify-between gap-3 md:hidden"><span className="label">{title}</span><span className="font-display num">{total}</span></div>
    {rows.map(r => <div key={r.label} className={`flex min-w-0 items-baseline justify-between gap-3 py-1 md:block md:py-0 ${side === 'in' ? 'md:text-right' : ''}`}>
      <div className="min-w-0 text-sm text-muted md:hidden">{r.label}</div>
      <div className="font-display num md:text-2xl">{money(r.value)}</div>
      <div className="hidden min-w-0 text-sm text-muted md:block">{r.label}{r.note && <span className="block text-xs text-faint">{r.note}</span>}</div>
    </div>)}
  </div>;
}

/** The curves between the streams and the balance. A curve's width is the amount, and its dots move the way the money does. */
function Pipes({ rows, side, widest }: { rows: Stream[]; side: 'in' | 'out'; widest: number }) {
  const color = side === 'in' ? 'var(--color-chart-in)' : 'var(--color-chart-out)';
  return <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" className="hidden h-full w-full overflow-visible md:block">
    {rows.map((r, i) => {
      const y = (i + 0.5) / rows.length * 100, c = 50 + (i - (rows.length - 1) / 2) * 7;
      const d = side === 'in' ? `M0 ${y} C55 ${y} 45 ${c} 100 ${c}` : `M0 ${c} C55 ${c} 45 ${y} 100 ${y}`;
      const width = 3 + 15 * r.value / widest;
      return <g key={r.label}>
        <path d={d} fill="none" stroke={r.value > 0 ? color : 'var(--color-line)'} strokeOpacity={r.value > 0 ? 0.26 : 1} strokeWidth={r.value > 0 ? width : 1.5} vectorEffect="non-scaling-stroke" />
        {r.value > 0 && <path d={d} className="flow-dash" stroke={color} strokeWidth={Math.max(3.5, width * 0.4)} vectorEffect="non-scaling-stroke" />}
      </g>;
    })}
  </svg>;
}

/** The same flow on a phone, where the page runs top to bottom. */
function Drop({ className }: { className: string }) {
  return <svg viewBox="0 0 4 32" aria-hidden="true" className={`mx-auto h-8 w-1 overflow-visible md:hidden ${className}`}><path d="M2 0V32" className="flow-dash" strokeWidth="3.5" /></svg>;
}

/** The vault's balance as a ring, split by what the money is for. Pointing at a slice names it in the middle. */
function Balance({ parts, total }: { parts: Part[]; total: number }) {
  const [active, setActive] = useState<Part | null>(null);
  const sum = parts.reduce((s, p) => s + p.value, 0), showing = active ?? { label: 'In the vault', value: total }, gap = parts.filter(p => p.value > 0).length > 1 ? 0.8 : 0;
  let at = 0;
  const text = money(showing.value);
  return <div className="relative mx-auto aspect-square w-56 self-center sm:w-60 md:mx-0 md:w-64" onMouseLeave={() => setActive(null)}>
    <svg viewBox="0 0 100 100" role="img" aria-label={`${money(total)} in the vault: ${parts.map(p => `${money(p.value)} ${p.label.toLowerCase()}`).join(', ')}`} className="size-full -rotate-90">
      <circle cx="50" cy="50" r="47" fill="none" stroke="var(--color-raised)" strokeWidth="6" />
      {sum > 0 && parts.map(p => {
        const length = p.value / sum * 100, drawn = Math.max(0, length - gap), offset = -at; at += length;
        return p.value > 0 ? <circle key={p.label} cx="50" cy="50" r="47" fill="none" pathLength={100} stroke={p.color} strokeWidth="6" strokeDasharray={`${drawn} ${100 - drawn}`} strokeDashoffset={offset} className="cursor-pointer" onMouseEnter={() => setActive(p)} /> : null;
      })}
    </svg>
    <div className="pointer-events-none absolute inset-0 grid place-content-center px-10 text-center">
      <div className="label">{showing.label}</div>
      <div className={`font-display num mt-1 font-bold leading-none tracking-tight ${text.length > 11 ? 'text-2xl' : 'text-4xl'}`}>{text}</div>
    </div>
  </div>;
}

/** How full the vault is against the level where off-site claims pay in full. */
function Level({ ready, healthBps, target }: { ready: number; healthBps: number; target: number }) {
  const scale = Math.max(target * 1.25, ready, 0.01), at = (v: number) => Math.min(100, v / scale * 100);
  return <div className="border-t border-line px-5 py-5 sm:px-7">
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <span className="flex items-baseline gap-3"><span className="font-semibold">Vault level</span><span className="font-display num text-2xl">{pct(healthBps)}</span></span>
      {target > 0 && <span className="text-sm text-muted">Off-site claims pay in full above <span className="num text-ink">{money(target)}</span></span>}
    </div>
    {target > 0 && <div className="relative mt-3 h-2.5 rounded-[4px] bg-raised" role="img" aria-label={`${money(ready)} ready, against a target of ${money(target)}`}>
      <div className="h-full rounded-[4px] bg-chart-out" style={{ width: `${at(ready)}%` }} />
      <i className="absolute -top-1 bottom-[-4px] w-0.5 -translate-x-1/2 bg-ink" style={{ left: `${at(target)}%` }} />
    </div>}
  </div>;
}

/** Each pack's money into the vault against what it paid back, on one shared scale from a centre line. */
function PackBalance({ rows }: { rows: PoolView['byPack'] }) {
  const widest = Math.max(0.01, ...rows.flatMap(p => [p.feesToPoolUsd, p.rebatesUsd]));
  const legend = <div className="flex gap-4 text-xs text-muted"><span className="inline-flex items-center gap-1.5"><i className="size-2.5 rounded-[3px] bg-chart-in" />Into the vault</span><span className="inline-flex items-center gap-1.5"><i className="size-2.5 rounded-[3px] bg-chart-out" />Paid back</span></div>;
  return <section className="pb-16">
    <SectionTitle title="Pack by pack" sub="What each pack put in against what it paid back over the last 7 days. Fees are priced to keep payouts under 100%, though a run of bad pulls can push one over." action={rows.length ? legend : undefined} />
    {rows.length ? <div className="card divide-y divide-line px-5 sm:px-7">{rows.map(p => {
      const s = packStyle(p.code, p.priceUsd), over = p.lossRatioBps !== null && p.lossRatioBps > 10_000;
      return <div key={p.code} className="grid grid-cols-2 items-center gap-x-0 gap-y-2 py-3.5 sm:grid-cols-[11.5rem_minmax(0,1fr)_minmax(0,1fr)_5rem]">
        <div className="flex min-w-0 items-center gap-2.5"><TypeBadge code={p.code} priceUsd={p.priceUsd} size={28} /><div className="min-w-0"><div className="font-semibold truncate text-sm">{s.name} {money(p.priceUsd)}</div><div className="num text-xs text-muted">{p.packs} opened{p.paused && ' · paused'}</div></div></div>
        <div className="justify-self-end sm:order-last"><span className={`tag num ${p.lossRatioBps === null ? 'bg-raised text-muted' : over ? 'bg-loss-soft text-loss' : 'bg-gain-soft text-gain'}`} title="Paid back as a share of what went in">{p.lossRatioBps === null ? '—' : pct(p.lossRatioBps)}</span></div>
        <div className="flex min-w-0 items-center gap-2 border-r border-ink/30 pr-0"><span className="font-display num w-[4.5rem] shrink-0 text-xs">{money(p.feesToPoolUsd)}</span><div className="flex min-w-0 flex-1 justify-end"><i className="block h-3 rounded-l-[4px] bg-chart-in" style={{ width: p.feesToPoolUsd > 0 ? `max(2px, ${p.feesToPoolUsd / widest * 100}%)` : 0 }} /></div></div>
        <div className="flex min-w-0 items-center gap-2"><div className="min-w-0 flex-1"><i className="block h-3 rounded-r-[4px] bg-chart-out" style={{ width: p.rebatesUsd > 0 ? `max(2px, ${p.rebatesUsd / widest * 100}%)` : 0 }} /></div><span className="font-display num w-[4.5rem] shrink-0 text-right text-xs">{money(p.rebatesUsd)}</span></div>
      </div>;
    })}</div> : <div className="border-y border-line py-10 text-center text-sm text-muted">No packs opened on Regrade yet.</div>}
  </section>;
}

function Burn({ pool, share }: { pool: PoolView; share: number | undefined }) {
  return <section className="pb-12"><div className="card flex flex-wrap items-center gap-x-8 gap-y-4 px-5 py-4 sm:px-7">
    <div className="flex min-w-0 flex-[1_1_18rem] items-center gap-3">
      <span className="grid size-10 shrink-0 place-items-center rounded-[11px] bg-warn-soft text-warn"><Flame size={20} /></span>
      <div className="min-w-0"><div className="font-semibold">Token burn</div><div className="text-sm text-muted">{share !== undefined ? pct(10_000 - share) : 'Part'} of every protection fee buys the token on the market and burns it.</div></div>
    </div>
    <div><div className="label">Burned</div><div className="font-display num text-xl">{money(pool.totals.burnedUsd)}</div></div>
    <div><div className="label">Next burn</div><div className="font-display num text-xl">{money(pool.burnBucketUsd)}</div></div>
    <div className="flex w-full flex-wrap gap-1.5">{pool.recentBurns.length ? pool.recentBurns.slice(0, 6).map(b => b.signature
      ? <a key={b.id} className="tag num bg-raised text-muted hover:text-accent" href={solscan('tx', b.signature)} target="_blank" rel="noreferrer">{money(b.usdcUsd)} · {ago(b.createdAt)}<ArrowUpRight size={11} /></a>
      : <span key={b.id} className="tag num bg-raised text-muted">{money(b.usdcUsd)} · {ago(b.createdAt)}</span>)
      : <span className="text-sm text-muted">No burns yet. One runs automatically once enough fees build up.</span>}</div>
  </div></section>;
}
