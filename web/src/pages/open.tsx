import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowRight, ArrowUpRight, Check, Coins, Package, ShieldCheck } from 'lucide-react';
import type { OrderView, PoolView, Quote } from '../../../shared/types';
import { ago, api, friendly, money, pct, solscan } from '../api';
import { Link, useApp } from '../app';
import { ensureSigner, hasSigner, signPayment } from '../wallet';
import { CoverageLadder } from '../parts/holder';
import { ContractAddress } from '../parts/contract';
import { Modal, PackArt, RebateBar, SectionTitle, Slab, packStyle } from '../ui';

type Pack = { priceUsd: number; quote: Quote };
type Activity = { kind: 'onsite' | 'offsite'; wallet: string; priceUsd: number; valueUsd: number; rebateUsd: number; cardName: string | null; at: number };
const FINAL = ['complete', 'refunded', 'expired', 'review'];

export function OpenPage() {
  const { me, config, connect, notify, refresh, version } = useApp();
  const [packs, setPacks] = useState<Pack[] | null>(null);
  const [packsFailed, setPacksFailed] = useState(false);
  const [pool, setPool] = useState<PoolView | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [history, setHistory] = useState<OrderView[]>([]);
  const [order, setOrder] = useState<OrderView | null>(null);
  const [opening, setOpening] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setInterval>>(undefined);

  const load = useCallback(() => {
    setPacksFailed(false);
    api<{ packs: Pack[] }>('/packs').then(r => setPacks(r.packs)).catch(() => setPacksFailed(true));
    api<PoolView>('/pool').then(setPool).catch(() => {});
    api<{ items: Activity[] }>('/activity').then(r => setActivity(r.items)).catch(() => {});
    if (me.wallet) api<{ orders: OrderView[] }>('/orders').then(r => setHistory(r.orders.filter(o => o.card))).catch(() => {}); else setHistory([]);
  }, [me.wallet, notify]);
  useEffect(load, [load, version]);
  useEffect(() => () => clearInterval(timer.current), []);

  function follow(id: string) {
    clearInterval(timer.current);
    timer.current = setInterval(async () => {
      try { const next = await api<OrderView>(`/orders/${id}`); setOrder(next); if (FINAL.includes(next.status)) { clearInterval(timer.current); load(); refresh(); } }
      catch { /* keep polling through brief network trouble */ }
    }, 1000);
  }

  async function open(pack: Pack) {
    if (!me.wallet) return connect();
    const practice = config?.mode === 'practice' && !hasSigner();
    // Make sure the signing wallet is ready (and is the signed-in one) before an order reserves anything.
    if (!practice) {
      try { await ensureSigner(me.wallet); }
      catch (e) { notify((e as Error).message); if ((e as { reconnect?: boolean }).reconnect) connect(); return; }
    }
    setOpening(pack.priceUsd); setOrder(null);
    let unpaid: string | null = null;
    try {
      const { order: created, transaction } = await api<{ order: OrderView; transaction: string }>('/orders', { priceUsd: pack.priceUsd });
      unpaid = created.id; setOrder(created);
      const signed = practice ? 'practice' : await signPayment(transaction);
      setOrder(await api<OrderView>(`/orders/${created.id}/pay`, { signed }));
      unpaid = null;
      follow(created.id);
    } catch (e) {
      // Release the unpaid order so the buyer can try again straight away.
      if (unpaid) await api(`/orders/${unpaid}/cancel`, {}).catch(() => {});
      notify(friendly(e as Error)); setOpening(null); setOrder(null); load();
    }
  }
  const close = () => { clearInterval(timer.current); setOpening(null); setOrder(null); };

  const coverage = me.holder?.tier?.onsiteCoverageBps ?? 5_000;
  return <>
    {/* Hero */}
    <section className="grid grid-cols-1 items-center gap-10 py-12 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] md:py-20">
      <div className="rise">
        <span className="chip bg-red-soft text-red"><ShieldCheck size={13} />For holders</span>
        <h1 className="mt-5 text-5xl font-bold leading-[.95] tracking-tight sm:text-6xl md:text-7xl">Rip packs.<br /><span className="text-red">Lose less.</span></h1>
        <p className="mt-6 max-w-md text-lg text-muted">Open Collector Crypt packs with protection. When a pull is worth less than the pack, part of the difference lands back in your wallet, automatically.</p>
        <div className="mt-8 flex flex-wrap gap-3">
          <a href="#packs" className="btn btn-red h-12 px-6">Open a pack<ArrowDown size={16} /></a>
          <Link href="/claim" className="btn btn-ghost h-12 px-6">Opened one elsewhere?</Link>
        </div>
        <ContractAddress variant="hero" className="mt-6" />
        <div className="mt-10 flex flex-wrap gap-x-10 gap-y-4">
          <HeroStat label="In the pool" value={money(pool?.balanceUsd)} />
          <HeroStat label="Paid back" value={money(pool ? pool.totals.onsiteRebatesUsd + pool.totals.offsiteRebatesUsd : null)} />
          <HeroStat label="Packs protected" value={pool ? String(pool.totals.packsOpened) : '—'} />
        </div>
      </div>
      <Example coverageBps={coverage} tierName={me.holder?.tier?.name ?? 'Collector'} />
    </section>

    {/* Coverage */}
    <section className="pb-14"><CoverageLadder /></section>

    {/* Packs */}
    <section id="packs" className="scroll-mt-24 pb-16">
      <SectionTitle title="Choose a pack" sub="One graded Pokémon card per pack, straight from Collector Crypt. Prices include protection." />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {(packs ?? []).map(p => <PackCard key={p.priceUsd} pack={p} signedIn={!!me.wallet} busy={opening !== null} onOpen={() => open(p)} />)}
        {!packs && !packsFailed && [0, 1, 2, 3].map(i => <div key={i} className="card aspect-[3/5] animate-pulse" />)}
        {!packs && packsFailed && <div className="card col-span-full flex flex-wrap items-center justify-between gap-3 p-6"><div><div className="font-semibold">Packs could not be loaded.</div><div className="text-sm text-muted">Collector Crypt or our server did not answer. Your funds are not affected.</div></div><button className="btn btn-ink" onClick={load}>Try again</button></div>}
        {packs && !packs.length && <div className="card col-span-full p-6 text-sm text-muted">No packs are available on Collector Crypt right now. Check back soon.</div>}
      </div>
    </section>

    {/* How it works */}
    <section className="pb-16">
      <SectionTitle title="How it works" action={<Link href="/docs" className="text-sm font-semibold text-blue underline-offset-2 hover:underline">Read the docs</Link>} />
      <div className="grid gap-4 md:grid-cols-3">
        {[
          [Coins, 'Hold the token', 'Your tier is your lowest balance over the window, so it rewards real holders, not quick flips.'],
          [Package, 'Open a protected pack', 'Pay once in USDC. We buy the pack on Collector Crypt and send the graded card to your wallet.'],
          [ShieldCheck, 'Get the difference back', `If the card is worth less than the pack, ${pct(coverage)} of that gap is sent to you right away.`],
        ].map(([Icon, title, text], i) => { const I = Icon as typeof Coins; return <div key={i} className="card p-6">
          <div className="flex items-center gap-3"><span className="num grid size-8 place-items-center rounded-full bg-yellow text-sm font-semibold">{i + 1}</span><I size={18} className="text-muted" /></div>
          <h3 className="mt-4 font-semibold">{title as string}</h3><p className="mt-1.5 text-sm text-muted">{text as string}</p>
        </div>; })}
      </div>
    </section>

    {history.length > 0 && <section className="pb-16">
      <SectionTitle title="Your pulls" />
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        {history.slice(0, 12).map(o => <div key={o.id}>
          <Slab card={o.card!} priceUsd={o.priceUsd} />
          <div className="mt-2 text-center text-xs">{o.rebateUsd ? <span className="font-semibold text-grass">+{money(o.rebateUsd)} back</span> : <span className="text-muted">{money(o.priceUsd)} pack</span>}</div>
        </div>)}
      </div>
    </section>}

    <section className="pb-8">
      <SectionTitle title="Live rebates" sub="Every pull that paid out, on-site and off-site." />
      {activity.length ? <div className="card divide-y divide-line">
        {activity.map((a, i) => <div key={i} className="flex items-center gap-4 px-5 py-3.5">
          <span className="size-2.5 shrink-0 rounded-full" style={{ background: packStyle(a.priceUsd).top }} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{a.cardName ? a.cardName.split(' · ').slice(0, 2).join(' · ') : 'Off-site pull'}</div>
            <div className="truncate text-xs text-muted"><span className="num">{a.wallet}</span> · {money(a.priceUsd)} {packStyle(a.priceUsd).name} pack · worth <span className="num">{money(a.valueUsd)}</span></div>
          </div>
          <div className="shrink-0 text-right">
            <div className={`num text-sm font-semibold ${a.rebateUsd ? 'text-grass' : 'text-ink'}`}>{a.rebateUsd ? `+${money(a.rebateUsd)}` : 'Hit!'}</div>
            <div className="text-xs text-faint">{ago(a.at)}</div>
          </div>
        </div>)}
      </div> : <div className="card px-5 py-8 text-center text-sm text-muted">No pulls yet. Be the first.</div>}
    </section>

    <Modal open={opening !== null} onClose={close} dismissable={!order || FINAL.includes(order.status)} width="max-w-2xl" label="Opening your pack">
      {opening !== null && <OpenFlow priceUsd={opening} order={order} onAgain={() => { const p = packs?.find(x => x.priceUsd === opening); close(); if (p) setTimeout(() => open(p), 50); }} onClose={close} />}
    </Modal>
  </>;
}

function HeroStat({ label, value }: { label: string; value: string }) {
  return <div><div className="num text-2xl font-semibold">{value}</div><div className="text-xs text-muted">{label}</div></div>;
}

/** A worked example at the visitor's own coverage. */
function Example({ coverageBps, tierName }: { coverageBps: number; tierName: string }) {
  const price = 25, fee = 2.5, value = 9.3, rebate = Math.floor((price - value) * coverageBps / 100) / 100;
  return <div className="card rise relative p-6 shadow-[0_30px_80px_-40px_rgb(23_23_28/.35)] sm:p-8">
    <div className="label">Example pull</div>
    <div className="mt-4 grid grid-cols-[110px_1fr] gap-6 sm:grid-cols-[130px_1fr]">
      <Slab card={{ name: 'Sylveon · Crown Zenith · PSA 9', image: null, insuredValueUsd: value, rarity: 'Common' }} priceUsd={price} />
      <dl className="grid content-start gap-2.5 text-sm">
        <Row k="Pack + protection" v={money(price + fee)} />
        <Row k="Card is worth" v={money(value)} />
        <Row k="Shortfall" v={money(price - value)} tone="text-red" />
        <Row k={`${tierName} covers`} v={pct(coverageBps)} />
        <div className="mt-1 border-t border-line pt-3"><Row k="Back to you" v={`+${money(rebate)}`} big /></div>
      </dl>
    </div>
    <div className="mt-6"><RebateBar priceUsd={price} valueUsd={value} rebateUsd={rebate} /></div>
  </div>;
}
function Row({ k, v, tone = '', big }: { k: string; v: string; tone?: string; big?: boolean }) {
  return <div className="flex items-baseline justify-between gap-3"><dt className={big ? 'font-semibold' : 'text-muted'}>{k}</dt><dd className={`num font-semibold ${big ? 'text-2xl text-grass' : tone}`}>{v}</dd></div>;
}

function PackCard({ pack, signedIn, busy, onOpen }: { pack: Pack; signedIn: boolean; busy: boolean; onOpen: () => void }) {
  const q = pack.quote, blocked = signedIn && !q.protected;
  return <article className="group flex flex-col">
    <PackArt priceUsd={pack.priceUsd} />
    <div className="mt-4 flex items-baseline justify-between gap-2">
      <span className="num text-lg font-semibold">{money(q.totalMicros / 1e6)}</span>
      <span className="text-xs text-muted">incl. {money(q.feeMicros / 1e6)} fee</span>
    </div>
    <div className="mt-1 min-h-10 text-sm">
      {q.protected ? <span className="text-grass">Up to <b className="num">{money(q.maxRebateMicros / 1e6)}</b> back · {pct(q.coverageBps)}</span>
        : signedIn ? <span className="text-xs text-red">{q.reason}</span> : <span className="text-muted">Connect to see your coverage</span>}
    </div>
    <button className="btn btn-ink mt-3 w-full" disabled={busy || blocked} onClick={onOpen}>{signedIn ? 'Open' : 'Connect to open'}<ArrowRight size={15} /></button>
  </article>;
}

const STEPS = [{ label: 'Payment', at: ['awaiting_payment', 'paying'] }, { label: 'Opening', at: ['paid', 'buying'] }, { label: 'Card sent', at: ['delivering'] }, { label: 'Rebate', at: ['settling'] }];

function OpenFlow({ priceUsd, order, onAgain, onClose }: { priceUsd: number; order: OrderView | null; onAgain: () => void; onClose: () => void }) {
  const status = order?.status;
  const step = status === 'complete' ? STEPS.length : STEPS.findIndex(s => s.at.includes(status ?? 'awaiting_payment'));
  const revealed = !!order?.card;
  const failed = status === 'refunded' || status === 'expired' || status === 'review';
  const hit = !!order && order.valueUsd !== null && order.valueUsd >= order.priceUsd;
  return <div className="grid gap-8 sm:grid-cols-[200px_1fr]">
    <div className="mx-auto w-[170px] sm:w-[200px]">
      {revealed ? <div className="reveal"><Slab card={order!.card!} priceUsd={priceUsd} /></div> : <PackArt priceUsd={priceUsd} className={status && status !== 'awaiting_payment' ? 'shake' : 'float'} />}
    </div>
    <div>
      <div className="label">{money(priceUsd)} {packStyle(priceUsd).name} pack · {pct(order?.coverageBps ?? 0)} covered</div>
      <h2 className="mt-1 text-2xl font-semibold tracking-tight">{failed ? (status === 'review' ? 'Needs a quick check' : status === 'refunded' ? 'Refunded in full' : 'Payment window closed') : revealed ? order!.card!.name.split(' · ')[0] : !order || status === 'awaiting_payment' ? 'Confirm in your wallet' : 'Opening your pack…'}</h2>
      {revealed && <p className="text-sm text-muted">{order!.card!.name.split(' · ').slice(1).join(' · ')}</p>}

      {!failed && <ol className="mt-5 flex flex-wrap gap-1.5">
        {STEPS.map((s, i) => <li key={s.label} className={`chip ${i < step ? 'bg-grass-soft text-grass' : i === step ? 'bg-red-soft text-red' : 'bg-bg text-faint'}`}>
          {i < step ? <Check size={12} /> : i === step ? <span className="dot-pulse" /> : null}{s.label}</li>)}
      </ol>}

      {order && order.valueUsd !== null && !failed && <div className="rise mt-6">
        <div className="grid grid-cols-3 gap-4">
          <Mini label="You paid" value={money(order.totalUsd)} />
          <Mini label="Card value" value={money(order.valueUsd)} tone={order.valueUsd >= order.priceUsd ? 'text-grass' : ''} />
          <Mini label="Back to you" value={hit ? 'Not needed' : order.rebateUsd === null ? '…' : `+${money(order.rebateUsd)}`} tone={hit ? 'text-muted' : 'text-grass'} />
        </div>
        {order.rebateUsd !== null && order.valueUsd < order.priceUsd && <div className="mt-5"><RebateBar priceUsd={order.priceUsd} valueUsd={order.valueUsd} rebateUsd={order.rebateUsd} /></div>}
        {status === 'complete' && order.valueUsd >= order.priceUsd && <p className="mt-4 rounded-2xl bg-yellow-soft px-4 py-3 text-sm font-medium">A hit! This card beat the pack price, so no rebate was needed.</p>}
      </div>}

      {!(status === 'complete' && hit) && <p className={`mt-4 text-sm ${status === 'review' ? 'text-red' : 'text-muted'}`}>{status === 'review' ? 'Your payment is safe. The team has been alerted and will finish this order.' : order?.message}</p>}

      <div className="mt-4 flex flex-wrap gap-4 text-xs">
        {([['Payment', order?.paymentSignature], ['Card transfer', order?.nftSignature], ['Rebate', order?.rebateSignature], ['Refund', order?.refundSignature]] as const).filter(([, s]) => s).map(([label, s]) =>
          <a key={label} className="inline-flex items-center gap-0.5 text-muted underline-offset-2 hover:text-ink hover:underline" href={solscan('tx', s!)} target="_blank" rel="noreferrer">{label}<ArrowUpRight size={12} /></a>)}
      </div>

      {(status === 'complete' || failed) && <div className="mt-6 flex gap-2">
        {status === 'complete' && <button className="btn btn-red" onClick={onAgain}>Open another</button>}
        <button className="btn btn-ghost" onClick={onClose}>Done</button>
      </div>}
    </div>
  </div>;
}
function Mini({ label, value, tone = '' }: { label: string; value: string; tone?: string }) {
  return <div><div className="label">{label}</div><div className={`num mt-1 text-xl font-semibold ${tone}`}>{value}</div></div>;
}
