import { Check } from 'lucide-react';
import type { HolderTier } from '../../../shared/types';
import { pct } from '../api';
import { useApp } from '../app';

/** The tier ladder: where this wallet sits, what each step covers, and how far the next one is. */
export function CoverageLadder({ mode = 'onsite' }: { mode?: 'onsite' | 'offsite' }) {
  const { me, config, connect } = useApp();
  const tiers: HolderTier[] = [...(config?.settings?.tiers ?? [])].sort((a, b) => a.minSupplyPpm - b.minSupplyPpm);
  const h = me.holder, current = h?.tier?.id, ppm = h?.ppm ?? 0;
  const next = tiers.find(t => t.minSupplyPpm > ppm);
  const share = (p: number) => `${+(p / 10_000).toFixed(3)}%`;
  return <div className="card p-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <div className="label">Your coverage</div>
        <div className="mt-1 text-xl font-semibold">{!me.wallet ? 'Connect to see your tier' : h?.tier ? `${h.tier.name} tier` : h?.configured === false ? 'Token not launched yet' : 'Not covered yet'}</div>
        {me.wallet && h?.configured && next && <div className="mt-3 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-line" role="progressbar" aria-label={`Progress to ${next.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(1, ppm / next.minSupplyPpm) * 100)}><div className="h-full rounded-full bg-yellow" style={{ width: `${Math.min(100, ppm / next.minSupplyPpm * 100)}%` }} /></div>}
        {me.wallet && h?.configured && <p className="mt-2 text-sm text-muted">You hold <span className="num text-ink">{share(ppm)}</span> of supply{next ? <>. <span className="num text-ink">{share(next.minSupplyPpm - ppm)}</span> more reaches {next.name}.</> : '. That is the top tier.'}</p>}
      </div>
      {!me.wallet && <button className="btn btn-ink btn-sm" onClick={connect}>Connect wallet</button>}
    </div>
    <div className="mt-5 grid gap-2 sm:grid-cols-3">
      {tiers.map(t => {
        const active = t.id === current;
        return <div key={t.id} className={`flex items-center justify-between gap-4 rounded-2xl border p-4 transition sm:block ${active ? 'border-ink bg-ink text-white' : 'border-line'}`}>
          <div className="min-w-0">
            <div className="flex items-center justify-between gap-2"><span className="font-semibold">{t.name}</span>{active && <span className="chip bg-white/15 text-white"><Check size={12} />You</span>}</div>
            <div className={`num mt-0.5 text-xs ${active ? 'text-white/60' : 'text-muted'}`}>hold {share(t.minSupplyPpm)}+</div>
          </div>
          <div className="shrink-0 text-right sm:mt-3 sm:text-left">
            <div className="num text-2xl font-semibold">{pct(mode === 'onsite' ? t.onsiteCoverageBps : t.offsiteCoverageBps)}</div>
            <div className={`text-xs ${active ? 'text-white/60' : 'text-muted'}`}>{mode === 'onsite' ? 'back on bad pulls here' : 'back on off-site pulls'}</div>
          </div>
        </div>;
      })}
    </div>
    {me.wallet && h?.offsiteCoverageFrom && h.offsiteCoverageFrom > Date.now() && <p className="mt-4 text-xs text-muted">Off-site pulls are covered from {new Date(h.offsiteCoverageFrom).toLocaleString()} ({config?.settings?.offsiteActivationHours}h after you first connected).</p>}
  </div>;
}
