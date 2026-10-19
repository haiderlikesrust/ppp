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
        {me.wallet && h?.configured && <p className="mt-1 text-sm text-muted">You hold <span className="num text-ink">{share(ppm)}</span> of supply{next ? <>. <span className="num text-ink">{share(next.minSupplyPpm - ppm)}</span> more reaches {next.name}.</> : '. That is the top tier.'}</p>}
      </div>
      {!me.wallet && <button className="btn btn-ink btn-sm" onClick={connect}>Connect wallet</button>}
    </div>
    <div className="mt-5 grid gap-2 sm:grid-cols-3">
      {tiers.map(t => {
        const active = t.id === current;
        return <div key={t.id} className={`rounded-2xl border p-4 transition ${active ? 'border-ink bg-ink text-white' : 'border-line'}`}>
          <div className="flex items-center justify-between"><span className="font-semibold">{t.name}</span>{active && <span className="chip bg-white/15 text-white"><Check size={12} />You</span>}</div>
          <div className={`num mt-0.5 text-xs ${active ? 'text-white/60' : 'text-muted'}`}>hold {share(t.minSupplyPpm)}+</div>
          <div className="num mt-3 text-2xl font-semibold">{pct(mode === 'onsite' ? t.onsiteCoverageBps : t.offsiteCoverageBps)}</div>
          <div className={`text-xs ${active ? 'text-white/60' : 'text-muted'}`}>{mode === 'onsite' ? 'back on bad pulls here' : 'back on off-site pulls'}</div>
        </div>;
      })}
    </div>
    {me.wallet && h?.offsiteCoverageFrom && h.offsiteCoverageFrom > Date.now() && <p className="mt-4 text-xs text-muted">Off-site pulls are covered from {new Date(h.offsiteCoverageFrom).toLocaleString()} (24h after you first connected).</p>}
  </div>;
}
