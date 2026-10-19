import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { FlaskConical, LogOut, Menu, Wallet as WalletIcon, X } from 'lucide-react';
import type { HolderView } from '../../shared/types';
import { api, short } from './api';
import { forget, signIn, useWallets } from './wallet';
import { Logo, Modal, Toast } from './ui';
import { OpenPage } from './pages/open';
import { ClaimPage } from './pages/claim';
import { PoolPage } from './pages/pool';
import { AdminPage } from './pages/admin';
import { DocsPage } from './pages/docs';
import { PracticeDrawer } from './parts/practice';

export type Me = { wallet: string | null; owner?: boolean; activatedAt?: number; holder?: HolderView | null };
export type AppConfig = { mode: 'practice' | 'mainnet' | 'read-only'; mint: string | null; poolAddress: string | null; settings: any };
type Ctx = { me: Me; config: AppConfig | null; refresh: () => Promise<void>; connect: () => void; notify: (message: string) => void; version: number; bump: () => void };
const AppContext = createContext<Ctx>(null as any);
export const useApp = () => useContext(AppContext);

export function navigate(path: string) { history.pushState(null, '', path); window.dispatchEvent(new PopStateEvent('popstate')); scrollTo({ top: 0 }); }
export function Link({ href, className, children }: { href: string; className?: string; children: React.ReactNode }) {
  return <a href={href} className={className} onClick={e => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); navigate(href); }}>{children}</a>;
}

export function App() {
  const [path, setPath] = useState(location.pathname);
  const [me, setMe] = useState<Me>({ wallet: null });
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [picker, setPicker] = useState(false);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  // Bumped whenever practice tools change state, so pages reload their data.
  const [version, setVersion] = useState(0);
  const wallets = useWallets();

  const refresh = useCallback(async () => { setMe(await api<Me>('/me')); }, []);
  useEffect(() => { const on = () => setPath(location.pathname); window.addEventListener('popstate', on); return () => window.removeEventListener('popstate', on); }, []);
  useEffect(() => { refresh().catch(() => {}); api<AppConfig>('/config').then(setConfig).catch(() => {}); }, [refresh]);
  const notify = useCallback((message: string) => setNotice(message), []);
  // The mobile menu closes on navigation and on Escape.
  useEffect(() => setMenu(false), [path]);
  useEffect(() => {
    if (!menu) return;
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(false);
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [menu]);

  async function connectWith(wallet?: any) {
    setBusy(true);
    try { if (wallet) await signIn(wallet); else await api('/practice/login', {}); setPicker(false); await refresh(); setVersion(v => v + 1); }
    catch (e) { notify((e as Error).message); } finally { setBusy(false); }
  }
  async function logout() { await api('/auth/logout', {}); forget(); await refresh(); setVersion(v => v + 1); }

  const nav = [['/', 'Open packs'], ['/claim', 'Claim'], ['/pool', 'Pool'], ['/docs', 'Docs'], ...(me.owner ? [['/admin', 'Admin']] : [])];
  const page = path === '/claim' ? <ClaimPage /> : path === '/pool' ? <PoolPage /> : path === '/docs' ? <DocsPage /> : path === '/admin' ? <AdminPage /> : <OpenPage />;
  const tier = me.holder?.tier;

  return <AppContext.Provider value={{ me, config, refresh, connect: () => setPicker(true), notify, version, bump: () => setVersion(v => v + 1) }}>
    <header className="sticky top-0 z-40 border-b border-line bg-bg/90 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 md:h-16 md:gap-6 md:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2 font-semibold tracking-tight"><Logo size={26} /><span className="hidden min-[380px]:inline">Pull Protection</span></Link>
        <nav aria-label="Main" className="hidden items-center gap-1 lg:flex">
          {nav.map(([href, label]) => <Link key={href} href={href} className={`whitespace-nowrap rounded-full px-3.5 py-1.5 text-sm transition ${path === href ? 'bg-ink text-white' : 'text-muted hover:text-ink'}`}>{label}</Link>)}
        </nav>
        <div className="ml-auto flex items-center gap-1.5">
          {config?.mode === 'practice' && <span className="chip hidden bg-yellow-soft text-ink lg:inline-flex"><FlaskConical size={13} />Practice</span>}
          {me.wallet
            ? <span className="flex h-9 items-center gap-2 whitespace-nowrap rounded-full border border-line px-3 text-sm" title={me.wallet}><span className={`size-2 rounded-full ${tier ? 'bg-grass' : 'bg-faint'}`} /><span className="num">{short(me.wallet)}</span></span>
            : <button className="btn btn-ink btn-sm" onClick={() => setPicker(true)}><WalletIcon size={15} />Connect</button>}
          {me.wallet && <button className="hidden size-9 place-items-center rounded-full text-muted hover:bg-line/60 hover:text-ink lg:grid" onClick={logout} aria-label="Sign out" title="Sign out"><LogOut size={16} /></button>}
          <button className="grid size-10 place-items-center rounded-full hover:bg-line/60 lg:hidden" onClick={() => setMenu(m => !m)} aria-label={menu ? 'Close menu' : 'Open menu'} aria-expanded={menu} aria-controls="mobile-menu">
            {menu ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </div>
      {menu && <nav id="mobile-menu" aria-label="Main" className="rise mx-auto max-w-6xl border-t border-line px-4 pb-4 pt-2 md:px-6 lg:hidden">
        {nav.map(([href, label]) => <Link key={href} href={href} className={`flex h-12 items-center justify-between rounded-xl px-3 text-base ${path === href ? 'bg-ink font-semibold text-white' : 'hover:bg-line/50'}`}>{label}{path === href && <span className="size-1.5 rounded-full bg-red" />}</Link>)}
        <div className="mt-3 flex items-center gap-3 border-t border-line px-3 pt-4 text-sm">
          {me.wallet ? <>
            <div className="min-w-0 flex-1"><div className="num truncate">{short(me.wallet)}</div><div className="text-xs text-muted">{tier ? `${tier.name} tier` : 'No tier yet'}{config?.mode === 'practice' ? ' · practice wallet' : ''}</div></div>
            <button className="btn btn-ghost btn-sm" onClick={() => { setMenu(false); void logout(); }}><LogOut size={14} />Sign out</button>
          </> : <button className="btn btn-ink w-full" onClick={() => { setMenu(false); setPicker(true); }}><WalletIcon size={16} />Connect wallet</button>}
        </div>
      </nav>}
    </header>
    {menu && <div className="fixed inset-0 z-30 bg-ink/20 lg:hidden" onClick={() => setMenu(false)} aria-hidden="true" />}

    <main className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">{page}</main>

    <footer className="border-t border-line">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-8 text-xs leading-relaxed text-muted sm:flex-row sm:px-6">
        <div className="flex items-center gap-4"><span className="flex items-center gap-2 font-semibold text-ink"><Logo size={18} />Pull Protection</span><Link href="/docs" className="underline-offset-2 hover:text-ink hover:underline">How it works</Link><Link href="/pool" className="underline-offset-2 hover:text-ink hover:underline">Pool</Link></div>
        <p className="sm:ml-auto sm:max-w-xl sm:text-right">A discretionary loss rebate for holders, not insurance and not a guarantee. Rebates depend on the pool balance and the published rules. Card values are Collector Crypt insured values at the time of the pull. Not affiliated with Nintendo, The Pokémon Company or Collector Crypt.</p>
      </div>
    </footer>

    <Modal open={picker} onClose={() => setPicker(false)}>
      <Logo size={36} />
      <h2 className="mt-4 text-xl font-semibold">Connect your wallet</h2>
      <p className="mt-1 text-sm text-muted">You'll sign a message to prove the wallet is yours. Signing in never approves a transaction.</p>
      <div className="mt-5 grid gap-2">
        {wallets.map(w => <button key={w.name} disabled={busy} className="btn btn-ghost h-12 justify-start rounded-2xl" onClick={() => connectWith(w)}><img src={w.icon} alt="" width={24} height={24} className="rounded-md" />{w.name}</button>)}
        {!wallets.length && config?.mode !== 'practice' && <p className="text-sm text-muted">No Solana wallet found. Install <a className="font-semibold text-blue underline" href="https://phantom.com" target="_blank" rel="noreferrer">Phantom</a> or <a className="font-semibold text-blue underline" href="https://solflare.com" target="_blank" rel="noreferrer">Solflare</a>, then reload.</p>}
        {config?.mode === 'practice' && <button disabled={busy} className="btn btn-red h-12 rounded-2xl" onClick={() => connectWith()}><FlaskConical size={16} />Use a practice wallet</button>}
      </div>
    </Modal>

    {config?.mode === 'practice' && me.wallet && <PracticeDrawer />}
    <Toast message={notice} onClose={() => setNotice('')} />
  </AppContext.Provider>;
}
