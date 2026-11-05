import { useEffect, useState } from 'react';
import { ArrowUpRight, Flame } from 'lucide-react';
import type { PoolView } from '../../../shared/types';
import { ago, api, money, pct, short, solscan } from '../api';
import { useApp } from '../app';
import { PageHead, SectionTitle, TypeBadge, packStyle } from '../ui';

const BLOCKS = 20;

/** The vault: the public USDC every rebate is paid from, and where it came from and went. */
export function PoolPage() {
  const { config, version } = useApp();
  const [pool, setPool] = useState<PoolView | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const load = () => api<PoolView>('/pool').then(p => { setPool(p); setFailed(false); }).catch(() => setFailed(true));
    load(); const id = setInterval(() => { if (!document.hidden) load(); }, 15_000); return () => clearInterval(id);
  }, [version]);
  if (!pool) return <div className="font-display py-24 text-center text-2xl text-muted">{failed ? <>The vault could not be loaded. <button className="text-accent underline" onClick={() => location.reload()}>Try again</button></> : 'Opening the vault…'}</div>;

  const t = pool.totals, total = Math.max(pool.balanceUsd, 0.01);
  const held = pool.reservedUsd, owed = Math.min(pool.queuedUsd, Math.max(0, pool.freeUsd)), ready = Math.max(0, pool.freeUsd - pool.queuedUsd);
  // Each block of the meter is one twentieth of the vault, colored by what that money is for.
  const counts = [held, owed].map(v => Math.round(v / total * BLOCKS));
  const blocks = Array.from({ length: BLOCKS }, (_, i) => i < counts[0] ? 'bg-spark' : i < counts[0] + counts[1] ? 'bg-info' : 'bg-gain');
  const target: number = config?.settings?.offsite?.targetReserveUsd ?? 0;
  const filledBy = [['Creator fees', t.creatorFeesUsd, 'bg-spark'], ['Protection fees', t.feeShareUsd, 'bg-info']] as const;
  const paidOut = [['Rebates on Regrade packs', t.onsiteRebatesUsd, 'bg-gain'], ['Off-site claims', t.offsiteRebatesUsd, 'bg-gain/60'], ...(t.networkFeesUsd > 0 ? [['Solana network fees', t.networkFeesUsd, 'bg-faint'] as const] : [])] as const;
  const inTotal = filledBy.reduce((s, r) => s + r[1], 0), outTotal = paidOut.reduce((s, r) => s + r[1], 0), max = Math.max(0.01, inTotal, outTotal);

  return <>
    <PageHead kicker="Rebate vault" title="The vault." sub="Every rebate is paid from this USDC. It sits in a public wallet, so you can check it whenever you like." action={pool.poolAddress ? <a className="font-display num inline-flex items-center gap-1.5 text-xs hover:text-accent" href={solscan('account', pool.poolAddress)} target="_blank" rel="noreferrer">Vault wallet {short(pool.poolAddress)}<ArrowUpRight size={13} /></a> : undefined} />
    <section className="pb-16">
      <div className="card p-6 sm:p-8">
        <div className="label">In the vault</div>
        <div className="font-display num mt-2 break-all text-6xl font-bold leading-none tracking-tight sm:text-7xl">{money(pool.balanceUsd)}</div>
        <div className="mt-6 grid gap-1" style={{ gridTemplateColumns: `repeat(${BLOCKS}, minmax(0, 1fr))` }} role="img" aria-label="How the vault's money is used">
          {blocks.map((c, i) => <span key={i} className={`h-4 rounded-full ${c}`} />)}
        </div>
        <dl className="mt-5 grid gap-2.5 text-sm">
          <Row color="bg-spark" label="Held for packs opening now" value={money(held)} />
          <Row color="bg-info" label="Owed to off-site claims" value={money(owed)} />
          <Row color="bg-gain" label="Ready for rebates" value={money(ready)} />
        </dl>
        <div className="mt-5 flex items-center justify-between gap-4 border-t border-line pt-4">
          <span className="text-sm text-muted">Vault level{target > 0 && <span className="block text-xs text-faint">Off-site claims pay in full above {money(target)}</span>}</span>
          <span className="font-display num text-3xl">{pct(pool.healthBps)}</span>
        </div>
      </div>
    </section>

    <section className="pb-14">
      <SectionTitle title="Ins & outs" sub="Everything that has gone into the vault and everything paid out of it." />
      <div className="card grid gap-px overflow-hidden bg-line md:grid-cols-2">
        <Flow title="Filled by" total={inTotal} rows={filledBy} max={max} />
        <Flow title="Paid out" total={outTotal} rows={paidOut} max={max} />
      </div>
      <div className="mt-3 flex justify-end gap-2 text-sm"><span className="text-muted">Net since launch</span><span className={`font-display num ${inTotal - outTotal >= 0 ? 'text-gain' : 'text-loss'}`}>{inTotal - outTotal >= 0 ? '+' : '−'}{money(Math.abs(inTotal - outTotal))}</span></div>
    </section>

    <section className="grid grid-cols-1 gap-4 pb-14 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <div className="card min-w-0 p-5 sm:p-6">
        <SectionTitle title="Pack ledger" sub="Payout ratio is what a pack paid back ÷ what it put into the vault over the last 7 days. Fees are priced to keep it under 100%; a run of bad pulls can still push it over." />
        {pool.byPack.length ? <div className="-mx-5 overflow-x-auto px-5 sm:-mx-6 sm:px-6"><table className="w-full min-w-[460px] text-sm">
          <thead><tr className="text-left">{['Pack', 'Opened', 'Into vault', 'Paid back', 'Payout ratio'].map(h => <th key={h} className="label pb-2 font-normal">{h}</th>)}</tr></thead>
          <tbody>{pool.byPack.map(p => { const s = packStyle(p.code, p.priceUsd); return <tr key={p.code} className="border-t border-line">
            <td className="py-3"><span className="flex items-center gap-2"><TypeBadge code={p.code} priceUsd={p.priceUsd} size={22} /><span className="font-semibold">{s.name} {money(p.priceUsd)}</span>{p.paused && <span className="tag bg-loss-soft text-loss">paused</span>}</span></td>
            <td className="num">{p.packs}</td><td className="num">{money(p.feesToPoolUsd)}</td><td className="num">{money(p.rebatesUsd)}</td>
            <td><span className={`tag num ${p.lossRatioBps === null ? 'bg-raised text-muted' : p.lossRatioBps > 10_000 ? 'bg-loss-soft text-loss' : 'bg-gain-soft text-gain'}`}>{p.lossRatioBps === null ? '—' : pct(p.lossRatioBps)}</span></td>
          </tr>; })}</tbody>
        </table></div> : <p className="text-sm text-muted">No packs opened on Regrade yet.</p>}
      </div>

      <div className="card min-w-0 p-5 sm:p-6">
        <h2 className="font-display flex items-center gap-2.5 text-3xl"><Flame size={20} className="text-warn" />Token burn</h2>
        <p className="mt-1.5 text-sm text-muted">{config ? pct(10_000 - config.settings.poolShareBps) : 'Part'} of every protection fee buys the token on the market and burns it.</p>
        <div className="mt-5 grid grid-cols-2 gap-4">
          <div><div className="label">Burned</div><div className="font-display num mt-1 text-xl text-warn">{money(t.burnedUsd)}</div></div>
          <div><div className="label">Next burn</div><div className="font-display num mt-1 text-xl">{money(pool.burnBucketUsd)}</div></div>
        </div>
        <div className="mt-5 grid gap-2 text-sm">
          {pool.recentBurns.length ? pool.recentBurns.map(b => <div key={b.id} className="flex justify-between border-t border-line pt-2"><span className="font-display num">{money(b.usdcUsd)}</span>
            {b.signature ? <a className="text-muted hover:text-accent" href={solscan('tx', b.signature)} target="_blank" rel="noreferrer">{ago(b.createdAt)} <ArrowUpRight className="inline" size={12} /></a> : <span className="text-muted">{ago(b.createdAt)}</span>}</div>)
            : <p className="text-muted">No burns yet. A burn runs automatically once enough fees build up.</p>}
        </div>
      </div>
    </section>
  </>;
}

function Row({ color, label, value }: { color: string; label: string; value: string }) {
  return <div className="leader"><dt className="flex items-center gap-2 text-muted"><i className={`size-2.5 shrink-0 rounded-full ${color}`} />{label}</dt><dd className="font-display num">{value}</dd></div>;
}

function Flow({ title, total, rows, max }: { title: string; total: number; rows: readonly (readonly [string, number, string])[]; max: number }) {
  return <div className="bg-surface p-5 sm:p-6">
    <div className="flex items-baseline justify-between gap-3"><span className="label">{title}</span><span className="font-display num text-xl">{money(total)}</span></div>
    <div className="mt-5 grid gap-4">
      {rows.map(([label, value, color]) => <div key={label}>
        <div className="flex justify-between gap-3 text-sm"><span className="text-muted">{label}</span><span className="num">{money(value)}</span></div>
        <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-raised"><div className={`h-2 rounded-full ${color}`} style={{ width: `${value / max * 100}%` }} /></div>
      </div>)}
    </div>
  </div>;
}
