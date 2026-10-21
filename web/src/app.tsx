import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type Ref } from 'react';
import { BarChart3, BookOpen, FlaskConical, LogOut, Package, ScanSearch, Settings2, Vault, Wallet as WalletIcon, type LucideIcon } from 'lucide-react';
import type { HolderView, PoolView } from '../../shared/types';
import { api, short } from './api';
import { forget, onAccountSwitch, signIn, useWallets } from './wallet';
import { Logo, Modal, Toast, Wordmark } from './ui';
import { OpenPage } from './pages/open';
import { ClaimPage } from './pages/claim';
import { PoolPage } from './pages/pool';
import { AdminPage } from './pages/admin';
import { DocsPage } from './pages/docs';
import { StatsPage } from './pages/stats';
import { PracticeDrawer } from './parts/practice';
import { ContractAddress } from './parts/contract';
import { XLink } from './parts/social';

export type Me = { wallet: string | null; owner?: boolean; activatedAt?: number; holder?: HolderView | null };
export type AppConfig = { mode: 'practice' | 'mainnet' | 'read-only'; mint: string | null; poolAddress: string | null; opsAddress: string | null; settings: any };
type Ctx = { me: Me; config: AppConfig | null; refresh: () => Promise<void>; connect: () => void; notify: (message: string) => void; version: number; bump: () => void };
const AppContext = createContext<Ctx>(null as any);
export const useApp = () => useContext(AppContext);

export function navigate(path: string) { history.pushState(null, '', path); window.dispatchEvent(new PopStateEvent('popstate')); scrollTo({ top: 0 }); }
export function Link({ href, className, children, ref, current, title }: { href: string; className?: string; children: React.ReactNode; ref?: Ref<HTMLAnchorElement>; current?: boolean; title?: string }) {
  return <a ref={ref} href={href} title={title} className={className} aria-current={current ? 'page' : undefined} onClick={e => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); navigate(href); }}>{children}</a>;
}

type NavItem = [href: string, label: string, icon: LucideIcon];

const TITLES: Record<string, string> = { '/claim': 'Claim', '/stats': 'Stats', '/pool': 'Vault', '/how-it-works': 'How it works', '/docs': 'How it works', '/admin': 'Admin' };

export function App() {
  const [path, setPath] = useState(location.pathname);
  const [me, setMe] = useState<Me>({ wallet: null });
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [picker, setPicker] = useState(false);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  // Bumped whenever practice tools or sign-in change state, so pages reload their data.
  const [version, setVersion] = useState(0);
  const wallets = useWallets();

  const refresh = useCallback(async () => { setMe(await api<Me>('/me')); }, []);
  const notify = useCallback((message: string) => setNotice(message), []);
  useEffect(() => { const on = () => setPath(location.pathname); window.addEventListener('popstate', on); return () => window.removeEventListener('popstate', on); }, []);
  useEffect(() => {
    refresh().catch(() => {});
    // Retry the public config until it loads, so a brief server restart doesn't leave pages blank.
    let timer: ReturnType<typeof setTimeout>;
    const loadConfig = () => api<AppConfig>('/config').then(setConfig).catch(() => { timer = setTimeout(loadConfig, 3000); });
    loadConfig();
    return () => clearTimeout(timer);
  }, [refresh]);
  useEffect(() => { document.title = TITLES[path] ? `${TITLES[path]} · Pullback` : 'Pullback · Bad pull? Pull back.'; }, [path]);

  const logout = useCallback(async (message?: string) => {
    forget();
    try { await api('/auth/logout', {}); } catch (e) { notify((e as Error).message); }
    await refresh().catch(() => {}); setVersion(v => v + 1);
    if (message) notify(message);
  }, [notify, refresh]);
  // Switching accounts in the wallet signs out the old one rather than failing later at payment.
  useEffect(() => onAccountSwitch(() => { void logout('Your wallet switched accounts. Connect again to use the new one.'); }), [logout]);

  async function connectWith(wallet?: any) {
    setBusy(true);
    try { if (wallet) await signIn(wallet); else await api('/practice/login', {}); setPicker(false); await refresh(); setVersion(v => v + 1); }
    catch (e) { notify((e as Error).message); } finally { setBusy(false); }
  }

  const nav: NavItem[] = [['/', 'Packs', Package], ['/claim', 'Claim', ScanSearch], ['/stats', 'Stats', BarChart3], ['/pool', 'Vault', Vault], ['/how-it-works', 'How it works', BookOpen], ...(me.owner ? [['/admin', 'Admin', Settings2] as NavItem] : [])];
  const active = path === '/docs' ? '/how-it-works' : nav.some(([href]) => href === path) ? path : '/';
  const page = path === '/claim' ? <ClaimPage /> : path === '/stats' ? <StatsPage /> : path === '/pool' ? <PoolPage /> : path === '/how-it-works' || path === '/docs' ? <DocsPage /> : path === '/admin' ? <AdminPage /> : <OpenPage />;
  const tier = me.holder?.tier;
  const practice = config?.mode === 'practice';
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => { const on = () => setScrolled(window.scrollY > 8); on(); window.addEventListener('scroll', on, { passive: true }); return () => window.removeEventListener('scroll', on); }, []);

  return <AppContext.Provider value={{ me, config, refresh, connect: () => setPicker(true), notify, version, bump: () => setVersion(v => v + 1) }}>
    {/* One floating bar: the brand, the pages (desktop) and the wallet. It firms up once the page scrolls. */}
    <header data-app-chrome className="sticky top-0 z-40 px-2 pt-2 sm:px-4 sm:pt-3">
      <div className={`mx-auto flex h-14 max-w-6xl items-center gap-3 rounded-2xl border pl-3 pr-2 backdrop-blur-md transition-[background-color,border-color,box-shadow] duration-300 lg:h-16 lg:gap-4 lg:pl-4 ${scrolled ? 'border-line bg-surface/90 shadow-[0_18px_40px_-22px_rgb(0_0_0/0.95)]' : 'border-line/60 bg-surface/55'}`}>
        <Link href="/" className="flex shrink-0 items-center gap-2.5" aria-label="Pullback home"><Logo size={28} /><span className="hidden min-[360px]:inline lg:hidden xl:inline"><Wordmark size="text-base" /></span></Link>
        {practice && <span className="tag hidden bg-volt-soft text-volt sm:inline-flex lg:hidden"><FlaskConical size={12} />Practice</span>}
        <DockNav items={nav} active={active} />
        <div className="ml-auto flex min-w-0 shrink-0 items-center gap-1.5 lg:ml-0">
          <XLink variant="icon" className="hidden sm:grid" />
          {me.wallet
            ? <span className="pixel num flex h-10 min-w-0 items-center gap-2 whitespace-nowrap rounded-lg border border-line bg-bg/70 px-3 text-xs" title={`${me.wallet}${tier ? ` · ${tier.name}` : ''}`}><i className={`size-2 shrink-0 ${tier ? 'bg-gain' : 'bg-faint'}`} />{short(me.wallet)}{tier && <span className="hidden text-muted sm:inline lg:hidden">· {tier.name}</span>}</span>
            : <button className="btn btn-primary btn-sm h-10" onClick={() => setPicker(true)}><WalletIcon size={15} />Connect</button>}
          {me.wallet && <button className="grid size-10 shrink-0 place-items-center rounded-lg text-muted hover:bg-raised hover:text-ink" onClick={() => logout()} aria-label="Sign out" title="Sign out"><LogOut size={16} /></button>}
        </div>
      </div>
    </header>
    <TabBar items={nav} active={active} />

    <main data-app-chrome className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">{page}</main>

    <footer data-app-chrome className="mt-8 border-t border-line pb-[calc(4rem+env(safe-area-inset-bottom))] lg:pb-0">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 text-sm sm:px-6 md:grid-cols-[1.2fr_1fr_1.6fr]">
        <div className="min-w-0">
          <Link href="/" className="flex items-center gap-2.5"><Logo size={24} /><Wordmark size="text-base" /></Link>
          <p className="mt-3 text-muted">Bad pull? Pull back. Loss rebates on Collector Crypt packs, Pokémon cards and watches, paid in USDC on Solana.</p>
        </div>
        <div className="grid content-start gap-2">
          <div className="label">Explore</div>
          {nav.filter(([href]) => href !== '/admin').map(([href, label]) => <Link key={href} href={href} className="w-fit text-muted hover:text-ink">{label}</Link>)}
          <XLink variant="inline" className="text-muted" />
        </div>
        <div className="grid min-w-0 content-start gap-3">
          <div className="label">Fine print</div>
          <p className="text-xs leading-relaxed text-muted">A discretionary loss rebate for token holders, not insurance and not a guarantee. Rebates come from the pool under the published rules. Card values are Collector Crypt's insured values at the time of the pull. Not affiliated with Nintendo, The Pokémon Company or Collector Crypt.</p>
          <ContractAddress variant="row" className="max-w-md" />
        </div>
      </div>
      <div className="border-t border-line">
        <div className="pixel mx-auto flex max-w-6xl justify-between px-4 py-3 text-[11px] uppercase text-faint sm:px-6"><span>Pullback</span><span>{config?.mode === 'mainnet' ? 'Solana mainnet' : practice ? 'Practice mode' : 'Pre-launch'}</span></div>
      </div>
    </footer>

    <Modal open={picker} onClose={() => setPicker(false)} label="Connect your wallet">
      <Logo size={34} />
      <h2 className="pixel mt-4 text-xl">Connect your wallet</h2>
      <p className="mt-1 text-sm text-muted">You'll sign a message to prove the wallet is yours. Signing in never approves a transaction.</p>
      <div className="mt-5 grid gap-2">
        {wallets.map(w => <button key={w.name} disabled={busy} className="btn btn-quiet h-12 justify-start" onClick={() => connectWith(w)}><img src={w.icon} alt="" width={24} height={24} className="rounded" />{w.name}</button>)}
        {!wallets.length && !practice && <p className="text-sm text-muted">No Solana wallet found. Install <a className="font-semibold text-volt underline" href="https://phantom.com" target="_blank" rel="noreferrer">Phantom</a> or <a className="font-semibold text-volt underline" href="https://solflare.com" target="_blank" rel="noreferrer">Solflare</a>, then reload.</p>}
        {practice && <button disabled={busy} className="btn btn-primary h-12" onClick={() => connectWith()}><FlaskConical size={16} />Use a practice wallet</button>}
      </div>
    </Modal>

    {practice && me.wallet && <PracticeDrawer />}
    <Toast message={notice} onClose={() => setNotice('')} />
  </AppContext.Provider>;
}

/** Measures the active link so the accent block can slide to it. Hidden navs measure as nothing. */
function useSlider(active: string, count: number) {
  const links = useRef<Record<string, HTMLAnchorElement | null>>({});
  const [box, setBox] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const measure = () => { const el = links.current[active]; setBox(el && el.offsetWidth ? { left: el.offsetLeft, width: el.offsetWidth } : null); };
    measure();
    document.fonts?.ready.then(measure);
    window.addEventListener('resize', measure); return () => window.removeEventListener('resize', measure);
  }, [active, count]);
  return { links, box };
}

const compactUsd = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: n < 1_000 ? 0 : 1 }).format(n);

/** Desktop: the pages as one segmented pill, the accent block sliding between them, the vault's live balance on its tab. */
function DockNav({ items, active }: { items: NavItem[]; active: string }) {
  const { version } = useApp();
  const { links, box } = useSlider(active, items.length);
  const [vault, setVault] = useState<number | null>(null);
  useEffect(() => {
    const load = () => api<PoolView>('/pool').then(p => setVault(p.balanceUsd)).catch(() => {});
    load(); const id = setInterval(() => { if (!document.hidden) load(); }, 30_000); return () => clearInterval(id);
  }, [version]);
  return <nav aria-label="Main" className="mx-auto hidden lg:block">
    <div className="relative flex items-center gap-0.5 rounded-xl border border-line bg-bg/70 p-1">
      {box && <span aria-hidden="true" className="nav-block absolute bottom-1 top-1 bg-volt" style={{ left: box.left, width: box.width }} />}
      {items.map(([href, label, Icon]) => {
        const on = href === active;
        return <Link key={href} href={href} current={on} ref={el => { links.current[href] = el; }} title={href === '/admin' ? label : undefined} className={`pixel relative z-[1] flex h-10 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-xs uppercase transition-colors ${on ? 'text-night' : 'text-muted hover:bg-raised hover:text-ink'}`}>
          <Icon size={15} aria-hidden="true" />{href === '/admin' ? <span className="sr-only">{label}</span> : label}
          {href === '/pool' && vault !== null && <span className={`num hidden rounded-[3px] px-1.5 py-0.5 text-[10px] xl:inline ${on ? 'bg-night/15 text-night' : 'bg-gain-soft text-gain'}`} title="In the vault now">{compactUsd(vault)}</span>}
        </Link>;
      })}
    </div>
  </nav>;
}

/** Phones and tablets: a tab bar fixed to the bottom, in thumb reach, with the same sliding block. */
function TabBar({ items, active }: { items: NavItem[]; active: string }) {
  const { links, box } = useSlider(active, items.length);
  return <nav aria-label="Main" data-app-chrome className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md lg:hidden">
    <div className="relative mx-auto grid max-w-xl px-1.5" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
      {box && <span aria-hidden="true" className="nav-block absolute bottom-1.5 top-1.5 bg-volt" style={{ left: box.left, width: box.width }} />}
      {items.map(([href, label, Icon]) => {
        const on = href === active;
        return <Link key={href} href={href} current={on} ref={el => { links.current[href] = el; }} className={`pixel relative z-[1] flex h-16 min-w-0 flex-col items-center justify-start gap-1.5 px-0.5 pt-3 text-center text-[9px] uppercase leading-[11px] transition-colors ${on ? 'text-night' : 'text-muted hover:text-ink'}`}>
          <Icon size={19} aria-hidden="true" /><span className="max-w-full">{label}</span>
        </Link>;
      })}
    </div>
  </nav>;
}
