import { useRef, type CSSProperties } from 'react';
import type { Card, OrderStatus } from '../../../shared/types';
import { Booster, Slab, isWatch, packStyle } from '../ui';

const SPARKS = Array.from({ length: 8 }, (_, i) => {
  const angle = (i / 8) * Math.PI * 2 + 0.4;
  return { dx: `${Math.round(Math.cos(angle) * 120)}px`, dy: `${Math.round(Math.sin(angle) * 130)}px`, delay: `${(i % 4) * 0.25}s` };
});
const BURST = Array.from({ length: 12 }, (_, i) => {
  const angle = (i / 12) * Math.PI * 2;
  return { dx: `${Math.round(Math.cos(angle) * 150)}px`, dy: `${Math.round(Math.sin(angle) * 160)}px` };
});

/**
 * The booster on the order screen. It bobs while the buyer approves the payment, a dashed ring turns
 * while the payment confirms, and it rumbles with pixel sparks while Collector Crypt opens it. When the
 * card arrives the top strip rips off, the booster drops away, and the card rises through a scan line.
 * A card worth more than the pack gets a shiny burst. Reopening a finished order just shows the card.
 */
export function PackOpening({ code, priceUsd, status, card, hit }: { code: string; priceUsd: number; status?: OrderStatus; card: Card | null; hit: boolean }) {
  const sawPack = useRef(!card);
  const failed = status === 'refunded' || status === 'expired' || status === 'review' || status === 'refunding';
  const charging = !failed && (status === 'paid' || status === 'buying'), confirming = !failed && status === 'paying';
  const glow = { '--glow': packStyle(code, priceUsd).color } as CSSProperties;

  if (!card) return <div className="relative mx-auto w-[170px] sm:w-[190px]" style={glow}>
    {(charging || confirming) && <div className={`charge-ring ${charging ? 'fast' : ''}`} aria-hidden="true" />}
    {charging && SPARKS.map((s, i) => <i key={i} className="pixel-spark" style={{ '--dx': s.dx, '--dy': s.dy, animationDelay: s.delay } as CSSProperties} aria-hidden="true" />)}
    <Booster code={code} priceUsd={priceUsd} className={failed ? 'opacity-50 grayscale' : charging ? 'rumble' : 'bob'} />
  </div>;

  const burst = sawPack.current;
  return <div className="relative mx-auto w-[170px] sm:w-[190px]" style={glow}>
    {hit && <div className="shiny" aria-hidden="true" />}
    {burst && <>
      <div className="rip-strip" aria-hidden="true"><Booster code={code} priceUsd={priceUsd} /></div>
      <div className="rip-body" aria-hidden="true"><Booster code={code} priceUsd={priceUsd} /></div>
    </>}
    <div className={`relative z-[2] ${burst ? 'card-up' : 'enter'}`}>
      <div className={burst ? 'scanned' : ''}><Slab card={card} priceUsd={priceUsd} watch={isWatch(code)} /></div>
      {burst && <div className="scan-line" aria-hidden="true" />}
    </div>
    {burst && hit && BURST.map((b, i) => <i key={i} className="shiny-burst" style={{ '--dx': b.dx, '--dy': b.dy } as CSSProperties} aria-hidden="true" />)}
  </div>;
}
