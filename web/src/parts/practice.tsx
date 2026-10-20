import { useState } from 'react';
import { FlaskConical, X } from 'lucide-react';
import { api } from '../api';
import { useApp } from '../app';

/** Practice-mode controls, kept out of the real UI in one floating drawer. */
export function PracticeDrawer() {
  const { refresh, notify, bump, me } = useApp();
  const [open, setOpen] = useState(false);
  const run = async (path: string, body: unknown, message: string) => {
    try { await api(path, body); notify(message); await refresh(); bump(); } catch (e) { notify((e as Error).message); }
  };
  const ppm = me.holder?.ppm ?? 0;
  if (!open) return <button onClick={() => setOpen(true)} className="btn btn-primary btn-sm fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] right-4 z-40 shadow-lg lg:bottom-5 lg:right-5"><FlaskConical size={14} />Practice</button>;
  return <aside className="card enter fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] right-4 z-40 lg:bottom-5 lg:right-5 w-[min(22rem,calc(100vw-2.5rem))] p-5 shadow-2xl">
    <div className="flex items-center justify-between"><span className="pixel flex items-center gap-2"><FlaskConical size={16} className="text-volt" />Practice tools</span><button aria-label="Close" onClick={() => setOpen(false)} className="text-muted hover:text-ink"><X size={18} /></button></div>
    <p className="mt-1 text-xs text-muted">Fake balances and a mocked Collector Crypt. Nothing here touches real money.</p>
    <div className="label mt-4">Your holdings</div>
    <div className="mt-2 grid grid-cols-4 gap-1.5">
      {[[0, 'None'], [1_000, 'Shrimp'], [10_000, 'Dolphin'], [20_000, 'Whale']].map(([value, label]) =>
        <button key={value} className={`btn btn-sm px-1.5 text-[11px] ${ppm === value ? 'btn-primary' : 'btn-outline'}`} onClick={() => run('/practice/holdings', { ppm: value }, `Holdings set to ${label}.`)}>{label}</button>)}
    </div>
    <div className="label mt-4">Off-site pulls</div>
    <div className="mt-2 grid grid-cols-2 gap-1.5">
      <button className="btn btn-outline btn-sm" onClick={() => run('/practice/bought', { hoursAgo: 72 }, 'Your coin now looks bought 3 days ago.')}>Bought 3 days ago</button>
      <button className="btn btn-outline btn-sm" onClick={() => run('/practice/bought', { hoursAgo: 0 }, 'Your coin now looks bought just now: earlier pulls are not covered.')}>Just bought</button>
    </div>
    <div className="mt-1.5 grid grid-cols-3 gap-1.5">
      {[25, 50, 100].map(p => <button key={p} className="btn btn-outline btn-sm" onClick={() => run('/practice/offsite-pull', { priceUsd: p, hoursAgo: 2 }, `Simulated a $${p} pack opened on Collector Crypt. Scan on the Claim page.`)}>${p} pull</button>)}
    </div>
    <div className="label mt-4">Pool</div>
    <button className="btn btn-outline btn-sm mt-2 w-full" onClick={() => run('/practice/fund-pool', { usd: 1_000 }, 'Added $1,000 of practice creator fees to the pool.')}>Add $1,000 creator fees</button>
  </aside>;
}
