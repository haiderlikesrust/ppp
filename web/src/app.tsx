import { createContext, useCallback, useContext, useEffect, useState, type Ref } from 'react';
import { BarChart3, FlaskConical, HelpCircle, Layers, LogOut, Menu, Moon, Package, ScanSearch, Settings2, Sun, Vault, Wallet as WalletIcon, X, type LucideIcon } from 'lucide-react';
import type { HolderView } from '../../shared/types';
import { BRAND } from '../../shared/brand';
import { api, short } from './api';
import { forget, onAccountSwitch, signIn, useWallets } from './wallet';
import { Modal, Toast, Wordmark } from './ui';
import { OpenPage } from './pages/open';
import { ClaimPage } from './pages/claim';
import { PoolPage } from './pages/pool';
import { AdminPage } from './pages/admin';
import { DocsPage } from './pages/docs';
import { StatsPage } from './pages/stats';
import { PortfolioPage } from './pages/portfolio';
import { PullPage } from './pages/pull';
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

const TITLES: Record<string, string> = { '/portfolio': 'Portfolio', '/claim': 'Claim', '/stats': 'Stats', '/pool': 'Vault', '/how-it-works': 'How it works', '/docs': 'How it works', '/admin': 'Admin' };
const PULL = /^\/pull\/([0-9a-f-]{36})$/;

/** Light by default; dark when chosen. public/theme.js applies a saved choice before the first paint. */
function useTheme() {
  const [dark, setDark] = useState(() => { try { return localStorage.getItem('rg-theme') === 'dark'; } catch { return false; } });
  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; }, [dark]);
  const toggle = () => { const next = !dark; setDark(next); try { localStorage.setItem('rg-theme', next ? 'dark' : 'light'); } catch { /* storage blocked: lasts this visit */ } };
  return { dark, toggle };
}

export function App() {
  const [path, setPath] = useState(location.pathname);
  const [me, setMe] = useState<Me>({ wallet: null });
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [picker, setPicker] = useState(false), [menu, setMenu] = useState(false);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  // Bumped whenever practice tools or sign-in change state, so pages reload their data.
  const [version, setVersion] = useState(0);
  const wallets = useWallets(), theme = useTheme();

  const refresh = useCallback(async () => { setMe(await api<Me>('/me')); }, []);
  const notify = useCallback((message: string) => setNotice(message), []);
  useEffect(() => { const on = () => { setPath(location.pathname); setMenu(false); }; window.addEventListener('popstate', on); return () => window.removeEventListener('popstate', on); }, []);
  useEffect(() => {
    if (!menu) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [menu]);
  useEffect(() => {
    refresh().catch(() => {});
    // Retry the public config until it loads, so a brief server restart doesn't leave pages blank.
    let timer: ReturnType<typeof setTimeout>;
    const loadConfig = () => api<AppConfig>('/config').then(setConfig).catch(() => { timer = setTimeout(loadConfig, 3000); });
    loadConfig();
    return () => clearTimeout(timer);
  }, [refresh]);
  useEffect(() => { document.title = TITLES[path] ? `${TITLES[path]} · ${BRAND.name}` : `${BRAND.name} · ${BRAND.tagline}`; }, [path]);

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

  // The logo sits between these two groups on wide screens; below that they run together in the menu.
  const left: NavItem[] = [['/', 'Packs', Package], ['/portfolio', 'Portfolio', Layers], ['/claim', 'Claim', ScanSearch]];
  const right: NavItem[] = [['/stats', 'Stats', BarChart3], ['/pool', 'Vault', Vault], ['/how-it-works', 'How it works', HelpCircle], ...(me.owner ? [['/admin', 'Admin', Settings2] as NavItem] : [])];
  const active = path === '/docs' ? '/how-it-works' : path;
  const pull = path.match(PULL)?.[1];
  const page = pull ? <PullPage id={pull} /> : path === '/portfolio' ? <PortfolioPage /> : path === '/claim' ? <ClaimPage /> : path === '/stats' ? <StatsPage /> : path === '/pool' ? <PoolPage /> : path === '/how-it-works' || path === '/docs' ? <DocsPage /> : path === '/admin' ? <AdminPage /> : <OpenPage />;
  const tier = me.holder?.tier;
  const practice = config?.mode === 'practice';

  return <AppContext.Provider value={{ me, config, refresh, connect: () => setPicker(true), notify, version, bump: () => setVersion(v => v + 1) }}>
    {menu && <button aria-hidden="true" tabIndex={-1} className="fixed inset-0 z-30 cursor-default" onClick={() => setMenu(false)} />}
    <header data-app-chrome className="topbar">
      <div className="relative mx-auto grid h-16 max-w-6xl grid-cols-[1fr_auto_1fr] items-center gap-3 px-4 sm:px-6">
        <div className="flex min-w-0 items-center">
          <button className="grid size-10 place-items-center rounded-lg text-ink hover:bg-raised xl:hidden" onClick={() => setMenu(m => !m)} aria-expanded={menu} aria-controls="site-menu" aria-label={menu ? 'Close menu' : 'Open menu'}>{menu ? <X size={21} /> : <Menu size={21} />}</button>
          <button onClick={theme.toggle} className="hidden size-9 place-items-center rounded-lg text-muted hover:bg-raised hover:text-ink xl:grid" aria-label={theme.dark ? 'Switch to light mode' : 'Switch to dark mode'}>{theme.dark ? <Sun size={18} /> : <Moon size={18} />}</button>
          <nav aria-label="Main" className="ml-auto hidden items-center gap-6 pr-5 xl:flex">{left.map(([href, label]) => <Link key={href} href={href} current={href === active} className="nav-link">{label}</Link>)}</nav>
        </div>
        <Link href="/" className="flex items-center gap-2" title={`${BRAND.name} home`}><Wordmark size="text-[1.7rem]" /></Link>
        <div className="flex min-w-0 items-center">
          <nav aria-label="More" className="hidden items-center gap-6 pl-5 xl:flex">{right.map(([href, label]) => <Link key={href} href={href} current={href === active} className="nav-link">{label}</Link>)}</nav>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {me.wallet ? <span className="num shrink-0 rounded-[10px] bg-raised px-2.5 py-2 text-[13px] font-medium" title={tier ? `${me.wallet} · ${tier.name}` : me.wallet}><span className="sm:hidden">{me.wallet.slice(0, 4)}…</span><span className="hidden sm:inline">{short(me.wallet)}</span></span>
              : <button className="btn btn-primary btn-sm" onClick={() => setPicker(true)}><WalletIcon size={15} className="hidden sm:block" />Connect</button>}
            {me.wallet && <button className="hidden size-9 shrink-0 place-items-center rounded-lg text-muted hover:bg-raised hover:text-ink xl:grid" onClick={() => logout()} aria-label="Sign out" title="Sign out"><LogOut size={16} /></button>}
          </div>
        </div>
        {menu && <div id="site-menu" className="menu-drop xl:hidden">
          <nav aria-label="Menu" className="grid gap-0.5">{[...left, ...right].map(([href, label, Icon]) => <Link key={href} href={href} current={href === active} className="menu-item"><Icon size={18} aria-hidden="true" />{label}</Link>)}</nav>
          <div className="mt-1.5 grid gap-0.5 border-t border-line pt-1.5">
            <button className="menu-item" onClick={theme.toggle}>{theme.dark ? <Sun size={18} /> : <Moon size={18} />}{theme.dark ? 'Light mode' : 'Dark mode'}</button>
            {me.wallet && <button className="menu-item" onClick={() => { setMenu(false); void logout(); }}><LogOut size={18} />Sign out {short(me.wallet)}</button>}
          </div>
        </div>}
      </div>
    </header>

    <main data-app-chrome className="mx-auto max-w-6xl px-4 pb-20 sm:px-6">{page}</main>
    <footer data-app-chrome className="border-t border-line">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 text-sm sm:px-6 md:grid-cols-[1.1fr_1.9fr]">
        <div className="min-w-0">
          <Link href="/" className="inline-flex"><Wordmark size="text-[1.5rem]" /></Link>
          <p className="mt-3 max-w-xs text-muted">{BRAND.tagline} Loss rebates on Collector Crypt packs, paid in USDC on Solana.</p>
          <XLink variant="inline" className="mt-3 text-muted" />
        </div>
        <div className="grid min-w-0 content-start gap-3">
          <div className="label">Fine print</div>
          <p className="text-xs leading-relaxed text-muted">A discretionary loss rebate for token holders, not insurance and not a guarantee. Rebates come from the vault under the published rules. Card values are Collector Crypt's insured values at the time of the pull. Regrade does not grade cards. Not affiliated with Nintendo, The Pokémon Company, Collector Crypt or any grading company.</p>
          <ContractAddress variant="row" className="max-w-md" />
        </div>
      </div>
    </footer>

    <Modal open={picker} onClose={() => setPicker(false)} label="Connect your wallet">
      <Wordmark size="text-[1.7rem]" />
      <h2 className="font-display mt-4 text-3xl font-bold">Connect your wallet</h2>
      <p className="mt-1 text-sm text-muted">You'll sign a message to prove the wallet is yours. Signing in never approves a transaction.</p>
      <div className="mt-5 grid gap-2">
        {wallets.map(w => <button key={w.name} disabled={busy} className="btn btn-quiet h-12 justify-start" onClick={() => connectWith(w)}><img src={w.icon} alt="" width={24} height={24} className="rounded" />{w.name}</button>)}
        {!wallets.length && !practice && <p className="text-sm text-muted">No Solana wallet found. Install <a className="font-semibold text-accent underline" href="https://phantom.com" target="_blank" rel="noreferrer">Phantom</a> or <a className="font-semibold text-accent underline" href="https://solflare.com" target="_blank" rel="noreferrer">Solflare</a>, then reload.</p>}
        {practice && <button disabled={busy} className="btn btn-primary h-12" onClick={() => connectWith()}><FlaskConical size={16} />Use a practice wallet</button>}
      </div>
    </Modal>

    {practice && me.wallet && <PracticeDrawer />}
    <Toast message={notice} onClose={() => setNotice('')} />
  </AppContext.Provider>;
}
