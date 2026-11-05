import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { Card, OrderStatus } from '../../../shared/types';
import { money } from '../api';
import { Booster, TradingCard, isWatch, packStyle, useCount } from '../ui';

/** When the card has finished flipping in, counted from the moment it arrived. */
const SETTLED_MS = 1700;
const SPARKLES = [[10, 14, 0], [86, 10, 0.4], [6, 62, 0.8], [92, 58, 0.2], [20, 84, 0.6], [78, 86, 1]];

type Phase = 'insert' | 'confirm' | 'open' | 'reveal' | 'done' | 'failed';

/**
 * The opening. The pack floats while the payment confirms, and energy charges in a ring around it, in its own
 * element's color, while Collector Crypt opens it. Then it fades into a flash and the card swings up into place.
 * A hit sends out yellow ripples and sparkles. A bad pull gets a mint Regraded sticker with its rebate counting up.
 * Reopening a finished order just shows the result.
 */
export function PackOpening({ code, priceUsd, status, card, hit, rebateUsd = null, replay = false }: { code: string; priceUsd: number; status?: OrderStatus; card: Card | null; hit: boolean; rebateUsd?: number | null; replay?: boolean }) {
  // The reveal only plays if this screen showed the pack first, or, with `replay`, every time it mounts.
  const watched = useRef(replay || !card).current;
  const arrived = useRef<number | null>(null);
  if (card && arrived.current === null) arrived.current = watched ? Date.now() : 0;
  const settled = useSettled(arrived.current);

  const failed = status === 'refunded' || status === 'expired' || status === 'review' || status === 'refunding';
  const phase: Phase = failed ? 'failed' : card ? (status === 'complete' ? 'done' : 'reveal') : status === 'paying' ? 'confirm' : status === 'paid' || status === 'buying' ? 'open' : 'insert';
  const back = card && !hit && status === 'complete' && rebateUsd ? rebateUsd : 0, ready = phase === 'done' && settled;
  const caption = {
    insert: 'Waiting for your wallet', confirm: 'Confirming payment', open: 'Opening your pack', reveal: status === 'settling' ? 'Checking its value' : 'Sending your card',
    done: hit ? 'A hit!' : back ? 'Regraded' : 'Done',
    failed: status === 'refunding' ? 'Refunding' : status === 'refunded' ? 'Refunded' : status === 'expired' ? 'Closed' : 'On hold',
  }[phase];

  return <div className="stage mx-auto flex h-[470px] w-full max-w-[320px] flex-col items-center justify-center px-10 pb-8" style={{ '--glow': packStyle(code, priceUsd).color } as CSSProperties}>
    {(!card || watched) && <div className={`absolute inset-x-[15%] top-[17%] ${card ? 'pack-out' : ''}`} aria-hidden={!!card}>
      <div className={phase === 'failed' ? 'opacity-40 grayscale' : phase === 'open' ? 'pack-charge' : card ? '' : 'float'}><Booster code={code} priceUsd={priceUsd} /></div>
    </div>}
    {phase === 'open' && <i className="charge" aria-hidden="true" />}
    {card && watched && <i className="flash" aria-hidden="true" />}
    {!card && phase !== 'failed' && <div className="sr-only">{caption}</div>}

    {card && <div className="relative z-[3] w-full">
      {hit && ready && <>{[0, 0.8, 1.6].map(d => <i key={d} className="ripple" aria-hidden="true" style={{ '--d': `${d}s` } as CSSProperties} />)}{SPARKLES.map(([x, y, d], i) => <i key={i} className="sparkle" aria-hidden="true" style={{ left: `${x}%`, top: `${y}%`, '--d': `${d}s` } as CSSProperties} />)}</>}
      <div className={watched ? 'card-arrive' : 'enter'}>
        <TradingCard card={card} priceUsd={priceUsd} watch={isWatch(code)} holo={hit && ready} tilt={ready} />
      </div>
      {ready && back > 0 && <div className="pop-in absolute inset-x-0 -bottom-4 z-[4] grid place-items-center"><Rebate amount={back} /></div>}
      {ready && hit && <div className="pop-in absolute inset-x-0 -bottom-4 z-[4] grid place-items-center"><span className="sticker sticker-hit">Above the pack!</span></div>}
    </div>}

    <div className="label absolute inset-x-0 bottom-0 z-[6] flex h-9 items-center justify-center px-3 text-center" aria-hidden="true">
      <span className={phase === 'failed' ? 'text-loss' : phase === 'done' ? (hit ? 'text-warn' : 'text-gain') : ''}>{caption}</span>
    </div>
  </div>;
}

function Rebate({ amount }: { amount: number }) {
  const shown = useCount(amount);
  return <span className="sticker num">Regraded +{money(Math.round(shown * 100) / 100)}</span>;
}

/** True once the card has finished arriving, however late the value or rebate comes. */
function useSettled(arrived: number | null) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (arrived === null || done) return;
    const left = arrived + SETTLED_MS - Date.now();
    if (left <= 0 || matchMedia('(prefers-reduced-motion: reduce)').matches) { setDone(true); return; }
    const t = setTimeout(() => setDone(true), left);
    return () => clearTimeout(t);
  }, [arrived, done]);
  return done;
}
