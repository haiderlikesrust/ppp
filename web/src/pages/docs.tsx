import { useEffect, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowRight, ArrowUpRight, Flame } from 'lucide-react';
import type { HolderTier } from '../../../shared/types';
import { money, pct, short, solscan } from '../api';
import { Link, useApp } from '../app';
import { Logo, PackArt, RebateBar } from '../ui';

const SECTIONS = [
  ['overview', 'Overview'],
  ['rebate', 'How a rebate is worked out'],
  ['tiers', 'Holder tiers'],
  ['onsite', 'Opening packs here'],
  ['offsite', 'Packs opened elsewhere'],
  ['money', 'Where the money comes from'],
  ['safety', 'Keeping the pool solvent'],
  ['verify', 'Checking it yourself'],
  ['faq', 'FAQ'],
] as const;

/** Public explainer. Every number comes from the live settings, so it stays true when the owner changes them. */
export function DocsPage() {
  const { config } = useApp();
  const [active, setActive] = useState<string>('overview');
  useEffect(() => {
    const observer = new IntersectionObserver(entries => { const top = entries.filter(e => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]; if (top) setActive(top.target.id); }, { rootMargin: '-80px 0px -60% 0px' });
    SECTIONS.forEach(([id]) => { const el = document.getElementById(id); if (el) observer.observe(el); });
    return () => observer.disconnect();
  }, [config]);

  const s = config?.settings;
  if (!s) return <div className="py-20 text-center text-muted">Loading…</div>;
  const tiers: HolderTier[] = [...s.tiers].sort((a, b) => a.minSupplyPpm - b.minSupplyPpm);
  const top = tiers[tiers.length - 1], mid = tiers[Math.floor((tiers.length - 1) / 2)];
  const fee = pct(s.feeBps), poolShare = pct(s.poolShareBps), burnShare = pct(10_000 - s.poolShareBps);
  const share = (ppm: number) => `${+(ppm / 10_000).toFixed(3)}%`;
  const example = (bps: number) => Math.floor((25 - 9.3) * bps / 100) / 100;

  return <div className="grid grid-cols-1 gap-12 py-12 md:grid-cols-[13rem_minmax(0,1fr)] md:py-16">
    <aside className="hidden md:block">
      <nav aria-label="On this page" className="sticky top-24 grid gap-0.5 text-sm">
        <div className="label mb-2">On this page</div>
        {SECTIONS.map(([id, label]) => <a key={id} href={`#${id}`} className={`rounded-lg px-3 py-1.5 transition ${active === id ? 'bg-ink text-white' : 'text-muted hover:text-ink'}`}>{label}</a>)}
      </nav>
    </aside>

    <article className="min-w-0 max-w-3xl">
      <span className="chip bg-yellow-soft text-ink">Docs</span>
      <h1 className="mt-4 text-4xl font-bold leading-[1.05] tracking-tight sm:text-5xl">How Pull Protection works</h1>
      <p className="mt-4 text-lg text-muted">Everything about how rebates are calculated, who qualifies, where the money comes from, and how to check it all on-chain.</p>

      <Section id="overview" title="Overview">
        <p>Pokémon card packs on Collector Crypt are a gamble: most pulls are worth less than the pack, and a few are worth a lot more. Pull Protection gives holders of our token some of that downside back.</p>
        <div className="not-prose my-6 grid gap-3 sm:grid-cols-3">
          {[['1', 'Hold the token', 'Your balance sets your tier and how much you are covered.'], ['2', 'Open a pack', `Here with protection (${fee} fee), or on Collector Crypt directly.`], ['3', 'Get some back', 'When the card is worth less than the pack, part of the gap is paid to you in USDC.']].map(([n, t, d]) =>
            <div key={n} className="card p-5"><span className="num grid size-7 place-items-center rounded-full bg-yellow text-xs font-semibold">{n}</span><div className="mt-3 font-semibold">{t}</div><p className="mt-1 text-sm text-muted">{d}</p></div>)}
        </div>
        <p>You always keep the card. The rebate is extra money on top. Packs opened on this site are covered automatically. Packs opened directly on Collector Crypt can be claimed at a lower rate.</p>
      </Section>

      <Section id="rebate" title="How a rebate is worked out">
        <Formula>rebate = coverage × (pack price − card value)</Formula>
        <ul>
          <li><b>Pack price</b> is what the pack costs on Collector Crypt ($25, $50, $100 or $500). The protection fee is not part of it.</li>
          <li><b>Card value</b> is the insured value Collector Crypt records for the card at the moment it is pulled. Nobody can change it afterwards, including us.</li>
          <li><b>Coverage</b> is set by your tier (below), and is lower for packs opened elsewhere.</li>
          <li>A single rebate is capped at <b>{money(s.maxRebateUsd)}</b>. If the card is worth the pack price or more, there is nothing to cover and no rebate.</li>
        </ul>
        <div className="card not-prose my-6 grid gap-6 p-6 sm:grid-cols-[96px_1fr]">
          <div className="w-24"><PackArt priceUsd={25} /></div>
          <div>
            <div className="label">Example: a $25 pack pulls a card worth $9.30</div>
            <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[320px] text-sm">
              <thead><tr className="text-left"><th className="label pb-2">Tier</th><th className="label pb-2">Coverage</th><th className="label pb-2 text-right">Back to you</th></tr></thead>
              <tbody>{tiers.map(t => <tr key={t.id} className="border-t border-line"><td className="py-2">{t.name}</td><td className="num">{pct(t.onsiteCoverageBps)} of $15.70</td><td className="num text-right font-semibold text-grass">+{money(example(t.onsiteCoverageBps))}</td></tr>)}</tbody>
            </table></div>
            <div className="mt-4"><RebateBar priceUsd={25} valueUsd={9.3} rebateUsd={example(mid?.onsiteCoverageBps ?? 5_000)} /></div>
          </div>
        </div>
      </Section>

      <Section id="tiers" title="Holder tiers">
        <p>Your tier depends on how much of the token's total supply your wallet holds.</p>
        <div className="not-prose my-6 overflow-x-auto"><table className="w-full min-w-[300px] text-sm">
          <thead><tr className="text-left">{['Tier', 'You hold', 'Opened here', 'Opened elsewhere'].map(h => <th key={h} className="label pb-2">{h}</th>)}</tr></thead>
          <tbody>{tiers.map(t => <tr key={t.id} className="border-t border-line"><td className="py-3 font-semibold">{t.name}</td><td className="num">{share(t.minSupplyPpm)}+</td><td className="num text-grass">{pct(t.onsiteCoverageBps)}</td><td className="num">{pct(t.offsiteCoverageBps)}</td></tr>)}</tbody>
        </table></div>
        <h3>Your lowest balance counts</h3>
        <p>We record every connected wallet's balance every 15 minutes. Your tier for a pull is your <b>lowest</b> balance over the window that matters, not your highest. Buying just before a pull does not raise your tier, and neither does passing one bag between wallets that we have already been watching.</p>
        <ul>
          <li><b>Packs opened here:</b> your balance when you pay{s.onsiteHoldHours > 0 ? ` (and for the ${s.onsiteHoldHours} hours before)` : ''} and again when the card arrives. If it dropped in between, you get the lower tier.</li>
          <li><b>Packs opened elsewhere:</b> from {s.offsiteHoldHours} hours before the pull until you claim, or from when you first connected if that was later. {s.offsiteActivationHours > 0 ? `Coverage starts ${s.offsiteActivationHours} hours after you first connect your wallet here.` : 'There is no waiting period: you are covered as soon as you connect.'} We check your balance again right before paying, so selling below your tier while a claim waits cancels it.</li>
        </ul>
      </Section>

      <Section id="onsite" title="Opening packs here">
        <ol>
          <li><b>Pick a pack.</b> You see the price plus the {fee} protection fee, your coverage, and the most you could get back.</li>
          <li><b>Pay once.</b> Your wallet signs a single USDC payment. Nothing else is ever requested.</li>
          <li><b>We open it.</b> We buy the pack on Collector Crypt and send the graded card NFT to your wallet.</li>
          <li><b>Rebate, automatically.</b> If the card is worth less than the pack, the rebate is paid to your wallet straight away. No claim needed.</li>
        </ol>
        <p>Before you pay, the largest rebate your pack could need is set aside in the pool, so rebates on packs opened here are always payable. If the pack sells out or Collector Crypt refunds it, you get the full amount back, fee included.</p>
      </Section>

      <Section id="offsite" title="Packs opened elsewhere">
        <p>Opened a pack directly on Collector Crypt? Connect the same wallet on the <Link href="/claim" className="font-semibold text-blue underline underline-offset-2">Claim page</Link> and scan. We find your pack payment on-chain, then check Collector Crypt's record of the card it sent you. A pull qualifies when:</p>
        <ul>
          <li>your wallet paid for the pack, and the card was delivered to that same wallet;</li>
          <li>it was opened in the last <b>{s.offsite.claimWindowDays} days</b>{s.offsiteActivationHours > 0 ? ', after your coverage started' : ''};</li>
          <li>you hold a tier balance (see above);</li>
          <li>the pack was not refunded or instantly sold back (turbo mode);</li>
          <li>it has not been claimed before. Each pack can be claimed once.</li>
        </ul>
        <p>Off-site coverage is lower than on-site because these packs paid no protection fee. Coverage is immediate, so each wallet has daily limits instead of a waiting period:</p>
        <ul>
          {s.offsite.perWalletDailyClaims > 0 && <li>up to <b>{s.offsite.perWalletDailyClaims} claims</b> per wallet in any 24 hours;</li>}
          {s.offsite.perWalletDailyUsd > 0 && <li>up to <b>{money(s.offsite.perWalletDailyUsd)}</b> paid to a wallet in any 24 hours{s.offsite.perWalletWeeklyUsd > 0 && <>, and <b>{money(s.offsite.perWalletWeeklyUsd)}</b> in any 7 days</>};</li>}
          {s.offsite.dailyPoolBps > 0 && <li>at most <b>{pct(s.offsite.dailyPoolBps)}</b> of the pool paid out across everyone per day.</li>}
        </ul>
        <p>A single off-site rebate is never larger than the per-wallet daily limit. Approved claims over a payout limit wait in line and pay out automatically, in order, as soon as there is room.</p>
      </Section>

      <Section id="money" title="Where the money comes from">
        <p>Rebates are paid from a pool of USDC. Two things fill it:</p>
        <div className="not-prose my-6 grid items-center gap-3 sm:grid-cols-[1fr_auto_1fr_auto_1fr]">
          <div className="grid gap-2">
            <Box tone="bg-yellow-soft">Creator fees from our token's trading, converted to USDC</Box>
            <Box tone="bg-blue-soft">{poolShare} of every protection fee</Box>
          </div>
          <Arrow />
          <Box tone="bg-ink text-white" big>Protection pool (USDC)</Box>
          <Arrow />
          <Box tone="bg-grass-soft">Rebates to holders</Box>
        </div>
        <p>The other <b>{burnShare}</b> of each protection fee buys the token on the market and burns it. So every protected pack also reduces supply.</p>
        <div className="not-prose my-4 flex items-center gap-3 rounded-2xl bg-red-soft px-5 py-4 text-sm"><Flame size={18} className="shrink-0 text-red" /><span>Protection fee split: <b>{poolShare}</b> to the pool, <b>{burnShare}</b> to buyback and burn.</span></div>
      </Section>

      <Section id="safety" title="Keeping the pool solvent">
        <p>Big hits do not offset bad pulls, so a rebate pool can drain quickly without limits. These rules keep it paying:</p>
        <ul>
          <li><b>Reserved rebates.</b> Each pack opened here sets aside its largest possible rebate before you pay. If the pool cannot cover that, protected packs pause until it can.</li>
          <li><b>Off-site limits.</b> Per-wallet weekly and pool-wide daily caps. Off-site coverage also shrinks when the pool drops below its {money(s.offsite.targetReserveUsd)} reserve target.</li>
          <li><b>Automatic brake.</b> If rebates for a pack price run above {pct(s.breaker.lossRatioBps)} of the fees that price brings in, protection for that price pauses.</li>
          <li><b>Lowest-balance tiers</b> stop people buying in just for one pull.</li>
          <li><b>Network fees.</b> Solana charges a tiny fee for every transaction. When our operations wallet runs low, the pool sends it SOL, and when the pool runs low it buys SOL with {s.gas ? <>at most {money(s.gas.maxUsdPerDay)}</> : 'a small, capped amount'} of USDC a day. It shows on the <Link href="/pool">Pool page</Link> as network fees.</li>
        </ul>
      </Section>

      <Section id="verify" title="Checking it yourself">
        <p>Every payment, card transfer, rebate and burn is a Solana transaction. Each one is linked from the screen where it happens.</p>
        <ul>
          <li>The <Link href="/pool" className="font-semibold text-blue underline underline-offset-2">Pool page</Link> shows the balance, what is reserved, money in and out, and every burn.</li>
          {config?.poolAddress && <li>The pool wallet is <a className="num font-semibold text-blue underline underline-offset-2" href={solscan('account', config.poolAddress)} target="_blank" rel="noreferrer">{short(config.poolAddress)} <ArrowUpRight className="inline" size={13} /></a>. Its USDC balance is the pool.</li>}
          {config?.mint && config.mode !== 'practice' && <li>The token is <a className="num font-semibold text-blue underline underline-offset-2" href={solscan('token', config.mint)} target="_blank" rel="noreferrer">{short(config.mint)} <ArrowUpRight className="inline" size={13} /></a>.</li>}
        </ul>
      </Section>

      <Section id="faq" title="FAQ">
        <div className="not-prose divide-y divide-line border-y border-line">
          {[
            ['Is this insurance?', 'No. It is a discretionary rebate for holders, funded by creator fees and protection fees. It is not insurance and not a guarantee: payouts depend on the pool and the rules on this page.'],
            ['Do I keep the card?', 'Yes, always. The rebate is paid on top. You can still sell the card back to Collector Crypt if you want to.'],
            ['Which card value do you use?', "Collector Crypt's insured value for the card, recorded when it was pulled. It is the same value Collector Crypt uses itself."],
            ['What if the pool runs low?', 'Rebates for packs opened here are reserved in advance, so they are always paid. Off-site claims slow down: coverage shrinks and claims queue until the pool refills.'],
            ['Can I claim the same pack twice, or from another wallet?', 'No. Each pack can be claimed once, only by the wallet that paid for it and received the card.'],
            ['Why the lowest balance, not my current one?', 'So holding is what earns coverage. Without it, anyone could buy the token for a minute before a pull and sell right after.'],
            ['Which wallets work?', 'Any Solana wallet that supports Wallet Standard, such as Phantom, Solflare or Backpack. Signing in is a message signature and never approves a transaction.'],
          ].map(([q, a]) => <details key={q} className="group py-4">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-semibold">{q}<span className="text-xl leading-none text-muted transition group-open:rotate-45">+</span></summary>
            <p className="mt-2 text-sm text-muted">{a}</p>
          </details>)}
        </div>
      </Section>

      <div className="card mt-14 flex flex-wrap items-center gap-4 p-6">
        <Logo size={32} />
        <div className="flex-1"><div className="font-semibold">Ready to rip?</div><div className="text-sm text-muted">{top ? `${top.name}s get ${pct(top.onsiteCoverageBps)} of every loss back.` : 'Hold the token to get covered.'}</div></div>
        <Link href="/" className="btn btn-red">Open a pack<ArrowRight size={15} /></Link>
      </div>
    </article>
  </div>;
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return <section id={id} className="scroll-mt-24 border-t border-line pt-10 mt-12 first-of-type:mt-10 [&_b]:font-semibold [&_b]:text-ink [&_h3]:mt-6 [&_h3]:font-semibold [&_li]:mt-2 [&_ol]:mt-4 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mt-4 [&_ul]:mt-4 [&_ul]:list-disc [&_ul]:pl-5 [&_.not-prose_p]:mt-1 text-[15px] leading-relaxed text-muted">
    <h2 className="text-2xl font-semibold tracking-tight text-ink">{title}</h2>
    {children}
  </section>;
}
function Formula({ children }: { children: ReactNode }) {
  return <div className="num my-6 rounded-2xl bg-ink px-6 py-5 text-center text-base text-white sm:text-lg">{children}</div>;
}
function Box({ tone, big, children }: { tone: string; big?: boolean; children: ReactNode }) {
  return <div className={`rounded-2xl px-4 py-3 text-center text-sm ${big ? 'py-5 font-semibold' : ''} ${tone} ${tone.includes('text-white') ? '' : 'text-ink'}`}>{children}</div>;
}
function Arrow() {
  return <div className="grid place-items-center text-muted"><ArrowRight className="hidden sm:block" size={18} /><ArrowDown className="sm:hidden" size={18} /></div>;
}
