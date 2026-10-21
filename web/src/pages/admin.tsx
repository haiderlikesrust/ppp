import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Plus, Trash2 } from 'lucide-react';
import type { Settings } from '../../../shared/types';
import { requiredFeeBps } from '../../../shared/protection';
import { PACK_CATALOG } from '../../../shared/packs';
import { api, money, pct } from '../api';
import { useApp } from '../app';
import { Empty, SectionTitle, packStyle } from '../ui';

type Gas = { opsSol: number; poolSol: number; spentTodayUsd: number; opsReady: boolean; opsUsdcAccount: boolean; poolUsdcAccount: boolean };
type Admin = { settings: Settings; version: string; gas: Gas | null; blockers: string[]; problems: string[]; calibration: { generatedAt: string; samples: number; distributions: any[] } | null; review: any[]; delayed: any[]; jobs: any[]; audit: any[] };

export function AdminPage() {
  const { me, notify, connect, version } = useApp();
  const [data, setData] = useState<Admin | null>(null);
  const [form, setForm] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  // Reloading after an action keeps any unsaved edits; only a fresh load or a save resets the form.
  const load = (resetForm = true) => api<Admin>('/admin').then(d => { setData(d); if (resetForm) setForm(d.settings); }).catch(e => notify(e.message));
  useEffect(() => { if (me.owner) load(); }, [me.owner, version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!me.owner) return <div className="py-16"><Empty title="Owner access only" text="Sign in with the owner wallet to manage protection." action={<button className="btn btn-primary" onClick={connect}>Connect wallet</button>} /></div>;
  if (!data || !form) return <div className="py-20 text-center text-muted">Loading…</div>;

  const dirty = JSON.stringify(form) !== JSON.stringify(data.settings);
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setForm({ ...form, [key]: value });
  const tier = (i: number, patch: Partial<Settings['tiers'][number]>) => set('tiers', form.tiers.map((t, j) => j === i ? { ...t, ...patch } : t));
  const n = (v: string) => Number(v);
  async function save() {
    if (saving) return;
    setSaving(true);
    try { await api('/admin/settings', form, 'PATCH', { 'If-Match': data!.version }); notify('Settings saved.'); await load(); } catch (e) { notify((e as Error).message); } finally { setSaving(false); }
  }
  async function act(path: string, body: unknown, message: string) { try { await api(path, body); notify(message); await load(false); } catch (e) { notify((e as Error).message); } }

  return <div className="grid gap-6 py-10">
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div><div className="label">Owner</div><h1 className="pixel mt-1 text-4xl sm:text-5xl">CONTROL ROOM</h1></div>
      <button className="btn btn-outline" onClick={() => act('/admin/treasury/run', {}, 'Ran fee transfer, burn and creator-fee collection.')}>Run treasury tasks</button>
    </div>

    <div className="card p-6">
      <div className="label mb-3">Launch readiness</div>
      <ul className="grid gap-2 text-sm">
        {data.blockers.map(b => <li key={b} className="flex items-center gap-2"><AlertTriangle size={15} className="text-volt" />{b}</li>)}
        {!data.blockers.length && <li className="flex items-center gap-2 text-gain"><CheckCircle2 size={15} />Ready for mainnet.</li>}
        {data.problems.map(p => <li key={p} className="flex items-start gap-2 text-loss"><AlertTriangle size={15} className="mt-0.5 shrink-0" />{p}</li>)}
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
            <td className="py-1"><button className="btn btn-outline btn-sm px-2.5" aria-label={`Remove ${t.name}`} onClick={() => set('tiers', form.tiers.filter((_, j) => j !== i))}><Trash2 size={14} /></button></td>
          </tr>)}</tbody>
        </table>
      </div>
      <button className="btn btn-outline btn-sm mt-3" onClick={() => set('tiers', [...form.tiers, { id: `t${Date.now() % 100_000}`, name: 'New tier', minSupplyPpm: 50_000, onsiteCoverageBps: 10_000, offsiteCoverageBps: 4_000 }])}><Plus size={14} />Add tier</button>
    </Section>

    <Section title="Tier exceptions" sub="Wallets that get a tier on packs opened here whatever they hold. A wallet holding enough for a better tier gets that one. Off-site claims still go by holdings. Rebates to these wallets come from the vault like any other.">
      {form.walletTiers.length > 0 && <div className="grid gap-2">{form.walletTiers.map((e, i) => <div key={i} className="flex flex-wrap items-center gap-2">
        <input className="input num min-w-0 flex-1 basis-72" placeholder="Wallet address" spellCheck={false} value={e.wallet} onChange={ev => set('walletTiers', form.walletTiers.map((x, j) => j === i ? { ...x, wallet: ev.target.value.trim() } : x))} />
        <select className="input w-40" value={e.tierId} onChange={ev => set('walletTiers', form.walletTiers.map((x, j) => j === i ? { ...x, tierId: ev.target.value } : x))}>
          {form.tiers.map(t => <option key={t.id} value={t.id}>{t.name} · {t.onsiteCoverageBps / 100}%</option>)}
        </select>
        <button className="btn btn-outline btn-sm px-2.5" aria-label="Remove exception" onClick={() => set('walletTiers', form.walletTiers.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
      </div>)}</div>}
      <button className={`btn btn-outline btn-sm ${form.walletTiers.length ? 'mt-3' : ''}`} onClick={() => { const top = [...form.tiers].sort((a, b) => b.onsiteCoverageBps - a.onsiteCoverageBps)[0]; if (top) set('walletTiers', [...form.walletTiers, { wallet: '', tierId: top.id }]); }}><Plus size={14} />Add wallet</button>
    </Section>

    <Section title="Off-site claims and limits">
      <div className="grid gap-4 sm:grid-cols-4">
        <Field label="Claims"><Toggle checked={form.offsite.enabled} onChange={v => set('offsite', { ...form.offsite, enabled: v })} label="Enabled" /></Field>
        <Field label="Claim window, hours" hint="48 = pulls from the last two days"><input className="input num" type="number" value={form.offsite.claimWindowHours} onChange={e => set('offsite', { ...form.offsite, claimWindowHours: n(e.target.value) })} /></Field>
        <Field label="Claims / wallet / day" hint="0 = no limit"><input className="input num" type="number" value={form.offsite.perWalletDailyClaims} onChange={e => set('offsite', { ...form.offsite, perWalletDailyClaims: n(e.target.value) })} /></Field>
        <Field label="Paid / wallet / day $" hint="0 = no limit"><input className="input num" type="number" value={form.offsite.perWalletDailyUsd} onChange={e => set('offsite', { ...form.offsite, perWalletDailyUsd: n(e.target.value) })} /></Field>
        <Field label="Paid / wallet / week $" hint="0 = no limit"><input className="input num" type="number" value={form.offsite.perWalletWeeklyUsd} onChange={e => set('offsite', { ...form.offsite, perWalletWeeklyUsd: n(e.target.value) })} /></Field>
        <Field label="Coverage delay, hours" hint="After first connect. 0 = right away"><input className="input num" type="number" value={form.offsiteActivationHours} onChange={e => set('offsiteActivationHours', n(e.target.value))} /></Field>
        <Field label="Pool paid / day, %" hint="All wallets. 0 = no limit"><input className="input num" type="number" step="0.5" value={form.offsite.dailyPoolBps / 100} onChange={e => set('offsite', { ...form.offsite, dailyPoolBps: Math.round(n(e.target.value) * 100) })} /></Field>
        <Field label="Reserve target $" hint="Off-site coverage shrinks below this"><input className="input num" type="number" value={form.offsite.targetReserveUsd} onChange={e => set('offsite', { ...form.offsite, targetReserveUsd: n(e.target.value) })} /></Field>
        <Field label="Off-site hold, hours" hint="Held before the pull. 0 = owning it at the pull is enough"><input className="input num" type="number" value={form.offsiteHoldHours} onChange={e => set('offsiteHoldHours', n(e.target.value))} /></Field>
        <Field label="On-site hold, hours"><input className="input num" type="number" value={form.onsiteHoldHours} onChange={e => set('onsiteHoldHours', n(e.target.value))} /></Field>
        <Field label="Breaker: max loss ratio %"><input className="input num" type="number" value={form.breaker.lossRatioBps / 100} onChange={e => set('breaker', { ...form.breaker, lossRatioBps: Math.round(n(e.target.value) * 100) })} /></Field>
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <span className="label mr-2">Pack prices</span>
        {PACK_CATALOG.map(({ code, priceUsd }) => { const paused = form.pausedPacks.includes(code); return <button key={code} className={`tag h-8 border px-3 ${paused ? 'border-loss bg-loss-soft text-loss' : 'border-line'}`} onClick={() => set('pausedPacks', paused ? form.pausedPacks.filter(x => x !== code) : [...form.pausedPacks, code])}>
          <i className="size-2" style={{ background: packStyle(code, priceUsd).color }} />{packStyle(code, priceUsd).name} ${priceUsd} {paused ? 'paused' : 'live'}</button>; })}
        <span className="ml-auto"><Toggle checked={form.paused} onChange={v => set('paused', v)} label="Pause all spending" danger /></span>
      </div>
    </Section>

    <Section title="Creator fees" sub="Your coin's pump.fun creator fees are checked every second, claimed into POOL and sold for USDC. Big claims are sold in parts so the price is not pushed down too far.">
      <div className="grid gap-4 sm:grid-cols-4">
        <Field label="Claim once at least $" hint="0 = claim any amount"><input className="input num" type="number" step="0.5" value={form.creatorFeeMinUsd} onChange={e => set('creatorFeeMinUsd', n(e.target.value))} /></Field>
        <Field label="Max price impact %" hint="Larger claims are split"><input className="input num" type="number" step="0.5" value={form.maxPriceImpactBps / 100} onChange={e => set('maxPriceImpactBps', Math.round(n(e.target.value) * 100))} /></Field>
      </div>
    </Section>

    <Section title="Network fees (SOL)" sub="OPS pays a small SOL fee for every pack it buys, card it sends and refund. POOL tops it up automatically, and buys SOL with a little USDC when it runs low itself.">
      {data.gas && (!data.gas.opsUsdcAccount || !data.gas.poolUsdcAccount) && <p className="mb-4 flex items-start gap-2 text-sm text-loss"><AlertTriangle size={15} className="mt-0.5 shrink-0" />{[!data.gas.opsUsdcAccount && 'OPS', !data.gas.poolUsdcAccount && 'POOL'].filter(Boolean).join(' and ')} has no USDC account yet, so it can't receive USDC. It is created automatically once the wallet has a little SOL (press Top up now to retry). New orders wait until OPS has one.</p>}
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
      <button className="btn btn-outline btn-sm mt-4" onClick={() => act('/admin/gas/run', {}, 'Checked network fee balances.')}>Top up now</button>
    </Section>

    <Section title="Calibration" sub={data.calibration ? `${data.calibration.samples} real Collector Crypt pulls · ${new Date(data.calibration.generatedAt).toLocaleString()}. Fee needed at your pool share, no subsidy.` : undefined}>
      {data.calibration ? <div className="overflow-x-auto"><table className="w-full min-w-[560px] text-sm">
        <thead><tr className="text-left">{['Pack', 'Pulls', 'Avg value', 'Hit rate', 'Expected loss', ...form.tiers.map(t => `Fee for ${t.name}`)].map(h => <th key={h} className="label pb-2 font-semibold">{h}</th>)}</tr></thead>
        <tbody>{data.calibration.distributions.map(d => <tr key={d.priceUsd} className="num border-t border-line">
          <td className="py-2.5">{money(d.priceUsd)}</td><td>{d.n}</td><td>{(d.meanValueRatio * 100).toFixed(0)}%</td><td>{(d.hitRate * 100).toFixed(0)}%</td><td>{(d.expectedLossRatio * 100).toFixed(1)}%</td>
          {form.tiers.map(t => { const fee = requiredFeeBps(t.onsiteCoverageBps, d.expectedLossRatio, form.poolShareBps); return <td key={t.id} className={fee > form.feeBps ? 'text-loss' : 'text-gain'}>{Number.isFinite(fee) ? pct(fee) : '∞'}</td>; })}
        </tr>)}</tbody>
      </table></div> : <p className="text-sm text-muted">No data yet. Run <code className="num rounded bg-raised px-1.5 py-0.5 text-ink">npm run calibrate</code> with a mainnet RPC to measure real pull values before choosing the fee.</p>}
    </Section>

    <Section title="Delayed orders" sub="Paid orders that hit an error and are retrying on their own, waiting longer each time. After about 3 hours of failures they move to review.">
      {data.delayed.length ? <div className="divide-y divide-line">{data.delayed.map(o => <div key={o.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
        <code className="num text-muted">{o.id.slice(0, 8)}</code><span className="tag bg-volt-soft text-ink">{o.status}</span>
        <span className="num text-xs text-muted">{o.failures} attempt{o.failures === 1 ? '' : 's'}{Number(o.retry_at) > Date.now() ? ` · next in ${Math.ceil((Number(o.retry_at) - Date.now()) / 1000)}s` : ' · retrying now'}</span>
        <span className="min-w-0 flex-1 basis-64 break-words text-loss">{o.error}</span>
        <button className="btn btn-outline btn-sm" onClick={() => act(`/admin/orders/${o.id}/retry-now`, {}, 'Retrying on the next pass.')}>Retry now</button>
      </div>)}</div> : <p className="text-sm text-muted">Nothing delayed.</p>}
    </Section>

    <Section title="Needs review">
      {data.review.length ? <div className="divide-y divide-line">{data.review.map(o => <div key={o.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
        <code className="num text-muted">{o.id.slice(0, 8)}</code><span className="flex-1">{o.error}</span>
        <button className="btn btn-outline btn-sm" onClick={() => act(`/admin/orders/${o.id}/resolve`, { action: 'retry' }, 'Retrying.')}>Retry</button>
        <button className="btn btn-outline btn-sm" onClick={() => act(`/admin/orders/${o.id}/resolve`, { action: 'refund' }, 'Refund queued.')}>Refund</button>
      </div>)}</div> : <p className="text-sm text-muted">Nothing stuck.</p>}
    </Section>

    <Section title="Audit log">
      <div className="max-h-80 overflow-auto text-xs">{data.audit.map(a => <div key={a.id} className="flex gap-3 border-t border-line py-2 first:border-0">
        <span className="num shrink-0 text-faint">{new Date(Number(a.created_at)).toLocaleString()}</span><b className="shrink-0">{a.event}</b><code className="num truncate text-muted">{JSON.stringify(a.data)}</code>
      </div>)}</div>
    </Section>

    {dirty && <div className="enter sticky bottom-[calc(5rem+env(safe-area-inset-bottom))] z-30 mx-auto lg:bottom-5 flex w-fit items-center gap-3 rounded-lg border border-volt/40 bg-raised py-2 pl-5 pr-2 text-sm shadow-2xl">
      Unsaved changes<button className="btn btn-quiet btn-sm" disabled={saving} onClick={() => setForm(data.settings)}>Discard</button><button className="btn btn-primary btn-sm" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
    </div>}
  </div>;
}

function GasStat({ label, sol, low, note }: { label: string; sol: number; low: boolean; note?: string }) {
  return <div><div className="label">{label}</div><div className={`num mt-1 text-2xl font-semibold ${low ? 'text-loss' : ''}`}>{sol.toFixed(4)} SOL</div>{note ? <div className="text-xs text-loss">{note}</div> : <div className="text-xs text-muted">{low ? 'Low: top-up queued' : 'Healthy'}</div>}</div>;
}

function Section({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return <section className="card min-w-0 p-6"><SectionTitle title={title} sub={sub} />{children}</section>;
}
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="grid content-start gap-1.5"><span className="label">{label}</span>{children}{hint && <span className="text-xs text-muted">{hint}</span>}</label>;
}
function Toggle({ checked, onChange, label, danger }: { checked: boolean; onChange: (v: boolean) => void; label: string; danger?: boolean }) {
  return <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className="flex h-10 items-center gap-2.5 text-sm">
    <span className={`relative h-6 w-10 rounded-full transition ${checked ? (danger ? 'bg-loss' : 'bg-gain') : 'bg-line'}`}><span className={`absolute top-1 size-4 rounded-full bg-white shadow transition-all ${checked ? 'left-5' : 'left-1'}`} /></span>{label}
  </button>;
}
