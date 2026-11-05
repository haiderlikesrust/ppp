import { useEffect, useState, type ReactNode } from 'react';
import { ArrowRight, ArrowUpRight, Flame } from 'lucide-react';
import type { HolderTier } from '../../../shared/types';
import { windowLabel } from '../../../shared/protection';
import { money, pct, short, solscan } from '../api';
import { Link, useApp } from '../app';
import { Booster, RebateBar } from '../ui';

const ENTRIES = [
  ['basics', 'The short version'],
  ['math', 'The rebate math'],
  ['tiers', 'Grades'],
  ['fees', 'How fees are set'],
  ['here', 'Opening a pack here'],
  ['sell', 'Cash out'],
  ['portfolio', 'Portfolio and sharing'],
  ['elsewhere', 'Packs opened elsewhere'],
  ['money', 'Where the money comes from'],
  ['guardrails', 'Guardrails'],
  ['stats', 'Stats and leaderboards'],
  ['verify', 'Check it on-chain'],
  ['faq', 'Questions'],
] as const;

/** How it works. Every number comes from the live settings, so it stays true when the owner changes them. */
export function DocsPage() {
  const { config } = useApp();
  const [active, setActive] = useState<string>('basics');
  useEffect(() => {
    const observer = new IntersectionObserver(entries => { const top = entries.filter(e => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]; if (top) setActive(top.target.id); }, { rootMargin: '-80px 0px -60% 0px' });
    ENTRIES.forEach(([id]) => { const el = document.getElementById(id); if (el) observer.observe(el); });
    return () => observer.disconnect();
  }, [config]);

  const s = config?.settings;
  if (!s) return <div className="font-display py-24 text-center text-2xl text-muted">Loading…</div>;
  const tiers: HolderTier[] = [...s.tiers].sort((a, b) => a.minSupplyPpm - b.minSupplyPpm);
  const top = tiers[tiers.length - 1], mid = tiers[Math.floor((tiers.length - 1) / 2)];
  const poolShare = pct(s.poolShareBps), burnShare = pct(10_000 - s.poolShareBps), priced = !!s.pricing?.enabled;
  const fee = priced ? `${pct(s.pricing.minFeeBps)}–${pct(s.pricing.maxFeeBps)}` : pct(s.feeBps);
  const share = (ppm: number) => `${+(ppm / 10_000).toFixed(3)}%`;
  const example = (bps: number) => Math.floor((25 - 9.3) * bps / 100) / 100;
  const window = windowLabel(s.offsite.claimWindowHours ?? 48);
  const limits = s.offsite.perWalletDailyClaims > 0 || s.offsite.perWalletDailyUsd > 0 || s.offsite.perWalletWeeklyUsd > 0 || s.offsite.dailyPoolBps > 0;

  return <div className="grid grid-cols-1 gap-12 py-14 md:grid-cols-[14rem_minmax(0,1fr)] md:py-20">
    <aside className="hidden md:block">
      <nav aria-label="On this page" className="sticky top-24 grid gap-0.5">
        <div className="label mb-3">On this page</div>
        {ENTRIES.map(([id, label], i) => <a key={id} href={`#${id}`} className={`flex items-center gap-3 rounded-lg px-3 py-1.5 text-sm font-medium transition ${active === id ? 'bg-raised text-ink' : 'text-muted hover:text-ink'}`}><span className="font-display num w-6 text-[10px] text-faint">{String(i + 1).padStart(2, '0')}</span>{label}</a>)}
      </nav>
    </aside>

    <article className="min-w-0 max-w-3xl">
      <div className="label">How it works</div>
      <h1 className="font-display mt-3 text-5xl font-bold leading-[1.05] tracking-tight sm:text-6xl">The rules of the <em>second grade.</em></h1>
      <p className="mt-5 text-lg text-muted">How rebates are worked out, who qualifies, where the money comes from, and how to check every step on-chain. Regrade doesn't grade cards: a regrade is our name for the rebate on a bad pull.</p>

      <Entry n={1} id="basics" title="The short version">
        <p>Most packs on Collector Crypt, Pokémon cards and luxury watches alike, pull something worth less than the pack. A few pull far more. Regrade pays token holders part of that downside back, in USDC.</p>
        <div className="not-prose my-6 grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-3">
          {[['Hold the token', 'Your lowest balance sets your grade and how much you get back.'], ['Open a pack', `Here, with a protection fee priced for that pack, or on Collector Crypt, pump.fun or Jupiter.`], ['Get some back', 'When the card is worth less than the pack, part of the gap is paid to you.']].map(([t, d], i) =>
            <div key={t} className="bg-surface p-5"><div className="font-display text-3xl text-accent">0{i + 1}</div><div className="mt-3 font-semibold text-ink">{t}</div><p className="mt-1 text-sm">{d}</p></div>)}
        </div>
        <p>You always keep the card, and the rebate comes on top. Packs opened here are paid back automatically. Packs opened on Collector Crypt, pump.fun, Jupiter or another app that sells Collector Crypt packs can be claimed at a lower rate.</p>
      </Entry>

      <Entry n={2} id="math" title="The rebate math">
        <div className="card font-display not-prose my-6 px-4 py-5 text-center text-xl text-accent sm:text-2xl">rebate = coverage × (pack price − card value)</div>
        <ul>
          <li><b>Pack price</b> is what the pack costs on Collector Crypt: $25 to $500 for Pokémon cards, $500 for watches. The protection fee isn't part of it.</li>
          <li><b>Card value</b> is the insured value Collector Crypt records for the card or watch at the moment it's pulled. Nobody can change it afterwards, including us.</li>
          <li><b>Coverage</b> comes from your grade, and is lower for packs opened elsewhere. On the riskiest packs it can be capped: see how fees are set.</li>
          <li>One rebate is capped at <b>{money(s.maxRebateUsd)}</b>. A card worth the pack price or more needs no rebate.</li>
        </ul>
        <div className="card not-prose my-6 grid gap-6 p-5 sm:grid-cols-[96px_1fr] sm:p-6">
          <div className="w-24"><Booster code="pokemon_25" priceUsd={25} /></div>
          <div className="min-w-0">
            <div className="label">A $25 Leaf pack pulls a card worth $9.30</div>
            <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[300px] text-sm">
              <thead><tr className="text-left"><th className="label pb-2 font-medium">Grade</th><th className="label pb-2 font-medium">Coverage</th><th className="label pb-2 text-right font-medium">Back to you</th></tr></thead>
              <tbody>{tiers.map(t => <tr key={t.id} className="border-t border-line"><td className="font-semibold py-2 text-ink">{t.name}</td><td className="num">{pct(t.onsiteCoverageBps)} of $15.70</td><td className="font-display num text-right text-gain">+{money(example(t.onsiteCoverageBps))}</td></tr>)}</tbody>
            </table></div>
            <div className="mt-4"><RebateBar priceUsd={25} valueUsd={9.3} rebateUsd={example(mid?.onsiteCoverageBps ?? 5_000)} /></div>
          </div>
        </div>
      </Entry>

      <Entry n={3} id="tiers" title="Grades">
        <p>Your grade is your holder tier. It depends on how much of the token's total supply your wallet holds. It has nothing to do with the grade printed on a card.</p>
        <div className="not-prose my-6 overflow-x-auto"><table className="w-full min-w-[320px] text-sm">
          <thead><tr className="text-left">{['Grade', 'You hold', 'Opened here', 'Opened elsewhere'].map(h => <th key={h} className="label pb-2 font-medium">{h}</th>)}</tr></thead>
          <tbody>{tiers.map(t => <tr key={t.id} className="border-t border-line"><td className="font-semibold py-3 text-ink">{t.name}</td><td className="num">{share(t.minSupplyPpm)}+</td><td className="font-display num text-gain">{pct(t.onsiteCoverageBps)}</td><td className="font-display num">{pct(t.offsiteCoverageBps)}</td></tr>)}</tbody>
        </table></div>
        <h3>Your lowest balance counts</h3>
        <p>Your grade for a pull is your <b>lowest</b> balance over the time that matters, so selling right after a pull lowers it, even if you buy back later.</p>
        <ul>
          <li><b>Packs opened here:</b> your balance when you pay{s.onsiteHoldHours > 0 ? ` (and for the ${s.onsiteHoldHours} hours before)` : ''} and again when the card arrives. If it dropped in between, the lower grade applies.</li>
          <li><b>Packs opened elsewhere:</b> we read your coin history on-chain. The pack must have been opened after you first bought the coin{s.offsiteHoldHours > 0 ? ` (and held it for ${s.offsiteHoldHours} hours)` : ''}, and your grade is your lowest balance from the pull until you claim.</li>
        </ul>
      </Entry>

      <Entry n={4} id="fees" title="How fees are set">
        <p>{priced ? <>Every pack on Collector Crypt pays out differently, so one flat fee would overcharge some packs and undercharge others. Each pack's fee is worked out from its own last 5,000 pulls at most, and it updates as new pulls come in.</> : <>Every pack currently pays a flat <b>{pct(s.feeBps)}</b> protection fee.</>}</p>
        {priced && <><div className="card font-display not-prose my-6 px-4 py-5 text-center text-lg text-accent sm:text-xl">fee = coverage × average shortfall × {+(1 + s.pricing.marginBps / 10_000).toFixed(2)} ÷ {poolShare}</div>
        <ul>
          <li><b>Average shortfall</b> is how far the pack's cards fall below its price on average. Cards above the price count as zero.</li>
          <li><b>{pct(s.pricing.marginBps)} margin</b> keeps the vault ahead of the rebates it expects to pay.</li>
          <li>Fees stay between <b>{pct(s.pricing.minFeeBps)}</b> and <b>{pct(s.pricing.maxFeeBps)}</b> of the pack price. If the top fee can't pay for your grade's coverage on a pack, coverage on that pack is cut to what it can pay for, and the pack shows the lower number before you buy.</li>
          <li>A pack with fewer than {s.pricing.minSamples.toLocaleString('en-US')} recorded pulls uses the flat <b>{pct(s.feeBps)}</b> fee.</li>
        </ul>
        <p>You always see your exact fee and coverage before you pay, and they can't change after. The <Link href="/stats">Stats page</Link> shows the numbers for every pack.</p></>}
      </Entry>

      <Entry n={5} id="here" title="Opening a pack here">
        <ol>
          <li><b>Pick a pack.</b> Graded cards or a watch pack. You see the price, your fee for that pack, your coverage and the most you could get back.</li>
          <li><b>Pay once.</b> Your wallet signs a single USDC payment. Nothing else is ever requested.</li>
          <li><b>We open it.</b> We buy the pack on Collector Crypt and send the graded card NFT to your wallet.</li>
          <li><b>Regraded, automatically.</b> If the card is worth less than the pack, the rebate lands in your wallet straight away. No claim needed.</li>
        </ol>
        <p>Before you pay, the largest rebate your pack could need is set aside in the pool, so rebates on packs opened here are always payable. If Collector Crypt can't sell the pack (sold out, paused or refunded), you get the full amount back, fee included.</p>
      </Entry>

      <Entry n={6} id="sell" title="Cash out">
        <p>Don't want the card? For <b>72 hours</b> after a pull you can sell it straight back to Collector Crypt for a share of its insured value, usually 85–93% depending on the pack. The Cash out panel shows the sale and the rebate together as one total, against what you paid. Open several packs at once and you can cash out the whole batch with one approval.</p>
        <ul>
          <li>Your wallet signs a transaction for each card, sending it to Collector Crypt and paying you USDC. Your wallet shows that before you approve.</li>
          <li>Selling doesn't change your rebate: it's already paid from the card's insured value.</li>
          <li>The offer comes from Collector Crypt and can move between the quote and your approval. Each sale stands alone, so one failing leaves the others sold.</li>
        </ul>
      </Entry>

      <Entry n={7} id="portfolio" title="Portfolio and sharing">
        <p>Your <Link href="/portfolio">Portfolio</Link> lists every pack this wallet opened here and every off-site claim that paid, with your net result overall. Off-site packs that still qualify show with the time left to claim them, and any card still inside its 72-hour window can be cashed out from there.</p>
        <p>Every pull opened here has its own public page. Use Share for a ready-made image of the pull, or a link that shows the card when it's posted. The page shows a shortened wallet address, like the receipts on the Stats page.</p>
      </Entry>

      <Entry n={8} id="elsewhere" title="Packs opened elsewhere">
        <p>Opened a pack on Collector Crypt, pump.fun, Jupiter or another app that sells Collector Crypt packs? Connect the same wallet on the <Link href="/claim">Claim page</Link> and scan. We find your pack payment on-chain, then check Collector Crypt's record of the card it sent you. A pull qualifies when:</p>
        <ul>
          <li>your wallet paid for the pack, and the card was delivered to that same wallet;</li>
          <li>it was opened in the last <b>{window}</b>, after you first bought the coin{s.offsiteActivationHours > 0 ? ', and after your coverage started' : ''};</li>
          <li>your lowest balance from the pull until you claim reaches a grade;</li>
          <li>the pack wasn't refunded or auto-sold (turbo mode);</li>
          <li>it hasn't been claimed before. Each pack can be claimed once.</li>
        </ul>
        <p>These packs paid no protection fee, so they get less back.{limits ? ' Each wallet has payout limits:' : ' There is no limit on how many you claim.'}</p>
        {limits && <><ul>
          {s.offsite.perWalletDailyClaims > 0 && <li>up to <b>{s.offsite.perWalletDailyClaims} claims</b> per wallet in any 24 hours;</li>}
          {s.offsite.perWalletDailyUsd > 0 && <li>up to <b>{money(s.offsite.perWalletDailyUsd)}</b> paid to a wallet in any 24 hours{s.offsite.perWalletWeeklyUsd > 0 && <>, and <b>{money(s.offsite.perWalletWeeklyUsd)}</b> in any 7 days</>};</li>}
          {s.offsite.dailyPoolBps > 0 && <li>at most <b>{pct(s.offsite.dailyPoolBps)}</b> of the pool paid out across everyone per day.</li>}
        </ul>
        <p>Approved claims over a payout limit wait in line and pay out automatically, in order, once there's room.</p></>}
      </Entry>

      <Entry n={9} id="money" title="Where the money comes from">
        <p>Rebates are paid from a pool of USDC. Two things fill it:</p>
        <div className="not-prose my-6 grid gap-2">
          <Flow tone="border-accent/40 text-accent" label="In">Creator fees from the token's trading, converted to USDC</Flow>
          <Flow tone="border-accent/40 text-accent" label="In">{poolShare} of every protection fee</Flow>
          <Flow tone="border-gain/40 text-gain" label="Out">Rebates to holders</Flow>
        </div>
        <p>The other <b>{burnShare}</b> of each protection fee buys the token on the market and burns it, so every protected pack also shrinks supply.</p>
        <div className="not-prose my-4 flex items-center gap-3 rounded-xl border border-warn/30 bg-warn-soft px-5 py-4 text-sm text-ink"><Flame size={18} className="shrink-0 text-warn" /><span>Protection fee split: <b>{poolShare}</b> to the pool, <b>{burnShare}</b> to buyback and burn.</span></div>
      </Entry>

      <Entry n={10} id="guardrails" title="Guardrails">
        <p>Big hits don't offset bad pulls, so a rebate pool could drain fast without limits. These rules keep it paying:</p>
        <ul>
          {priced && <li><b>Fees priced from real pulls.</b> Each pack's fee is set so the vault expects to collect more than it pays out on that pack, at every grade.</li>}
          <li><b>Reserved rebates.</b> Each pack opened here sets aside its largest possible rebate before you pay. If the pool can't cover that, protected packs pause until it can.</li>
          <li><b>Off-site coverage follows the pool.</b> It shrinks while the pool is below its {money(s.offsite.targetReserveUsd)} reserve target{limits ? ', and the payout limits above apply' : ''}. Approved claims wait in line until the pool can pay them.</li>
          <li><b>Automatic brake.</b> If rebates for a pack price run above {pct(s.breaker.lossRatioBps)} of the fees that price brings in, protection for that price pauses.</li>
          <li><b>The buy-in check.</b> A pack opened elsewhere only counts if the wallet already held the token when it was opened, read from its on-chain history, so nobody can buy in after a bad pull and claim it.</li>
          <li><b>Lowest-balance grades</b> mean selling after a pull lowers what it pays.</li>
          <li><b>Network fees.</b> Every Solana transaction costs a tiny fee. When our operations wallet runs low, the pool tops it up with SOL, and buys more with {s.gas ? <>at most {money(s.gas.maxUsdPerDay)}</> : 'a small, capped amount'} of USDC a day when it runs low itself. It shows on the <Link href="/pool">Vault page</Link>.</li>
        </ul>
      </Entry>

      <Entry n={11} id="stats" title="Stats and leaderboards">
        <p>The <Link href="/stats">Stats page</Link> shows every pack opened on Regrade and what Collector Crypt packs really pay out. We read Collector Crypt's public feed of recent pulls every 2 minutes and keep each machine's latest 5,000 pulls.</p>
        <ul>
          <li><b>Receipts:</b> every pack opened on Regrade with its transactions on Solscan: the buyer's payment, our purchase of the pack on Collector Crypt, the card sent to the buyer, the rebate, and the sale if the card was sold back. Each card also links to its NFT.</li>
          <li><b>Pack stats:</b> the median card, the hit rate (cards worth at least the pack), the spread of values, and each grade's fee, coverage and average rebate on that pack. These same pulls set the fees.</li>
          <li><b>Leaderboards:</b> this week's biggest hit, most packs opened and biggest rebate on Regrade. They reset every Monday at 00:00 UTC, and last week's stay up for a week.</li>
          <li><b>Recent pulls:</b> the newest pulls on Collector Crypt with the real card photo, and what your grade would get back on a bad one. Tap a card to see its NFT on Solscan.</li>
        </ul>
        <p>Card values are Collector Crypt's insured values at the moment of each pull. Regrade doesn't set the odds and never sees a pack before it opens.</p>
      </Entry>

      <Entry n={12} id="verify" title="Check it on-chain">
        <p>Every payment, card transfer, rebate, sale and burn is a Solana transaction, linked from the screen where it happens.</p>
        <ul>
          <li>The <Link href="/pool">Vault page</Link> shows the balance, what's reserved, money in and out, and every burn.</li>
          {config?.poolAddress && <li>The vault wallet is <a className="font-display num" href={solscan('account', config.poolAddress)} target="_blank" rel="noreferrer">{short(config.poolAddress)} <ArrowUpRight className="inline" size={13} /></a>. Its USDC balance is the vault.</li>}
          {config?.mint && config.mode !== 'practice' && <li>The token is <a className="font-display num" href={solscan('token', config.mint)} target="_blank" rel="noreferrer">{short(config.mint)} <ArrowUpRight className="inline" size={13} /></a>.</li>}
        </ul>
      </Entry>

      <Entry n={13} id="faq" title="Questions">
        <div className="not-prose divide-y divide-line border-y border-line">
          {[
            ['Is this insurance?', 'No. It is a discretionary rebate for holders, funded by creator fees and protection fees. It is not insurance and not a guarantee: payouts depend on the pool and the rules on this page.'],
            ['Do you grade cards?', 'No. Cards are graded by the companies named on them, and Collector Crypt sets their insured values. A regrade is our name for the rebate on a bad pull. Your grade is your holder tier.'],
            ['Do I keep the card?', 'Yes. The rebate comes on top. If you would rather have USDC, cash out within 72 hours.'],
            ['Which card value do you use?', "Collector Crypt's insured value, recorded when the card was pulled. It's the same value Collector Crypt uses itself."],
            ['Why is my fee different on each pack?', 'Each pack pays out differently, and a higher grade gets more back, so the fee follows what that coverage costs on that pack. You see the exact fee before you pay.'],
            ['What if the pool runs low?', 'Rebates for packs opened here are reserved before you pay, so they are always paid. Off-site claims slow down instead: coverage shrinks and claims wait until the pool refills.'],
            ['Can I claim the same pack twice, or from another wallet?', 'No. Each pack can be claimed once, and only by the wallet that paid for it and received the card.'],
            ['Why my lowest balance, not my current one?', 'So that holding is what earns coverage. Otherwise anyone could buy the token after a bad pull, claim, and sell. A pack only counts if you held the token when it was opened, and selling after the pull lowers your grade.'],
            ['Is there a limit on claims?', limits ? 'Yes, the payout limits are listed under Packs opened elsewhere. Each pack can be claimed once.' : 'No. Claim as many packs as qualify. Each pack can be claimed once, and one rebate is capped at the amount shown under The rebate math.'],
            ['Which wallets work?', 'Any Solana wallet with Wallet Standard support, such as Phantom, Solflare or Backpack. Signing in is a message signature and never approves a transaction.'],
          ].map(([q, a]) => <details key={q} className="group py-4">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-ink">{q}<span className="font-display text-2xl leading-none text-accent transition group-open:rotate-45">+</span></summary>
            <p className="mt-2 text-sm text-muted">{a}</p>
          </details>)}
        </div>
      </Entry>

      <div className="card mt-14 flex flex-wrap items-center gap-4 p-6">
        <div className="flex-1"><div className="font-display text-2xl">Ready to open one?</div><div className="text-sm text-muted">{top ? `${top.name} gets up to ${pct(top.onsiteCoverageBps)} of a loss back.` : 'Hold the token to get covered.'}</div></div>
        <Link href="/" className="btn btn-primary">Open a pack<ArrowRight size={15} /></Link>
      </div>
    </article>
  </div>;
}

function Entry({ n, id, title, children }: { n: number; id: string; title: string; children: ReactNode }) {
  return <section id={id} className="mt-14 scroll-mt-24 border-t border-line pt-10 text-[15px] leading-relaxed text-muted [&_a]:text-accent [&_a:hover]:underline [&_b]:font-semibold [&_b]:text-ink [&_h3]:font-display [&_h3]:mt-7 [&_h3]:text-ink [&_li]:mt-2 [&_ol]:mt-4 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mt-4 [&_ul]:mt-4 [&_ul]:list-disc [&_ul]:pl-5 [&_.not-prose_p]:mt-1 first-of-type:mt-10">
    <div className="label">No. {String(n).padStart(3, '0')}</div>
    <h2 className="font-display mt-1 text-3xl font-bold tracking-tight text-ink sm:text-4xl">{title}</h2>
    {children}
  </section>;
}
function Flow({ tone, label, children }: { tone: string; label: string; children: ReactNode }) {
  return <div className={`flex items-center gap-4 rounded-xl border bg-surface px-4 py-3 text-sm ${tone}`}><span className="font-display w-10 shrink-0 text-xs uppercase">{label}</span><span className="text-ink">{children}</span></div>;
}
