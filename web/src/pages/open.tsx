import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowRight, ArrowUpRight, Check, Plus } from 'lucide-react';
import type { OrderView, PoolView, Quote } from '../../../shared/types';
import { ago, api, friendly, money, pct, solscan } from '../api';
import { Link, useApp } from '../app';
import { ensureSigner, hasSigner, signPayment } from '../wallet';
import { CoverageLadder } from '../parts/holder';
import { ContractAddress } from '../parts/contract';
import { PackOpening } from '../parts/opening';
import { RecentPullsStrip } from '../parts/pulls';
import { XLogo, X_HANDLE, X_URL } from '../parts/social';
import { Booster, Modal, RebateBar, SectionTitle, Slab, isWatch, packStyle } from '../ui';
import { packDef } from '../../../shared/packs';
import { windowLabel } from '../../../shared/protection';
import { useShowcase } from '../showcase';

type Pack = { code: string; priceUsd: number; quote: Quote };
type Activity = { kind: 'onsite' | 'offsite'; wallet: string; code: string; priceUsd: number; valueUsd: number; rebateUsd: number; cardName: string | null; at: number };
const FINAL = ['complete', 'refunded', 'expired', 'review'];
const IN_PROGRESS = ['paying', 'paid', 'buying', 'delivering', 'settling', 'refunding'];

export function OpenPage() {
  const { me, config, connect, notify, refresh, version, bump } = useApp();
  const [packs, setPacks] = useState<Pack[] | null>(null);
  const [packsFailed, setPacksFailed] = useState(false);
  const [pool, setPool] = useState<PoolView | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [history, setHistory] = useState<OrderView[]>([]);
  const [order, setOrder] = useState<OrderView | null>(null);
  const [opening, setOpening] = useState<Pack | null>(null);
  const [allActivity, setAllActivity] = useState(false);
  const poll = useRef<ReturnType<typeof setTimeout>>(undefined);
  const following = useRef<string | null>(null), inFlight = useRef(false), aborted = useRef(false);

  const load = useCallback(() => {
    setPacksFailed(false);
    api<{ packs: Pack[] }>('/packs').then(r => setPacks(r.packs)).catch(() => setPacksFailed(true));
    api<PoolView>('/pool').then(setPool).catch(() => {});
    api<{ items: Activity[] }>('/activity').then(r => setActivity(r.items)).catch(() => {});
    if (me.wallet) api<{ orders: OrderView[] }>('/orders').then(r => setHistory(r.orders)).catch(() => {}); else setHistory([]);
  }, [me.wallet]);
  useEffect(load, [load, version]);
  useEffect(() => () => { following.current = null; clearTimeout(poll.current); }, []);
  useEffect(() => {
    const id = setInterval(() => { if (!document.hidden) api<{ items: Activity[] }>('/activity').then(r => setActivity(r.items)).catch(() => {}); }, 20_000);
    return () => clearInterval(id);
  }, []);

  /** Polls one order, one request at a time. A reply for an order we stopped following is dropped. */
  function follow(id: string) {
    clearTimeout(poll.current); following.current = id;
    const tick = async () => {
      try {
        const next = await api<OrderView>(`/orders/${id}`);
        if (following.current !== id) return;
        setOrder(next);
        // Bumping reloads this page's lists, the Just pulled strip and the vault balance.
        if (FINAL.includes(next.status)) { following.current = null; bump(); refresh().catch(() => {}); return; }
      } catch (e) {
        if (following.current !== id) return;
        const status = (e as { status?: number }).status;
        if (status === 401 || status === 404) { following.current = null; notify('This order can no longer be followed here. Its result shows under Your pulls.'); return; }
      }
      poll.current = setTimeout(tick, 1000);
    };
    poll.current = setTimeout(tick, 500);
  }

  async function open(pack: Pack) {
    if (!me.wallet) return connect();
    if (inFlight.current) return;
    inFlight.current = true; aborted.current = false;
    setOpening(pack); setOrder(null);
    let unpaid: string | null = null;
    try {
      const practice = config?.mode === 'practice' && !hasSigner();
      // Make sure the signing wallet is ready (and is the signed-in one) before an order is created.
      if (!practice) {
        try { await ensureSigner(me.wallet); }
        catch (e) { notify((e as Error).message); if ((e as { reconnect?: boolean }).reconnect) connect(); setOpening(null); return; }
      }
      if (aborted.current) return;
      const { order: created, transaction } = await api<{ order: OrderView; transaction: string }>('/orders', { code: pack.code });
      unpaid = created.id;
      if (aborted.current) return;
      setOrder(created);
      const signed = practice ? 'practice' : await signPayment(transaction);
      // Closed while the wallet prompt was open: don't send a payment nobody is watching.
      if (aborted.current) return;
      try { setOrder(await api<OrderView>(`/orders/${created.id}/pay`, { signed })); }
      catch (e) {
        // A dropped connection can hide a payment that was sent: check before calling it a failure.
        const check = await api<OrderView>(`/orders/${created.id}`).catch(() => null);
        if (check && check.status !== 'awaiting_payment') { unpaid = null; setOrder(check); follow(created.id); return; }
        throw e;
      }
      unpaid = null;
      follow(created.id);
    } catch (e) {
      if (!aborted.current) { notify(friendly(e as Error)); setOpening(null); setOrder(null); load(); }
    } finally {
      // Release an unpaid order so the buyer can try again straight away.
      if (unpaid) await api(`/orders/${unpaid}/cancel`, {}).catch(() => {});
      inFlight.current = false;
    }
  }

  /** Reopens an order that is still going (or just finished) from the pulls list. */
  function resume(o: OrderView) {
    const pack = packs?.find(p => p.code === o.packCode) ?? { code: o.packCode, priceUsd: o.priceUsd, quote: { coverageBps: o.coverageBps } as Quote };
    setOpening(pack); setOrder(o);
    if (!FINAL.includes(o.status)) follow(o.id);
  }

  const close = () => {
    const running = !!order && IN_PROGRESS.includes(order.status);
    aborted.current = true; following.current = null; clearTimeout(poll.current);
    setOpening(null); setOrder(null);
    if (running) notify('Your pack keeps opening in the background. Find it under Your pulls.');
    load();
  };

  const s = config?.settings, feeBps: number = s?.feeBps ?? 1_000;
  const tier = me.holder?.tier;
  const sample = s?.tiers?.[1] ?? { name: 'Dolphin', onsiteCoverageBps: 5_000 };
  const covered = tier?.onsiteCoverageBps;
  const mode = config?.mode;
  return <>
    {/* Hero */}
    <section className="enter flex flex-col items-center py-14 text-center md:py-24">
      <span className="tag bg-volt-soft text-volt"><i className="live-dot" />{mode === 'mainnet' ? 'Live on Solana' : mode === 'practice' ? 'Practice mode' : 'Launching on Solana'}</span>
      <h1 className="pixel mt-7 text-[2.3rem] font-bold leading-[1.05] min-[420px]:text-5xl sm:text-6xl md:text-[5.5rem]">BAD PULL?<br /><span className="text-volt">PULL BACK.</span></h1>
      <p className="mt-7 max-w-xl text-lg text-muted">Open Collector Crypt packs here, Pokémon cards and luxury watches. When a pull comes in under the pack price, part of the loss lands back in your wallet in USDC, automatically.</p>
      <div className="mt-9 grid w-full gap-3 sm:flex sm:w-auto">
        <a href="#packs" className="btn btn-primary h-12 px-7">Open a pack<ArrowDown size={16} /></a>
      </div>
      <ContractAddress variant="hero" className="mx-auto mt-6" />
      <div className="card mt-12 grid w-full max-w-3xl grid-cols-1 divide-y divide-line sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <Readout label="In the pool" value={money(pool?.balanceUsd)} />
        <Readout label="Paid back" value={money(pool ? pool.totals.onsiteRebatesUsd + pool.totals.offsiteRebatesUsd : null)} tone="text-gain" />
        <Readout label="Packs protected" value={pool ? String(pool.totals.packsOpened) : '—'} />
      </div>
    </section>

    <CoveredApps hours={s?.offsite?.claimWindowHours ?? 48} />

    {/* Example entry */}
    <section className="pb-16">
      <Example feeBps={feeBps} coverageBps={covered ?? sample.onsiteCoverageBps} tierName={tier?.name ?? sample.name} illustrative={!tier} />
    </section>

    {/* Packs */}
    <section id="packs" className="scroll-mt-32 pb-16">
      <SectionTitle title="Choose a pack" sub={`One graded Pokémon card or luxury watch per pack, straight from Collector Crypt. Prices include the ${pct(feeBps)} protection fee.`} />
      {packs && (['pokemon', 'watch'] as const).map(kind => {
        const list = packs.filter(p => (packDef(p.code)?.kind ?? 'pokemon') === kind);
        return list.length ? <div key={kind} className="mb-12">
          <div className="label mb-4 flex items-center gap-2">{kind === 'pokemon' ? 'Pokémon cards' : 'Luxury watches'}<span className="h-px flex-1 bg-line" /></div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-8 lg:grid-cols-4">{list.map(p => <PackTile key={p.code} pack={p} signedIn={!!me.wallet} busy={opening !== null} onOpen={() => open(p)} />)}</div>
        </div> : null;
      })}
      <div className="grid grid-cols-2 gap-x-4 gap-y-8 lg:grid-cols-4">
        {!packs && !packsFailed && [0, 1, 2, 3].map(i => <div key={i} className="aspect-[5/7] animate-pulse rounded-md bg-surface" />)}
        {!packs && packsFailed && <div className="card col-span-full flex flex-wrap items-center justify-between gap-3 p-6"><div><div className="pixel">Packs could not be loaded.</div><div className="text-sm text-muted">Collector Crypt or our server did not answer. Your funds are not affected.</div></div><button className="btn btn-outline" onClick={load}>Try again</button></div>}
        {packs && !packs.length && <div className="card col-span-full p-6 text-sm text-muted">No packs are available on Collector Crypt right now. Check back soon.</div>}
      </div>
    </section>

    <RecentPullsStrip />

    <section className="pb-16"><CoverageLadder /></section>

    {/* How it works */}
    <section className="pb-16">
      <SectionTitle title="Three steps" action={<Link href="/how-it-works" className="pixel text-sm text-volt hover:underline">How it works →</Link>} />
      <ol className="grid gap-px overflow-hidden rounded-[10px] border border-line bg-line md:grid-cols-3">
        {[
          ['Hold the token', 'Your tier is your lowest balance over the window, so it rewards real holders, not quick flips.'],
          ['Open a pack here', 'Pay once in USDC. We buy the pack on Collector Crypt and send the graded card to your wallet.'],
          ['Get part of it back', covered ? `If the card is worth less than the pack, ${pct(covered)} of that gap is sent to you right away.` : 'If the card is worth less than the pack, part of that gap is sent to you right away. Your tier sets how much.'],
        ].map(([title, text], i) => <li key={title} className="bg-surface p-6">
          <div className="pixel text-4xl text-volt">0{i + 1}</div>
          <h3 className="pixel mt-4 text-lg">{title}</h3><p className="mt-1.5 text-sm text-muted">{text}</p>
        </li>)}
      </ol>
    </section>

    {history.length > 0 && <section className="pb-16">
      <SectionTitle title="Your pulls" sub="Tap one that's still opening to watch it." />
      <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 lg:grid-cols-6">
        {history.slice(0, 12).map(o => <button key={o.id} onClick={() => resume(o)} className="min-w-0 text-left">
          {o.card ? <Slab card={o.card} priceUsd={o.priceUsd} size="sm" watch={isWatch(o.packCode)} /> : <Booster code={o.packCode} priceUsd={o.priceUsd} className={IN_PROGRESS.includes(o.status) ? 'bob' : 'opacity-50 grayscale'} />}
          <div className="mt-2 truncate text-center text-xs">{o.sale ? <span className="pixel text-water">Sold {money(o.sale.amountUsd)}</span> : o.rebateUsd ? <span className="pixel text-gain">+{money(o.rebateUsd)}</span> : o.card ? <span className="text-muted">{money(o.priceUsd)} pack</span> : <span className="pixel text-muted">{IN_PROGRESS.includes(o.status) ? 'Opening…' : o.status === 'refunded' ? 'Refunded' : o.status === 'review' ? 'Being checked' : 'Expired'}</span>}</div>
        </button>)}
      </div>
    </section>}

    {/* Live rebates */}
    <section className="pb-16">
      <SectionTitle title="Live rebates" sub="Every pull that paid out, on-site and off-site." action={<span className="tag bg-gain-soft text-gain"><i className="live-dot" />Live</span>} />
      {activity.length ? <div className="card overflow-hidden">
        <div className="hidden grid-cols-[1fr_auto_auto] gap-6 border-b border-line px-5 py-2.5 sm:grid"><span className="label">Pull</span><span className="label">When</span><span className="label w-24 text-right">Back</span></div>
        {activity.slice(0, allActivity ? activity.length : 6).map((a, i) => <div key={`${a.at}-${i}`} className="grid grid-cols-[1fr_auto] items-center gap-x-6 border-b border-line px-4 py-3 last:border-0 sm:grid-cols-[1fr_auto_auto] sm:px-5">
          <div className="flex min-w-0 items-center gap-3">
            <i className="size-2.5 shrink-0" style={{ background: packStyle(a.code, a.priceUsd).color }} />
            <div className="min-w-0">
              <div className="truncate text-sm">{a.cardName ? a.cardName.split(' · ').slice(0, 2).join(' · ') : 'Opened off-site'}</div>
              <div className="num truncate text-xs text-muted">{a.wallet} · {money(a.priceUsd)} {packStyle(a.code, a.priceUsd).name} · worth {money(a.valueUsd)}</div>
            </div>
          </div>
          <span className="hidden text-xs text-faint sm:block">{ago(a.at)}</span>
          <div className="text-right sm:w-24">{a.rebateUsd ? <span className="pixel num text-gain">+{money(a.rebateUsd)}</span> : <span className="tag bg-volt text-night">Hit</span>}<div className="text-[11px] text-faint sm:hidden">{ago(a.at)}</div></div>
        </div>)}
        {activity.length > 6 && <button className="pixel flex h-11 w-full items-center justify-center gap-1.5 border-t border-line text-sm text-muted hover:bg-raised hover:text-ink" onClick={() => setAllActivity(v => !v)}>{allActivity ? 'Show less' : `Show all ${activity.length}`}<ArrowDown size={14} className={allActivity ? 'rotate-180' : ''} /></button>}
      </div> : <div className="card px-5 py-8 text-center text-sm text-muted">No pulls yet. Be the first.</div>}
    </section>

    {/* Closing call to action */}
    <section className="pt-4">
      <div className="card relative overflow-hidden border-volt/40 px-6 py-12 text-center sm:px-10">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-[0.07]" style={{ backgroundImage: 'repeating-linear-gradient(0deg, #ffd23f 0 1px, transparent 1px 6px)' }} />
        <h2 className="pixel relative text-2xl sm:text-4xl">EVERY PACK. <span className="text-volt">A PULLBACK.</span></h2>
        <p className="relative mx-auto mt-4 max-w-lg text-muted">Hold the token, open packs here, and get part of every bad pull back in USDC. Drops and big hits go out on X first.</p>
        <div className="relative mt-8 grid gap-3 sm:flex sm:justify-center">
          <a href="#packs" className="btn btn-primary h-12 px-7">Open a pack<ArrowRight size={16} /></a>
          <a href={X_URL} target="_blank" rel="noreferrer" className="btn btn-outline h-12 px-7"><XLogo size={15} />Follow @{X_HANDLE}</a>
        </div>
      </div>
    </section>

    <Modal open={opening !== null} onClose={close} width="max-w-2xl" label="Opening your pack">
      {opening && <OpenFlow pack={opening} order={order} onUpdate={setOrder} onAgain={() => { const p = packs?.find(x => x.code === opening.code); close(); if (p) setTimeout(() => open(p), 50); }} onClose={close} />}
    </Modal>
  </>;
}

/** Apps that sell Collector Crypt packs: they all pay the same machines, so their packs can be claimed here. */
const APPS = [['pump.fun', '/apps/pump-fun.svg'], ['Collector Crypt', '/apps/collector-crypt.svg'], ['Jupiter', '/apps/jupiter.svg']] as const;

function CoveredApps({ hours }: { hours: number }) {
  return <section className="pb-16">
    <div className="card overflow-hidden">
      <div className="grid gap-5 p-5 sm:p-6 lg:grid-cols-[1fr_auto] lg:items-center lg:gap-10">
        <div>
          <div className="label">Opened a pack somewhere else?</div>
          <h2 className="pixel mt-2 text-xl sm:text-2xl">COVERED WHEREVER YOU <span className="text-volt">OPEN</span></h2>
          <p className="mt-2 max-w-md text-sm text-muted">Collector Crypt packs opened on these apps can be claimed here for a rebate, up to {windowLabel(hours)} after the pull.</p>
        </div>
        <ul className="grid grid-cols-2 gap-2 lg:flex lg:items-center" aria-label="Apps whose packs are covered">
          {APPS.map(([name, logo], i) => <li key={name} className="flex min-w-0 items-center gap-2">
            {i > 0 && <Plus size={14} className="hidden shrink-0 text-faint lg:block" aria-hidden="true" />}
            <span className="flex h-12 min-w-0 flex-1 items-center gap-2.5 rounded-lg border border-line bg-raised px-3 lg:flex-none lg:px-3.5"><img src={logo} alt="" className="size-6 shrink-0 object-contain" /><span className="min-w-0 text-[13px] font-semibold leading-tight lg:text-sm">{name}</span></span>
          </li>)}
          <li className="flex min-w-0 items-center gap-2">
            <Plus size={14} className="hidden shrink-0 text-faint lg:block" aria-hidden="true" />
            <span className="flex h-12 min-w-0 flex-1 items-center gap-2 rounded-lg border border-dashed border-line px-3 text-sm text-muted lg:flex-none lg:px-3.5" title="Solflare, Rarible and other apps that sell Collector Crypt packs"><Plus size={16} className="shrink-0" aria-hidden="true" /><span className="truncate">More apps</span></span>
          </li>
        </ul>
      </div>
      <Link href="/claim" className="flex items-center justify-between gap-3 border-t border-line px-5 py-3.5 text-sm hover:bg-raised sm:px-6"><span className="pixel text-volt">Claim a pack opened elsewhere</span><ArrowRight size={16} className="text-volt" /></Link>
    </div>
  </section>;
}

function Readout({ label, value, tone = '' }: { label: string; value: string; tone?: string }) {
  return <div className="flex min-w-0 items-center justify-between gap-4 px-5 py-4 sm:block sm:px-6 sm:py-5"><div className="label truncate">{label}</div><div className={`pixel num truncate text-xl sm:mt-1.5 sm:text-2xl lg:text-3xl ${tone}`}>{value}</div></div>;
}

/** A worked example on a real $25 pull from Collector Crypt, at the visitor's own coverage when they have a tier. */
function Example({ feeBps, coverageBps, tierName, illustrative }: { feeBps: number; coverageBps: number; tierName: string; illustrative: boolean }) {
  const real = useShowcase()?.example;
  const card = real ? { name: real.name, image: real.image, insuredValueUsd: real.insuredValueUsd, rarity: real.rarity } : { name: 'Sylveon · Crown Zenith · PSA 9', image: null, insuredValueUsd: 9.3, rarity: 'Common' };
  const price = 25, fee = Math.round(price * feeBps) / 10_000, value = card.insuredValueUsd, rebate = Math.floor((price - value) * coverageBps / 100) / 100;
  return <div className="card overflow-hidden">
    <div className="flex items-center justify-between border-b border-line bg-raised px-5 py-2.5"><span className="label">{real ? 'A real $25 pull from Collector Crypt' : 'Example pull'}</span><span className="label hidden sm:inline">{illustrative ? `At ${tierName}` : 'Your tier'}</span></div>
    <div className="grid gap-6 p-5 sm:grid-cols-[150px_1fr] sm:gap-10 sm:p-8">
      <div className="mx-auto w-[130px] sm:w-[150px]"><Slab card={card} priceUsd={price} /></div>
      <div className="min-w-0 self-center">
        <dl className="grid gap-3 text-sm">
          <div className="leader"><dt className="text-muted">Pack + protection</dt><dd className="pixel num">{money(price + fee)}</dd></div>
          <div className="leader"><dt className="text-muted">Card is worth</dt><dd className="pixel num">{money(value)}</dd></div>
          <div className="leader"><dt className="text-muted">Shortfall</dt><dd className="pixel num text-loss">{money(price - value)}</dd></div>
          <div className="leader"><dt className="text-muted">{tierName} covers</dt><dd className="pixel num">{pct(coverageBps)}</dd></div>
        </dl>
        <div className="mt-5 flex items-baseline justify-between border-t border-line pt-4"><span className="pixel">Back to you</span><span className="pixel num text-2xl text-gain sm:text-3xl">+{money(rebate)}</span></div>
        <div className="mt-5"><RebateBar priceUsd={price} valueUsd={value} rebateUsd={rebate} /></div>
      </div>
    </div>
  </div>;
}

function PackTile({ pack, signedIn, busy, onOpen }: { pack: Pack; signedIn: boolean; busy: boolean; onOpen: () => void }) {
  const q = pack.quote, blocked = signedIn && !q.protected;
  return <article className="group flex min-w-0 flex-col">
    <Booster code={pack.code} priceUsd={pack.priceUsd} />
    <div className="mt-4 flex flex-wrap items-baseline justify-between gap-x-2">
      <span className="pixel num text-lg">{money(q.totalMicros / 1e6)}</span>
      <span className="text-[11px] text-muted">incl. {money(q.feeMicros / 1e6)} fee</span>
    </div>
    <div className="mt-1 min-h-10 text-sm">
      {q.protected ? <span className="text-gain">Up to <b className="num">{money(q.maxRebateMicros / 1e6)}</b> back · {pct(q.coverageBps)}</span>
        : signedIn ? <span className="text-xs text-loss">{q.reason}</span> : <span className="text-muted">Connect to see your coverage</span>}
    </div>
    <button className="btn btn-primary mt-3 w-full" disabled={busy || blocked} onClick={onOpen}>{signedIn ? 'Open' : 'Connect to open'}<ArrowRight size={15} /></button>
  </article>;
}

const STEPS = [{ label: 'Pay', at: ['awaiting_payment', 'paying'] }, { label: 'Open', at: ['paid', 'buying'] }, { label: 'Send', at: ['delivering'] }, { label: 'Rebate', at: ['settling'] }];

function OpenFlow({ pack, order, onUpdate, onAgain, onClose }: { pack: Pack; order: OrderView | null; onUpdate: (o: OrderView) => void; onAgain: () => void; onClose: () => void }) {
  const priceUsd = pack.priceUsd, status = order?.status;
  const step = status === 'complete' ? STEPS.length : STEPS.findIndex(s => s.at.includes(status ?? 'awaiting_payment'));
  const revealed = !!order?.card;
  const failed = status === 'refunded' || status === 'expired' || status === 'review' || status === 'refunding';
  const hit = !!order && order.valueUsd !== null && order.valueUsd >= order.priceUsd;
  const title = status === 'refunding' ? 'Refunding your payment' : status === 'review' ? 'Needs a quick check' : status === 'refunded' ? 'Refunded in full' : status === 'expired' ? 'Payment window closed'
    : revealed ? order!.card!.name.split(' · ')[0] : !order || status === 'awaiting_payment' ? 'Confirm in your wallet' : 'Opening your pack…';
  return <div className="relative grid gap-6 sm:grid-cols-[210px_1fr] sm:gap-8">
    {status === 'complete' && hit && <Confetti />}
    <PackOpening code={pack.code} priceUsd={priceUsd} status={status} card={order?.card ?? null} hit={hit} rebateUsd={order?.rebateUsd ?? null} />
    <div className="min-w-0">
      <div className="label pr-8">{money(priceUsd)} {packStyle(pack.code, priceUsd).name} pack · {pct(order?.coverageBps ?? pack.quote.coverageBps ?? 0)} covered</div>
      <h2 className="pixel mt-1.5 text-2xl" aria-live="polite">{title}</h2>
      {revealed && <p className="text-sm text-muted">{order!.card!.name.split(' · ').slice(1).join(' · ')}</p>}

      {!failed && <ol className="mt-5 grid grid-cols-4 gap-1.5">
        {STEPS.map((s, i) => <li key={s.label}>
          <div className={`h-1.5 rounded-[2px] ${i < step ? 'bg-gain' : i === step ? 'blink bg-volt' : 'bg-raised'}`} />
          <div className={`pixel mt-1.5 flex items-center gap-1 text-[11px] uppercase tracking-[0.08em] ${i < step ? 'text-gain' : i === step ? 'text-volt' : 'text-faint'}`}>{i < step && <Check size={11} />}{s.label}</div>
        </li>)}
      </ol>}

      {order && order.valueUsd !== null && !failed && <div className="enter mt-6">
        <div className="grid grid-cols-3 gap-3">
          <Mini label="You paid" value={money(order.totalUsd)} />
          <Mini label="Card value" value={money(order.valueUsd)} tone={hit ? 'text-gain' : ''} />
          <Mini label="Back to you" value={hit ? 'None' : order.rebateUsd === null ? '…' : `+${money(order.rebateUsd)}`} tone={hit ? 'text-muted' : 'text-gain'} />
        </div>
        {order.rebateUsd !== null && !hit && <div className="mt-5"><RebateBar priceUsd={order.priceUsd} valueUsd={order.valueUsd} rebateUsd={order.rebateUsd} /></div>}
        {status === 'complete' && hit && <p className="mt-4 rounded-md border border-volt/40 bg-volt-soft px-4 py-3 text-sm text-volt">A hit! This one beat the pack price, so no rebate was needed.</p>}
      </div>}

      {status === 'complete' && order?.card && <QuickSell order={order} onSold={onUpdate} />}

      {!(status === 'complete' && hit) && <p className={`mt-4 text-sm ${status === 'review' ? 'text-loss' : 'text-muted'}`}>{status === 'review' ? 'Your payment is safe. The team has been alerted and will finish this order.' : order?.message}</p>}

      <div className="mt-4 flex flex-wrap gap-4 text-xs">
        {([['Payment', order?.paymentSignature], ['Card transfer', order?.nftSignature], ['Rebate', order?.rebateSignature], ['Refund', order?.refundSignature]] as const).filter(([, s]) => s).map(([label, s]) =>
          <a key={label} className="inline-flex items-center gap-0.5 text-muted hover:text-volt" href={solscan('tx', s!)} target="_blank" rel="noreferrer">{label}<ArrowUpRight size={12} /></a>)}
      </div>

      <div className="mt-6 flex flex-wrap gap-2">
        {status === 'complete' && <button className="btn btn-primary" onClick={onAgain}>Open another</button>}
        <button className="btn btn-outline" onClick={onClose}>{status && FINAL.includes(status) ? 'Done' : 'Close'}</button>
      </div>
    </div>
  </div>;
}

type SaleQuote = { available: boolean; amountUsd: number | null; expiresAt: number | null };

/** Collector Crypt's sell-back offer for the card just pulled, signed by the buyer's own wallet. */
function QuickSell({ order, onSold }: { order: OrderView; onSold: (o: OrderView) => void }) {
  const { config, me, notify } = useApp();
  const [quote, setQuote] = useState<SaleQuote | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (order.sale) return;
    api<SaleQuote>(`/orders/${order.id}/sell`).then(setQuote).catch(() => setQuote({ available: false, amountUsd: null, expiresAt: null }));
  }, [order.id, order.sale]);
  if (order.sale) return <div className="enter mt-5 flex flex-wrap items-center justify-between gap-3 rounded-md border border-water/40 bg-water/10 px-4 py-3 text-sm">
    <span>Sold back for <b className="pixel text-water">{money(order.sale.amountUsd)}</b>. The USDC is in your wallet.</span>
    <a className="inline-flex items-center gap-0.5 text-xs text-muted hover:text-volt" href={solscan('tx', order.sale.signature)} target="_blank" rel="noreferrer">Sale<ArrowUpRight size={12} /></a>
  </div>;
  if (!quote?.available || quote.amountUsd === null) return null;
  async function sell() {
    if (busy) return;
    setBusy(true);
    try {
      const practice = config?.mode === 'practice' && !hasSigner();
      if (!practice && me.wallet) await ensureSigner(me.wallet);
      const offer = await api<{ transaction: string; amountUsd: number }>(`/orders/${order.id}/sell`, {});
      const signed = practice ? offer.transaction : await signPayment(offer.transaction);
      onSold(await api<OrderView>(`/orders/${order.id}/sell/submit`, { signed }));
      notify(`Sold for ${money(offer.amountUsd)}.`);
    } catch (e) { notify(friendly(e as Error)); } finally { setBusy(false); }
  }
  const hours = quote.expiresAt ? Math.max(0, Math.round((quote.expiresAt - Date.now()) / 3_600_000)) : null;
  const share = order.valueUsd ? Math.round(quote.amountUsd / order.valueUsd * 100) : null;
  return <div className="enter mt-5 flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-raised p-4">
    <div className="min-w-0"><div className="label">Quick sell</div><div className="mt-0.5 text-sm text-muted">Sell it back to Collector Crypt{share ? ` at ${share}% of its value` : ''}{hours !== null ? `. Offer open ${hours}h more.` : '.'}</div></div>
    <button className="btn btn-outline btn-sm" disabled={busy} onClick={sell}>{busy ? 'Selling…' : `Sell for ${money(quote.amountUsd)}`}</button>
  </div>;
}

const CONFETTI = ['#ffd23f', '#45d483', '#4aa3ff', '#ff8a4c', '#c77dff'];
function Confetti() {
  return <div className="confetti" aria-hidden="true">{Array.from({ length: 28 }, (_, i) =>
    <i key={i} style={{ left: `${(i * 37) % 100}%`, background: CONFETTI[i % CONFETTI.length], animationDelay: `${(i % 7) * 70}ms` }} />)}</div>;
}
function Mini({ label, value, tone = '' }: { label: string; value: string; tone?: string }) {
  return <div className="min-w-0"><div className="label truncate">{label}</div><div className={`pixel num mt-1 truncate text-sm sm:text-lg ${tone}`}>{value}</div></div>;
}
