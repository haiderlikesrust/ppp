import { useCallback, useEffect, useState } from 'react';
import { ArrowUpRight, Loader2, ScanSearch } from 'lucide-react';
import type { ClaimCandidate } from '../../../shared/types';
import { windowLabel } from '../../../shared/protection';
import { ago, api, money, pct, short, solscan } from '../api';
import { useApp } from '../app';
import { CoverageLadder } from '../parts/holder';
import { SectionTitle, packStyle } from '../ui';

type Holding = { firstAt: number | null; complete: boolean; holds: boolean | null };
type Claim = { memo: string; status: string; priceUsd: number; valueUsd: number; rebateUsd: number; signature: string | null; createdAt: number };
const STATUS: Record<string, [string, string]> = {
  approved: ['Approved', 'bg-water/15 text-water'], paying: ['Paying', 'bg-water/15 text-water'], queued: ['Queued · limit reached', 'bg-volt-soft text-volt'],
  paid: ['Paid', 'bg-gain-soft text-gain'], rejected: ['Not paid · holdings dropped', 'bg-loss-soft text-loss'],
};
/** Claims that can still change; only these are refreshed. */
const MOVING = ['approved', 'paying', 'queued'];

export function ClaimPage() {
  const { me, config, connect, notify, version } = useApp();
  const [candidates, setCandidates] = useState<ClaimCandidate[] | null>(null);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [pasted, setPasted] = useState('');
  const [found, setFound] = useState<ClaimCandidate | null>(null);
  const [showOther, setShowOther] = useState(false);
  const [holding, setHolding] = useState<Holding | null>(null);

  const scan = useCallback(async (quiet = false) => {
    if (!me.wallet) return;
    if (!quiet) setBusy('scan');
    try { const r = await api<{ candidates: ClaimCandidate[]; claims: Claim[]; holding: Holding }>('/claims/scan'); setCandidates(r.candidates); setClaims(r.claims); setHolding(r.holding); }
    // Background refreshes stay quiet; only a scan the user asked for reports errors.
    catch (e) { if (!quiet) notify((e as Error).message); } finally { if (!quiet) setBusy(null); }
  }, [me.wallet, notify]);
  // Another wallet (or none) means the previous wallet's pulls must not stay on screen.
  useEffect(() => { setCandidates(null); setClaims([]); setFound(null); setHolding(null); }, [me.wallet]);
  // Re-scan after practice tools change something, but only once the user has scanned.
  useEffect(() => { if (candidates) scan(true); }, [version]); // eslint-disable-line react-hooks/exhaustive-deps
  // Refresh while a claim is still moving, gently: the scan is rate limited.
  useEffect(() => {
    if (!claims.some(c => MOVING.includes(c.status))) return;
    const id = setInterval(() => { if (!document.hidden) scan(true); }, 15_000); return () => clearInterval(id);
  }, [claims, scan]);

  async function claim(c: ClaimCandidate) {
    setBusy(c.memo);
    // Naming the transaction lets the server verify just that one instead of rescanning the wallet.
    try { await api(`/claims/${c.memo}`, { signature: c.signature }); notify('Claim approved. The rebate is on its way.'); setFound(null); await scan(true); }
    catch (e) { notify((e as Error).message); } finally { setBusy(null); }
  }

  /** "Can't find a pull?": paste its Solscan link or transaction signature. */
  async function lookup(event: React.FormEvent) {
    event.preventDefault();
    const signature = pasted.trim().split('/').pop()?.split('?')[0] ?? '';
    if (!signature) return;
    setBusy('lookup');
    try {
      const hit = await api<ClaimCandidate>('/claims/lookup', { signature });
      if (candidates?.some(c => c.memo === hit.memo)) { setFound(null); notify('That pull is already in your list.'); }
      else { setFound(hit); setPasted(''); }
    }
    catch (e) { setFound(null); notify((e as Error).message); } finally { setBusy(null); }
  }

  const o = config?.settings?.offsite, activation: number = config?.settings?.offsiteActivationHours ?? 0, hold: number = config?.settings?.offsiteHoldHours ?? 0;
  const window = windowLabel(o?.claimWindowHours ?? 48);
  const daily = [(o?.perWalletDailyClaims ?? 0) > 0 && `${o.perWalletDailyClaims} claim${o.perWalletDailyClaims > 1 ? 's' : ''}`, (o?.perWalletDailyUsd ?? 0) > 0 && money(o.perWalletDailyUsd)].filter(Boolean);
  const eligible = candidates?.filter(c => c.eligible) ?? [], other = candidates?.filter(c => !c.eligible) ?? [];
  const screen = !me.wallet ? ['NO WALLET', 'Connect the wallet that opened the pack.']
    : busy === 'scan' ? ['SCANNING', `Reading ${short(me.wallet)} for pack payments…`]
    : candidates ? [`${candidates.length} PACK${candidates.length === 1 ? '' : 'S'} FOUND`, eligible.length ? `${eligible.length} to claim, worth ${money(eligible.reduce((s, c) => s + c.rebateUsd, 0))}.` : 'Nothing to claim right now.']
    : ['READY', `Wallet ${short(me.wallet)}. Pulls from the last ${window}.`];

  return <div className="grid gap-8 py-10 md:py-14 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
    {/* Scanner console */}
    <aside className="enter lg:sticky lg:top-32 lg:self-start">
      <div className="card overflow-hidden">
        <div className="flex items-center justify-between border-b border-line px-5 py-3"><span className="label">Off-site scanner</span><span className="tag bg-water/15 text-water">Claims</span></div>
        <div className="p-5">
          <div className="relative overflow-hidden rounded-md border border-line bg-bg px-4 py-4">
            <div aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-[0.06]" style={{ backgroundImage: 'repeating-linear-gradient(0deg, #4aa3ff 0 1px, transparent 1px 4px)' }} />
            <div className="pixel relative text-lg text-water" aria-live="polite">{screen[0]}{busy === 'scan' && <span className="blink">_</span>}</div>
            <div className="relative mt-1 text-xs text-muted">{screen[1]}</div>
          </div>
          {me.wallet && <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2.5 text-xs">
            <span className="label">You bought in</span>
            <span className="num text-right">{!holding ? <span className="text-faint">Scan to check</span>
              : holding.firstAt ? <>{when(holding.firstAt)} <span className="text-muted">· {ago(holding.firstAt)}</span></>
              : holding.holds === false ? <span className="text-loss">No coin in this wallet</span>
              : holding.complete ? <span className="text-loss">Never</span> : <span className="text-muted">Long ago</span>}</span>
          </div>}
          <button className="btn btn-primary mt-4 h-12 w-full" onClick={() => me.wallet ? scan() : connect()} disabled={busy === 'scan'}>
            {busy === 'scan' ? <Loader2 className="animate-spin" size={17} /> : <ScanSearch size={17} />}{me.wallet ? (candidates ? 'Scan again' : 'Scan my wallet') : 'Connect to scan'}</button>

          <form onSubmit={lookup} className="mt-5 border-t border-line pt-5">
            <label htmlFor="tx" className="label">Missing a pull?</label>
            <p className="mt-1 text-xs text-muted">Paste the Solscan link or signature of the pack purchase.</p>
            <div className="mt-2 flex gap-2">
              <input id="tx" className="input min-w-0 flex-1" value={pasted} onChange={e => setPasted(e.target.value)} placeholder="solscan.io/tx/…" />
              <button className="btn btn-outline shrink-0" disabled={busy === 'lookup' || !pasted.trim() || !me.wallet}>{busy === 'lookup' ? <Loader2 className="animate-spin" size={15} /> : 'Find'}</button>
            </div>
          </form>
        </div>
        <ol className="border-t border-line bg-raised/40 px-5 py-4 text-sm">
          {[[`Opened in the last ${window}`, 'Bought and delivered to this same wallet, on any app. Each pack can be claimed once.'],
            ['Opened after you bought in', `We read your coin history on-chain. Packs opened before you first held the coin aren't covered${hold > 0 ? `, and you need to have held it for ${hold}h before the pull` : ''}.`],
            ['Your tier is your lowest balance since', 'Selling after the pull lowers it, even if you buy back.'],
            ...(activation > 0 ? [[`Starts ${activation}h after connecting`, 'Pulls from before that are not covered.']] : []),
            // Limits only show when the owner sets some; by default claims are unlimited.
            ...(daily.length || (o?.perWalletWeeklyUsd ?? 0) > 0 ? [[daily.length ? `Up to ${daily.join(' and ')} a day` : 'No daily limit', (o?.perWalletWeeklyUsd ?? 0) > 0 ? `At most ${money(o.perWalletWeeklyUsd)} a week.` : '']] : [])].map(([title, text], i) =>
            <li key={i} className="flex gap-3 py-1.5"><span className="pixel w-5 shrink-0 text-xs text-water">{i + 1}</span><span><span className="text-ink">{title}.</span> <span className="text-muted">{text}</span></span></li>)}
        </ol>
      </div>
      <p className="mt-3 px-1 text-xs text-muted">Packs opened on Pullback are paid back automatically. This page is for packs opened on Collector Crypt, pump.fun, Jupiter or any other app that sells Collector Crypt packs.</p>
    </aside>

    {/* Results */}
    <section className="min-w-0">
      <h1 className="pixel text-3xl leading-tight sm:text-4xl">CLAIM A <span className="text-water">PULL</span></h1>
      <p className="mt-2 max-w-xl text-muted">Opened a pack on Collector Crypt, pump.fun or Jupiter that came in under the pack price? Claim part of the difference back. You keep the card.</p>

      {found && <div className="card enter mt-6 overflow-hidden border-water/40"><div className="border-b border-line bg-raised px-5 py-2"><span className="label">Found from your link</span></div><ClaimRow c={found} busy={busy === found.memo} onClaim={() => claim(found)} /></div>}

      {!candidates ? <div className="mt-6 grid place-items-center rounded-[10px] border border-dashed border-line px-6 py-16 text-center">
        <ScanSearch size={34} className="text-water" />
        <div className="pixel mt-4 text-lg">Nothing scanned yet</div>
        <p className="mt-1 max-w-sm text-sm text-muted">{me.wallet ? `Scan to list every Collector Crypt pack this wallet opened in the last ${window}, on any app, and what each one can get back.` : 'Connect the wallet that opened the pack, then scan.'}</p>
      </div> : <>
        <div className="mt-8">
          <SectionTitle title={eligible.length ? `${eligible.length} to claim` : 'Nothing to claim'} sub={candidates.length ? `${candidates.length} pack${candidates.length > 1 ? 's' : ''} found in the last ${window}.` : `No Collector Crypt packs from this wallet in the last ${window}.`} />
          {eligible.length > 0 && <div className="card overflow-hidden">{eligible.map(c => <ClaimRow key={c.memo} c={c} busy={busy === c.memo} onClaim={() => claim(c)} />)}</div>}
        </div>
        {other.length > 0 && <div className="mt-6">
          <button className="pixel flex w-full items-center justify-between rounded-md border border-line px-4 py-3 text-left text-sm text-muted hover:text-ink" onClick={() => setShowOther(v => !v)} aria-expanded={showOther}>
            {other.length} that don't qualify<span>{showOther ? '−' : '+'}</span>
          </button>
          {showOther && <div className="card mt-2 overflow-hidden">{other.map(c => <ClaimRow key={c.memo} c={c} busy={false} onClaim={() => {}} />)}</div>}
        </div>}
      </>}

      {claims.length > 0 && <div className="mt-10">
        <SectionTitle title="Your claims" />
        <div className="card overflow-hidden">
          {claims.map(c => <div key={c.memo} className="grid grid-cols-[auto_1fr_auto] items-center gap-x-4 gap-y-1 border-b border-line px-4 py-3 text-sm last:border-0 sm:px-5">
            <i className="size-2.5" style={{ background: packStyle(null, c.priceUsd).color }} />
            <div className="min-w-0"><span className="pixel num">{money(c.priceUsd)} pack</span> <span className="num text-muted">· worth {money(c.valueUsd)} · {ago(c.createdAt)}</span></div>
            <span className="pixel num text-gain">+{money(c.rebateUsd)}</span>
            <span />
            <div className="flex flex-wrap items-center gap-3"><span className={`tag ${STATUS[c.status]?.[1] ?? 'bg-raised text-muted'}`}>{STATUS[c.status]?.[0] ?? c.status}</span>
              {c.signature && <a className="text-xs text-muted hover:text-volt" href={solscan('tx', c.signature)} target="_blank" rel="noreferrer">Payout <ArrowUpRight className="inline" size={12} /></a>}</div>
          </div>)}
        </div>
      </div>}

      <div className="mt-10"><CoverageLadder mode="offsite" /></div>
    </section>
  </div>;
}

/** "Oct 19, 14:02" in the visitor's own time zone. */
const when = (at: number) => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function ClaimRow({ c, busy, onClaim }: { c: ClaimCandidate; busy: boolean; onClaim: () => void }) {
  const p = packStyle(c.packCode, c.priceUsd);
  return <div className="relative flex flex-col gap-3 border-b border-line py-4 pl-5 pr-4 last:border-0 sm:flex-row sm:items-center sm:gap-6 sm:pr-5">
    <i className="absolute inset-y-0 left-0 w-1" style={{ background: p.color }} />
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-baseline gap-x-3"><span className="pixel">{p.name} · {money(c.priceUsd)}</span><span className="text-xs text-faint">{ago(c.pulledAt)}</span>
        <a className="text-xs text-muted hover:text-volt" href={solscan('tx', c.signature)} target="_blank" rel="noreferrer">payment <ArrowUpRight className="inline" size={11} /></a></div>
      <div className="mt-0.5 text-sm text-muted">{c.valueUsd !== null ? <>Worth <span className="num text-ink">{money(c.valueUsd)}</span>{c.valueUsd < c.priceUsd && <> · <span className="num text-loss">−{money(c.priceUsd - c.valueUsd)}</span></>}</> : 'Value unknown'}{!c.eligible && c.reason && !c.claim && <> · {c.reason}</>}</div>
    </div>
    {c.eligible ? <div className="flex items-center justify-between gap-4 sm:justify-end">
      <div className="sm:text-right"><div className="pixel num text-lg text-gain">+{money(c.rebateUsd)}</div><div className="text-xs text-muted">{pct(c.coverageBps)} of the loss</div></div>
      <button className="btn btn-primary" disabled={busy} onClick={onClaim}>{busy && <Loader2 className="animate-spin" size={15} />}Claim</button>
    </div> : c.claim ? <span className={`tag self-start sm:self-auto ${STATUS[c.claim.status]?.[1] ?? 'bg-raised text-muted'}`}>{STATUS[c.claim.status]?.[0] ?? c.claim.status} · {money(c.claim.rebateUsd)}</span> : null}
  </div>;
}
