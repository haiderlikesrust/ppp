import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { ArrowUpRight, Clock, Coins, Gauge, Loader2, ScanSearch, Timer, TrendingDown, Wallet, type LucideIcon } from 'lucide-react';
import type { ClaimCandidate } from '../../../shared/types';
import { windowLabel } from '../../../shared/protection';
import { ago, api, money, pct, short, solscan } from '../api';
import { useApp } from '../app';
import { CoverageLadder } from '../parts/holder';
import { PageHead, RebateBar, SectionTitle, TypeBadge, packStyle } from '../ui';

type Holding = { firstAt: number | null; complete: boolean; holds: boolean | null };
type Claim = { memo: string; status: string; priceUsd: number; valueUsd: number; rebateUsd: number; signature: string | null; createdAt: number };
const STATUS: Record<string, [string, string]> = {
  approved: ['Approved', 'bg-accent-soft text-accent'], paying: ['Paying', 'bg-accent-soft text-accent'], queued: ['Queued · limit reached', 'bg-accent-soft text-accent'],
  paid: ['Paid', 'bg-gain-soft text-gain'], rejected: ['Not paid · holdings dropped', 'bg-loss-soft text-loss'],
};
/** Claims that can still change; only these are refreshed. */
const MOVING = ['approved', 'paying', 'queued'];
/** How far along each status is, out of the three steps a claim takes. */
const PROGRESS: Record<string, number> = { approved: 1, queued: 1, paying: 2, paid: 3 };

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
  const total = eligible.reduce((s, c) => s + c.rebateUsd, 0);
  const screen = !me.wallet ? ['No wallet yet', 'Connect the wallet that opened the pack.']
    : busy === 'scan' ? ['Scanning…', `Reading ${short(me.wallet)} for pack payments.`]
    : candidates ? [eligible.length ? `${money(total)} to claim` : 'Nothing to claim', `${candidates.length ? `${candidates.length} pack${candidates.length === 1 ? '' : 's'}` : 'No packs'} found in the last ${window}.`]
    : ['Ready to scan', `Wallet ${short(me.wallet)}. Pulls from the last ${window}.`];
  const rules: [LucideIcon, string, string][] = [
    [Coins, 'Sells back under the pack', 'We use the live sell-back offer, usually 85–93% of insured value, not the insured value itself.'],
    [Clock, `Opened in the last ${window}`, 'Bought and delivered to this same wallet, on any app. Each pack can be claimed once.'],
    [Wallet, 'Opened after you bought in', `We read your coin history on-chain. Packs opened before you first held the coin aren't covered${hold > 0 ? `, and you need to have held it for ${hold}h before the pull` : ''}.`],
    [TrendingDown, 'Your grade is your lowest balance since', 'Selling after the pull lowers it, even if you buy back.'],
    ...(activation > 0 ? [[Timer, `Starts ${activation}h after connecting`, 'Pulls from before that are not covered.'] as [LucideIcon, string, string]] : []),
    // Limits only show when the owner sets some; by default claims are unlimited.
    ...(daily.length || (o?.perWalletWeeklyUsd ?? 0) > 0 ? [[Gauge, daily.length ? `Up to ${daily.join(' and ')} a day` : 'No daily limit', (o?.perWalletWeeklyUsd ?? 0) > 0 ? `At most ${money(o.perWalletWeeklyUsd)} a week.` : ''] as [LucideIcon, string, string]] : []),
  ];

  return <>
    <PageHead kicker="Off-site claims" title="Claim back a weak pull." sub="Opened a Collector Crypt pack on another app and it sells back for less than you paid? Claim part of the gap in USDC. You keep the card." />

    <section className="pb-10">
      <div className="card enter relative overflow-hidden">
        {busy === 'scan' && <i className="scan-beam" />}
        <div className="grid items-center gap-x-10 gap-y-5 p-5 sm:p-7 lg:grid-cols-[minmax(0,1fr)_auto_auto]">
          <div className="min-w-0" aria-live="polite">
            <div className="label">Wallet scanner</div>
            <div className="font-display num mt-1 text-3xl font-bold leading-tight tracking-tight sm:text-4xl">{screen[0]}</div>
            <div className="mt-1 text-sm text-muted">{screen[1]}</div>
          </div>
          {me.wallet && <div className="min-w-0">
            <div className="label">You bought in</div>
            <div className="num mt-1 text-sm">{!holding ? <span className="text-faint">Scan to check</span>
              : holding.firstAt ? <>{when(holding.firstAt)} <span className="text-muted">· {ago(holding.firstAt)}</span></>
              : holding.holds === false ? <span className="text-loss">No coin in this wallet</span>
              : holding.complete ? <span className="text-loss">Never</span> : <span className="text-muted">Long ago</span>}</div>
          </div>}
          <button className="btn btn-primary h-12 w-full px-6 lg:w-auto" onClick={() => me.wallet ? scan() : connect()} disabled={busy === 'scan'}>
            {busy === 'scan' ? <Loader2 className="animate-spin" size={17} /> : <ScanSearch size={17} />}{me.wallet ? (candidates ? 'Scan again' : 'Scan my wallet') : 'Connect to scan'}</button>
        </div>
        <form onSubmit={lookup} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line px-5 py-3.5 sm:px-7">
          <label htmlFor="tx" className="text-sm text-muted">Missing a pull? <span className="text-faint">Paste its Solscan link or signature.</span></label>
          <div className="flex min-w-[min(100%,16rem)] flex-1 gap-2">
            <input id="tx" className="input min-w-0 flex-1" value={pasted} onChange={e => setPasted(e.target.value)} placeholder="solscan.io/tx/…" />
            <button className="btn btn-outline shrink-0" disabled={busy === 'lookup' || !pasted.trim() || !me.wallet}>{busy === 'lookup' ? <Loader2 className="animate-spin" size={15} /> : 'Find'}</button>
          </div>
        </form>
      </div>
    </section>

    <section className="grid gap-3 pb-14">
      {found && <><div className="label">Found from your link</div><Ticket c={found} busy={busy === found.memo} onClaim={() => claim(found)} /></>}
      {!candidates ? <div className="grid gap-3" aria-label="No scan yet">
        <div className="ticket-ghost"><ScanSearch size={22} className="shrink-0 text-accent" /><p className="text-sm text-muted">{me.wallet ? `Your packs from the last ${window}, on any app, will show up here as tickets you can cash in.` : 'Connect the wallet that opened the pack, then scan.'}</p></div>
        <div className="ticket-ghost opacity-50" /><div className="ticket-ghost opacity-25" />
      </div>
        : eligible.length ? eligible.map(c => <Ticket key={c.memo} c={c} busy={busy === c.memo} onClaim={() => claim(c)} />)
        : <div className="ticket-ghost"><p className="text-sm text-muted">{candidates.length ? 'None of these packs can be claimed right now.' : `No Collector Crypt packs from this wallet in the last ${window}.`}</p></div>}
      {other.length > 0 && <div className="mt-2">
        <button className="font-semibold flex items-center gap-2 text-sm text-muted hover:text-ink" onClick={() => setShowOther(v => !v)} aria-expanded={showOther}><span className="num">{showOther ? '−' : '+'}</span>{other.length} that {other.length === 1 ? "doesn't" : "don't"} qualify</button>
        {showOther && <div className="mt-2 border-t border-line">{other.map(c => <Skipped key={c.memo} c={c} />)}</div>}
      </div>}
    </section>

    {claims.length > 0 && <section className="pb-14">
      <SectionTitle title="Your claims" sub="Approved, then paying, then paid. This updates on its own." />
      <div className="border-t border-line">{claims.map(c => <div key={c.memo} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-line py-3 text-sm">
        <TypeBadge priceUsd={c.priceUsd} size={24} />
        <div className="min-w-0 flex-[1_1_12rem]"><span className="font-display num">{money(c.priceUsd)} pack</span> <span className="num text-muted">· insured {money(c.valueUsd)} · {ago(c.createdAt)}</span></div>
        {PROGRESS[c.status] && <div className="flex w-20 gap-0.5" aria-hidden="true">{[0, 1, 2].map(i => <i key={i} className={`h-1.5 flex-1 rounded-sm ${i < PROGRESS[c.status] ? 'bg-chart-out' : 'bg-raised'}`} />)}</div>}
        <span className={`tag ${STATUS[c.status]?.[1] ?? 'bg-raised text-muted'}`}>{STATUS[c.status]?.[0] ?? c.status}</span>
        {c.signature && <a className="text-xs text-muted hover:text-accent" href={solscan('tx', c.signature)} target="_blank" rel="noreferrer">Payout <ArrowUpRight className="inline" size={12} /></a>}
        <span className="font-display num w-20 text-right text-gain">+{money(c.rebateUsd)}</span>
      </div>)}</div>
    </section>}

    <section className="pb-14">
      <SectionTitle title="What counts" />
      <ul className="grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">{rules.map(([Icon, title, text]) => <li key={title} className="flex gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-accent-soft text-accent"><Icon size={17} /></span>
        <div className="min-w-0"><div className="font-semibold text-sm">{title}</div>{text && <p className="mt-0.5 text-sm text-muted">{text}</p>}</div>
      </li>)}</ul>
    </section>

    <section className="pb-8"><CoverageLadder mode="offsite" /></section>
    <p className="pb-4 text-xs text-faint">Packs opened on Regrade are paid back automatically. This page is for packs opened on Collector Crypt, pump.fun, Jupiter or any other app that sells Collector Crypt packs.</p>
  </>;
}

/** "Oct 19, 14:02" in the visitor's own time zone. */
const when = (at: number) => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** A pull that can be claimed, drawn as a ticket: the pull on one side, and a stub to cash in on the other. */
function Ticket({ c, busy, onClaim }: { c: ClaimCandidate; busy: boolean; onClaim: () => void }) {
  const p = packStyle(c.packCode, c.priceUsd), sell = c.sellUsd ?? c.valueUsd, title = c.card?.name?.split(' · ')[0] ?? `${p.name} pack`;
  return <article className="ticket enter" style={{ '--pack': p.color } as CSSProperties}>
    <div className="flex min-w-0 gap-4 p-4 sm:p-5">
      {c.card?.image ? <img src={c.card.image} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-[84px] w-[52px] shrink-0 rounded-md object-cover" /> : <TypeBadge code={c.packCode} priceUsd={c.priceUsd} size={40} />}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <h3 className="font-semibold truncate" title={c.card?.name ?? undefined}>{title}</h3>
          <span className="text-xs text-faint">{ago(c.pulledAt)} · <a className="hover:text-accent" href={solscan('tx', c.signature)} target="_blank" rel="noreferrer">payment <ArrowUpRight className="inline" size={11} /></a></span>
        </div>
        <div className="num text-xs text-muted">{p.name} {money(c.priceUsd)}{c.valueUsd !== null && ` · insured at ${money(c.valueUsd)}`}</div>
        {sell !== null && <div className="mt-3"><RebateBar priceUsd={c.priceUsd} valueUsd={sell} rebateUsd={c.rebateUsd} /></div>}
      </div>
    </div>
    <div className="ticket-stub">
      <div><div className="font-display num text-3xl font-bold leading-none tracking-tight text-gain">+{money(c.rebateUsd)}</div><div className="mt-1 text-xs text-muted">{pct(c.coverageBps)} of the gap</div></div>
      <button className="btn btn-primary mt-3 w-full max-sm:mt-0 max-sm:w-auto" disabled={busy} onClick={onClaim}>{busy && <Loader2 className="animate-spin" size={15} />}Claim</button>
    </div>
  </article>;
}

/** A pack the scan found that can't be claimed, with why, or the claim already made on it. */
function Skipped({ c }: { c: ClaimCandidate }) {
  const p = packStyle(c.packCode, c.priceUsd);
  return <div className="flex items-center gap-3 border-b border-line py-2.5 text-sm">
    <TypeBadge code={c.packCode} priceUsd={c.priceUsd} size={24} />
    <div className="min-w-0 flex-1">
      <div className="truncate"><span className="font-display">{p.name} {money(c.priceUsd)}</span> <span className="text-xs text-faint">{ago(c.pulledAt)}</span></div>
      <div className="text-xs text-muted">{c.valueUsd === null ? 'Value unknown' : c.sellUsd !== null ? `Sells back for ${money(c.sellUsd)}` : `Insured at ${money(c.valueUsd)}`}{!c.claim && c.reason && ` · ${c.reason}`}</div>
    </div>
    {c.claim && <span className={`tag shrink-0 ${STATUS[c.claim.status]?.[1] ?? 'bg-raised text-muted'}`}>{STATUS[c.claim.status]?.[0] ?? c.claim.status} · {money(c.claim.rebateUsd)}</span>}
  </div>;
}
