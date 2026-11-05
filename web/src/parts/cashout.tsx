import { useEffect, useState } from 'react';
import { ArrowUpRight, Banknote, Loader2 } from 'lucide-react';
import type { OrderView } from '../../../shared/types';
import { api, friendly, money, solscan } from '../api';
import { useApp } from '../app';
import { ensureSigner, hasSigner, signPayments } from '../wallet';

export type SaleQuote = { available: boolean; amountUsd: number | null; expiresAt: number | null };
const NONE: SaleQuote = { available: false, amountUsd: null, expiresAt: null };

/** Collector Crypt's live sell-back offer for each order, by order id. */
export function useOffers(ids: string[]) {
  const key = ids.join(',');
  const [offers, setOffers] = useState<Record<string, SaleQuote> | null>(null);
  useEffect(() => {
    if (!key) { setOffers({}); return; }
    let live = true; setOffers(null);
    Promise.all(key.split(',').map(id => api<SaleQuote>(`/orders/${id}/sell`).catch(() => NONE).then(q => [id, q] as const))).then(all => { if (live) setOffers(Object.fromEntries(all)); });
    return () => { live = false; };
  }, [key]);
  return offers;
}

/** Sells several cards with one wallet approval. Each is still its own sale, so one failing leaves the others sold. */
export function useCashOut() {
  const { config, me, notify } = useApp();
  const [busy, setBusy] = useState(false);
  async function cashOut(ids: string[]) {
    if (busy || !ids.length) return [];
    setBusy(true);
    try {
      const practice = config?.mode === 'practice' && !hasSigner();
      if (!practice && me.wallet) await ensureSigner(me.wallet);
      const offers: { transaction: string; amountUsd: number }[] = [];
      for (const id of ids) offers.push(await api(`/orders/${id}/sell`, {}));
      const signed = practice ? offers.map(o => o.transaction) : await signPayments(offers.map(o => o.transaction));
      const sold: OrderView[] = []; let failed = 0;
      for (const [i, id] of ids.entries()) {
        try { sold.push(await api<OrderView>(`/orders/${id}/sell/submit`, { signed: signed[i] })); } catch { failed++; }
      }
      const total = sold.reduce((sum, o) => sum + (o.sale?.amountUsd ?? 0), 0);
      if (sold.length) notify(`Cashed out ${money(total)}.${failed ? ` ${failed} card${failed > 1 ? 's' : ''} could not be sold and stay in your wallet.` : ''}`);
      else notify('The sale did not go through. Your cards are still in your wallet.');
      return sold;
    } catch (e) { notify(friendly(e as Error)); return []; } finally { setBusy(false); }
  }
  return { cashOut, busy };
}

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * The end of a pull: what the sale and the rebate come to together, against what was paid, with one button
 * that sells every card here. Rebates are already in the wallet; only the sale is waiting on a signature.
 */
export function CashOut({ orders, onSold }: { orders: OrderView[]; onSold: (sold: OrderView[]) => void }) {
  const open = orders.filter(o => o.status === 'complete' && o.card && !o.sale);
  const offers = useOffers(open.map(o => o.id)), { cashOut, busy } = useCashOut();
  const sellable = open.filter(o => offers?.[o.id]?.available && offers[o.id].amountUsd !== null);
  const done = orders.filter(o => o.sale), paid = round(orders.reduce((s, o) => s + o.totalUsd, 0));
  const rebates = round(orders.reduce((s, o) => s + (o.rebateUsd ?? 0), 0));
  const sold = round(done.reduce((s, o) => s + (o.sale?.amountUsd ?? 0), 0));
  const offered = round(sellable.reduce((s, o) => s + (offers?.[o.id].amountUsd ?? 0), 0));
  const total = round(sold + offered + rebates), net = round(total - paid);
  const left = offers !== null && !sellable.length;
  if (left && !done.length) return null;
  const hours = sellable.length ? Math.min(...sellable.map(o => offers?.[o.id].expiresAt ?? Infinity)) : Infinity;
  const remain = Number.isFinite(hours) ? Math.max(0, Math.round((hours - Date.now()) / 3_600_000)) : null;

  return <div className="enter mt-5 rounded-xl border border-line bg-bg p-4">
    <div className="flex items-center justify-between gap-3"><span className="label">{sellable.length ? 'Cash out' : 'Cashed out'}</span>{remain !== null && <span className="label">Offer open {remain}h</span>}</div>
    <dl className="mt-3 grid gap-1.5 text-sm">
      <div className="leader"><dt className="text-muted">{sellable.length ? `Sell ${sellable.length > 1 ? `${sellable.length} cards` : 'the card'} to Collector Crypt` : 'Sold to Collector Crypt'}</dt><dd className="font-display num">{offers === null ? '…' : money(round(sold + offered))}</dd></div>
      <div className="leader"><dt className="text-muted">Rebate, already paid</dt><dd className="font-display num">{money(rebates)}</dd></div>
    </dl>
    <div className="mt-3 flex items-end justify-between gap-4 border-t border-line pt-3">
      <div><div className="label">Total back</div><div className="font-display num text-4xl font-bold leading-none tracking-tight">{offers === null ? '…' : money(total)}</div></div>
      {offers !== null && <div className="text-right"><div className="label">On {money(paid)} paid</div><div className={`font-display num text-sm ${net >= 0 ? 'text-gain' : 'text-loss'}`}>{net >= 0 ? '+' : '−'}{money(Math.abs(net))}</div></div>}
    </div>
    {sellable.length > 0 && <button className="btn btn-gain mt-4 h-12 w-full" disabled={busy} onClick={async () => { const s = await cashOut(sellable.map(o => o.id)); if (s.length) onSold(s); }}>
      {busy ? <Loader2 size={16} className="animate-spin" /> : <Banknote size={17} />}{busy ? 'Waiting for your wallet…' : `Cash out ${money(offered)}`}
    </button>}
    {done.length > 0 && <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs">{done.map((o, i) => <a key={o.id} className="inline-flex items-center gap-0.5 text-muted hover:text-accent" href={solscan('tx', o.sale!.signature)} target="_blank" rel="noreferrer">{done.length > 1 ? `Sale ${i + 1}` : 'Sale'}<ArrowUpRight size={12} /></a>)}</div>}
  </div>;
}
