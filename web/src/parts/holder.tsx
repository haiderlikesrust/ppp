import type { HolderTier } from '../../../shared/types';
import { pct } from '../api';
import { useApp } from '../app';

const share = (ppm: number) => `${+(ppm / 10_000).toFixed(3)}%`;

/** Where the wallet sits on the tier track, as a share of the track width (tier i sits at (2i+1)/2n). */
function progress(ppm: number, tiers: HolderTier[]) {
  const n = tiers.length, at = (i: number) => (2 * i + 1) / (2 * n);
  if (!n) return 0;
  if (ppm < tiers[0].minSupplyPpm) return at(0) * ppm / tiers[0].minSupplyPpm;
  for (let i = 0; i < n - 1; i++) {
    const a = tiers[i].minSupplyPpm, b = tiers[i + 1].minSupplyPpm;
    if (ppm < b) return at(i) + (at(i + 1) - at(i)) * (ppm - a) / (b - a);
  }
  return 1;
}

/** The tier track: like an XP bar, filled to the wallet's balance, with each tier's coverage underneath. */
export function CoverageLadder({ mode = 'onsite' }: { mode?: 'onsite' | 'offsite' }) {
  const { me, config, connect } = useApp();
  const tiers: HolderTier[] = [...(config?.settings?.tiers ?? [])].sort((a, b) => a.minSupplyPpm - b.minSupplyPpm);
  const h = me.holder, current = h?.tier?.id, ppm = h?.ppm ?? 0;
  const next = tiers.find(t => t.minSupplyPpm > ppm);
  const filled = me.wallet && h?.configured ? progress(ppm, tiers) : 0;
  return <div className="card p-5 sm:p-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <div className="label">{mode === 'onsite' ? 'Your coverage · packs opened here' : 'Your coverage · packs opened elsewhere'}</div>
        <div className="pixel mt-1.5 text-xl">{!me.wallet ? 'Connect to see your tier' : h?.tier ? h.tier.name : h?.configured === false ? 'Token not launched yet' : 'No tier yet'}</div>
        {me.wallet && h?.configured && <p className="mt-1 text-sm text-muted">You hold <span className="num text-ink">{share(ppm)}</span> of supply{next ? <>. <span className="num text-ink">{share(next.minSupplyPpm - ppm)}</span> more reaches {next.name}.</> : '. That is the top tier.'}</p>}
      </div>
      {!me.wallet && <button className="btn btn-primary btn-sm" onClick={connect}>Connect wallet</button>}
    </div>

    <div className="relative mt-7">
      <div className="absolute inset-x-0 top-[7px] h-1.5 rounded-[2px] bg-raised" />
      <div className="absolute left-0 top-[7px] h-1.5 rounded-[2px] bg-volt transition-[width] duration-700" style={{ width: `${filled * 100}%` }} role="progressbar" aria-label="Your tier progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(filled * 100)} />
      <div className="relative grid" style={{ gridTemplateColumns: `repeat(${tiers.length || 1}, minmax(0, 1fr))` }}>
        {tiers.map(t => {
          const reached = !!me.wallet && ppm >= t.minSupplyPpm, here = t.id === current;
          return <div key={t.id} className="flex min-w-0 flex-col items-center text-center">
            <span className={`size-5 rotate-45 border-2 ${here ? 'border-volt bg-volt shadow-[0_0_0_4px_rgb(255_210_63/.18)]' : reached ? 'border-volt bg-volt' : 'border-faint bg-bg'}`} />
            <div className={`pixel mt-3 max-w-full truncate text-[11px] sm:text-sm ${here ? 'text-volt' : ''}`}>{t.name}</div>
            <div className="num text-[11px] text-muted">hold {share(t.minSupplyPpm)}+</div>
            <div className="pixel num mt-2 text-lg sm:text-2xl">{pct(mode === 'onsite' ? t.onsiteCoverageBps : t.offsiteCoverageBps)}</div>
            <div className="text-[11px] text-muted">of the loss back</div>
          </div>;
        })}
      </div>
    </div>
    {me.wallet && h?.offsiteCoverageFrom && h.offsiteCoverageFrom > Date.now() && <p className="mt-5 text-xs text-muted">Off-site pulls are covered from {new Date(h.offsiteCoverageFrom).toLocaleString()} ({config?.settings?.offsiteActivationHours}h after you first connected).</p>}
  </div>;
}
