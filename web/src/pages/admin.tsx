import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Plus, Trash2 } from 'lucide-react';
import type { Settings } from '../../../shared/types';
import { requiredFeeBps } from '../../../shared/protection';
import { api, money, pct } from '../api';
import { useApp } from '../app';
import { Empty, SectionTitle, packStyle } from '../ui';

type Gas = { opsSol: number; poolSol: number; spentTodayUsd: number; opsReady: boolean };
type Admin = { settings: Settings; version: string; gas: Gas | null; blockers: string[]; problems: string[]; calibration: { generatedAt: string; samples: number; distributions: any[] } | null; review: any[]; jobs: any[]; audit: any[] };

export function AdminPage() {
  const { me, notify, connect, version } = useApp();
  const [data, setData] = useState<Admin | null>(null);
  const [form, setForm] = useState<Settings | null>(null);
  const load = () => api<Admin>('/admin').then(d => { setData(d); setForm(d.settings); }).catch(e => notify(e.message));
  useEffect(() => { if (me.owner) load(); }, [me.owner, version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!me.owner) return <div className="py-16"><Empty title="Owner access only" text="Sign in with the owner wallet to manage protection." action={<button className="btn btn-ink" onClick={connect}>Connect wallet</button>} /></div>;
  if (!data || !form) return <div className="py-20 text-center text-muted">Loading…</div>;

  const dirty = JSON.stringify(form) !== JSON.stringify(data.settings);
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setForm({ ...form, [key]: value });
  const tier = (i: number, patch: Partial<Settings['tiers'][number]>) => set('tiers', form.tiers.map((t, j) => j === i ? { ...t, ...patch } : t));
  const n = (v: string) => Number(v);
  async function save() { try { await api('/admin/settings', form, 'PATCH', { 'If-Match': data!.version }); notify('Settings saved.'); load(); } catch (e) { notify((e as Error).message); } }
  async function act(path: string, body: unknown, message: string) { try { await api(path, body); notify(message); load(); } catch (e) { notify((e as Error).message); } }

  return <div className="grid gap-6 py-10">
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div><div className="label">Owner</div><h1 className="mt-1 text-4xl font-bold tracking-tight">Control room</h1></div>
      <button className="btn btn-ghost" onClick={() => act('/admin/treasury/run', {}, 'Ran fee transfer, burn and creator-fee collection.')}>Run treasury tasks</button>
    </div>

    <div className="card p-6">
      <div className="label mb-3">Launch readiness</div>
      <ul className="grid gap-2 text-sm">
        {data.blockers.map(b => <li key={b} className="flex items-center gap-2"><AlertTriangle size={15} className="text-yellow" />{b}</li>)}
        {!data.blockers.length && <li className="flex items-center gap-2 text-grass"><CheckCircle2 size={15} />Ready for mainnet.</li>}
        {data.problems.map(p => <li key={p} className="flex items-start gap-2 text-red"><AlertTriangle size={15} className="mt-0.5 shrink-0" />{p}</li>)}
      </ul>
    </div>

    <Section title="Pricing" sub="The fee is added on top of the pack price. Part goes to the pool, the rest buys back and burns the token.">
      <div className="grid gap-4 sm:grid-cols-4">
        <Field label="Protection fee %"><input className="input num" type="number" step="0.5" value={form.feeBps / 100} onChange={e => set('feeBps', Math.round(n(e.target.value) * 100))} /></Field>
        <Field label="Fee to pool %" hint={`${pct(10_000 - form.poolShareBps)} to burn`}><input className="input num" type="number" step="5" value={form.poolShareBps / 100} onChange={e => set('poolShareBps', Math.round(n(e.target.value) * 100))} /></Field>
        <Field label="Max rebate / pack $"><input className="input num" type="number" value={form.maxRebateUsd} onChange={e => set('maxRebateUsd', n(e.target.value))} /></Field>
        <Field label="Creator fees / day $" hint="Subsidy the fee check counts on"><input className="input num" type="number" value={form.creatorFeeBudgetUsdPerDay} onChange={e => set('creatorFeeBudgetUsdPerDay', n(e.target.value))} /></Field>
      </div>
    </Section>

    <Section title="Holder tiers" sub="Coverage is the share of the loss paid back. Off-site must stay below on-site.">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead><tr className="text-left">{['Name', 'Min % of supply', 'On-site %', 'Off-site %', ''].map(h => <th key={h} className="label pb-2 pr-3 font-semibold">{h}</th>)}</tr></thead>
          <tbody>{form.tiers.map((t, i) => <tr key={i}>
            <td className="py-1 pr-3"><input className="input" value={t.name} onChange={e => tier(i, { name: e.target.value })} /></td>
            <td className="py-1 pr-3"><input className="input num" type="number" step="0.01" value={t.minSupplyPpm / 10_000} onChange={e => tier(i, { minSupplyPpm: Math.round(n(e.target.value) * 10_000) })} /></td>
            <td className="py-1 pr-3"><input className="input num" type="number" value={t.onsiteCoverageBps / 100} onChange={e => tier(i, { onsiteCoverageBps: Math.round(n(e.target.value) * 100) })} /></td>
            <td className="py-1 pr-3"><input className="input num" type="number" value={t.offsiteCoverageBps / 100} onChange={e => tier(i, { offsiteCoverageBps: Math.round(n(e.target.value) * 100) })} /></td>
            <td className="py-1"><button className="btn btn-ghost btn-sm px-2.5" aria-label={`Remove ${t.name}`} onClick={() => set('tiers', form.tiers.filter((_, j) => j !== i))}><Trash2 size={14} /></button></td>
          </tr>)}</tbody>
        </table>
      </div>
      <button className="btn btn-ghost btn-sm mt-3" onClick={() => set('tiers', [...form.tiers, { id: `t${Date.now() % 100_000}`, name: 'New tier', minSupplyPpm: 50_000, onsiteCoverageBps: 10_000, offsiteCoverageBps: 4_000 }])}><Plus size={14} />Add tier</button>
    </Section>

    <Section title="Off-site claims and limits">
      <div className="grid gap-4 sm:grid-cols-4">
        <Field label="Claims"><Toggle checked={form.offsite.enabled} onChange={v => set('offsite', { ...form.offsite, enabled: v })} label="Enabled" /></Field>
        <Field label="Claim window, days"><input className="input num" type="number" value={form.offsite.claimWindowDays} onChange={e => set('offsite', { ...form.offsite, claimWindowDays: n(e.target.value) })} /></Field>
        <Field label="Claims / wallet / day" hint="0 = no limit"><input className="input num" type="number" value={form.offsite.perWalletDailyClaims} onChange={e => set('offsite', { ...form.offsite, perWalletDailyClaims: n(e.target.value) })} /></Field>
        <Field label="Paid / wallet / day $" hint="0 = no limit"><input className="input num" type="number" value={form.offsite.perWalletDailyUsd} onChange={e => set('offsite', { ...form.offsite, perWalletDailyUsd: n(e.target.value) })} /></Field>
        <Field label="Paid / wallet / week $" hint="0 = no limit"><input className="input num" type="number" value={form.offsite.perWalletWeeklyUsd} onChange={e => set('offsite', { ...form.offsite, perWalletWeeklyUsd: n(e.target.value) })} /></Field>
        <Field label="Coverage delay, hours" hint="After first connect. 0 = right away"><input className="input num" type="number" value={form.offsiteActivationHours} onChange={e => set('offsiteActivationHours', n(e.target.value))} /></Field>
        <Field label="Pool paid / day, %" hint="All wallets. 0 = no limit"><input className="input num" type="number" step="0.5" value={form.offsite.dailyPoolBps / 100} onChange={e => set('offsite', { ...form.offsite, dailyPoolBps: Math.round(n(e.target.value) * 100) })} /></Field>
        <Field label="Reserve target $" hint="Off-site coverage shrinks below this"><input className="input num" type="number" value={form.offsite.targetReserveUsd} onChange={e => set('offsite', { ...form.offsite, targetReserveUsd: n(e.target.value) })} /></Field>
        <Field label="Off-site hold, hours"><input className="input num" type="number" value={form.offsiteHoldHours} onChange={e => set('offsiteHoldHours', n(e.target.value))} /></Field>
        <Field label="On-site hold, hours"><input className="input num" type="number" value={form.onsiteHoldHours} onChange={e => set('onsiteHoldHours', n(e.target.value))} /></Field>
        <Field label="Breaker: max loss ratio %"><input className="input num" type="number" value={form.breaker.lossRatioBps / 100} onChange={e => set('breaker', { ...form.breaker, lossRatioBps: Math.round(n(e.target.value) * 100) })} /></Field>
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <span className="label mr-2">Pack prices</span>
        {[25, 50, 100, 500].map(p => { const paused = form.pausedPrices.includes(p); return <button key={p} className={`chip h-8 border px-3 ${paused ? 'border-red bg-red-soft text-red' : 'border-line'}`} onClick={() => set('pausedPrices', paused ? form.pausedPrices.filter(x => x !== p) : [...form.pausedPrices, p].sort((a, b) => a - b))}>
          <i className="size-2 rounded-full" style={{ background: packStyle(p).top }} />${p} {paused ? 'paused' : 'live'}</button>; })}
        <span className="ml-auto"><Toggle checked={form.paused} onChange={v => set('paused', v)} label="Pause all spending" danger /></span>
      </div>
    </Section>

    <Section title="Network fees (SOL)" sub="OPS pays a small SOL fee for every pack it buys, card it sends and refund. POOL tops it up automatically, and buys SOL with a little USDC when it runs low itself.">
      {data.gas && <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <GasStat label="OPS wallet" sol={data.gas.opsSol} low={data.gas.opsSol < form.gas.opsMinSol} note={data.gas.opsReady ? undefined : 'Too low to open packs. New orders wait.'} />
        <GasStat label="POOL wallet" sol={data.gas.poolSol} low={data.gas.poolSol < form.gas.poolMinSol} note={data.gas.poolSol < form.gasReserveSol ? 'Send POOL some SOL by hand: it needs a little to pay for buying more.' : undefined} />
        <div><div className="label">USDC spent on SOL, 24h</div><div className="num mt-1 text-2xl font-semibold">{money(data.gas.spentTodayUsd)}</div><div className="text-xs text-muted">of {money(form.gas.maxUsdPerDay)} allowed</div></div>
      </div>}
      <div className="grid gap-4 sm:grid-cols-5">
        <Field label="Top up OPS below, SOL"><input className="input num" type="number" step="0.01" value={form.gas.opsMinSol} onChange={e => set('gas', { ...form.gas, opsMinSol: n(e.target.value) })} /></Field>
        <Field label="Refill OPS to, SOL"><input className="input num" type="number" step="0.01" value={form.gas.opsTargetSol} onChange={e => set('gas', { ...form.gas, opsTargetSol: n(e.target.value) })} /></Field>
        <Field label="POOL keeps, SOL" hint="Buys more below this"><input className="input num" type="number" step="0.01" value={form.gas.poolMinSol} onChange={e => set('gas', { ...form.gas, poolMinSol: n(e.target.value) })} /></Field>
        <Field label="Buy SOL with $"><input className="input num" type="number" value={form.gas.buyUsd} onChange={e => set('gas', { ...form.gas, buyUsd: n(e.target.value) })} /></Field>
        <Field label="Max $ a day" hint="0 = never buy"><input className="input num" type="number" value={form.gas.maxUsdPerDay} onChange={e => set('gas', { ...form.gas, maxUsdPerDay: n(e.target.value) })} /></Field>
      </div>
      <button className="btn btn-ghost btn-sm mt-4" onClick={() => act('/admin/gas/run', {}, 'Checked network fee balances.')}>Top up now</button>
    </Section>

    <Section title="Calibration" sub={data.calibration ? `${data.calibration.samples} real Collector Crypt pulls · ${new Date(data.calibration.generatedAt).toLocaleString()}. Fee needed at your pool share, no subsidy.` : undefined}>
      {data.calibration ? <div className="overflow-x-auto"><table className="w-full min-w-[560px] text-sm">
        <thead><tr className="text-left">{['Pack', 'Pulls', 'Avg value', 'Hit rate', 'Expected loss', ...form.tiers.map(t => `Fee for ${t.name}`)].map(h => <th key={h} className="label pb-2 font-semibold">{h}</th>)}</tr></thead>
        <tbody>{data.calibration.distributions.map(d => <tr key={d.priceUsd} className="num border-t border-line">
          <td className="py-2.5">{money(d.priceUsd)}</td><td>{d.n}</td><td>{(d.meanValueRatio * 100).toFixed(0)}%</td><td>{(d.hitRate * 100).toFixed(0)}%</td><td>{(d.expectedLossRatio * 100).toFixed(1)}%</td>
          {form.tiers.map(t => { const fee = requiredFeeBps(t.onsiteCoverageBps, d.expectedLossRatio, form.poolShareBps); return <td key={t.id} className={fee > form.feeBps ? 'text-red' : 'text-grass'}>{Number.isFinite(fee) ? pct(fee) : '∞'}</td>; })}
        </tr>)}</tbody>
      </table></div> : <p className="text-sm text-muted">No data yet. Run <code className="num rounded bg-bg px-1.5 py-0.5 text-ink">npm run calibrate</code> with a mainnet RPC to measure real pull values before choosing the fee.</p>}
    </Section>

    <Section title="Needs review">
      {data.review.length ? <div className="divide-y divide-line">{data.review.map(o => <div key={o.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
        <code className="num text-muted">{o.id.slice(0, 8)}</code><span className="flex-1">{o.error}</span>
        <button className="btn btn-ghost btn-sm" onClick={() => act(`/admin/orders/${o.id}/resolve`, { action: 'retry' }, 'Retrying.')}>Retry</button>
        <button className="btn btn-ghost btn-sm" onClick={() => act(`/admin/orders/${o.id}/resolve`, { action: 'refund' }, 'Refund queued.')}>Refund</button>
      </div>)}</div> : <p className="text-sm text-muted">Nothing stuck.</p>}
    </Section>

    <Section title="Audit log">
      <div className="max-h-80 overflow-auto text-xs">{data.audit.map(a => <div key={a.id} className="flex gap-3 border-t border-line py-2 first:border-0">
        <span className="num shrink-0 text-faint">{new Date(Number(a.created_at)).toLocaleString()}</span><b className="shrink-0">{a.event}</b><code className="num truncate text-muted">{JSON.stringify(a.data)}</code>
      </div>)}</div>
    </Section>

    {dirty && <div className="rise sticky bottom-5 z-30 mx-auto flex w-fit items-center gap-3 rounded-full bg-ink py-2 pl-5 pr-2 text-sm text-white shadow-xl">
      Unsaved changes<button className="btn btn-sm bg-white/10 text-white hover:bg-white/20" onClick={() => setForm(data.settings)}>Discard</button><button className="btn btn-red btn-sm" onClick={save}>Save</button>
    </div>}
  </div>;
}

function GasStat({ label, sol, low, note }: { label: string; sol: number; low: boolean; note?: string }) {
  return <div><div className="label">{label}</div><div className={`num mt-1 text-2xl font-semibold ${low ? 'text-red' : ''}`}>{sol.toFixed(4)} SOL</div>{note ? <div className="text-xs text-red">{note}</div> : <div className="text-xs text-muted">{low ? 'Low: top-up queued' : 'Healthy'}</div>}</div>;
}

function Section({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return <section className="card min-w-0 p-6"><SectionTitle title={title} sub={sub} />{children}</section>;
}
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="grid content-start gap-1.5"><span className="label">{label}</span>{children}{hint && <span className="text-xs text-muted">{hint}</span>}</label>;
}
function Toggle({ checked, onChange, label, danger }: { checked: boolean; onChange: (v: boolean) => void; label: string; danger?: boolean }) {
  return <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className="flex h-10 items-center gap-2.5 text-sm">
    <span className={`relative h-6 w-10 rounded-full transition ${checked ? (danger ? 'bg-red' : 'bg-grass') : 'bg-line'}`}><span className={`absolute top-1 size-4 rounded-full bg-white shadow transition-all ${checked ? 'left-5' : 'left-1'}`} /></span>{label}
  </button>;
}
