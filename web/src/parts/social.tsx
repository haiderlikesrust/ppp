import { BRAND } from '../../../shared/brand';

const handle = BRAND.xHandle;

/** The X wordmark; lucide only ships the old bird. */
export function XLogo({ size = 16, className = '' }: { size?: number; className?: string }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} className={className} fill="currentColor" aria-hidden="true">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>;
}

/** The brand's X account, as a footer link. Renders nothing until `BRAND.xHandle` is set. */
export function XLink({ className = '' }: { variant?: 'inline'; className?: string }) {
  if (!handle) return null;
  return <a href={`https://x.com/${handle}`} target="_blank" rel="noreferrer" aria-label={`Follow @${handle} on X`} className={`inline-flex w-fit items-center gap-1.5 hover:text-ink ${className}`}><XLogo size={12} />@{handle}</a>;
}
