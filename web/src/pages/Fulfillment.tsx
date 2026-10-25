import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Layers, PackageCheck, ScanLine, Truck, UserPlus } from 'lucide-react';
import { SHIPMENT_STATUSES } from '@shared/domain';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn, date, dateTime, humanize, qty } from '@/lib/utils';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Select, StatusBadge } from '@/components/ui/core';
import { Dialog, Tabs } from '@/components/ui/overlay';
import { KeyValue, PageHeader } from '@/components/ui/blocks';
import { SearchInput, Table, useServerList } from '@/components/ui/table';
import { DispatchForm, PackStation, PickFlow } from '@/features/flows';
import { useWarehouses } from './Inventory';

export function Picking() {
  const [params] = useSearchParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const warehouses = useWarehouses();
  const [warehouseId, setWarehouseId] = useState('');
  const [view, setView] = useState('tasks');
  const [selected, setSelected] = useState<string[]>([]);
  const [picking, setPicking] = useState<any | null>(null);
  const [assign, setAssign] = useState(false);
  const list = useServerList<any>('/picking/tasks', { warehouseId: warehouseId || undefined, salesOrderId: params.get('order') ?? undefined }, { pageSize: 50 });
  const waves = useQuery({ queryKey: ['waves'], queryFn: () => api.get<any[]>('/picking/waves'), enabled: view === 'waves' });
  const users = useQuery({ queryKey: ['users-directory'], queryFn: () => api.get<any[]>('/users/directory'), enabled: can('task.manage') });
  const createWave = useMutation({ mutationFn: (body: any) => api.post<any>('/picking/waves', body), onSuccess: (w) => { toast.success(`Wave ${w.number} created with ${w.tasks} tasks`); setSelected([]); qc.invalidateQueries(); } });
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  return (
    <div>
      <PageHeader title="Picking" description="Tasks are ordered by priority, required date and walking sequence. Scan location and product to confirm — wrong items are blocked."
        actions={<><Link to="/m/pick"><Button><ScanLine /> Mobile picker</Button></Link>
          {can('task.manage') && selected.length > 0 && <><Button onClick={() => setAssign(true)}><UserPlus /> Assign ({selected.length})</Button><Button variant="primary" loading={createWave.isPending} onClick={() => createWave.mutate({ warehouseId: list.rows?.find((r) => selected.includes(r.id))?.warehouseId, type: 'batch', taskIds: selected })}><Layers /> Create batch wave</Button></>}</>} />
      <Tabs value={view} onValueChange={setView} tabs={[{ value: 'tasks', label: 'Open tasks', count: list.meta.total }, { value: 'waves', label: 'Waves (batch / zone)' }]} />
      <div className="mt-4">
        {view === 'tasks' ? (
          <Card>
            <div className="flex flex-wrap gap-2 border-b border-ink-100 p-3">
              <Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className="w-44"><option value="">All warehouses</option>{warehouses.data?.map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}</Select>
              {params.get('order') && <Badge tone="blue">Filtered to one order</Badge>}
            </div>
            <Table rows={list.rows} loading={list.loading} error={list.error} onRetry={list.refetch}
              empty={<EmptyState icon={ScanLine} title="No open pick tasks" description="Pick tasks appear when sales orders are confirmed and stock is reserved." />}
              columns={[
                ...(can('task.manage') ? [{ key: 'sel', header: '', cell: (r: any) => <input type="checkbox" className="size-4 accent-brand-700" checked={selected.includes(r.id)} onChange={() => toggle(r.id)} onClick={(e) => e.stopPropagation()} aria-label="Select" /> }] : []),
                { key: 'pri', header: 'Priority', cell: (r) => <StatusBadge status={r.priority} /> },
                { key: 'order', header: 'Order', cell: (r) => <div><Link to={`/orders/${r.salesOrderId}`} className="font-medium hover:text-brand-700">{r.orderNumber}</Link><div className="text-xs text-ink-500">{r.customerName}</div></div> },
                { key: 'loc', header: 'Location', cell: (r) => <div><span className="font-mono text-sm font-semibold">{r.locationCode}</span><div className="text-xs text-ink-500">{r.warehouseCode}{r.zoneCode ? ` · zone ${r.zoneCode}` : ''}</div></div> },
                { key: 'p', header: 'Product', cell: (r) => <div><div className="text-sm">{r.productName}</div><div className="text-xs text-ink-500">{r.sku}{r.batchNo ? ` · ${r.batchNo}` : ''}</div></div> },
                { key: 'q', header: 'Qty', align: 'right', cell: (r) => <b className="num">{qty(r.quantity - r.pickedQty)}</b> },
                { key: 'who', header: 'Assigned', hideOnMobile: true, cell: (r) => r.assignedTo ?? <span className="text-xs text-ink-400">Anyone</span> },
                { key: 'wave', header: 'Wave', hideOnMobile: true, cell: (r) => r.waveNumber ?? '—' },
                { key: 'a', header: '', align: 'right', cell: (r) => can('picking.execute') && <Button size="sm" variant="primary" onClick={() => setPicking(r)}>Pick</Button> },
              ]} />
            {list.pagination}
          </Card>
        ) : (
          <Card>
            <Table rows={waves.data} loading={waves.isLoading} empty={<EmptyState icon={Layers} title="No open waves" description="Select several tasks and create a batch wave so one picker collects items for many orders in a single walk." />}
              columns={[{ key: 'n', header: 'Wave', cell: (w: any) => <b>{w.number}</b> }, { key: 't', header: 'Type', cell: (w: any) => humanize(w.type) }, { key: 'wh', header: 'Warehouse', cell: (w: any) => w.warehouseCode }, { key: 'o', header: 'Orders', align: 'right', cell: (w: any) => w.orders }, { key: 'p', header: 'Progress', align: 'right', cell: (w: any) => `${w.done} / ${w.tasks}` }, { key: 'a', header: 'Picker', cell: (w: any) => w.assignedTo ?? '—' }, { key: 'd', header: 'Created', cell: (w: any) => dateTime(w.createdAt) }]} />
          </Card>
        )}
      </div>
      {picking && <Dialog open onOpenChange={() => setPicking(null)} title={`Pick ${picking.number}`} size="md"><PickFlow task={picking} onDone={() => setPicking(null)} /></Dialog>}
      {assign && <AssignDialog users={users.data ?? []} onClose={() => setAssign(false)} onAssign={async (userId) => { await api.post('/picking/tasks/assign', { taskIds: selected, userId }); toast.success('Tasks assigned'); setSelected([]); qc.invalidateQueries(); }} />}
    </div>
  );
}

function AssignDialog({ users, onClose, onAssign }: { users: any[]; onClose: () => void; onAssign: (id: string | null) => Promise<void> }) {
  const [userId, setUserId] = useState('');
  return (
    <Dialog open onOpenChange={onClose} title="Assign tasks" size="sm" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={async () => { await onAssign(userId || null); onClose(); }}>Assign</Button></>}>
      <Field label="Picker"><Select value={userId} onChange={(e) => setUserId(e.target.value)}><option value="">Unassigned (anyone)</option>{users.filter((u) => ['operator', 'picker_packer', 'warehouse_manager', 'inventory_controller'].includes(u.roleKey)).map((u) => <option key={u.id} value={u.id}>{u.name} · {u.roleName}</option>)}</Select></Field>
    </Dialog>
  );
}

export function Packing() {
  const [params, setParams] = useSearchParams();
  const orderId = params.get('order');
  const queue = useQuery({ queryKey: ['packing-queue'], queryFn: () => api.get<any[]>('/packing/queue'), refetchInterval: 30_000 });
  return (
    <div>
      <PageHeader title="Packing station" description="Scan each picked item into the carton. The system confirms correct products and quantities before the carton can be closed." back={orderId ? { to: '/packing', label: 'Packing queue' } : undefined} />
      {orderId ? <PackStation orderId={orderId} onDone={() => setParams({})} /> : (
        <Card>
          <CardHeader title="Ready to pack" description="All pick tasks finished" />
          <Table rows={queue.data} loading={queue.isLoading} onRowClick={(r) => setParams({ order: r.id })}
            empty={<EmptyState icon={PackageCheck} title="Nothing waiting to be packed" description="Orders appear here as soon as picking is finished." />}
            columns={[
              { key: 'n', header: 'Order', cell: (r: any) => <b>{r.number}</b> }, { key: 'c', header: 'Customer', cell: (r: any) => r.customerName },
              { key: 'p', header: 'Priority', cell: (r: any) => <StatusBadge status={r.priority} /> }, { key: 'r', header: 'Required', cell: (r: any) => date(r.requiredDate) },
              { key: 'u', header: 'Units', align: 'right', cell: (r: any) => `${qty(r.packedQty)} / ${qty(r.pickedQty)}` },
              { key: 'a', header: '', align: 'right', cell: () => <Button size="sm" variant="primary">Pack</Button> },
            ]} />
        </Card>
      )}
    </div>
  );
}

export function Dispatch() {
  const [params, setParams] = useSearchParams();
  const { can } = useAuth();
  const [tab, setTab] = useState(params.get('shipment') ? 'shipments' : 'ready');
  const [dispatching, setDispatching] = useState<any | null>(null);
  const [shipmentId, setShipmentId] = useState<string | null>(params.get('shipment'));
  const ready = useServerList<any>('/sales-orders', { status: 'packed' });
  const [status, setStatus] = useState('');
  const shipments = useServerList<any>('/shipments', { status: status || undefined });
  const preselect = params.get('order');
  const pre = useQuery({ queryKey: ['order', preselect], queryFn: () => api.get<any>(`/sales-orders/${preselect}`), enabled: !!preselect });
  return (
    <div>
      <PageHeader title="Dispatch" description="Hand packed orders to a vehicle or courier, then track delivery: Ready → Dispatched → In transit → Delivered." />
      <Tabs value={tab} onValueChange={setTab} tabs={[{ value: 'ready', label: 'Ready to dispatch', count: ready.meta.total }, { value: 'shipments', label: 'Shipments' }]} />
      <div className="mt-4">
        {tab === 'ready' ? (
          <Card>
            <Table rows={ready.rows} loading={ready.loading} error={ready.error} empty={<EmptyState icon={Truck} title="Nothing ready to dispatch" description="Packed orders appear here." />}
              columns={[
                { key: 'n', header: 'Order', cell: (r) => <Link to={`/orders/${r.id}`} className="font-medium hover:text-brand-700">{r.number}</Link> },
                { key: 'c', header: 'Customer', cell: (r) => r.customerName }, { key: 'p', header: 'Priority', cell: (r) => <StatusBadge status={r.priority} /> },
                { key: 'pk', header: 'Packages', align: 'right', cell: (r) => r.packageCount }, { key: 'r', header: 'Required', cell: (r) => date(r.requiredDate) },
                { key: 'a', header: '', align: 'right', cell: (r) => can('dispatch.execute') && <Button size="sm" variant="primary" onClick={() => setDispatching(r)}><Truck /> Dispatch</Button> },
              ]} />
          </Card>
        ) : (
          <Card>
            <div className="flex flex-wrap gap-2 border-b border-ink-100 p-3">
              <SearchInput value={shipments.q} onChange={shipments.setQ} placeholder="Shipment, tracking, order or customer" className="w-full sm:w-72" />
              <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-44"><option value="">All statuses</option>{SHIPMENT_STATUSES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</Select>
            </div>
            <Table rows={shipments.rows} loading={shipments.loading} error={shipments.error} onRowClick={(r) => setShipmentId(r.id)} empty={<EmptyState icon={Truck} title="No shipments" />}
              columns={[
                { key: 'n', header: 'Shipment', cell: (r) => <div><div className="font-medium">{r.number}</div><div className="text-xs text-ink-500">{r.orderNumber}</div></div> },
                { key: 'c', header: 'Customer', cell: (r) => r.customerName },
                { key: 'carrier', header: 'Carrier / vehicle', cell: (r) => <div><div className="text-sm">{r.carrier || '—'}</div><div className="font-mono text-xs text-ink-500">{r.trackingNumber || r.vehicleNo}</div></div> },
                { key: 'pk', header: 'Pkgs', align: 'right', hideOnMobile: true, cell: (r) => r.packageCount },
                { key: 'd', header: 'Dispatched', hideOnMobile: true, cell: (r) => dateTime(r.dispatchedAt) },
                { key: 's', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
              ]} />
            {shipments.pagination}
          </Card>
        )}
      </div>
      {(dispatching || pre.data?.status === 'packed') && <Dialog open onOpenChange={() => { setDispatching(null); setParams({}); }} title={`Dispatch ${(dispatching ?? pre.data).number}`} description={(dispatching ?? pre.data).customerName ?? pre.data?.customer?.name}><DispatchForm order={dispatching ?? pre.data} onDone={() => { setDispatching(null); setParams({}); }} /></Dialog>}
      {shipmentId && <ShipmentDialog id={shipmentId} onClose={() => { setShipmentId(null); setParams({}); }} />}
    </div>
  );
}

const NEXT: Record<string, string[]> = { ready: [], dispatched: ['in_transit', 'delivered', 'failed'], in_transit: ['delivered', 'failed', 'returned'], failed: ['in_transit', 'returned'], delivered: [], returned: [] };

function ShipmentDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const { data } = useQuery({ queryKey: ['shipment', id], queryFn: () => api.get<any>(`/shipments/${id}`) });
  const [note, setNote] = useState('');
  const m = useMutation({ mutationFn: (status: string) => api.post(`/shipments/${id}/status`, { status, note }), onSuccess: () => { toast.success('Delivery status updated'); setNote(''); qc.invalidateQueries(); } });
  if (!data) return null;
  return (
    <Dialog open onOpenChange={onClose} title={`Shipment ${data.number}`} description={`${data.order?.number} · ${data.order?.customer}`} size="lg">
      <div className="space-y-5">
        <KeyValue cols={3} items={[['Status', <StatusBadge key="s" status={data.status} />], ['Carrier', data.carrier || '—'], ['Tracking', data.trackingNumber || '—'], ['Vehicle', data.vehicleNo || '—'], ['Driver', `${data.driverName || '—'} ${data.driverPhone || ''}`], ['Packages', data.packageCount], ['Destination', data.destination || '—'], ['Dispatched', dateTime(data.dispatchedAt)], ['Delivered', dateTime(data.deliveredAt)]]} />
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">Timeline</div>
          <ol className="space-y-3 border-l-2 border-ink-200 pl-4">{data.events.map((e: any, i: number) => <li key={i} className="relative"><span className="absolute -left-[22px] top-1 size-3 rounded-full border-2 border-white bg-brand-600" /><div className="flex items-center gap-2"><StatusBadge status={e.status} /><span className="text-xs text-ink-500">{dateTime(e.createdAt)} · {e.by ?? 'System'}</span></div>{e.note && <p className="mt-0.5 text-sm text-ink-600">{e.note}</p>}</li>)}</ol>
        </div>
        {can('dispatch.execute') && NEXT[data.status]?.length > 0 && (
          <div className="space-y-2 rounded-xl bg-ink-50 p-4">
            <Field label="Note (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Received by store manager" /></Field>
            <div className="flex flex-wrap gap-2">{NEXT[data.status]!.map((s) => <Button key={s} variant={s === 'delivered' ? 'primary' : s === 'failed' || s === 'returned' ? 'danger' : 'secondary'} loading={m.isPending && m.variables === s} onClick={() => m.mutate(s)}>Mark {humanize(s).toLowerCase()}</Button>)}</div>
          </div>
        )}
        <div className="flex gap-2"><Link to={`/print/shipping-label/${data.salesOrderId}`} target="_blank"><Button size="sm">Shipping labels</Button></Link><Link to={`/orders/${data.salesOrderId}`}><Button size="sm" variant="ghost">Open order</Button></Link></div>
      </div>
    </Dialog>
  );
}

