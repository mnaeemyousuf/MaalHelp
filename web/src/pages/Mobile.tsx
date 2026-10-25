import { useEffect, useState, type ReactNode } from 'react';
import { Link, Route, Routes, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, ArrowLeftRight, CheckCircle2, ClipboardCheck, CloudOff, Home, LayoutDashboard, LogOut, MapPinned, PackageCheck, PackagePlus, ScanLine, Search, Truck, Wifi } from 'lucide-react';
import { BRAND } from '@shared/brand';
import type { Permission } from '@shared/permissions';
import { api, dismissIssue, errorMessage, queuedRequests, syncIssues, syncQueue, type QueuedRequest, type SyncIssue } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn, date, dateTime, qty } from '@/lib/utils';
import { Badge, Button, Card, EmptyState, Field, Input, Select, Skeleton, StatusBadge } from '@/components/ui/core';
import { ScanInput, scanFeedback } from '@/components/ui/blocks';
import { DispatchForm, PackStation, PickFlow } from '@/features/flows';
import { useOfflineState } from '@/components/layout/AppShell';

const TILES: { to: string; label: string; icon: React.ComponentType<{ className?: string }>; perms: Permission[]; tone: string }[] = [
  { to: 'scan', label: 'Scan', icon: Search, perms: ['inventory.view'], tone: 'bg-ink-800' },
  { to: 'receive', label: 'Receive', icon: PackagePlus, perms: ['receiving.execute'], tone: 'bg-brand-700' },
  { to: 'putaway', label: 'Putaway', icon: MapPinned, perms: ['putaway.execute'], tone: 'bg-brand-600' },
  { to: 'pick', label: 'Pick', icon: ScanLine, perms: ['picking.execute'], tone: 'bg-brand-800' },
  { to: 'pack', label: 'Pack', icon: PackageCheck, perms: ['packing.execute'], tone: 'bg-accent-600' },
  { to: 'transfer', label: 'Transfer', icon: ArrowLeftRight, perms: ['transfer.execute'], tone: 'bg-sky-700' },
  { to: 'count', label: 'Count', icon: ClipboardCheck, perms: ['inventory.count'], tone: 'bg-violet-700' },
  { to: 'dispatch', label: 'Dispatch', icon: Truck, perms: ['dispatch.execute'], tone: 'bg-emerald-700' },
];

function Shell({ title, children, back = '/m' }: { title: string; children: ReactNode; back?: string | null }) {
  const { online, queued } = useOfflineState();
  return (
    <div className="min-h-screen bg-ink-100 pb-10">
      <header className="sticky top-0 z-20 flex h-14 items-center gap-3 bg-brand-900 px-4 text-white shadow">
        {back ? <Link to={back} className="-ml-1 rounded-lg p-1.5 hover:bg-white/10" aria-label="Back"><ArrowLeft className="size-6" /></Link> : <img src="/brand/logo-mark.svg" alt={BRAND.name} className="size-8" />}
        <h1 className="flex-1 truncate text-lg font-semibold text-white">{title}</h1>
        <Link to="/m/sync" className={cn('flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold', online ? 'bg-white/10' : 'bg-accent-500 text-ink-900')}>{online ? <Wifi className="size-3.5" /> : <CloudOff className="size-3.5" />}{queued ? `${queued} queued` : online ? 'Online' : 'Offline'}</Link>
      </header>
      <main className="mx-auto max-w-xl space-y-4 p-4">{children}</main>
    </div>
  );
}

export function MobileApp() {
  return (
    <Routes>
      <Route index element={<MobileHome />} />
      <Route path="scan" element={<ScanLookup />} />
      <Route path="receive" element={<MobileReceive />} />
      <Route path="putaway" element={<MobilePutaway />} />
      <Route path="pick" element={<MobilePick />} />
      <Route path="pack" element={<MobilePack />} />
      <Route path="transfer" element={<MobileTransfer />} />
      <Route path="count" element={<MobileCount />} />
      <Route path="dispatch" element={<MobileDispatch />} />
      <Route path="sync" element={<SyncCenter />} />
    </Routes>
  );
}

function MobileHome() {
  const { me, can, logout } = useAuth();
  const navigate = useNavigate();
  const counts = useQuery({
    queryKey: ['mobile-counts'],
    refetchInterval: 60_000,
    queryFn: async () => {
      const get = (path: string, params: Record<string, unknown> = {}) => api.page<unknown>(path, { pageSize: 1, ...params } as never).then((r) => r.meta?.total ?? 0).catch(() => 0);
      const [pick, putaway, pack, dispatch] = await Promise.all([
        can('picking.execute') ? get('/picking/tasks', { mine: true }) : 0, can('putaway.execute') ? get('/putaway/tasks') : 0,
        can('packing.execute') ? api.get<any[]>('/packing/queue').then((r) => r.length).catch(() => 0) : 0, can('dispatch.execute') ? get('/sales-orders', { status: 'packed' }) : 0,
      ]);
      return { pick, putaway, pack, dispatch } as Record<string, number>;
    },
  });
  const tiles = TILES.filter((t) => can(...t.perms));
  return (
    <Shell title={BRAND.name} back={null}>
      <div className="rounded-2xl bg-white p-4 shadow-card">
        <div className="text-sm text-ink-500">Assalam-o-Alaikum,</div>
        <div className="text-xl font-semibold text-ink-900">{me?.user.name}</div>
        <div className="mt-1 text-xs text-ink-500">{me?.role.name} · {me?.tenant?.name}</div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {tiles.map((t) => (
          <Link key={t.to} to={t.to} className={cn('relative flex aspect-[4/3] flex-col items-center justify-center gap-2 rounded-2xl text-white shadow-md active:scale-[0.98]', t.tone)}>
            <t.icon className="size-10" />
            <span className="text-lg font-bold uppercase tracking-wide">{t.label}</span>
            {!!counts.data?.[t.to] && <span className="absolute right-3 top-3 grid min-w-7 place-items-center rounded-full bg-white px-1.5 py-0.5 text-sm font-bold text-ink-900">{counts.data[t.to]}</span>}
          </Link>
        ))}
      </div>
      <div className="flex gap-2">
        {can('dashboard.view') && <Link to="/" className="flex-1"><Button size="lg" className="w-full"><LayoutDashboard /> Full app</Button></Link>}
        <Button size="lg" variant="ghost" className="flex-1" onClick={async () => { await logout(); navigate('/login'); }}><LogOut /> Sign out</Button>
      </div>
    </Shell>
  );
}

function ScanLookup() {
  const [result, setResult] = useState<any>(null);
  const onScan = async (code: string) => {
    try {
      const loc = await api.get<any>('/warehouses/locations/lookup', { code }, { cache: true }).catch(() => null);
      if (loc) { setResult({ kind: 'location', data: loc }); scanFeedback(true); return; }
      const p = await api.get<any>('/products/lookup', { code }, { cache: true });
      const stock = await api.page<any>('/inventory', { productId: p.id, pageSize: 50 }, { cache: true });
      setResult({ kind: 'product', data: { ...p, stock: stock.data } }); scanFeedback(true);
    } catch (e) { scanFeedback(false); toast.error(errorMessage(e)); }
  };
  return (
    <Shell title="Scan">
      <Card className="p-4"><ScanInput large onScan={onScan} label="Scan a product or location" /></Card>
      {result?.kind === 'location' && <Card className="p-4"><div className="text-xs text-ink-500">{result.data.warehouseName}</div><div className="font-mono text-2xl font-bold">{result.data.code}</div><div className="mb-3 text-sm text-ink-600">{result.data.name}</div>{result.data.stock.length ? result.data.stock.map((s: any, i: number) => <div key={i} className="flex justify-between border-t border-ink-100 py-2 text-sm"><span>{s.sku}<span className="block text-xs text-ink-500">{s.name}{s.batchNo ? ` · ${s.batchNo}` : ''}</span></span><span className="text-right"><b className="text-lg">{qty(s.quantity)}</b><StatusBadge status={s.status} /></span></div>) : <p className="text-sm text-ink-500">Empty location.</p>}</Card>}
      {result?.kind === 'product' && <Card className="p-4"><div className="font-mono text-sm text-ink-500">{result.data.sku}</div><div className="text-xl font-semibold">{result.data.name}</div><div className="mt-3 space-y-0">{result.data.stock.map((s: any) => <div key={s.id} className="flex justify-between border-t border-ink-100 py-2 text-sm"><span className="font-mono">{s.warehouseCode} · {s.locationCode}{s.batchNo ? <span className="block font-sans text-xs text-ink-500">batch {s.batchNo}</span> : null}</span><span className="text-right"><b className="text-lg">{qty(s.quantity)}</b> <StatusBadge status={s.status} /></span></div>)}{!result.data.stock.length && <p className="text-sm text-ink-500">No stock on hand.</p>}</div></Card>}
    </Shell>
  );
}

function MobileReceive() {
  const qc = useQueryClient();
  const pos = useQuery({ queryKey: ['receivable-pos-mobile'], queryFn: () => api.get<any[]>('/purchase-orders', { receivable: true, pageSize: 30 }, { cache: true }) });
  const [poId, setPoId] = useState<string | null>(null);
  const po = useQuery({ queryKey: ['po', poId], queryFn: () => api.get<any>(`/purchase-orders/${poId}`), enabled: !!poId });
  const [lines, setLines] = useState<Record<string, { qty: number; damaged: number; batch: string; expiry: string }>>({});
  const [done, setDone] = useState<any>(null);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const submit = useMutation({
    mutationFn: () => api.post<any>('/receiving', { purchaseOrderId: poId, warehouseId: po.data.warehouseId, confirmOverReceipt: false, lines: po.data.lines.filter((l: any) => lines[l.id]?.qty > 0).map((l: any) => ({ purchaseOrderLineId: l.id, productId: l.productId, quantity: lines[l.id]!.qty, damagedQty: lines[l.id]!.damaged, batchNo: lines[l.id]!.batch || null, expiryDate: lines[l.id]!.expiry || null })) }, { idempotencyKey: key, queueOffline: { label: `Receive ${po.data?.number}` } }),
    onSuccess: (r) => { setDone(r); qc.invalidateQueries(); },
  });
  const onScan = async (code: string) => {
    try {
      const p = await api.get<any>('/products/lookup', { code }, { cache: true });
      const line = po.data?.lines.find((l: any) => l.productId === p.id);
      if (!line) { scanFeedback(false); toast.error(`${p.sku} is not on this PO`); return; }
      scanFeedback(true);
      setLines((s) => ({ ...s, [line.id]: { ...(s[line.id] ?? { damaged: 0, batch: '', expiry: '', qty: 0 }), qty: (s[line.id]?.qty ?? 0) + (p.unitQty ?? 1) } }));
    } catch (e) { scanFeedback(false); toast.error(errorMessage(e)); }
  };
  if (done) return <Shell title="Received"><Card className="p-6 text-center"><CheckCircle2 className="mx-auto size-16 text-emerald-500" /><div className="mt-2 text-xl font-semibold">{done.queued ? 'Saved offline' : done.number}</div><p className="text-sm text-ink-600">{done.queued ? 'It will sync when you are back online.' : `${done.putawayTaskIds?.length ?? 0} putaway task(s) created.`}</p><div className="mt-4 grid gap-2"><Link to="/m/putaway"><Button variant="primary" size="xl" className="w-full">Put away now</Button></Link><Button size="lg" onClick={() => { setDone(null); setPoId(null); setLines({}); setKey(crypto.randomUUID()); }}>Receive another</Button></div></Card></Shell>;
  if (!poId) return (
    <Shell title="Receive goods">
      <p className="text-sm text-ink-600">Choose the purchase order on the delivery note.</p>
      {pos.isLoading ? <Skeleton className="h-40" /> : !pos.data?.length ? <Card><EmptyState title="No deliveries expected" description="Ask your purchase team to approve the PO." /></Card> : pos.data.map((p) => (
        <button key={p.id} onClick={() => setPoId(p.id)} className="block w-full rounded-2xl bg-white p-4 text-left shadow-card active:bg-brand-50">
          <div className="flex items-center justify-between"><span className="text-lg font-bold">{p.number}</span>{p.overdue && <Badge tone="red">Late</Badge>}</div>
          <div className="text-sm text-ink-700">{p.supplierName}</div><div className="text-xs text-ink-500">{p.warehouseCode} · due {date(p.expectedDate)} · {qty(p.receivedQty, 0)}/{qty(p.orderedQty, 0)} received</div>
        </button>
      ))}
    </Shell>
  );
  const ready = po.data && Object.values(lines).some((l) => l.qty > 0) && po.data.lines.every((l: any) => !(lines[l.id]?.qty > 0) || ((!l.trackBatch || lines[l.id]!.batch) && (!l.trackExpiry || lines[l.id]!.expiry)));
  return (
    <Shell title={po.data?.number ?? 'Receive'} back={null}>
      <button onClick={() => setPoId(null)} className="text-sm font-medium text-brand-700">← Choose another PO</button>
      <Card className="p-4"><ScanInput large onScan={onScan} label="Scan each item" /></Card>
      {po.data?.lines.filter((l: any) => l.remainingQty > 0).map((l: any) => {
        const v = lines[l.id] ?? { qty: 0, damaged: 0, batch: '', expiry: '' };
        const set = (patch: Partial<typeof v>) => setLines({ ...lines, [l.id]: { ...v, ...patch } });
        return (
          <Card key={l.id} className={cn('p-4', v.qty > 0 && 'ring-2 ring-emerald-300')}>
            <div className="flex justify-between"><div><div className="font-semibold">{l.productName}</div><div className="text-xs text-ink-500">{l.sku}</div></div><div className="text-right text-sm">expected<div className="text-xl font-bold">{qty(l.remainingQty)}</div></div></div>
            <div className="mt-3 flex items-center gap-2"><Button size="lg" onClick={() => set({ qty: Math.max(0, v.qty - 1) })}>−</Button><Input type="number" inputMode="decimal" value={v.qty} onChange={(e) => set({ qty: Number(e.target.value) })} className="h-12 text-center text-2xl font-bold" /><Button size="lg" onClick={() => set({ qty: v.qty + 1 })}>+</Button><Button size="lg" variant="soft" onClick={() => set({ qty: l.remainingQty })}>All</Button></div>
            {v.qty > 0 && <div className="mt-3 grid grid-cols-2 gap-2">
              <Field label="Damaged"><Input type="number" inputMode="decimal" value={v.damaged} onChange={(e) => set({ damaged: Number(e.target.value) })} /></Field>
              {l.trackBatch && <Field label="Batch *"><Input value={v.batch} onChange={(e) => set({ batch: e.target.value.toUpperCase() })} /></Field>}
              {l.trackExpiry && <Field label="Expiry *"><Input type="date" value={v.expiry} onChange={(e) => set({ expiry: e.target.value })} /></Field>}
            </div>}
          </Card>
        );
      })}
      <Button variant="primary" size="xl" className="w-full" disabled={!ready} loading={submit.isPending} onClick={() => submit.mutate()}><CheckCircle2 /> Confirm receipt</Button>
    </Shell>
  );
}

function MobilePutaway() {
  const qc = useQueryClient();
  const tasks = useQuery({ queryKey: ['putaway-mobile'], queryFn: () => api.get<any[]>('/putaway/tasks', { status: 'pending', mine: true, pageSize: 50 }, { cache: true }) });
  const [task, setTask] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const complete = useMutation({
    meta: { silent: true },
    mutationFn: (locationId: string) => api.post<any>(`/putaway/tasks/${task.id}/complete`, { locationId }, { idempotencyKey: `${task.id}-${locationId}`, queueOffline: { label: `Putaway ${task.sku} → ${task.suggestedCode}` } }),
    onSuccess: (r) => { scanFeedback(true); toast.success(r?.queued ? 'Saved offline' : `Put away to ${r.location}`); setTask(null); setError(null); qc.invalidateQueries(); },
    onError: (e) => { scanFeedback(false); setError(errorMessage(e)); },
  });
  const onScan = async (code: string) => {
    try {
      const loc = await api.get<any>('/warehouses/locations/lookup', { code, warehouseId: task.warehouseId }, { cache: true });
      if (task.suggestedLocationId && loc.id !== task.suggestedLocationId) { setError(`That is ${loc.code}. Go to ${task.suggestedCode}, or ask a manager to override.`); scanFeedback(false); return; }
      complete.mutate(loc.id);
    } catch (e) { scanFeedback(false); setError(errorMessage(e)); }
  };
  if (task) return (
    <Shell title={`Putaway ${task.number}`} back={null}>
      <button onClick={() => setTask(null)} className="text-sm font-medium text-brand-700">← All tasks</button>
      <div className="rounded-2xl bg-brand-900 p-5 text-white"><div className="text-sm text-brand-200">Take {qty(task.quantity)} {task.uom} of</div><div className="text-lg font-semibold">{task.productName}</div><div className="font-mono text-xs text-brand-200">{task.sku}{task.batchNo ? ` · ${task.batchNo}` : ''}</div><div className="mt-4 text-xs uppercase tracking-wide text-brand-200">to location</div><div className="font-mono text-4xl font-bold">{task.suggestedCode ?? 'Choose any'}</div>{task.suggestionReason && <div className="mt-2 text-xs text-brand-100">{task.suggestionReason}</div>}</div>
      {error && <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-700">{error}</div>}
      <Card className="p-4"><ScanInput large onScan={onScan} label="Scan the destination location" /></Card>
    </Shell>
  );
  return (
    <Shell title="Putaway">
      {tasks.isLoading ? <Skeleton className="h-40" /> : !tasks.data?.length ? <Card><EmptyState icon={MapPinned} title="Nothing to put away" /></Card> : tasks.data.map((t) => (
        <button key={t.id} onClick={() => setTask(t)} className="flex w-full items-center justify-between rounded-2xl bg-white p-4 text-left shadow-card">
          <div><div className="font-semibold">{t.productName}</div><div className="text-xs text-ink-500">{t.sku} · from {t.fromCode}</div><div className="mt-1 font-mono text-sm font-bold text-brand-800">→ {t.suggestedCode ?? 'choose'}</div></div>
          <div className="text-2xl font-bold">{qty(t.quantity)}</div>
        </button>
      ))}
    </Shell>
  );
}

function MobilePick() {
  const tasks = useQuery({ queryKey: ['pick-mobile'], queryFn: () => api.get<any[]>('/picking/tasks', { mine: true, pageSize: 100 }, { cache: true }) });
  const [task, setTask] = useState<any>(null);
  if (task) return <Shell title={`Pick ${task.number}`} back={null}><button onClick={() => setTask(null)} className="text-sm font-medium text-brand-700">← All tasks</button><PickFlow task={task} large onDone={() => { setTask(null); void tasks.refetch(); }} /></Shell>;
  return (
    <Shell title="My pick tasks">
      {tasks.isLoading ? <Skeleton className="h-40" /> : !tasks.data?.length ? <Card><EmptyState icon={ScanLine} title="No pick tasks" description="New tasks appear when orders are confirmed." /></Card> : tasks.data.map((t, i) => (
        <button key={t.id} onClick={() => setTask(t)} className={cn('flex w-full items-center gap-3 rounded-2xl bg-white p-4 text-left shadow-card', i === 0 && 'ring-2 ring-brand-400')}>
          <div className="flex-1"><div className="flex items-center gap-2"><span className="font-mono text-xl font-bold">{t.locationCode}</span>{t.priority !== 'normal' && <StatusBadge status={t.priority} />}</div><div className="text-sm">{t.productName}</div><div className="text-xs text-ink-500">{t.orderNumber} · {t.customerName}</div></div>
          <div className="text-3xl font-bold">{qty(t.quantity - t.pickedQty)}</div>
        </button>
      ))}
    </Shell>
  );
}

function MobilePack() {
  const queue = useQuery({ queryKey: ['packing-queue'], queryFn: () => api.get<any[]>('/packing/queue') });
  const [orderId, setOrderId] = useState<string | null>(null);
  if (orderId) return <Shell title="Pack order" back={null}><button onClick={() => setOrderId(null)} className="text-sm font-medium text-brand-700">← Packing queue</button><PackStation orderId={orderId} large onDone={() => { setOrderId(null); void queue.refetch(); }} /></Shell>;
  return <Shell title="Pack">{!queue.data?.length ? <Card><EmptyState icon={PackageCheck} title="Nothing to pack" /></Card> : queue.data.map((o) => <button key={o.id} onClick={() => setOrderId(o.id)} className="flex w-full justify-between rounded-2xl bg-white p-4 text-left shadow-card"><div><div className="text-lg font-bold">{o.number}</div><div className="text-sm text-ink-600">{o.customerName}</div></div><div className="text-right"><StatusBadge status={o.priority} /><div className="mt-1 text-sm font-semibold">{qty(o.pickedQty)} items</div></div></button>)}</Shell>;
}

function MobileTransfer() {
  const [from, setFrom] = useState<any>(null);
  const [line, setLine] = useState<any>(null);
  const [quantity, setQuantity] = useState(1);
  const [done, setDone] = useState<string | null>(null);
  const qc = useQueryClient();
  const move = useMutation({
    mutationFn: (to: any) => api.post<any>('/inventory/relocate', { warehouseId: from.warehouseId, fromLocationId: from.id, toLocationId: to.id, productId: line.productId, batchId: line.batchId ?? null, ownerCustomerId: line.ownerCustomerId ?? null, status: line.status, quantity, reason: 'Mobile transfer' }, { idempotencyKey: crypto.randomUUID(), queueOffline: { label: `Move ${line.sku} ×${quantity} ${from.code} → ${to.code}` } }),
    onSuccess: (r, to) => { scanFeedback(true); setDone(r?.queued ? 'Saved offline — will sync automatically.' : `Moved ${qty(quantity)} × ${line.sku} to ${to.code}`); setFrom(null); setLine(null); qc.invalidateQueries(); },
  });
  const scanFrom = async (code: string) => { try { const l = await api.get<any>('/warehouses/locations/lookup', { code }, { cache: true }); setFrom(l); setDone(null); scanFeedback(true); } catch (e) { scanFeedback(false); toast.error(errorMessage(e)); } };
  const scanTo = async (code: string) => { try { const l = await api.get<any>('/warehouses/locations/lookup', { code, warehouseId: from.warehouseId }, { cache: true }); if (l.id === from.id) { toast.error('Same location'); return; } move.mutate(l); } catch (e) { scanFeedback(false); toast.error(errorMessage(e)); } };
  return (
    <Shell title="Move stock">
      {done && <div className="rounded-xl bg-emerald-50 p-3 text-sm font-medium text-emerald-800">{done}</div>}
      {!from && <Card className="p-4"><ScanInput large onScan={scanFrom} label="1. Scan the FROM location" /></Card>}
      {from && !line && <Card className="p-4"><div className="mb-2 text-xs uppercase text-ink-500">2. What are you moving from <b className="font-mono">{from.code}</b>?</div>{from.stock.filter((s: any) => s.status !== 'reserved').map((s: any, i: number) => <button key={i} onClick={() => { setLine(s); setQuantity(s.quantity); }} className="flex w-full justify-between border-t border-ink-100 py-3 text-left"><span>{s.sku}<span className="block text-xs text-ink-500">{s.name}{s.batchNo ? ` · ${s.batchNo}` : ''}</span></span><b className="text-xl">{qty(s.quantity)}</b></button>)}{!from.stock.length && <p className="text-sm text-ink-500">This location is empty.</p>}<Button className="mt-3" variant="ghost" onClick={() => setFrom(null)}>Scan a different location</Button></Card>}
      {from && line && <Card className="space-y-4 p-4"><div className="text-sm">Moving <b>{line.sku}</b> from <b className="font-mono">{from.code}</b></div><Field label="3. Quantity"><Input type="number" inputMode="decimal" max={line.quantity} value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} className="h-14 text-center text-2xl font-bold" /></Field><ScanInput large onScan={scanTo} label="4. Scan the TO location" /><Button variant="ghost" onClick={() => setLine(null)}>Back</Button></Card>}
    </Shell>
  );
}

function MobileCount() {
  const counts = useQuery({ queryKey: ['counts-mobile'], queryFn: () => api.get<any[]>('/stock-counts', { status: 'draft,assigned,counting', pageSize: 30 }) });
  const [id, setId] = useState<string | null>(null);
  const sheet = useQuery({ queryKey: ['count', id], queryFn: () => api.get<any>(`/stock-counts/${id}`), enabled: !!id });
  const qc = useQueryClient();
  const [active, setActive] = useState<any>(null);
  const [value, setValue] = useState('');
  const save = useMutation({ mutationFn: () => api.post(`/stock-counts/${id}/record`, { lines: [{ lineId: active.id, countedQty: Number(value) }] }, { idempotencyKey: crypto.randomUUID(), queueOffline: { label: `Count ${active.locationCode} ${active.sku}` } }), onSuccess: () => { scanFeedback(true); toast.success('Saved'); setActive(null); setValue(''); qc.invalidateQueries({ queryKey: ['count', id] }); } });
  const submit = useMutation({ mutationFn: () => api.post<any>(`/stock-counts/${id}/submit`), onSuccess: (r) => { toast.success(r.status === 'pending_approval' ? 'Submitted for approval' : 'Count posted'); setId(null); qc.invalidateQueries(); } });
  const onScan = (code: string) => {
    const up = code.toUpperCase();
    const line = sheet.data?.lines.find((l: any) => (l.locationBarcode?.toUpperCase() === up || l.locationCode === up) && l.countedQty === null) ?? sheet.data?.lines.find((l: any) => l.barcode === code || l.sku === up);
    if (!line) { scanFeedback(false); toast.error('Not on this count'); return; }
    scanFeedback(true); setActive(line); setValue('');
  };
  if (!id) return <Shell title="Stock count">{!counts.data?.length ? <Card><EmptyState icon={ClipboardCheck} title="No counts assigned" /></Card> : counts.data.map((c) => <button key={c.id} onClick={() => setId(c.id)} className="flex w-full justify-between rounded-2xl bg-white p-4 text-left shadow-card"><div><div className="text-lg font-bold">{c.number}</div><div className="text-sm text-ink-600">{c.warehouseCode} · {c.type}{c.isBlind ? ' · blind' : ''}</div></div><div className="text-right text-lg font-semibold">{c.counted}/{c.lines}</div></button>)}</Shell>;
  const remaining = sheet.data?.lines.filter((l: any) => l.countedQty === null).length ?? 0;
  return (
    <Shell title={sheet.data?.number ?? 'Count'} back={null}>
      <button onClick={() => setId(null)} className="text-sm font-medium text-brand-700">← All counts</button>
      {!active ? <Card className="p-4"><ScanInput large onScan={onScan} label="Scan location, then product" /></Card> : (
        <Card className="space-y-3 p-4"><div className="font-mono text-2xl font-bold">{active.locationCode}</div><div>{active.productName} <span className="text-xs text-ink-500">{active.sku}</span></div>{!sheet.data?.hideExpected && <div className="text-sm text-ink-500">System expects {qty(active.expectedQty)}</div>}<Input type="number" inputMode="decimal" autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder="Counted quantity" className="h-16 text-center text-3xl font-bold" /><Button variant="primary" size="xl" className="w-full" disabled={value === ''} loading={save.isPending} onClick={() => save.mutate()}>Save count</Button><Button variant="ghost" onClick={() => setActive(null)}>Cancel</Button></Card>
      )}
      <Card className="divide-y divide-ink-100">{sheet.data?.lines.map((l: any) => <button key={l.id} onClick={() => { setActive(l); setValue(l.countedQty ?? ''); }} className="flex w-full justify-between px-4 py-3 text-left text-sm"><span><span className="font-mono font-semibold">{l.locationCode}</span><span className="block text-xs text-ink-500">{l.sku}</span></span>{l.countedQty === null ? <Badge>To count</Badge> : <b>{qty(l.countedQty)}</b>}</button>)}</Card>
      <Button variant="primary" size="xl" className="w-full" disabled={remaining > 0} loading={submit.isPending} onClick={() => submit.mutate()}>{remaining ? `${remaining} lines left` : 'Submit count'}</Button>
    </Shell>
  );
}

function MobileDispatch() {
  const ready = useQuery({ queryKey: ['dispatch-mobile'], queryFn: () => api.get<any[]>('/sales-orders', { status: 'packed', pageSize: 50 }) });
  const [order, setOrder] = useState<any>(null);
  if (order) return <Shell title={`Dispatch ${order.number}`} back={null}><button onClick={() => setOrder(null)} className="text-sm font-medium text-brand-700">← Ready list</button><Card className="p-4"><div className="mb-3 text-sm">{order.customerName} · {order.packageCount} package(s)</div><DispatchForm order={order} onDone={() => { setOrder(null); void ready.refetch(); }} /></Card></Shell>;
  return <Shell title="Dispatch">{!ready.data?.length ? <Card><EmptyState icon={Truck} title="Nothing ready to dispatch" /></Card> : ready.data.map((o) => <button key={o.id} onClick={() => setOrder(o)} className="flex w-full justify-between rounded-2xl bg-white p-4 text-left shadow-card"><div><div className="text-lg font-bold">{o.number}</div><div className="text-sm text-ink-600">{o.customerName}</div></div><div className="text-right text-sm">{o.packageCount} pkg<div><StatusBadge status={o.priority} /></div></div></button>)}</Shell>;
}

function SyncCenter() {
  const [queued, setQueued] = useState<QueuedRequest[]>([]);
  const [issues, setIssues] = useState<SyncIssue[]>([]);
  const refresh = async () => { setQueued(await queuedRequests()); setIssues(await syncIssues()); };
  useEffect(() => { void refresh(); }, []);
  return (
    <Shell title="Offline sync">
      <Card className="p-4 text-sm text-ink-600">Actions you take while offline are stored on this phone and sent in order when the connection returns. If something changed in the meantime (for example the stock was already picked), the action is <b>not forced through</b> — it appears below for a supervisor to resolve.</Card>
      <Button variant="primary" size="lg" className="w-full" onClick={async () => { const r = await syncQueue(); toast.info(`${r.synced} synced, ${r.failed} need review`); await refresh(); }}>Sync now</Button>
      <Card><div className="border-b border-ink-100 px-4 py-3 text-sm font-semibold">Waiting to sync ({queued.length})</div>{queued.length ? queued.map((q) => <div key={q.id} className="border-b border-ink-100 px-4 py-2 text-sm last:border-0">{q.label}<div className="text-xs text-ink-500">{dateTime(q.createdAt)}</div></div>) : <p className="px-4 py-3 text-sm text-ink-500">Nothing waiting.</p>}</Card>
      <Card><div className="border-b border-ink-100 px-4 py-3 text-sm font-semibold">Needs review ({issues.length})</div>{issues.length ? issues.map((q) => <div key={q.id} className="border-b border-ink-100 px-4 py-3 text-sm last:border-0"><div className="font-medium">{q.label}</div><div className="text-xs text-red-600">{q.error}</div><div className="mt-2 flex gap-2"><Button size="sm" onClick={async () => { await dismissIssue(q.id); await refresh(); }}>Dismiss</Button></div></div>) : <p className="px-4 py-3 text-sm text-ink-500">No conflicts.</p>}</Card>
      <Link to="/m"><Button size="lg" className="w-full"><Home /> Home</Button></Link>
    </Shell>
  );
}

