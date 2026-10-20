import { useEffect, useState } from 'react';
import { ArrowUpRight, Flame } from 'lucide-react';
import type { PoolView } from '../../../shared/types';
import { ago, api, money, pct, short, solscan } from '../api';
import { useApp } from '../app';
import { SectionTitle, Stat, packStyle } from '../ui';

/** Public transparency page: everything here can be checked on-chain. */
export function PoolPage() {
  const { config, notify, version } = useApp();
  const [pool, setPool] = useState<PoolView | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const load = () => api<PoolView>('/pool').then(p => { setPool(p); setFailed(false); }).catch(() => setFailed(true));
    load(); const id = setInterval(load, 15_000); return () => clearInterval(id);
  }, [notify, version]);
  if (!pool) return <div className="py-20 text-center text-muted">{failed ? <>The pool could not be loaded. <button className="font-semibold text-ink underline" onClick={() => location.reload()}>Try again</button></> : "Loading the pool…"}</div>;
  const t = pool.totals, total = Math.max(pool.balanceUsd, 0.01);
  const inflow = [['Creator fees', t.creatorFeesUsd, 'bg-yellow'], ['Pack protection fees', t.feeShareUsd, 'bg-blue']] as const;
  const outflow = [['Rebates on our packs', t.onsiteRebatesUsd, 'bg-grass'], ['Off-site claims', t.offsiteRebatesUsd, 'bg-grass/60']] as const;
  const flowMax = Math.max(0.01, ...inflow.map(x => x[1]), ...outflow.map(x => x[1]));

  return <>
    <section className="py-12 md:py-16">
      <div className="label">Protection pool</div>
      <div className="num mt-2 text-6xl font-semibold tracking-tight sm:text-7xl">{money(pool.balanceUsd)}</div>
      {pool.poolAddress && <a className="mt-2 inline-flex items-center gap-1 text-sm text-muted hover:text-ink" href={solscan('account', pool.poolAddress)} target="_blank" rel="noreferrer">USDC held by <span className="num">{short(pool.poolAddress)}</span><ArrowUpRight size={13} /></a>}

      <div className="mt-8 flex h-4 overflow-hidden rounded-full bg-line">
        <div className="bg-yellow" style={{ width: `${pool.reservedUsd / total * 100}%` }} title="Reserved" />
        <div className="bg-blue" style={{ width: `${Math.min(pool.queuedUsd, pool.freeUsd) / total * 100}%` }} title="Claims waiting" />
        <div className="bg-grass" style={{ width: `${Math.max(0, pool.freeUsd - pool.queuedUsd) / total * 100}%` }} title="Free" />
      </div>
      <div className="mt-6 grid grid-cols-2 gap-6 sm:grid-cols-4">
        <Legend color="bg-yellow" label="Reserved for open packs" value={money(pool.reservedUsd)} />
        <Legend color="bg-blue" label="Claims waiting" value={money(pool.queuedUsd)} />
        <Legend color="bg-grass" label="Free to pay out" value={money(pool.freeUsd - pool.queuedUsd)} />
        <div><div className="label">Health</div><div className="num mt-1 text-2xl font-semibold">{pct(pool.healthBps)}</div><div className="text-xs text-muted">Off-site coverage scales with this</div></div>
      </div>
    </section>

    <section className="grid gap-4 pb-14 md:grid-cols-2">
      <Flow title="Money in" rows={inflow} max={flowMax} />
      <Flow title="Money out" rows={outflow} max={flowMax} />
    </section>

    <section className="grid grid-cols-1 gap-4 pb-14 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <div className="card p-6">
        <SectionTitle title="By pack" sub="Loss ratio is rebates ÷ the pool's share of fees over 7 days. Above 100%, creator fees are covering the gap." />
        {pool.byPrice.length ? <div className="-mx-6 overflow-x-auto px-6"><table className="w-full min-w-[440px] text-sm">
          <thead><tr className="text-left">{['Pack', 'Opened', 'Fees in', 'Rebates', 'Loss ratio'].map(h => <th key={h} className="label pb-2 font-semibold">{h}</th>)}</tr></thead>
          <tbody>{pool.byPrice.map(p => <tr key={p.priceUsd} className="border-t border-line">
            <td className="py-3"><span className="flex items-center gap-2"><i className="size-2.5 rounded-full" style={{ background: packStyle(p.priceUsd).top }} /><span className="num">{money(p.priceUsd)}</span>{p.paused && <span className="chip bg-red-soft text-red">paused</span>}</span></td>
            <td className="num">{p.packs}</td><td className="num">{money(p.feesToPoolUsd)}</td><td className="num">{money(p.rebatesUsd)}</td>
            <td><span className={`chip num ${p.lossRatioBps === null ? 'bg-bg text-muted' : p.lossRatioBps > 10_000 ? 'bg-red-soft text-red' : 'bg-grass-soft text-grass'}`}>{p.lossRatioBps === null ? '—' : pct(p.lossRatioBps)}</span></td>
          </tr>)}</tbody>
        </table></div> : <p className="text-sm text-muted">No protected packs opened yet.</p>}
      </div>
      <div className="card p-6">
        <div className="flex items-center gap-2"><Flame size={18} className="text-red" /><h2 className="text-2xl font-semibold tracking-tight">Buyback & burn</h2></div>
        <p className="mt-1 text-sm text-muted">{config ? pct(10_000 - config.settings.poolShareBps) : 'Part'} of every protection fee buys the token back and burns it.</p>
        <div className="mt-5 grid grid-cols-2 gap-4"><Stat label="Burned so far" value={money(t.burnedUsd)} tone={t.burnedUsd > 0 ? 'red' : undefined} /><Stat label="Waiting to burn" value={money(pool.burnBucketUsd)} /></div>
        <div className="mt-5 grid gap-2 text-sm">
          {pool.recentBurns.length ? pool.recentBurns.map(b => <div key={b.id} className="flex justify-between border-t border-line pt-2"><span className="num">{money(b.usdcUsd)}</span>
            {b.signature ? <a className="text-muted hover:text-ink" href={solscan('tx', b.signature)} target="_blank" rel="noreferrer">{ago(b.createdAt)} <ArrowUpRight className="inline" size={12} /></a> : <span className="text-muted">{ago(b.createdAt)}</span>}</div>)
            : <p className="text-muted">No burns yet. They run automatically once enough fees build up.</p>}
        </div>
      </div>
    </section>
  </>;
}

function Legend({ color, label, value }: { color: string; label: string; value: string }) {
  return <div><div className="flex items-center gap-2"><i className={`size-2.5 rounded-full ${color}`} /><span className="label">{label}</span></div><div className="num mt-1 text-2xl font-semibold">{value}</div></div>;
}

function Flow({ title, rows, max }: { title: string; rows: readonly (readonly [string, number, string])[]; max: number }) {
  return <div className="card p-6">
    <div className="flex items-baseline justify-between"><h2 className="text-lg font-semibold">{title}</h2><span className="num text-lg font-semibold">{money(rows.reduce((s, r) => s + r[1], 0))}</span></div>
    <div className="mt-5 grid gap-4">
      {rows.map(([label, value, color]) => <div key={label}>
        <div className="flex justify-between text-sm"><span className="text-muted">{label}</span><span className="num">{money(value)}</span></div>
        <div className="mt-1.5 h-2 rounded-full bg-bg"><div className={`h-2 rounded-full ${color}`} style={{ width: `${value / max * 100}%` }} /></div>
      </div>)}
    </div>
  </div>;
}
