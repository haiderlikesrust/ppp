import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ArrowDown, ArrowRight, ArrowUpRight } from 'lucide-react';
import type { OrderView, PackStats, PoolView, Quote, StatsView } from '../../../shared/types';
import { ago, api, friendly, money, pct, solscan } from '../api';
import { Link, useApp } from '../app';
import { ensureSigner, hasSigner, signPayment, signPayments } from '../wallet';
import { CoverageLadder } from '../parts/holder';
import { ContractAddress } from '../parts/contract';
import { PackOpening } from '../parts/opening';
import { CashOut } from '../parts/cashout';
import { ShareButton } from '../parts/share';
import { RecentPullsStrip, useRecentPulls } from '../parts/pulls';
import { Booster, GradeRing, Modal, SectionTitle, TradingCard, TypeBadge, isWatch, packStyle, useCount } from '../ui';
import { packDef, sellBpsFor } from '../../../shared/packs';
import { useShowcase } from '../showcase';

type Pack = { code: string; priceUsd: number; quote: Quote };
type Activity = { kind: 'onsite' | 'offsite'; wallet: string; code: string; priceUsd: number; valueUsd: number; rebateUsd: number; cardName: string | null; at: number };
const FINAL = ['complete', 'refunded', 'expired', 'review'];
const IN_PROGRESS = ['paying', 'paid', 'buying', 'delivering', 'settling', 'refunding'];
/** A real pull's shape, for the frames before Collector Crypt's example has loaded. */
const SAMPLE = { name: 'Sylveon · Crown Zenith · PSA 9', image: null, insuredValueUsd: 9.3, rarity: 'Common' };

export function OpenPage() {
  const { me, config, connect, notify, refresh, version, bump } = useApp();
  const [packs, setPacks] = useState<Pack[] | null>(null);
  const [packsFailed, setPacksFailed] = useState(false);
  // The wallet's cooldown: when it can open its next pack.
  const [nextPackAt, setNextPackAt] = useState<number | null>(null);
  const now = useNow(!!nextPackAt), waitMs = nextPackAt ? Math.max(0, nextPackAt - now) : 0;
  // Packs per open (1, 3 or 5), capped by what the server allows this wallet.
  const [qty, setQty] = useState(1), [maxPerOpen, setMaxPerOpen] = useState(5), count = Math.min(qty, maxPerOpen);
  // Packs opened together are revealed one after another, then summed up.
  const [batch, setBatch] = useState<Batch | null>(null), batchRef = useRef<Batch | null>(null);
  const [batchOrders, setBatchOrders] = useState<OrderView[] | null>(null);
  const toBatch = (b: Batch | null) => { batchRef.current = b; setBatch(b); };
  const [pool, setPool] = useState<PoolView | null>(null);
  const [stats, setStats] = useState<StatsView | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [history, setHistory] = useState<OrderView[]>([]);
  const [order, setOrder] = useState<OrderView | null>(null);
  const [opening, setOpening] = useState<Pack | null>(null);
  const [allActivity, setAllActivity] = useState(false);
  const poll = useRef<ReturnType<typeof setTimeout>>(undefined);
  const following = useRef<string | null>(null), inFlight = useRef(false), aborted = useRef(false);

  const load = useCallback(() => {
    setPacksFailed(false);
    api<{ packs: Pack[]; nextPackAt: number | null; maxPerOpen?: number }>('/packs').then(r => { setPacks(r.packs); setNextPackAt(r.nextPackAt ?? null); setMaxPerOpen(r.maxPerOpen ?? 1); }).catch(() => setPacksFailed(true));
    api<PoolView>('/pool').then(setPool).catch(() => {});
    api<StatsView>('/stats').then(setStats).catch(() => {});
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
        // Bumping reloads this page's lists, the Just graded strip and the vault balance.
        if (FINAL.includes(next.status)) {
          following.current = null; bump(); refresh().catch(() => {});
          // The last pack of a batch: add the whole batch up.
          const b = batchRef.current;
          if (b && b.index === b.ids.length - 1) Promise.all(b.ids.map(o => api<OrderView>(`/orders/${o}`))).then(all => { if (batchRef.current === b) setBatchOrders(all); }).catch(() => {});
          return;
        }
      } catch (e) {
        if (following.current !== id) return;
        const status = (e as { status?: number }).status;
        if (status === 401 || status === 404) { following.current = null; notify('This order can no longer be followed here. Its result shows under Your pulls.'); return; }
      }
      poll.current = setTimeout(tick, 1000);
    };
    poll.current = setTimeout(tick, 500);
  }

  /** Opens `count` packs of one machine: one wallet approval for all the payments, then the reveals one by one. */
  async function open(pack: Pack, count = 1) {
    if (!me.wallet) return connect();
    if (inFlight.current) return;
    inFlight.current = true; aborted.current = false;
    setOpening(pack); setOrder(null); toBatch(null); setBatchOrders(null);
    let unpaid: string[] = [];
    try {
      const practice = config?.mode === 'practice' && !hasSigner();
      // Make sure the signing wallet is ready (and is the signed-in one) before an order is created.
      if (!practice) {
        try { await ensureSigner(me.wallet); }
        catch (e) { notify((e as Error).message); if ((e as { reconnect?: boolean }).reconnect) connect(); setOpening(null); return; }
      }
      if (aborted.current) return;
      const created = count > 1
        ? await api<{ orders: OrderView[]; transactions: string[] }>('/orders', { code: pack.code, count })
        : await api<{ order: OrderView; transaction: string }>('/orders', { code: pack.code }).then(r => ({ orders: [r.order], transactions: [r.transaction] }));
      unpaid = created.orders.map(o => o.id);
      if (aborted.current) return;
      setOrder(created.orders[0]);
      const signed = practice ? created.orders.map(() => 'practice') : count > 1 ? await signPayments(created.transactions) : [await signPayment(created.transactions[0])];
      // Closed while the wallet prompt was open: don't send a payment nobody is watching.
      if (aborted.current) return;
      // Pay in order; if one is refused (say the pool filled up), the rest are released, not charged.
      const paid: string[] = []; let refused: Error | null = null;
      for (const [i, o] of created.orders.entries()) {
        try { const view = await api<OrderView>(`/orders/${o.id}/pay`, { signed: signed[i] }); if (!paid.length) setOrder(view); }
        catch (e) {
          // A dropped connection can hide a payment that was sent: check before calling it a failure.
          const check = await api<OrderView>(`/orders/${o.id}`).catch(() => null);
          if (!check || check.status === 'awaiting_payment') { refused = e as Error; break; }
          if (!paid.length) setOrder(check);
        }
        paid.push(o.id); unpaid = unpaid.filter(id => id !== o.id);
      }
      if (!paid.length) throw refused ?? new Error('The payment did not go through. Nothing was charged.');
      if (refused) notify(`Opened ${paid.length} of ${count}. ${friendly(refused)} Nothing was charged for the rest.`);
      if (paid.length > 1) toBatch({ ids: paid, index: 0 });
      follow(paid[0]);
    } catch (e) {
      if (!aborted.current) { notify(friendly(e as Error)); setOpening(null); setOrder(null); load(); }
    } finally {
      // Release unpaid orders so the buyer can try again straight away.
      for (const id of unpaid) await api(`/orders/${id}/cancel`, {}).catch(() => {});
      inFlight.current = false;
    }
  }

  /** Moves the reveal on to the next pack of the batch. It has been opening in the background meanwhile. */
  async function nextInBatch() {
    const b = batchRef.current;
    if (!b || b.index >= b.ids.length - 1) return;
    const nb = { ids: b.ids, index: b.index + 1 }, id = nb.ids[nb.index];
    const view = await api<OrderView>(`/orders/${id}`).catch(() => null);
    toBatch(nb);
    if (view) setOrder(view);
    follow(id);
  }

  /** Reopens an order that is still going (or just finished) from the pulls list. */
  function resume(o: OrderView) {
    const pack = packs?.find(p => p.code === o.packCode) ?? { code: o.packCode, priceUsd: o.priceUsd, quote: { coverageBps: o.coverageBps } as Quote };
    setOpening(pack); setOrder(o);
    if (!FINAL.includes(o.status)) follow(o.id);
  }

  const close = () => {
    const running = !!order && IN_PROGRESS.includes(order.status);
    const others = batchRef.current ? batchRef.current.ids.length - batchRef.current.index - 1 : 0;
    aborted.current = true; following.current = null; clearTimeout(poll.current);
    setOpening(null); setOrder(null); toBatch(null); setBatchOrders(null);
    if (running || others) notify(`Your ${others ? 'packs keep' : 'pack keeps'} opening in the background. Find ${others ? 'them' : 'it'} under Your pulls.`);
    load();
  };

  /** Sold cards come back as fresh orders: swap them into the open result and the batch totals. */
  const onSold = (sold: OrderView[]) => {
    const fresh = new Map(sold.map(o => [o.id, o]));
    setOrder(o => o && fresh.get(o.id) ? fresh.get(o.id)! : o);
    setBatchOrders(all => all ? all.map(o => fresh.get(o.id) ?? o) : all);
    bump();
  };

  const s = config?.settings, feeBps: number = s?.feeBps ?? 1_000;
  const tier = me.holder?.tier;
  const sample = s?.tiers?.[1] ?? { id: 't2', name: 'Mint', onsiteCoverageBps: 5_000 };
  const mode = config?.mode;
  const statFor = useMemo(() => new Map(stats?.packs.map(p => [p.code, p])), [stats]);
  const example = statFor.get('pokemon_25')?.terms[tier?.id ?? sample.id];
  const opened = pool?.totals.packsOpened ?? null, paidBack = pool ? pool.totals.onsiteRebatesUsd + pool.totals.offsiteRebatesUsd : null;
  return <>
    <Hero mode={mode} vault={pool?.balanceUsd ?? null} paidBack={paidBack} opened={opened} />

    <section id="packs" className="scroll-mt-24 pb-16">
      <SectionTitle title="The packs" sub="One graded card or watch per pack, straight from Collector Crypt. Each fee comes from that pack's own recent pulls."
        action={me.wallet && maxPerOpen > 1 ? <div role="radiogroup" aria-label="Packs per open" className="flex rounded-[10px] border border-line p-0.5">
          {[1, 3, 5].filter(n => n <= maxPerOpen).map(n => <button key={n} role="radio" aria-checked={count === n} onClick={() => setQty(n)} className={`font-display h-8 min-w-10 rounded-lg px-3 text-sm transition ${count === n ? 'bg-accent text-on-accent' : 'text-muted hover:text-ink'}`}>{n}×</button>)}
        </div> : undefined} />
      {packs && (['pokemon', 'watch'] as const).map(kind => {
        const list = packs.filter(p => (packDef(p.code)?.kind ?? 'pokemon') === kind);
        return list.length ? <div key={kind} className="mb-8 last:mb-0">
          {kind === 'watch' && <div className="label mb-3">Luxury watches</div>}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">{list.map(p => <PackCard key={p.code} pack={p} stat={statFor.get(p.code)} signedIn={!!me.wallet} busy={opening !== null} waitMs={waitMs} count={count} onOpen={() => open(p, count)} />)}</div>
        </div> : null;
      })}
      {!packs && !packsFailed && <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">{[0, 1, 2, 3].map(i => <div key={i} className="shimmer h-80 rounded-2xl" />)}</div>}
      {!packs && packsFailed && <div className="card flex flex-wrap items-center justify-between gap-3 p-6"><div><div className="font-display text-lg">Packs could not be loaded.</div><div className="text-sm text-muted">Collector Crypt or our server did not answer. Your funds are not affected.</div></div><button className="btn btn-outline" onClick={load}>Try again</button></div>}
      {packs && !packs.length && <div className="card p-6 text-sm text-muted">No packs are available on Collector Crypt right now. Check back soon.</div>}
    </section>

    <section className="pb-16">
      <Example feeBps={example?.feeBps ?? feeBps} coverageBps={example?.coverageBps ?? tier?.onsiteCoverageBps ?? sample.onsiteCoverageBps} tierName={tier?.name ?? sample.name} illustrative={!tier} />
    </section>

    <RecentPullsStrip />

    <section className="pb-16"><SectionTitle title="Your grade" sub="Hold more of the token and more of a bad pull comes back." /><CoverageLadder /></section>

    {history.length > 0 && <section className="pb-16">
      <SectionTitle title="Your pulls" sub="Tap one that's still opening to watch it." action={<Link href="/portfolio" className="font-display text-accent hover:underline">Full portfolio →</Link>} />
      <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 xl:grid-cols-6">
        {history.slice(0, 6).map(o => <button key={o.id} onClick={() => resume(o)} className="min-w-0 text-left">
          {o.card ? <TradingCard card={o.card} priceUsd={o.priceUsd} size="sm" watch={isWatch(o.packCode)} /> : <Booster code={o.packCode} priceUsd={o.priceUsd} className={IN_PROGRESS.includes(o.status) ? 'float' : 'opacity-50 grayscale'} />}
          <div className="mt-2 truncate text-center text-xs">{o.sale ? <span className="font-display num text-accent">Sold {money(o.sale.amountUsd)}</span> : o.rebateUsd ? <span className="font-display num text-gain">+{money(o.rebateUsd)}</span> : o.card ? <span className="text-muted">{money(o.priceUsd)} pack</span> : <span className="text-muted">{IN_PROGRESS.includes(o.status) ? 'Opening…' : o.status === 'refunded' ? 'Refunded' : o.status === 'review' ? 'Being checked' : 'Expired'}</span>}</div>
        </button>)}
      </div>
    </section>}

    <section className="pb-8">
      <SectionTitle title="Live rebates" sub="Every pull that paid out, here and elsewhere." action={<span className="tag bg-gain-soft text-gain"><i className="live-dot" />Live</span>} />
      {activity.length ? <div className="card overflow-hidden">
        {activity.slice(0, allActivity ? activity.length : 6).map((a, i) => <div key={`${a.at}-${i}`} className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-0 sm:px-5">
          <TypeBadge code={a.code} priceUsd={a.priceUsd} size={32} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{a.cardName ? a.cardName.split(' · ').slice(0, 2).join(' · ') : 'Opened off-site'}</div>
            <div className="num truncate text-xs text-muted">{a.wallet} · {money(a.priceUsd)} {packStyle(a.code, a.priceUsd).name} · worth {money(a.valueUsd)}</div>
          </div>
          <div className="shrink-0 text-right">{a.rebateUsd ? <span className="font-display num text-gain">+{money(a.rebateUsd)}</span> : <span className="tag bg-spark-soft text-warn">Hit</span>}<div className="text-[11px] text-faint">{ago(a.at)}</div></div>
        </div>)}
        {activity.length > 6 && <button className="font-display flex h-11 w-full items-center justify-center gap-1.5 text-sm text-muted hover:text-ink" onClick={() => setAllActivity(v => !v)}>{allActivity ? 'Show less' : `Show all ${activity.length}`}<ArrowDown size={14} className={allActivity ? 'rotate-180' : ''} /></button>}
      </div> : <div className="card px-5 py-8 text-center text-sm text-muted">No pulls yet. Be the first.</div>}
    </section>

    <Modal open={opening !== null} onClose={close} width="max-w-[56rem]" label="Opening your pack">
      {opening && <OpenFlow pack={opening} order={order} batch={batch ? { index: batch.index, count: batch.ids.length } : null} batchOrders={batchOrders} onNext={nextInBatch} onSold={onSold}
        onAgain={() => { const p = packs?.find(x => x.code === opening.code), n = batch ? batch.ids.length : 1; close(); if (p) setTimeout(() => open(p, Math.min(n, maxPerOpen)), 50); }} onClose={close} />}
    </Modal>
  </>;
}

/** The promise, centered, over a hand of real pulls fanned out like cards held up to show. */
function Hero({ mode, vault, paidBack, opened }: { mode?: string; vault: number | null; paidBack: number | null; opened: number | null }) {
  const front = useShowcase()?.example, recent = useRecentPulls();
  const best = [...(recent ?? [])].filter(p => p.card?.image).sort((a, b) => b.valueUsd / b.priceUsd - a.valueUsd / a.priceUsd).slice(0, 4);
  const spot = (i: number) => ({ translate: `calc(-50% + ${i * 66}%) ${Math.abs(i) * 15}px`, rotate: `${i * 7}deg`, zIndex: 3 - Math.abs(i), animationDelay: `${0.1 + Math.abs(i) * 0.08}s` }) as CSSProperties;
  const back = Math.floor((25 - (front ?? SAMPLE).insuredValueUsd * sellBpsFor('pokemon_25') / 10_000) * 50) / 100;
  return <section className="pb-14 pt-10 text-center md:pt-16">
    <div className="enter mx-auto max-w-3xl">
      <span className="label inline-flex items-center gap-2"><i className="live-dot" />{mode === 'mainnet' ? 'Live on Solana' : mode === 'practice' ? 'Practice mode' : 'Launching on Solana'}</span>
      <h1 className="font-display mt-4 text-[2.9rem] font-bold leading-[1.04] tracking-tight sm:text-7xl">Every pack gets a <em>second grade.</em></h1>
      <p className="mx-auto mt-5 max-w-xl text-lg text-muted">Open Collector Crypt packs here. When a card comes in under the pack price, part of the gap lands back in your wallet in USDC, right away.</p>
      <div className="mt-7 flex flex-wrap items-center justify-center gap-x-5 gap-y-3">
        <a href="#packs" className="btn btn-primary">See the packs<ArrowDown size={17} /></a>
        <ContractAddress variant="hero" />
      </div>
    </div>
    <div className="relative mx-auto mt-12 h-[250px] max-w-3xl sm:h-[310px]" aria-hidden="true">
      {[best[0], best[1], best[2], best[3]].map((p, n) => { const i = [-2, -1, 1, 2][n]; return p?.card ? <div key={p.id} className={`rise absolute bottom-0 left-1/2 w-[34%] sm:w-[190px] ${Math.abs(i) > 1 ? 'hidden sm:block' : ''}`} style={spot(i)}><TradingCard tilt card={{ name: p.card.name, image: p.card.image, insuredValueUsd: p.valueUsd, rarity: null }} /></div> : null; })}
      <div className="rise absolute bottom-0 left-1/2 w-[38%] sm:w-[205px]" style={spot(0)}>
        <div className="relative"><TradingCard tilt holo card={front ?? SAMPLE} /><div className="absolute inset-x-0 -bottom-3 z-[4] grid place-items-center"><span className="sticker num">Regraded +{money(back)}</span></div></div>
      </div>
    </div>
    <dl className="mx-auto mt-12 grid max-w-2xl grid-cols-3 divide-x divide-line">
      <Figure label="In the vault" value={vault} />
      <Figure label="Paid back" value={paidBack} tone="text-gain" />
      <Figure label="Packs opened" value={opened} count />
    </dl>
  </section>;
}

function Figure({ label, value, tone = '', count = false }: { label: string; value: number | null; tone?: string; count?: boolean }) {
  const shown = useCount(value);
  return <div className="min-w-0 px-2"><dt className="label truncate">{label}</dt><dd className={`font-display num mt-0.5 truncate text-xl sm:text-2xl ${tone}`}>{value === null ? '—' : count ? Math.round(shown).toLocaleString('en-US') : money(Math.round(shown * 100) / 100)}</dd></div>;
}

/** A worked example on a real $25 pull from Collector Crypt, at the visitor's own terms when they have a grade. */
function Example({ feeBps, coverageBps, tierName, illustrative }: { feeBps: number; coverageBps: number; tierName: string; illustrative: boolean }) {
  const real = useShowcase()?.example;
  const card = real ? { name: real.name, image: real.image, insuredValueUsd: real.insuredValueUsd, rarity: real.rarity } : SAMPLE;
  const price = 25, fee = Math.round(price * feeBps) / 10_000, value = card.insuredValueUsd, sell = Math.round(value * sellBpsFor('pokemon_25') / 100) / 100, rebate = Math.max(0, Math.floor((price - sell) * coverageBps / 100) / 100);
  return <div>
    <SectionTitle title="How a regrade works" sub={`${real ? 'A real $25 pull' : 'An example $25 pull'}, ${illustrative ? `at the ${tierName} grade` : `at your ${tierName} grade`}.`} />
    <div className="card grid items-center gap-6 p-5 sm:p-7 md:grid-cols-[160px_minmax(0,1fr)_auto] md:gap-10">
      <div className="mx-auto w-[160px] md:w-full"><TradingCard card={card} priceUsd={price} tilt /></div>
      <div className="min-w-0">
        <dl className="grid gap-2.5">
          <div className="leader"><dt className="text-muted">Pack + {money(fee)} fee</dt><dd className="font-display num">{money(price + fee)}</dd></div>
          <div className="leader"><dt className="text-muted">Card is insured at</dt><dd className="font-display num">{money(value)}</dd></div>
          <div className="leader"><dt className="text-muted">It sells back for</dt><dd className="font-display num">{money(sell)}</dd></div>
          <div className="leader"><dt className="text-muted">Under the pack price by</dt><dd className="font-display num text-loss">{money(price - sell)}</dd></div>
          <div className="leader"><dt className="text-muted">{tierName} covers</dt><dd className="font-display num">{pct(coverageBps)}</dd></div>
        </dl>
        <div className="mt-4 flex items-baseline justify-between gap-3 border-t border-line pt-3"><span className="font-display text-lg">Back to you</span><span className="font-display num text-3xl text-gain sm:text-4xl">+{money(rebate)}</span></div>
        <p className="mt-2 text-sm text-muted">You keep the card. Hold it, or cash it out in one tap.</p>
      </div>
      <div className="grid place-items-center"><GradeRing priceUsd={price} valueUsd={sell} rebateUsd={rebate} /></div>
    </div>
  </div>;
}

/** The current time, ticking every second while `active`. */
function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now()); const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** "4:05" or "1:02:09". */
const clock = (ms: number) => {
  const s = Math.ceil(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
};

/** One pack: its machine glowing in its element, what it pays out on Collector Crypt, and what it costs this wallet to cover. */
function PackCard({ pack, stat, signedIn, busy, waitMs, count, onOpen }: { pack: Pack; stat?: PackStats; signedIn: boolean; busy: boolean; waitMs: number; count: number; onOpen: () => void }) {
  const q = pack.quote, cooling = signedIn && waitMs > 0, blocked = signedIn && (!q.protected || cooling), several = signedIn && count > 1, style = packStyle(pack.code, pack.priceUsd);
  // Before sign-in there is no tier to quote, so show the range across tiers from the pack's own data.
  const terms = stat ? Object.values(stat.terms) : [], fees = terms.map(t => t.feeBps), read = !!stat && stat.n > 0;
  return <article className="card pack-card lift group flex min-w-0 flex-col p-4" style={{ '--glow': style.color } as CSSProperties}>
    <Booster code={pack.code} priceUsd={pack.priceUsd} className="relative mx-auto w-[80%]" />
    <div className="relative mt-3 flex items-center justify-between gap-2">
      <h3 className="font-display flex min-w-0 items-center gap-2 text-lg"><TypeBadge code={pack.code} priceUsd={pack.priceUsd} size={22} /><span className="truncate">{style.name}</span></h3>
      <span className="font-display num text-lg">${pack.priceUsd}</span>
    </div>
    {read && <p className="num relative mt-1 text-xs text-muted">Median {money(stat!.medianUsd)} · {Math.round(stat!.hitRate * 100)}% hit rate</p>}
    <dl className="relative mt-3 grid grid-cols-3 gap-2 border-t border-line pt-3">
      {signedIn && q.protected ? <>
        <Term label="Fee" value={short(q.feeBps)} title={`${pct(q.feeBps)} of the pack, ${money(q.feeMicros / 1e6)}`} />
        <Term label="Cover" value={short(q.coverageBps)} title={q.tier && q.coverageBps < q.tier.onsiteCoverageBps ? `Capped from ${pct(q.tier.onsiteCoverageBps)} on this pack` : undefined} />
        <Term label="Up to" value={`$${Math.floor(q.maxRebateMicros / 1e6)}`} tone="text-gain" title={`Up to ${money(q.maxRebateMicros / 1e6)} back`} />
      </> : signedIn ? <p className="col-span-3 text-xs font-medium text-loss">{q.reason}</p>
        : fees.length ? <>
          <Term label="Fee from" value={short(Math.min(...fees))} />
          <Term label="Cover to" value={short(Math.max(...terms.map(t => t.coverageBps)))} />
          <Term label="Grades" value={String(terms.length)} />
        </> : <p className="col-span-3 text-xs text-muted">Connect to see your coverage.</p>}
    </dl>
    <div className="relative mt-auto pt-3">
      <button className="btn btn-primary w-full" disabled={busy || blocked} onClick={onOpen}>{cooling ? <>Next in <span className="num">{clock(waitMs)}</span></> : signedIn ? several ? `Open ${count}` : 'Open' : 'Connect to open'}</button>
      {signedIn && <div className="num mt-1.5 text-center text-[11px] text-muted">{several ? `${count} × ${money(q.totalMicros / 1e6)} = ${money(q.totalMicros * count / 1e6)}` : `${money(q.totalMicros / 1e6)} total`}</div>}
    </div>
  </article>;
}
/** A percentage at a size that fits a narrow card: 9.5%, 50%. The exact figure is on hover and at checkout. */
const short = (bps: number) => `${+(bps / 100).toFixed(1)}%`;
function Term({ label, value, tone = '', title }: { label: string; value: string; tone?: string; title?: string }) {
  return <div className="min-w-0" title={title}><dt className="truncate text-[11px] text-muted">{label}</dt><dd className={`font-display num whitespace-nowrap text-sm ${tone}`}>{value}</dd></div>;
}

type Batch = { ids: string[]; index: number };

const STEPS = [{ label: 'Paid', at: ['awaiting_payment', 'paying'] }, { label: 'Opened', at: ['paid', 'buying'] }, { label: 'Sent', at: ['delivering'] }, { label: 'Done', at: ['settling'] }];

function OpenFlow({ pack, order, batch, batchOrders, onNext, onSold, onAgain, onClose }: {
  pack: Pack; order: OrderView | null; batch: { index: number; count: number } | null; batchOrders: OrderView[] | null;
  onNext: () => void; onSold: (sold: OrderView[]) => void; onAgain: () => void; onClose: () => void;
}) {
  const priceUsd = pack.priceUsd, status = order?.status, more = !!batch && batch.index < batch.count - 1;
  const step = status === 'complete' ? STEPS.length : STEPS.findIndex(s => s.at.includes(status ?? 'awaiting_payment'));
  const revealed = !!order?.card;
  const failed = status === 'refunded' || status === 'expired' || status === 'review' || status === 'refunding';
  const sell = order?.sellUsd ?? order?.valueUsd ?? null, hit = !!order && sell !== null && sell >= order.priceUsd && !order.rebateUsd;
  const title = status === 'refunding' ? 'Refunding your payment' : status === 'review' ? 'Needs a quick check' : status === 'refunded' ? 'Refunded in full' : status === 'expired' ? 'Payment window closed'
    : revealed ? order!.card!.name.split(' · ')[0] : !order || status === 'awaiting_payment' ? 'Confirm in your wallet' : 'Opening your pack…';
  const kept = batchOrders?.filter(o => o.status !== 'refunded' && o.status !== 'expired');
  const refunded = batchOrders ? batchOrders.length - kept!.length : 0;
  // A batch cashes out together at its end; a single pack, or one still mid-batch, keeps its own result.
  const cash = !more ? (kept?.length ? kept : status === 'complete' && order?.card && !batch ? [order] : null) : null;
  return <div className="grid gap-6 md:grid-cols-[minmax(0,320px)_minmax(0,1fr)] md:gap-8">
    {/* In a batch each pack gets its own reveal, even if it finished while the last one was showing. */}
    <PackOpening key={batch ? order?.id : undefined} replay={!!batch} code={pack.code} priceUsd={priceUsd} status={status} card={order?.card ?? null} hit={hit} rebateUsd={order?.rebateUsd ?? null} />
    <div className="min-w-0 self-center">
      <div className="flex items-center gap-2 pr-8"><TypeBadge code={pack.code} priceUsd={priceUsd} size={22} /><span className="label">{batch && `Pack ${batch.index + 1} of ${batch.count} · `}{packStyle(pack.code, priceUsd).name} ${priceUsd} · {pct(order?.coverageBps ?? pack.quote.coverageBps ?? 0)} covered</span></div>
      <h2 className="font-display mt-2 text-3xl font-bold leading-[1.1] tracking-tight sm:text-4xl" aria-live="polite">{title}</h2>
      {revealed && <p className="mt-1 text-sm text-muted">{order!.card!.name.split(' · ').slice(1).join(' · ')}</p>}

      {!failed && <ol className="mt-5 grid grid-cols-4 gap-2">
        {STEPS.map((s, i) => <li key={s.label}>
          <div className={`h-1.5 rounded-full transition-colors duration-500 ${i < step ? 'bg-accent' : i === step ? 'animate-pulse bg-accent/50' : 'bg-raised'}`} />
          <div className={`label mt-1.5 ${i < step ? 'text-ink' : i === step ? 'text-accent' : ''}`}>{s.label}</div>
        </li>)}
      </ol>}

      {order && order.valueUsd !== null && !failed && <div className="enter mt-5 flex items-center gap-5">
        <GradeRing priceUsd={order.priceUsd} valueUsd={sell!} rebateUsd={order.rebateUsd ?? 0} size={112} />
        <dl className="grid min-w-0 flex-1 gap-1.5 text-sm">
          <div className="leader"><dt className="text-muted">You paid</dt><dd className="font-display num">{money(order.totalUsd)}</dd></div>
          <div className="leader"><dt className="text-muted">Insured value</dt><dd className="font-display num">{money(order.valueUsd)}</dd></div>
          <div className="leader"><dt className="text-muted">Sells back for</dt><dd className={`font-display num ${hit ? 'text-gain' : ''}`}>{order.sellUsd === null ? '…' : money(order.sellUsd)}</dd></div>
          <div className="leader"><dt className="text-muted">Back to you</dt><dd className={`font-display num ${hit ? 'text-muted' : 'text-gain'}`}>{hit ? 'Not needed' : order.rebateUsd === null ? '…' : `+${money(order.rebateUsd)}`}</dd></div>
        </dl>
      </div>}

      {status && status !== 'complete' && <p className={`mt-4 text-sm ${status === 'review' ? 'text-loss' : 'text-muted'}`}>{status === 'review' ? 'Your payment is safe. The team has been alerted and will finish this order.' : order?.message}</p>}
      {more && status === 'complete' && <p className="mt-4 text-sm text-muted">{order?.message} You can cash out the whole batch after the last pack.</p>}
      {batch && !more && !kept && status === 'complete' && <p className="mt-4 text-sm text-muted">Adding up the batch…</p>}

      {kept && !more && <div className="enter mt-5"><div className="label">{batchOrders!.length} packs{refunded ? ` · ${refunded} refunded` : ''}</div></div>}
      {cash && <CashOut orders={cash} onSold={onSold} />}

      <div className="mt-4 flex flex-wrap gap-4 text-xs font-semibold">
        {([['Payment', order?.paymentSignature], ['Card transfer', order?.nftSignature], ['Rebate', order?.rebateSignature], ['Refund', order?.refundSignature]] as const).filter(([, s]) => s).map(([label, s]) =>
          <a key={label} className="inline-flex items-center gap-0.5 text-muted hover:text-accent" href={solscan('tx', s!)} target="_blank" rel="noreferrer">{label}<ArrowUpRight size={12} /></a>)}
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {more && status && FINAL.includes(status) ? <button className="btn btn-primary" onClick={onNext}>Next pack ({batch!.index + 2} of {batch!.count})<ArrowRight size={15} /></button>
          : status === 'complete' && <button className="btn btn-primary" onClick={onAgain}>{batch ? `Open ${batch.count} more` : 'Open another'}</button>}
        {status === 'complete' && order?.card && <ShareButton id={order.id} />}
        <button className="btn btn-outline" onClick={onClose}>{status && FINAL.includes(status) && !more ? 'Done' : 'Close'}</button>
      </div>
    </div>
  </div>;
}
