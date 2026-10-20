import { useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Card, OrderStatus } from '../../../shared/types';
import { money } from '../api';
import { Booster, Slab, isWatch, packStyle } from '../ui';

const SPARKS = Array.from({ length: 10 }, (_, i) => {
  const angle = (i / 10) * Math.PI * 2 + 0.3;
  return { dx: `${Math.round(Math.cos(angle) * 84)}px`, dy: `${Math.round(Math.sin(angle) * 96)}px`, delay: `${(i % 5) * 0.2}s` };
});
const BURST = Array.from({ length: 12 }, (_, i) => {
  const angle = (i / 12) * Math.PI * 2;
  return { dx: `${Math.round(Math.cos(angle) * 110)}px`, dy: `${Math.round(Math.sin(angle) * 120)}px` };
});
const COINS = [-48, -26, -8, 12, 30, 50];
const LEDS = 8;
/** When the card has finished flipping up, counted from the moment it arrived. */
const REVEALED_MS = 1500;

type Phase = 'insert' | 'confirm' | 'open' | 'reveal' | 'done' | 'failed';

/**
 * The order screen's gacha machine, in a lit display case that keeps every effect inside it.
 * A coin drops in while the payment confirms; the machine shakes under a light sweep while Collector
 * Crypt opens the pack; then a flash, a capsule pops out and splits, and the real card flips up out of
 * it. A hit gets rays and a burst; a bad pull gets green coins and its rebate. Reopening a finished
 * order just shows the card.
 */
export function PackOpening({ code, priceUsd, status, card, hit, rebateUsd = null }: { code: string; priceUsd: number; status?: OrderStatus; card: Card | null; hit: boolean; rebateUsd?: number | null }) {
  // The reveal only plays if this screen showed the machine first.
  const watched = useRef(!card).current;
  const arrived = useRef<number | null>(null);
  if (card && arrived.current === null) arrived.current = watched ? Date.now() : 0;

  const failed = status === 'refunded' || status === 'expired' || status === 'review' || status === 'refunding';
  const phase: Phase = failed ? 'failed' : card ? (status === 'complete' ? 'done' : 'reveal') : status === 'paying' ? 'confirm' : status === 'paid' || status === 'buying' ? 'open' : 'insert';
  const back = card && !hit && status === 'complete' && rebateUsd ? rebateUsd : 0;
  const caption = {
    insert: 'Insert USDC', confirm: 'Confirming', open: 'Opening', reveal: status === 'settling' ? 'Checking value' : 'Sending card',
    done: hit ? 'Hit!' : back ? 'Rebate sent' : 'Done',
    failed: status === 'refunding' ? 'Refunding' : status === 'refunded' ? 'Refunded' : status === 'expired' ? 'Closed' : 'On hold',
  }[phase];
  const glow = { '--glow': packStyle(code, priceUsd).color } as CSSProperties;

  return <div className="stage mx-auto h-[330px] w-full max-w-[240px]" style={glow}>
    {(!card || watched) && <div className={`absolute left-[10%] right-[10%] top-[5%] ${card ? 'machine-out' : ''}`} aria-hidden={!!card}>
      <div className={phase === 'open' ? 'rumble' : phase === 'failed' ? 'opacity-40 grayscale' : 'bob'}><Booster code={code} priceUsd={priceUsd} /></div>
      {phase === 'open' && <div className="sweep" aria-hidden="true" />}
    </div>}
    {phase === 'confirm' && <i className="coin" aria-hidden="true" />}
    {phase === 'open' && SPARKS.map((s, i) => <i key={i} className="pixel-spark" style={{ '--dx': s.dx, '--dy': s.dy, animationDelay: s.delay } as CSSProperties} aria-hidden="true" />)}

    {card && watched && <>
      <div className="flash" aria-hidden="true" />
      <i className="cap cap-top" aria-hidden="true" /><i className="cap cap-bottom" aria-hidden="true" />
    </>}

    {card && <div className="absolute inset-x-0 top-[5%] z-[3] mx-auto w-[60%]">
      {hit && <Afterglow since={arrived.current!}>{at => <>
        <div className="shiny" style={{ animationDelay: `0s, ${at}s` }} aria-hidden="true" />
        {watched && BURST.map((b, i) => <i key={i} className="shiny-burst" style={{ '--dx': b.dx, '--dy': b.dy, animationDelay: `${at}s` } as CSSProperties} aria-hidden="true" />)}
      </>}</Afterglow>}
      <div className={watched ? 'card-flip' : 'enter'}>
        <div className="relative"><Slab card={card} priceUsd={priceUsd} watch={isWatch(code)} />{watched && <i className="slab-shine" aria-hidden="true" />}</div>
      </div>
      {back > 0 && <Afterglow since={arrived.current!}>{at => <>
        <div className="absolute -right-7 top-[44%] z-[4] rotate-[-8deg]"><div className="pop tag h-7 bg-gain px-2.5 text-xs text-night shadow-lg" style={{ animationDelay: `${at}s` }}>+{money(back)} back</div></div>
        {watched && COINS.map((dx, i) => <i key={i} className="rebate-coin" style={{ '--dx': `${dx}px`, animationDelay: `${at + i * 0.09}s` } as CSSProperties} aria-hidden="true" />)}
      </>}</Afterglow>}
    </div>}

    <div className="absolute inset-x-0 bottom-0 z-[6] flex h-8 items-center justify-between gap-3 border-t border-line bg-night/90 px-3" aria-hidden="true">
      <span className={`pixel truncate text-[10px] uppercase ${phase === 'failed' ? 'text-loss' : phase === 'done' ? (hit ? 'text-volt' : 'text-gain') : 'text-muted'}`}>{caption}</span>
      <span className={`leds ${phase} ${hit ? 'hit' : ''}`}>{Array.from({ length: LEDS }, (_, i) => <i key={i} style={{ '--i': i } as CSSProperties} />)}</span>
    </div>
  </div>;
}

/**
 * Effects that follow the reveal: they wait until the card has flipped up, however late the value or
 * rebate arrives. The delay is fixed when they first appear, so later renders don't restart them.
 */
function Afterglow({ since, children }: { since: number; children: (delaySeconds: number) => ReactNode }) {
  const [at] = useState(() => since ? Math.max(0.1, (since + REVEALED_MS - Date.now()) / 1000) : 0);
  return <>{children(at)}</>;
}
