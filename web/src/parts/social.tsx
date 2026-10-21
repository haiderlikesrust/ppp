export const X_HANDLE = 'pullbackcards';
export const X_URL = `https://x.com/${X_HANDLE}`;

/** The X wordmark; lucide only ships the old bird. */
export function XLogo({ size = 16, className = '' }: { size?: number; className?: string }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} className={className} fill="currentColor" aria-hidden="true">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>;
}

/** `icon`: a round header button. `row`: the mobile menu line. `inline`: a footer link. */
export function XLink({ variant, className = '' }: { variant: 'icon' | 'row' | 'inline'; className?: string }) {
  const label = `Follow @${X_HANDLE} on X`;
  if (variant === 'icon') return <a href={X_URL} target="_blank" rel="noreferrer" aria-label={label} title={label} className={`size-9 place-items-center rounded-md text-muted hover:bg-raised hover:text-ink ${className}`}><XLogo size={15} /></a>;
  if (variant === 'row') return <a href={X_URL} target="_blank" rel="noreferrer" className={`flex h-12 items-center gap-3 px-4 text-sm hover:text-volt ${className}`}><XLogo size={15} /><span>Follow <span className="font-semibold">@{X_HANDLE}</span></span></a>;
  return <a href={X_URL} target="_blank" rel="noreferrer" aria-label={label} className={`inline-flex w-fit items-center gap-1.5 hover:text-ink ${className}`}><XLogo size={12} />@{X_HANDLE}</a>;
}
