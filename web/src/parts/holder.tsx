import type { HolderTier } from '../../../shared/types';
import { pct } from '../api';
import { useApp } from '../app';

const share = (ppm: number) => `${+(ppm / 10_000).toFixed(3)}%`;

/** The three grades side by side. The wallet's own lights up. */
export function CoverageLadder({ mode = 'onsite' }: { mode?: 'onsite' | 'offsite' }) {
  const { me, config, connect } = useApp();
  const tiers: HolderTier[] = [...(config?.settings?.tiers ?? [])].sort((a, b) => a.minSupplyPpm - b.minSupplyPpm);
  // Packs opened here can be covered above what the wallet holds; off-site claims always go by holdings.
  const h = me.holder, tier = mode === 'onsite' ? h?.tier : h?.heldTier ?? null, current = tier?.id, ppm = h?.ppm ?? 0;
  const lifted = !!tier && ppm < tier.minSupplyPpm, level = lifted ? tier.minSupplyPpm : ppm;
  const next = tiers.find(t => t.minSupplyPpm > level);
  return <div>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <div className="label">{mode === 'onsite' ? 'Packs opened here' : 'Packs opened elsewhere'}</div>
        <div className="font-display mt-0.5 text-xl">{!me.wallet ? 'Connect to see your grade' : tier ? `You're ${tier.name}` : h?.configured === false ? 'Token not launched yet' : 'Not graded yet'}</div>
        {me.wallet && h?.configured && !lifted && <p className="mt-0.5 text-sm text-muted">You hold <span className="font-display num text-ink">{share(ppm)}</span> of supply{next ? <>. <span className="font-display num text-ink">{share(next.minSupplyPpm - ppm)}</span> more reaches {next.name}.</> : '. That is the top grade.'}</p>}
      </div>
      {!me.wallet && <button className="btn btn-primary btn-sm" onClick={connect}>Connect wallet</button>}
    </div>

    <div className="card mt-5 grid divide-y divide-line overflow-hidden sm:grid-cols-3 sm:divide-x sm:divide-y-0">
      {tiers.map(t => {
        const reached = !!me.wallet && level >= t.minSupplyPpm, here = t.id === current;
        return <div key={t.id} className={`min-w-0 p-5 ${here ? 'bg-accent-soft' : ''}`}>
          <div className="flex items-center justify-between gap-2">
            <span className="font-display truncate text-xl">{t.name}</span>
            {here ? <span className="tag bg-accent text-on-accent">You</span> : reached ? <span className="tag bg-raised text-muted">Reached</span> : null}
          </div>
          <div className="font-display num mt-3 text-5xl font-bold leading-none tracking-tight">{pct(mode === 'onsite' ? t.onsiteCoverageBps : t.offsiteCoverageBps)}</div>
          <div className="mt-1.5 text-sm text-muted">{mode === 'onsite' ? 'of the gap back, at most' : 'of the gap back'}</div>
          <div className="num mt-3 text-xs text-muted">Hold {share(t.minSupplyPpm)}+ of supply</div>
        </div>;
      })}
    </div>
    {mode === 'onsite' && <p className="mt-3 text-sm text-muted">A higher grade costs more to cover, so each pack prices it from its own pulls. On the riskiest packs, coverage is capped at what the top fee can pay for.</p>}
    {me.wallet && h?.offsiteCoverageFrom && h.offsiteCoverageFrom > Date.now() && <p className="mt-3 text-xs text-muted">Off-site pulls are covered from {new Date(h.offsiteCoverageFrom).toLocaleString()} ({config?.settings?.offsiteActivationHours}h after you first connected).</p>}
  </div>;
}
