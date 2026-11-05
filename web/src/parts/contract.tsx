import { useState } from 'react';
import { ArrowUpRight, Check, Copy } from 'lucide-react';
import { short, solscan } from '../api';
import { useApp } from '../app';

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Our token's contract address (MEMECOIN_MINT), with copy and Solscan. Renders nothing until a
 * real mint is configured, so practice mode and pre-launch never show a placeholder.
 */
export function ContractAddress({ variant, className = '' }: { variant: 'hero' | 'row'; className?: string }) {
  const { config, notify } = useApp();
  const [copied, setCopied] = useState(false);
  const mint = config?.mint;
  if (!mint || !BASE58.test(mint)) return null;
  async function copy() {
    try { await navigator.clipboard.writeText(mint!); setCopied(true); notify('Contract address copied.'); setTimeout(() => setCopied(false), 1800); }
    catch { notify(`Contract address: ${mint}`); }
  }
  const CopyIcon = copied ? Check : Copy;
  const link = <a href={solscan('token', mint)} target="_blank" rel="noreferrer" aria-label="View the token on Solscan" title="View on Solscan" className="grid size-8 shrink-0 place-items-center rounded-xl text-muted hover:bg-raised hover:text-ink"><ArrowUpRight size={15} /></a>;

  if (variant === 'row') return <div className={`flex items-center gap-2 text-sm ${className}`}>
    <span className="label shrink-0">CA</span>
    <button onClick={copy} className="font-display num min-w-0 flex-1 truncate text-left text-xs hover:text-accent" aria-label={`Copy contract address ${mint}`} title={mint}>{mint}</button>
    <button onClick={copy} aria-label="Copy contract address" className="grid size-8 shrink-0 place-items-center rounded-xl text-muted hover:bg-raised hover:text-ink"><CopyIcon size={15} className={copied ? 'text-gain' : ''} /></button>
    {link}
  </div>;

  return <div className={`flex min-w-0 items-center gap-2 ${className}`}>
    <span className="label shrink-0">CA</span>
    <button onClick={copy} className="font-display num flex min-w-0 items-center gap-1.5 text-xs hover:text-accent" title={mint} aria-label={`Copy contract address ${mint}`}><span className="truncate">{short(mint)}</span><CopyIcon size={13} className={copied ? 'text-gain' : 'text-muted'} /></button>
    {link}
  </div>;
}
