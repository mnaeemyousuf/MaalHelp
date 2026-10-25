import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Command } from 'cmdk';
import { Bell, ChevronsUpDown, CloudOff, LogOut, Menu as MenuIcon, Search, Sparkles, UserRound, X, RefreshCw, Smartphone } from 'lucide-react';
import { api, onQueueChange, queuedRequests, syncIssues, syncQueue } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn, initials } from '@/lib/utils';
import { Kbd, Spinner } from '@/components/ui/core';
import { Menu } from '@/components/ui/overlay';
import { NAV, PLATFORM_NAV } from './nav';
import { BrandLogo } from '@/components/Brand';

function useBadges(enabled: boolean) {
  const { can } = useAuth();
  // Only ask for counts the user is allowed to see (avoids 403s for floor roles).
  const allowed = { alerts: can('alert.view', 'dashboard.view', 'inventory.view'), approvals: can('approval.decide'), putaway: can('putaway.execute'), picking: can('picking.execute', 'task.manage') };
  return useQuery({
    queryKey: ['nav-badges', allowed],
    enabled,
    refetchInterval: 60_000,
    queryFn: async () => {
      const [alerts, approvals, putaway, picking] = await Promise.all([
        !allowed.alerts ? 0 : api.page<unknown>('/alerts', { pageSize: 1 }).then((r) => Object.values((r.meta?.counts ?? {}) as Record<string, { unread: number }>).reduce((s, c) => s + c.unread, 0)).catch(() => 0),
        !allowed.approvals ? 0 : api.page<unknown>('/approvals', { pageSize: 1 }).then((r) => r.meta?.total ?? 0).catch(() => 0),
        !allowed.putaway ? 0 : api.page<unknown>('/putaway/tasks', { pageSize: 1 }).then((r) => r.meta?.total ?? 0).catch(() => 0),
        !allowed.picking ? 0 : api.page<unknown>('/picking/tasks', { pageSize: 1 }).then((r) => r.meta?.total ?? 0).catch(() => 0),
      ]);
      return { alerts, approvals, putaway, picking } as Record<string, number>;
    },
  });
}

export function useOfflineState() {
  const [online, setOnline] = useState(navigator.onLine);
  const [queued, setQueued] = useState(0);
  const [issues, setIssues] = useState(0);
  useEffect(() => {
    const refresh = async () => { setQueued((await queuedRequests()).length); setIssues((await syncIssues()).length); };
    void refresh();
    const off = onQueueChange(() => void refresh());
    const on = () => setOnline(true), offl = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', offl);
    return () => { off(); window.removeEventListener('online', on); window.removeEventListener('offline', offl); };
  }, []);
  return { online, queued, issues };
}

export function OfflineBanner() {
  const { online, queued, issues } = useOfflineState();
  if (online && !queued && !issues) return null;
  return (
    <div className={cn('no-print flex flex-wrap items-center justify-center gap-3 px-4 py-1.5 text-xs font-medium', !online ? 'bg-accent-500 text-ink-900' : issues ? 'bg-red-600 text-white' : 'bg-brand-700 text-white')}>
      {!online ? <><CloudOff className="size-3.5" /> You are offline. Scans are saved on this device and will sync automatically.</> : null}
      {queued > 0 && <span>{queued} action{queued > 1 ? 's' : ''} waiting to sync</span>}
      {online && queued > 0 && <button className="inline-flex items-center gap-1 underline" onClick={() => void syncQueue()}><RefreshCw className="size-3" /> Sync now</button>}
      {issues > 0 && <Link to="/m/sync" className="underline">{issues} sync issue{issues > 1 ? 's' : ''} need review</Link>}
    </div>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { me, can } = useAuth();
  const badges = useBadges(!!me?.tenant);
  return (
    <div className="flex h-full flex-col">
      <Link to="/" onClick={onNavigate} className="flex items-center px-5 pb-4 pt-5" aria-label="Maal Help home">
        <BrandLogo />
      </Link>
      <nav className="flex-1 space-y-5 overflow-y-auto px-3 pb-4 scrollbar-thin">
        {NAV.map((g) => {
          const items = g.items.filter((i) => can(...i.perms));
          if (!items.length) return null;
          return (
            <div key={g.label}>
              <div className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-widest text-ink-400">{g.label}</div>
              {items.map((i) => {
                const count = i.badge ? badges.data?.[i.badge] : 0;
                return (
                  <NavLink key={i.to} to={i.to} end={i.to === '/'} onClick={onNavigate}
                    className={({ isActive }) => cn('group flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13px] font-medium transition-colors', isActive ? 'bg-brand-50 text-brand-800' : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900')}>
                    <i.icon className="size-4 shrink-0 opacity-80" />
                    <span className="flex-1 truncate">{i.label}</span>
                    {!!count && <span className={cn('rounded-full px-1.5 text-[10px] font-semibold', i.badge === 'alerts' ? 'bg-red-100 text-red-700' : 'bg-ink-200 text-ink-700')}>{count > 99 ? '99+' : count}</span>}
                  </NavLink>
                );
              })}
            </div>
          );
        })}
        {me?.user.isPlatformAdmin && (
          <div><div className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-widest text-ink-400">Platform</div>
            <NavLink to={PLATFORM_NAV.to} onClick={onNavigate} className={({ isActive }) => cn('flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13px] font-medium', isActive ? 'bg-brand-50 text-brand-800' : 'text-ink-600 hover:bg-ink-100')}><PLATFORM_NAV.icon className="size-4" />{PLATFORM_NAV.label}</NavLink>
          </div>
        )}
      </nav>
      <CompanySwitcher />
    </div>
  );
}

function CompanySwitcher() {
  const { me, logout } = useAuth();
  const navigate = useNavigate();
  if (!me) return null;
  return (
    <div className="border-t border-ink-100 p-3">
      <Menu
        trigger={
          <button className="flex w-full items-center gap-2.5 rounded-lg p-2 text-left hover:bg-ink-100">
            <span className="grid size-8 place-items-center rounded-lg bg-brand-700 text-xs font-semibold text-white">{initials(me.user.name)}</span>
            <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-semibold text-ink-900">{me.user.name}</span><span className="block truncate text-[11px] text-ink-500">{me.role.name}{me.tenant ? ` · ${me.tenant.name}` : ''}</span></span>
            <ChevronsUpDown className="size-4 text-ink-400" />
          </button>
        }
        items={[
          ...me.memberships.filter((m) => m.tenantId !== me.tenant?.id).map((m) => ({ label: `Switch to ${m.name}`, icon: <ChevronsUpDown />, onSelect: async () => { await api.post('/auth/switch-tenant', { tenantId: m.tenantId }); window.location.href = '/'; } })),
          { label: 'My profile & password', icon: <UserRound />, onSelect: () => navigate('/settings/profile') },
          { label: 'Mobile task mode', icon: <Smartphone />, onSelect: () => navigate('/m') },
          'separator',
          { label: 'Sign out', icon: <LogOut />, danger: true, onSelect: async () => { await logout(); navigate('/login'); } },
        ]}
      />
    </div>
  );
}

const TYPE_LABEL: Record<string, string> = { product: 'Product', customer: 'Customer', supplier: 'Supplier', sales_order: 'Sales order', purchase_order: 'Purchase order', grn: 'Goods receipt', shipment: 'Shipment', warehouse: 'Warehouse', location: 'Location', batch: 'Batch', serial: 'Serial', invoice: 'Invoice', transfer: 'Transfer' };

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [q, setQ] = useState('');
  const navigate = useNavigate();
  const { can } = useAuth();
  const { data, isFetching } = useQuery({ queryKey: ['search', q], queryFn: () => api.get<{ type: string; id: string; title: string; subtitle: string; href: string }[]>('/search', { q }), enabled: q.trim().length >= 2 });
  useEffect(() => { if (!open) setQ(''); }, [open]);
  const go = (href: string) => { onOpenChange(false); navigate(href); };
  const pages = NAV.flatMap((g) => g.items).filter((i) => can(...i.perms));
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] bg-ink-900/40 p-4 pt-[12vh] backdrop-blur-[2px]" onClick={() => onOpenChange(false)}>
      <Command shouldFilter={false} className="mx-auto max-w-xl overflow-hidden rounded-2xl border border-ink-200 bg-white shadow-pop" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') onOpenChange(false); }}>
        <div className="flex items-center gap-2 border-b border-ink-100 px-4">
          <Search className="size-4 text-ink-400" />
          <Command.Input autoFocus value={q} onValueChange={setQ} placeholder="Search SKU, barcode, order, PO, GRN, customer, location, batch, serial…" className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-ink-400" />
          {isFetching ? <Spinner className="size-4" /> : <Kbd>Esc</Kbd>}
        </div>
        <Command.List className="max-h-[60vh] overflow-y-auto p-2">
          {q.trim().length < 2 && (
            <Command.Group heading="Go to" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:text-ink-400">
              {pages.map((p) => (
                <Command.Item key={p.to} value={p.label} onSelect={() => go(p.to)} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-ink-700 data-[selected=true]:bg-brand-50 data-[selected=true]:text-brand-800">
                  <p.icon className="size-4" />{p.label}
                </Command.Item>
              ))}
            </Command.Group>
          )}
          {q.trim().length >= 2 && !isFetching && !data?.length && <Command.Empty className="px-3 py-8 text-center text-sm text-ink-500">No results for “{q}”</Command.Empty>}
          {data?.map((r) => (
            <Command.Item key={`${r.type}-${r.id}`} value={`${r.type}-${r.id}`} onSelect={() => go(r.href)} className="flex cursor-pointer items-center justify-between gap-3 rounded-lg px-2.5 py-2 data-[selected=true]:bg-brand-50">
              <div className="min-w-0"><div className="truncate text-sm font-medium text-ink-800">{r.title}</div><div className="truncate text-xs text-ink-500">{r.subtitle}</div></div>
              <span className="shrink-0 rounded-md bg-ink-100 px-1.5 py-0.5 text-[10px] font-medium text-ink-600">{TYPE_LABEL[r.type] ?? r.type}</span>
            </Command.Item>
          ))}
        </Command.List>
      </Command>
    </div>
  );
}

export function AppShell({ children }: { children?: ReactNode }) {
  const { me, can } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const location = useLocation();
  const badges = useBadges(!!me?.tenant);
  useEffect(() => setMobileOpen(false), [location.pathname]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((v) => !v); } };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  return (
    <div className="min-h-screen lg:pl-60">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-ink-200 bg-white lg:block"><Sidebar /></aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-ink-900/40" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 bg-white shadow-pop"><button className="absolute right-3 top-4 rounded-md p-1 text-ink-500" onClick={() => setMobileOpen(false)} aria-label="Close menu"><X className="size-5" /></button><Sidebar onNavigate={() => setMobileOpen(false)} /></aside>
        </div>
      )}
      <OfflineBanner />
      <header data-app-header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-ink-200 bg-white/85 px-4 backdrop-blur sm:px-6">
        <button className="rounded-md p-1.5 text-ink-600 hover:bg-ink-100 lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open menu"><MenuIcon className="size-5" /></button>
        <button onClick={() => setPalette(true)} className="flex h-9 max-w-md flex-1 items-center gap-2 rounded-lg border border-ink-200 bg-ink-50 px-3 text-sm text-ink-400 hover:border-ink-300 hover:bg-white">
          <Search className="size-4" /><span className="flex-1 truncate text-left">Search anything…</span><span className="hidden sm:inline"><Kbd>Ctrl K</Kbd></span>
        </button>
        <div className="ml-auto flex items-center gap-1">
          {can('ai.use') && <Link to="/ai" className="hidden items-center gap-1.5 rounded-lg bg-gradient-to-r from-brand-700 to-brand-500 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:opacity-95 sm:inline-flex"><Sparkles className="size-3.5" /> Ask AI</Link>}
          <Link to="/alerts" className="relative rounded-lg p-2 text-ink-600 hover:bg-ink-100" aria-label="Alerts">
            <Bell className="size-5" />
            {!!badges.data?.alerts && <span className="absolute right-1 top-1 grid min-w-4 place-items-center rounded-full bg-red-500 px-1 text-[9px] font-bold text-white">{badges.data.alerts > 9 ? '9+' : badges.data.alerts}</span>}
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8">{children ?? <Outlet />}</main>
      <CommandPalette open={palette} onOpenChange={setPalette} />
    </div>
  );
}
