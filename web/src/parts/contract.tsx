import { useState } from 'react';
import { ArrowUpRight, Check, Copy } from 'lucide-react';
import { short, solscan } from '../api';
import { useApp } from '../app';

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Our token's contract address (MEMECOIN_MINT), with copy and Solscan. Renders nothing until a
 * real mint is configured, so practice mode and pre-launch never show a placeholder.
 */
export function ContractAddress({ variant, className = '' }: { variant: 'chip' | 'hero' | 'row'; className?: string }) {
  const { config, notify } = useApp();
  const [copied, setCopied] = useState(false);
  const mint = config?.mint;
  if (!mint || !BASE58.test(mint)) return null;
  async function copy() {
    try { await navigator.clipboard.writeText(mint!); setCopied(true); notify('Contract address copied.'); setTimeout(() => setCopied(false), 1800); }
    catch { notify(`Contract address: ${mint}`); }
  }
  const CopyIcon = copied ? Check : Copy;
  const link = <a href={solscan('token', mint)} target="_blank" rel="noreferrer" aria-label="View the token on Solscan" title="View on Solscan" className="grid size-8 shrink-0 place-items-center rounded-full text-muted hover:bg-line/60 hover:text-ink"><ArrowUpRight size={15} /></a>;

  if (variant === 'chip') return <div className={`flex h-9 items-center whitespace-nowrap rounded-full border border-line pl-3 pr-0.5 text-sm ${className}`} title={mint}>
    <span className="label mr-2">CA</span>
    <button onClick={copy} className="num flex items-center gap-1.5 rounded-full py-1 pr-2 hover:text-red" aria-label={`Copy contract address ${mint}`}>{short(mint)}<CopyIcon size={13} className={copied ? 'text-grass' : 'text-muted'} /></button>
    {link}
  </div>;

  if (variant === 'row') return <div className={`flex items-center gap-2 text-sm ${className}`}>
    <span className="label shrink-0">CA</span>
    <button onClick={copy} className="num min-w-0 flex-1 truncate text-left hover:text-red" aria-label={`Copy contract address ${mint}`} title={mint}>{mint}</button>
    <button onClick={copy} aria-label="Copy contract address" className="grid size-8 shrink-0 place-items-center rounded-full text-muted hover:bg-line/60 hover:text-ink"><CopyIcon size={15} className={copied ? 'text-grass' : ''} /></button>
    {link}
  </div>;

  return <div className={`card flex w-full min-w-0 max-w-lg items-center gap-3 py-2 pl-4 pr-2 ${className}`}>
    <div className="min-w-0 flex-1">
      <div className="label">Contract address</div>
      <button onClick={copy} className="num mt-0.5 block max-w-full truncate text-left text-sm hover:text-red sm:text-[15px]" title={mint} aria-label={`Copy contract address ${mint}`}>{mint}</button>
    </div>
    <button onClick={copy} className={`btn btn-sm shrink-0 ${copied ? 'bg-grass text-white' : 'btn-ink'}`}><CopyIcon size={14} />{copied ? 'Copied' : 'Copy'}</button>
    {link}
  </div>;
}
