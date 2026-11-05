import { useEffect, useState } from 'react';
import { ArrowRight, ArrowUpRight } from 'lucide-react';
import type { SitePull } from '../../../shared/types';
import { ago, api, money, solscan } from '../api';
import { Link } from '../app';
import { ShareButton } from '../parts/share';
import { Empty, RebateBar, TradingCard, isWatch, packStyle } from '../ui';

const TXS = [['payment', 'Payment'], ['pack', 'Pack bought'], ['card', 'Card sent'], ['rebate', 'Rebate'], ['sale', 'Sale']] as const;

/** One pull on its own public page: where a shared link lands. Anyone can open it and check every step on-chain. */
export function PullPage({ id }: { id: string }) {
  const [pull, setPull] = useState<SitePull | null>(null), [missing, setMissing] = useState(false);
  useEffect(() => { let live = true; api<SitePull>(`/pulls/${id}`).then(p => { if (live) setPull(p); }).catch(() => { if (live) setMissing(true); }); return () => { live = false; }; }, [id]);
  if (missing) return <div className="py-16"><Empty title="Pull not found" text="This pull doesn't exist, or it hasn't finished opening." action={<Link href="/" className="btn btn-primary">See the packs</Link>} /></div>;
  if (!pull) return <div className="grid gap-6 py-16 md:grid-cols-2"><div className="shimmer aspect-[5/7] max-w-xs rounded-xl" /><div className="shimmer h-64 rounded-xl" /></div>;

  const [name, set, grade] = (pull.card?.name ?? 'Graded card').split(' · '), style = packStyle(pull.code, pull.priceUsd);
  const hit = pull.valueUsd >= pull.priceUsd, regraded = pull.rebateUsd > 0;
  return <div className="grid items-center gap-10 py-10 md:grid-cols-[minmax(0,340px)_minmax(0,1fr)] md:gap-16 md:py-20">
    <div className="rise relative mx-auto w-full max-w-[320px]">
      <TradingCard tilt holo={hit} card={{ name: pull.card?.name ?? 'Graded card', image: pull.card?.image ?? null, insuredValueUsd: pull.valueUsd, rarity: null }} watch={isWatch(pull.code)} />
      {(regraded || hit) && <div className="pop-in pointer-events-none absolute inset-x-0 -bottom-4 z-[4] grid place-items-center" style={{ animationDelay: '.6s' }}><span className={`sticker num ${hit ? 'sticker-hit' : ''}`}>{hit ? 'Above the pack!' : `Regraded +${money(pull.rebateUsd)}`}</span></div>}
    </div>
    <div className="enter min-w-0">
      <div className="label">{style.name} {money(pull.priceUsd)} pack · {pull.wallet} · {ago(pull.at)}</div>
      <h1 className="font-display mt-3 text-5xl font-bold leading-[1.05] tracking-tight sm:text-6xl">{name}</h1>
      {(set || grade) && <p className="mt-2 text-muted">{[set, grade].filter(Boolean).join(' · ')}</p>}
      <dl className="mt-7 grid gap-2.5 text-[15px]">
        <div className="leader"><dt className="text-muted">Pack price</dt><dd className="font-display num">{money(pull.priceUsd)}</dd></div>
        <div className="leader"><dt className="text-muted">Insured value</dt><dd className={`font-display num ${hit ? 'text-gain' : ''}`}>{money(pull.valueUsd)}</dd></div>
        {regraded && <div className="leader"><dt className="text-muted">Back in USDC</dt><dd className="font-display num text-gain">+{money(pull.rebateUsd)}</dd></div>}
        {pull.soldUsd !== null && <div className="leader"><dt className="text-muted">Sold back for</dt><dd className="font-display num">{money(pull.soldUsd)}</dd></div>}
      </dl>
      {!hit && <div className="mt-5"><RebateBar priceUsd={pull.priceUsd} valueUsd={pull.valueUsd} rebateUsd={pull.rebateUsd} /></div>}
      <div className="mt-6 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {TXS.filter(([key]) => pull.txs[key]).map(([key, label]) => <a key={key} href={solscan('tx', pull.txs[key]!)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-muted hover:text-accent">{label}<ArrowUpRight size={12} /></a>)}
        {pull.mint && <a href={solscan('token', pull.mint)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-muted hover:text-accent">Card NFT<ArrowUpRight size={12} /></a>}
      </div>
      <div className="mt-8 flex flex-wrap gap-2"><Link href="/" className="btn btn-primary">Open a pack<ArrowRight size={15} /></Link><ShareButton id={pull.id} /></div>
    </div>
  </div>;
}
