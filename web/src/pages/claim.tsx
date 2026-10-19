import { useCallback, useEffect, useState } from 'react';
import { ArrowUpRight, CalendarClock, Clock, Loader2, ScanSearch, Wallet } from 'lucide-react';
import type { ClaimCandidate } from '../../../shared/types';
import { ago, api, money, pct, solscan } from '../api';
import { useApp } from '../app';
import { CoverageLadder } from '../parts/holder';
import { Empty, SectionTitle, packStyle } from '../ui';

type Claim = { memo: string; status: string; priceUsd: number; valueUsd: number; rebateUsd: number; signature: string | null; createdAt: number };
const STATUS: Record<string, [string, string]> = { approved: ['Approved', 'bg-blue-soft text-blue'], paying: ['Paying', 'bg-blue-soft text-blue'], queued: ['Queued · cap reached', 'bg-yellow-soft text-ink'], paid: ['Paid', 'bg-grass-soft text-grass'] };

export function ClaimPage() {
  const { me, config, connect, notify, version } = useApp();
  const [candidates, setCandidates] = useState<ClaimCandidate[] | null>(null);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const scan = useCallback(async (quiet = false) => {
    if (!me.wallet) return;
    if (!quiet) setBusy('scan');
    try { const r = await api<{ candidates: ClaimCandidate[]; claims: Claim[] }>('/claims/scan'); setCandidates(r.candidates); setClaims(r.claims); }
    catch (e) { notify((e as Error).message); } finally { if (!quiet) setBusy(null); }
  }, [me.wallet, notify]);
  // Re-scan after practice tools change something, but only once the user has scanned.
  useEffect(() => { if (candidates) scan(true); }, [version]); // eslint-disable-line react-hooks/exhaustive-deps
  // Claims pay out within seconds; refresh while any are in flight.
  useEffect(() => {
    if (!claims.some(c => c.status !== 'paid')) return;
    const id = setInterval(() => scan(true), 4000); return () => clearInterval(id);
  }, [claims, scan]);

  async function claim(memo: string) {
    setBusy(memo);
    try { await api(`/claims/${memo}`, {}); notify('Claim approved. The rebate is on its way.'); await scan(true); }
    catch (e) { notify((e as Error).message); } finally { setBusy(null); }
  }

  const o = config?.settings?.offsite, activation: number = config?.settings?.offsiteActivationHours ?? 0;
  const dailyParts = [(o?.perWalletDailyClaims ?? 0) > 0 && `${o.perWalletDailyClaims} claim${o.perWalletDailyClaims > 1 ? 's' : ''}`, (o?.perWalletDailyUsd ?? 0) > 0 && `${money(o.perWalletDailyUsd)}`].filter(Boolean);
  const dailyLimit = dailyParts.length ? `Up to ${dailyParts.join(' and ')} a day` : 'No daily limit';
  const eligible = candidates?.filter(c => c.eligible) ?? [], other = candidates?.filter(c => !c.eligible) ?? [];
  return <>
    <section className="grid items-center gap-10 py-12 md:grid-cols-[1.1fr_1fr] md:py-16">
      <div className="rise">
        <span className="chip bg-blue-soft text-blue">Off-site claims</span>
        <h1 className="mt-5 text-4xl font-bold leading-[1] tracking-tight sm:text-5xl md:text-6xl">Opened a pack on<br /><span className="text-blue">Collector Crypt?</span></h1>
        <p className="mt-5 max-w-md text-lg text-muted">Scan your wallet. If a pull came in under the pack price, claim part of the difference back. You keep the card.</p>
        <button className="btn btn-red mt-8 h-12 px-6" onClick={() => me.wallet ? scan() : connect()} disabled={busy === 'scan'}>
          {busy === 'scan' ? <Loader2 className="animate-spin" size={17} /> : <ScanSearch size={17} />}{me.wallet ? 'Scan my wallet' : 'Connect to scan'}</button>
      </div>
      <div className="card grid gap-5 p-6 sm:p-8">
        <div className="label">The rules</div>
        {[[CalendarClock, `Pulls from the last ${o?.claimWindowDays ?? 7} days`, 'Paid for and delivered to this same wallet.'],
          activation > 0 ? [Clock, `Starts ${activation}h after you connect`, 'Your balance has to stay in tier through the pull.'] : [Clock, 'Covered right away', 'No waiting period. Hold a tier balance and claim the same day you connect.'],
          [Wallet, dailyLimit, `${(o?.perWalletWeeklyUsd ?? 0) > 0 ? `At most ${money(o.perWalletWeeklyUsd)} a week. ` : ''}Each pack can be claimed once, and off-site pays less than packs opened here.`]].map(([Icon, title, text], i) => {
          const I = Icon as typeof Clock;
          return <div key={i} className="flex gap-4"><span className="grid size-10 shrink-0 place-items-center rounded-full bg-bg"><I size={18} /></span><div><div className="font-semibold">{title as string}</div><div className="text-sm text-muted">{text as string}</div></div></div>;
        })}
      </div>
    </section>

    {candidates && <section className="pb-14">
      <SectionTitle title={eligible.length ? `${eligible.length} pull${eligible.length > 1 ? 's' : ''} you can claim` : 'Pulls found in your wallet'} sub={candidates.length ? `${candidates.length} Collector Crypt pack${candidates.length > 1 ? 's' : ''} in the last ${o?.claimWindowDays ?? 7} days.` : undefined} />
      {candidates.length ? <div className="grid gap-3">
        {[...eligible, ...other].map(c => <ClaimRow key={c.memo} c={c} busy={busy === c.memo} onClaim={() => claim(c.memo)} />)}
      </div> : <Empty title="No pack payments found" text="This wallet has no Collector Crypt pack purchases in the claim window. Packs bought from another wallet have to be claimed from that wallet." />}
    </section>}

    {claims.length > 0 && <section className="pb-14">
      <SectionTitle title="Your claims" />
      <div className="card divide-y divide-line">
        {claims.map(c => <div key={c.memo} className="flex flex-wrap items-center gap-x-5 gap-y-1 px-5 py-3.5 text-sm">
          <span className="size-2.5 rounded-full" style={{ background: packStyle(c.priceUsd).top }} />
          <span className="num">{money(c.priceUsd)} pack</span><span className="num text-muted">worth {money(c.valueUsd)}</span>
          <span className="flex-1" />
          <span className="num font-semibold text-grass">+{money(c.rebateUsd)}</span>
          <span className={`chip ${STATUS[c.status]?.[1] ?? 'bg-bg'}`}>{STATUS[c.status]?.[0] ?? c.status}</span>
          {c.signature && <a className="text-xs text-muted hover:text-ink" href={solscan('tx', c.signature)} target="_blank" rel="noreferrer">Payout <ArrowUpRight className="inline" size={12} /></a>}
        </div>)}
      </div>
    </section>}

    <section className="pb-8"><CoverageLadder mode="offsite" /></section>
  </>;
}

function ClaimRow({ c, busy, onClaim }: { c: ClaimCandidate; busy: boolean; onClaim: () => void }) {
  const s = packStyle(c.priceUsd);
  return <div className={`card flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:gap-6 sm:px-5 ${c.eligible ? '' : 'opacity-75'}`}>
    <div className="flex min-w-0 flex-1 items-center gap-4">
    <div className="grid size-12 shrink-0 place-items-center rounded-2xl text-xs font-bold text-white" style={{ background: s.top }}>${c.priceUsd}</div>
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-baseline gap-x-3"><span className="font-semibold">{s.name} pack</span><span className="text-xs text-faint">{ago(c.pulledAt)}</span>
        <a className="text-xs text-muted hover:text-ink" href={solscan('tx', c.signature)} target="_blank" rel="noreferrer">payment <ArrowUpRight className="inline" size={11} /></a></div>
      <div className="mt-0.5 text-sm text-muted">{c.valueUsd !== null ? <>Card worth <span className="num text-ink">{money(c.valueUsd)}</span>{c.valueUsd < c.priceUsd && <> · <span className="num text-red">−{money(c.priceUsd - c.valueUsd)}</span></>}</> : 'Card value unknown'}{!c.eligible && c.reason && !c.claim && <> · {c.reason}</>}</div>
    </div>
    </div>
    {c.eligible ? <div className="flex items-center justify-between gap-4 border-t border-line pt-3 sm:border-0 sm:pt-0">
      <div className="sm:text-right"><div className="num text-xl font-semibold text-grass">+{money(c.rebateUsd)}</div><div className="text-xs text-muted">{pct(c.coverageBps)} of the loss</div></div>
      <button className="btn btn-red" disabled={busy} onClick={onClaim}>{busy && <Loader2 className="animate-spin" size={15} />}Claim</button>
    </div> : c.claim ? <span className={`chip ${STATUS[c.claim.status]?.[1] ?? 'bg-bg'}`}>{STATUS[c.claim.status]?.[0] ?? c.claim.status} · {money(c.claim.rebateUsd)}</span> : null}
  </div>;
}
