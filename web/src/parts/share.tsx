import { useEffect, useRef, useState } from 'react';
import { Check, Download, Link2, Loader2, Share2 } from 'lucide-react';
import type { SitePull } from '../../../shared/types';
import { BRAND } from '../../../shared/brand';
import { api, money } from '../api';
import { useApp } from '../app';
import { Modal, packStyle } from '../ui';
import { XLogo } from './social';

const W = 1200, H = 630;
const INK = '#14151f', MUTED = '#565a70', LINE = '#dfe2ec', GAIN = '#0a8a62', SPARK = '#ffcb05';
const DISPLAY = '"Outfit Variable", sans-serif', BODY = '"Figtree Variable", sans-serif';

function loadImage(src: string) {
  return new Promise<HTMLImageElement | null>(resolve => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => resolve(null); img.src = src; });
}
function round(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) { c.beginPath(); c.roundRect(x, y, w, h, r); }
/** Breaks text on spaces to fit a width, for at most `lines` lines. */
function wrap(c: CanvasRenderingContext2D, text: string, width: number, lines: number) {
  const out: string[] = []; let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (c.measureText(next).width > width && line) { out.push(line); line = word; } else line = next;
  }
  out.push(line);
  if (out.length > lines) { out.length = lines; out[lines - 1] = `${out[lines - 1].replace(/\s+\S*$/, '')}…`; }
  return out;
}

/** Draws a pull as a 1200×630 card, ready to post. The photo comes through our own origin so the canvas can be saved. */
async function drawCard(canvas: HTMLCanvasElement, p: SitePull) {
  const c = canvas.getContext('2d')!;
  await Promise.all([document.fonts.load(`600 64px ${DISPLAY}`), document.fonts.load(`700 64px ${DISPLAY}`), document.fonts.load(`600 20px ${BODY}`)]).catch(() => {});
  const photo = p.card?.image ? await loadImage(`/api/pulls/${p.id}/image`) : null;
  const [name, set] = (p.card?.name ?? 'Graded card').split(' · '), style = packStyle(p.code, p.priceUsd);
  canvas.width = W; canvas.height = H;
  c.fillStyle = '#f5f6fa'; c.fillRect(0, 0, W, H);
  // The pack's element glows behind the card.
  const glow = c.createRadialGradient(270, H / 2, 40, 270, H / 2, 520); glow.addColorStop(0, `${style.color}55`); glow.addColorStop(1, `${style.color}00`);
  c.fillStyle = glow; c.fillRect(0, 0, W, H);

  // The card, tilted a little like one held up to the light.
  const cw = 372, ch = 520;
  c.save(); c.translate(270, H / 2); c.rotate(-0.045);
  c.shadowColor = 'rgba(20,21,31,.34)'; c.shadowBlur = 46; c.shadowOffsetY = 22; c.fillStyle = '#eceef4'; round(c, -cw / 2, -ch / 2, cw, ch, 18); c.fill();
  c.shadowColor = 'transparent'; round(c, -cw / 2, -ch / 2, cw, ch, 18); c.clip();
  if (photo) { const k = Math.max(cw / photo.width, ch / photo.height), dw = photo.width * k, dh = photo.height * k; c.drawImage(photo, -dw / 2, -dh / 2, dw, dh); }
  else {
    // No photo to show: the pack's color and the card's name, so the card never reads as broken.
    c.fillStyle = style.color; c.fillRect(-cw / 2, -ch / 2, cw, ch);
    c.fillStyle = '#fff'; c.textAlign = 'center'; c.font = `600 46px ${DISPLAY}`;
    const words = wrap(c, name, cw - 60, 3), top = -(words.length - 1) * 26 + 14;
    words.forEach((line, i) => c.fillText(line, 0, top + i * 52));
    c.textAlign = 'left';
  }
  c.restore();

  // The result.
  const x = 520, right = W - 72, regraded = p.rebateUsd > 0, hit = p.valueUsd >= p.priceUsd;
  // The wordmark: the name with its bolt.
  c.font = `700 42px ${DISPLAY}`; c.fillStyle = INK; c.fillText(BRAND.name, x, 96);
  c.save(); c.translate(x + c.measureText(BRAND.name).width + 3, 64); c.scale(1.5, 1.5); c.fillStyle = SPARK; c.fill(new Path2D('M10.2 1 1.5 13.5h5.3L5.4 23l9.1-13.2H9.1L10.2 1Z')); c.restore();
  c.fillStyle = style.color; c.beginPath(); c.arc(x + 11, 142, 11, 0, Math.PI * 2); c.fill();
  c.fillStyle = MUTED; c.font = `600 22px ${DISPLAY}`; c.fillText(`${style.name} ${money(p.priceUsd)} pack`, x + 32, 150);
  c.fillStyle = INK; c.font = `700 62px ${DISPLAY}`;
  const title = wrap(c, name, right - x, 2); title.forEach((line, i) => c.fillText(line, x, 232 + i * 68));
  let y = 232 + (title.length - 1) * 68;
  if (set) { c.fillStyle = MUTED; c.font = `600 22px ${BODY}`; c.fillText(wrap(c, set, right - x, 1)[0], x, y + 38); y += 38; }
  y += 66;
  const rows: [string, string, string][] = [['Pack', money(p.priceUsd), INK], ['Insured value', money(p.valueUsd), INK], ...(p.sellUsd !== null ? [['Sells back for', money(p.sellUsd), hit ? GAIN : INK] as [string, string, string]] : []), ...(p.soldUsd !== null ? [['Sold for', money(p.soldUsd), INK] as [string, string, string]] : [])];
  for (const [label, value, color] of rows) {
    c.fillStyle = MUTED; c.font = `600 24px ${BODY}`; c.fillText(label, x, y);
    c.fillStyle = color; c.textAlign = 'right'; c.font = `600 28px ${DISPLAY}`; c.fillText(value, right, y); c.textAlign = 'left';
    c.strokeStyle = LINE; c.lineWidth = 2; c.beginPath(); c.moveTo(x, y + 16); c.lineTo(right, y + 16); c.stroke();
    y += 50;
  }
  c.fillStyle = MUTED; c.font = `600 20px ${DISPLAY}`; c.fillText(new URL(BRAND.origin).host, x, H - 44);
  // The sticker.
  if (regraded || hit) {
    const word = regraded ? `Regraded +${money(p.rebateUsd)}` : 'Above the pack!';
    c.save(); c.font = `600 28px ${DISPLAY}`; const tw = c.measureText(word).width + 44;
    c.translate(right - tw / 2, H - 56); c.rotate(-0.07);
    c.fillStyle = regraded ? '#35dfa6' : SPARK; round(c, -tw / 2, -29, tw, 58, 14); c.fill();
    c.fillStyle = regraded ? '#06281d' : '#1a1500'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(word, 0, 1); c.restore();
  }
}

/** A button that opens the share sheet for a pull: the card image, a post, and the link. */
export function ShareButton({ id, className = 'btn btn-outline', label = 'Share' }: { id: string; className?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return <>
    <button className={className} onClick={() => setOpen(true)}><Share2 size={15} />{label}</button>
    <Modal open={open} onClose={() => setOpen(false)} width="max-w-2xl" label="Share this pull">{open && <ShareSheet id={id} />}</Modal>
  </>;
}

function ShareSheet({ id }: { id: string }) {
  const { notify } = useApp();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [pull, setPull] = useState<SitePull | null>(null), [ready, setReady] = useState(false), [copied, setCopied] = useState(false), [failed, setFailed] = useState(false);
  const link = `${location.origin}/s/${id}`;
  useEffect(() => {
    let live = true;
    api<SitePull>(`/pulls/${id}`).then(async p => { if (!live) return; setPull(p); await drawCard(canvas.current!, p); if (live) setReady(true); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [id]);
  const blob = () => new Promise<Blob | null>(resolve => canvas.current!.toBlob(resolve, 'image/png'));
  const filename = `regrade-${id.slice(0, 8)}.png`;
  async function save() {
    const b = await blob(); if (!b) return;
    const file = new File([b], filename, { type: 'image/png' });
    // Phones hand the image straight to their share sheet; desktops download it.
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file] }).catch(() => {}); return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5_000);
  }
  async function copy() {
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { notify(link); }
  }
  const name = pull?.card?.name.split(' · ')[0] ?? 'a graded card';
  const line = pull ? pull.rebateUsd > 0 ? `Pulled ${name} from a ${money(pull.priceUsd)} pack on ${BRAND.name}. ${money(pull.rebateUsd)} came back.` : `Pulled ${name}, worth ${money(pull.valueUsd)}, from a ${money(pull.priceUsd)} pack on ${BRAND.name}.` : '';
  const post = `https://x.com/intent/post?text=${encodeURIComponent(line)}&url=${encodeURIComponent(link)}`;
  return <div>
    <h2 className="font-display text-3xl font-bold">Share this pull</h2>
    <div className="relative mt-4 overflow-hidden rounded-2xl bg-raised" style={{ aspectRatio: `${W} / ${H}` }}>
      <canvas ref={canvas} width={W} height={H} className={`h-full w-full transition-opacity duration-500 ${ready ? 'opacity-100' : 'opacity-0'}`} aria-label={line} role="img" />
      {!ready && <div className="absolute inset-0 grid place-items-center text-sm text-muted">{failed ? 'This pull could not be loaded.' : <Loader2 size={20} className="animate-spin" />}</div>}
    </div>
    <div className="mt-4 grid gap-2 sm:grid-cols-3">
      <a className={`btn btn-primary ${ready ? '' : 'pointer-events-none opacity-40'}`} href={post} target="_blank" rel="noreferrer"><XLogo size={14} />Post on X</a>
      <button className="btn btn-outline" disabled={!ready} onClick={save}><Download size={15} />Save image</button>
      <button className="btn btn-outline" onClick={copy}>{copied ? <Check size={15} /> : <Link2 size={15} />}{copied ? 'Copied' : 'Copy link'}</button>
    </div>
  </div>;
}
