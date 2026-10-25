import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeftRight, CheckCircle2, ClipboardCheck, Plus, RotateCcw, Send, Trash2 } from 'lucide-react';
import { COUNT_TYPES, RETURN_DISPOSITIONS, RETURN_REASONS } from '@shared/domain';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn, date, dateTime, humanize, money, qty } from '@/lib/utils';
import { Badge, Button, Card, CardHeader, Checkbox, EmptyState, ErrorState, Field, Input, Select, Skeleton, StatusBadge, Textarea } from '@/components/ui/core';
import { ConfirmDialog, Dialog } from '@/components/ui/overlay';
import { EntityPicker, KeyValue, PageHeader, ScanInput, scanFeedback } from '@/components/ui/blocks';
import { SearchInput, Table, useServerList } from '@/components/ui/table';
import { LocationPicker, useWarehouses } from './Inventory';

// ───────────────────────── Transfers ─────────────────────────
const TRF_FLOW = ['draft', 'requested', 'approved', 'picking', 'in_transit', 'received', 'completed'];

export function Transfers() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [status, setStatus] = useState('');
  const [create, setCreate] = useState(false);
  const list = useServerList<any>('/transfers', { status: status || undefined });
  return (
    <div>
      <PageHeader title="Stock transfers" description="Warehouse → warehouse with approval and in-transit tracking, or location → location within a site." actions={can('transfer.request') && <Button variant="primary" onClick={() => setCreate(true)}><Plus /> New transfer</Button>} />
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-ink-100 p-3">
          <SearchInput value={list.q} onChange={list.setQ} placeholder="Transfer number" className="w-full sm:w-60" />
          <div className="flex flex-wrap gap-1">{[['', 'All'], ['requested', 'To approve'], ['approved,picking', 'To pick'], ['in_transit', 'In transit'], ['received', 'Short received'], ['completed', 'Completed']].map(([v, l]) => <button key={v} onClick={() => setStatus(v)} className={cn('rounded-full px-3 py-1 text-xs font-medium', status === v ? 'bg-brand-700 text-white' : 'bg-ink-100 text-ink-600')}>{l}</button>)}</div>
        </div>
        <Table rows={list.rows} loading={list.loading} error={list.error} onRowClick={(r) => navigate(`/transfers/${r.id}`)} empty={<EmptyState icon={ArrowLeftRight} title="No transfers" />}
          columns={[
            { key: 'n', header: 'Transfer', cell: (r) => <div><div className="font-medium">{r.number}</div><div className="text-xs text-ink-500">{dateTime(r.createdAt)}</div></div> },
            { key: 'route', header: 'Route', cell: (r) => r.type === 'location' ? <span className="text-sm">Within {r.sourceCode}</span> : <span className="text-sm">{r.sourceCode} → {r.destCode}</span> },
            { key: 'lines', header: 'Lines / units', align: 'right', cell: (r) => `${r.lines} · ${qty(r.units)}` },
            { key: 'by', header: 'Requested by', hideOnMobile: true, cell: (r) => r.requestedBy ?? '—' },
            { key: 'p', header: 'Priority', hideOnMobile: true, cell: (r) => <StatusBadge status={r.priority} /> },
            { key: 's', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
          ]} />
        {list.pagination}
      </Card>
      {create && <TransferForm onClose={() => setCreate(false)} onCreated={(id) => navigate(`/transfers/${id}`)} />}
    </div>
  );
}

function TransferForm({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const warehouses = useWarehouses();
  const [type, setType] = useState<'warehouse' | 'location'>('warehouse');
  const [src, setSrc] = useState('');
  const [dst, setDst] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<{ key: string; balance: any | null; quantity: number; destLocationId: string | null }[]>([{ key: crypto.randomUUID(), balance: null, quantity: 1, destLocationId: null }]);
  const m = useMutation({
    mutationFn: () => api.post<any>('/transfers', { type, sourceWarehouseId: src, destWarehouseId: type === 'warehouse' ? dst : undefined, notes, lines: lines.filter((l) => l.balance).map((l) => ({ productId: l.balance.productId, sourceLocationId: l.balance.locationId, batchId: l.balance.batchId, ownerCustomerId: l.balance.ownerCustomerId, quantity: l.quantity, destLocationId: l.destLocationId })) }),
    onSuccess: (t) => { toast.success(`${t.number} requested — waiting for approval`); onCreated(t.id); },
  });
  return (
    <Dialog open onOpenChange={onClose} title="New stock transfer" size="xl" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={!src || (type === 'warehouse' && !dst) || !lines.some((l) => l.balance)} onClick={() => m.mutate()}><Send /> Request transfer</Button></>}>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Type"><Select value={type} onChange={(e) => setType(e.target.value as never)}><option value="warehouse">Warehouse → warehouse</option><option value="location">Location → location</option></Select></Field>
          <Field label="From warehouse"><Select value={src} onChange={(e) => setSrc(e.target.value)}><option value="">Select…</option>{warehouses.data?.map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}</Select></Field>
          {type === 'warehouse' && <Field label="To warehouse"><Select value={dst} onChange={(e) => setDst(e.target.value)}><option value="">Select…</option>{warehouses.data?.filter((w) => w.id !== src).map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}</Select></Field>}
        </div>
        {src && lines.map((l, i) => (
          <div key={l.key} className="grid gap-3 rounded-xl border border-ink-200 p-3 sm:grid-cols-[1fr_120px_1fr_40px]">
            <Field label={`Line ${i + 1}: stock to move`}><EntityPicker value={l.balance?.id ?? null} onChange={(_id, o) => setLines(lines.map((x) => (x.key === l.key ? { ...x, balance: o?.raw ?? null, quantity: Math.min(x.quantity, o?.raw?.quantity ?? 1) } : x)))} endpoint="/inventory" params={{ warehouseId: src, status: 'available' }} placeholder="Search product or location" map={(b) => ({ id: b.id, label: `${b.sku} @ ${b.locationCode}`, sub: `${qty(b.quantity)} available${b.batchNo ? ` · ${b.batchNo}` : ''}${b.ownerName ? ` · owner ${b.ownerName}` : ''}`, raw: b })} /></Field>
            <Field label="Quantity"><Input type="number" min={1} max={l.balance?.quantity} value={l.quantity} onChange={(e) => setLines(lines.map((x) => (x.key === l.key ? { ...x, quantity: Number(e.target.value) } : x)))} /></Field>
            <Field label={type === 'location' ? 'Destination location' : 'Destination location (optional)'}>{(type === 'location' ? src : dst) ? <LocationPicker warehouseId={type === 'location' ? src : dst} value={l.destLocationId} onChange={(id) => setLines(lines.map((x) => (x.key === l.key ? { ...x, destLocationId: id } : x)))} /> : <Input disabled placeholder="Choose destination warehouse" />}</Field>
            <Button size="icon" variant="ghost" className="self-end" onClick={() => setLines(lines.filter((x) => x.key !== l.key))} disabled={lines.length === 1} aria-label="Remove"><Trash2 /></Button>
          </div>
        ))}
        {src && <Button size="sm" onClick={() => setLines([...lines, { key: crypto.randomUUID(), balance: null, quantity: 1, destLocationId: null }])}><Plus /> Add line</Button>}
        <Field label="Notes"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </div>
    </Dialog>
  );
}

export function TransferDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<'cancel' | 'complete' | null>(null);
  const [received, setReceived] = useState<Record<string, number>>({});
  const { data: t, isLoading, error } = useQuery({ queryKey: ['transfer', id], queryFn: () => api.get<any>(`/transfers/${id}`) });
  const act = useMutation({ mutationFn: ({ step, body }: { step: string; body?: unknown }) => api.post<any>(`/transfers/${id}/${step}`, body ?? {}, { idempotencyKey: crypto.randomUUID() }), onSuccess: (r) => { toast.success(`Transfer is now ${humanize(r.status).toLowerCase()}`); qc.invalidateQueries(); } });
  if (error) return <Card><ErrorState error={error} /></Card>;
  if (isLoading || !t) return <Skeleton className="h-96" />;
  const idx = TRF_FLOW.indexOf(t.status);
  return (
    <div>
      <PageHeader back={{ to: '/transfers', label: 'Transfers' }} title={<span className="flex items-center gap-2">{t.number}<StatusBadge status={t.status} /></span>} description={t.type === 'location' ? `Location transfer within ${t.source?.name}` : `${t.source?.name} → ${t.dest?.name}`}
        actions={<>
          {t.status === 'draft' && can('transfer.request') && <Button variant="primary" onClick={() => act.mutate({ step: 'request' })}>Submit request</Button>}
          {t.status === 'requested' && can('transfer.approve') && <Button variant="primary" loading={act.isPending} onClick={() => act.mutate({ step: 'approve' })}><CheckCircle2 /> Approve</Button>}
          {t.status === 'approved' && can('transfer.execute') && <Button onClick={() => act.mutate({ step: 'start-picking' })}>Start picking</Button>}
          {['approved', 'picking'].includes(t.status) && can('transfer.execute') && <Button variant="primary" loading={act.isPending} onClick={() => act.mutate({ step: 'dispatch' })}>{t.type === 'location' ? 'Move stock now' : 'Confirm picked & dispatch'}</Button>}
          {t.status === 'in_transit' && can('transfer.execute') && <Button variant="primary" loading={act.isPending} onClick={() => act.mutate({ step: 'receive', body: { lines: t.lines.map((l: any) => ({ lineId: l.id, quantity: received[l.id] ?? l.pickedQty })) } })}>Receive at {t.dest?.code}</Button>}
          {t.status === 'received' && can('transfer.approve') && <Button variant="primary" onClick={() => setConfirm('complete')}>Complete & write off shortage</Button>}
          {['draft', 'requested', 'approved', 'picking'].includes(t.status) && <Button variant="ghost" className="text-red-600" onClick={() => setConfirm('cancel')}>Cancel</Button>}
        </>} />
      {t.status !== 'cancelled' && <Card className="mb-4 px-5 py-4"><ol className="flex flex-wrap items-center gap-2 text-xs">{TRF_FLOW.filter((s) => t.type === 'warehouse' || !['in_transit', 'received'].includes(s)).map((s, i, arr) => <li key={s} className="flex items-center gap-2"><span className={cn('rounded-full px-2.5 py-1 font-medium capitalize', TRF_FLOW.indexOf(s) < idx ? 'bg-brand-100 text-brand-800' : s === t.status ? 'bg-brand-700 text-white' : 'bg-ink-100 text-ink-400')}>{s.replace('_', ' ')}</span>{i < arr.length - 1 && <span className="text-ink-300">→</span>}</li>)}</ol></Card>}
      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <Card><CardHeader title="Lines" /><Table rows={t.lines} columns={[
          { key: 'p', header: 'Product', cell: (l: any) => <div><div className="font-medium">{l.productName}</div><div className="text-xs text-ink-500">{l.sku}{l.batchNo ? ` · ${l.batchNo}` : ''}</div></div> },
          { key: 'from', header: 'From', cell: (l: any) => <span className="font-mono text-xs">{l.sourceCode}</span> }, { key: 'to', header: 'To', cell: (l: any) => <span className="font-mono text-xs">{l.destCode ?? `${t.dest?.code} dock`}</span> },
          { key: 'q', header: 'Requested', align: 'right', cell: (l: any) => qty(l.quantity) }, { key: 'pk', header: 'Picked', align: 'right', cell: (l: any) => qty(l.pickedQty) },
          { key: 'r', header: 'Received', align: 'right', cell: (l: any) => t.status === 'in_transit' ? <Input type="number" min={0} max={l.pickedQty} value={received[l.id] ?? l.pickedQty} onChange={(e) => setReceived({ ...received, [l.id]: Number(e.target.value) })} className="ml-auto h-8 w-24 text-right" /> : <span className={cn('num', l.receivedQty < l.pickedQty && t.status !== 'requested' && 'text-red-600')}>{qty(l.receivedQty)}</span> },
        ]} /></Card>
        <Card className="p-5"><KeyValue cols={2} items={[['Requested', t.requestedByName ?? '—'], ['Approved', t.approvedByName ?? '—'], ['Picked', t.pickedByName ?? '—'], ['Received', t.receivedByName ?? '—'], ['Dispatched', dateTime(t.dispatchedAt)], ['Received at', dateTime(t.receivedAt)]]} />{t.notes && <p className="mt-3 whitespace-pre-line text-xs text-ink-600">{t.notes}</p>}</Card>
      </div>
      <ConfirmDialog open={confirm === 'cancel'} onOpenChange={() => setConfirm(null)} title={`Cancel ${t.number}?`} tone="danger" confirmLabel="Cancel transfer" reason={{ label: 'Reason', required: true }} onConfirm={(reason) => act.mutateAsync({ step: 'cancel', body: { reason } })} />
      <ConfirmDialog open={confirm === 'complete'} onOpenChange={() => setConfirm(null)} title="Write off transit shortage?" description="The difference between picked and received quantities is written off from in-transit stock." confirmLabel="Complete transfer" reason={{ label: 'Explanation', required: true, placeholder: 'e.g. 2 cartons lost in transit, driver statement attached' }} onConfirm={(reason) => act.mutateAsync({ step: 'complete', body: { reason } })} />
    </div>
  );
}

// ───────────────────────── Returns ─────────────────────────
export function Returns() {
  const { can } = useAuth();
  const [create, setCreate] = useState(false);
  const list = useServerList<any>('/returns', {});
  return (
    <div>
      <PageHeader title="Customer returns" description="Receive returned goods and decide where each unit goes: back to stock, damaged, quarantine, repair or write-off." actions={can('returns.manage') && <Button variant="primary" onClick={() => setCreate(true)}><RotateCcw /> Receive a return</Button>} />
      <Card>
        <div className="border-b border-ink-100 p-3"><SearchInput value={list.q} onChange={list.setQ} placeholder="Return, order or customer" className="w-full sm:w-72" /></div>
        <Table rows={list.rows} loading={list.loading} error={list.error} empty={<EmptyState icon={RotateCcw} title="No returns" />}
          columns={[
            { key: 'n', header: 'Return', cell: (r) => <div><div className="font-medium">{r.number}</div><div className="text-xs text-ink-500">{dateTime(r.createdAt)}</div></div> },
            { key: 'c', header: 'Customer', cell: (r) => r.customerName }, { key: 'o', header: 'Order', cell: (r) => r.orderNumber ?? '—' },
            { key: 'r', header: 'Reason', cell: (r) => humanize(r.reason) }, { key: 'u', header: 'Units', align: 'right', cell: (r) => qty(r.units) },
            ...(can('billing.view') ? [{ key: 'cr', header: 'Credit', align: 'right' as const, cell: (r: any) => money(r.creditTotal) }] : []),
            { key: 's', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
          ]} />
        {list.pagination}
      </Card>
      {create && <ReturnForm onClose={() => setCreate(false)} />}
    </div>
  );
}

function ReturnForm({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [orderId, setOrderId] = useState<string | null>(null);
  const [reason, setReason] = useState('damaged');
  const [notes, setNotes] = useState('');
  const [credit, setCredit] = useState(true);
  const [lines, setLines] = useState<Record<string, { quantity: number; disposition: string }>>({});
  const order = useQuery({ queryKey: ['order', orderId], queryFn: () => api.get<any>(`/sales-orders/${orderId}`), enabled: !!orderId });
  const m = useMutation({
    mutationFn: () => api.post<any>('/returns', { salesOrderId: orderId, reason, notes, issueCreditNote: credit, lines: Object.entries(lines).filter(([, v]) => v.quantity > 0).map(([productId, v]) => ({ productId, quantity: v.quantity, disposition: v.disposition })) }, { idempotencyKey: crypto.randomUUID() }),
    onSuccess: (r) => { toast.success(`${r.number} received${r.creditTotal ? ` · credit ${money(r.creditTotal)}` : ''}`); qc.invalidateQueries(); onClose(); },
  });
  return (
    <Dialog open onOpenChange={onClose} title="Receive a customer return" size="lg" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={!Object.values(lines).some((l) => l.quantity > 0)} onClick={() => m.mutate()}>Receive return</Button></>}>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Original order" required><EntityPicker value={orderId} onChange={(id) => { setOrderId(id); setLines({}); }} endpoint="/sales-orders" params={{ status: 'dispatched,delivered,completed' }} map={(o) => ({ id: o.id, label: `${o.number} · ${o.customerName}`, sub: date(o.orderDate) })} /></Field>
          <Field label="Reason"><Select value={reason} onChange={(e) => setReason(e.target.value)}>{RETURN_REASONS.map((r) => <option key={r} value={r}>{humanize(r)}</option>)}</Select></Field>
        </div>
        {order.data && (order.data.lines as any[]).filter((l) => l.shippedQty > 0).map((l) => (
          <div key={l.id} className="grid items-end gap-3 rounded-xl border border-ink-200 p-3 sm:grid-cols-[1fr_110px_170px]">
            <div><div className="text-sm font-medium">{l.productName}</div><div className="text-xs text-ink-500">{l.sku} · shipped {qty(l.shippedQty)}</div></div>
            <Field label="Return qty"><Input type="number" min={0} max={l.shippedQty} value={lines[l.productId]?.quantity ?? 0} onChange={(e) => setLines({ ...lines, [l.productId]: { disposition: lines[l.productId]?.disposition ?? 'available', quantity: Number(e.target.value) } })} /></Field>
            <Field label="Send to"><Select value={lines[l.productId]?.disposition ?? 'available'} onChange={(e) => setLines({ ...lines, [l.productId]: { quantity: lines[l.productId]?.quantity ?? 0, disposition: e.target.value } })}>{RETURN_DISPOSITIONS.map((d) => <option key={d} value={d}>{({ available: 'Back to stock', damaged: 'Damaged', quarantine: 'Quarantine (inspect)', repair: 'Repair (blocked)', write_off: 'Write off' } as Record<string, string>)[d]}</option>)}</Select></Field>
          </div>
        ))}
        <Field label="Notes"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        {can('billing.manage') && <Checkbox label="Issue a credit note to the customer" checked={credit} onChange={setCredit} />}
      </div>
    </Dialog>
  );
}

// ───────────────────────── Stock counts ─────────────────────────
export function StockCounts() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [create, setCreate] = useState(false);
  const list = useServerList<any>('/stock-counts', {});
  return (
    <div>
      <PageHeader title="Stock counts" description="Create count → assign counter → count → variance → review → approval → adjustment. Significant variances always need approval." actions={can('inventory.count') && <Button variant="primary" onClick={() => setCreate(true)}><Plus /> New count</Button>} />
      <Card>
        <Table rows={list.rows} loading={list.loading} error={list.error} onRowClick={(r) => navigate(`/stock-counts/${r.id}`)} empty={<EmptyState icon={ClipboardCheck} title="No stock counts yet" description="Run a cycle count weekly on high-value locations to keep accuracy above 98%." />}
          columns={[
            { key: 'n', header: 'Count', cell: (r) => <div><div className="font-medium">{r.number}</div><div className="text-xs text-ink-500">{dateTime(r.createdAt)}</div></div> },
            { key: 't', header: 'Type', cell: (r) => <div className="flex gap-1"><Badge>{humanize(r.type)}</Badge>{r.isBlind && <Badge tone="violet">Blind</Badge>}</div> },
            { key: 'wh', header: 'Warehouse', cell: (r) => r.warehouseCode }, { key: 'a', header: 'Counter', cell: (r) => r.assignedTo ?? '—' },
            { key: 'p', header: 'Progress', align: 'right', cell: (r) => `${r.counted} / ${r.lines}` },
            { key: 'v', header: 'Variance', align: 'right', cell: (r) => ['draft', 'assigned', 'counting'].includes(r.status) ? '—' : <span className={cn('num', r.varianceQty !== 0 && 'font-semibold text-amber-700')}>{r.varianceQty > 0 ? '+' : ''}{qty(r.varianceQty)}{r.varianceValue !== undefined ? ` · ${money(r.varianceValue)}` : ''}</span> },
            { key: 's', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
          ]} />
        {list.pagination}
      </Card>
      {create && <CountForm onClose={() => setCreate(false)} onCreated={(id) => navigate(`/stock-counts/${id}`)} />}
    </div>
  );
}

function CountForm({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const warehouses = useWarehouses();
  const users = useQuery({ queryKey: ['users-directory'], queryFn: () => api.get<any[]>('/users/directory') });
  const [f, setF] = useState({ warehouseId: '', type: 'cycle', blind: false, assignedTo: '', cycleSample: 20, notes: '' });
  const m = useMutation({ mutationFn: () => api.post<any>('/stock-counts', { ...f, assignedTo: f.assignedTo || null }), onSuccess: (c) => { toast.success(`${c.number} created with ${c.lines} lines`); onCreated(c.id); } });
  return (
    <Dialog open onOpenChange={onClose} title="New stock count" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={!f.warehouseId} onClick={() => m.mutate()}>Create count</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Warehouse" required><Select value={f.warehouseId} onChange={(e) => setF({ ...f, warehouseId: e.target.value })}><option value="">Select…</option>{warehouses.data?.map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}</Select></Field>
        <Field label="Count type"><Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value, blind: e.target.value === 'blind' || f.blind })}>{COUNT_TYPES.filter((t) => t !== 'location' && t !== 'product').map((t) => <option key={t} value={t}>{humanize(t)}</option>)}</Select></Field>
        {f.type === 'cycle' && <Field label="Locations to sample" hint="Least-recently-counted, highest value first"><Input type="number" min={1} max={500} value={f.cycleSample} onChange={(e) => setF({ ...f, cycleSample: Number(e.target.value) })} /></Field>}
        <Field label="Assign counter"><Select value={f.assignedTo} onChange={(e) => setF({ ...f, assignedTo: e.target.value })}><option value="">Anyone</option>{users.data?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></Field>
        <div className="sm:col-span-2"><Checkbox label="Blind count" hint="Counters don't see the expected quantity — reduces bias." checked={f.blind} onChange={(v) => setF({ ...f, blind: v })} /></div>
      </div>
    </Dialog>
  );
}

export function CountDetail() {
  const { id } = useParams();
  const qc = useQueryClient();
  const { can } = useAuth();
  const { data: c, isLoading, error } = useQuery({ queryKey: ['count', id], queryFn: () => api.get<any>(`/stock-counts/${id}`) });
  const [counts, setCounts] = useState<Record<string, string>>({});
  const save = useMutation({ mutationFn: () => api.post(`/stock-counts/${id}/record`, { lines: Object.entries(counts).filter(([, v]) => v !== '').map(([lineId, v]) => ({ lineId, countedQty: Number(v) })) }, { idempotencyKey: crypto.randomUUID() }), onSuccess: () => { toast.success('Counts saved'); setCounts({}); qc.invalidateQueries({ queryKey: ['count', id] }); } });
  const submit = useMutation({ mutationFn: () => api.post<any>(`/stock-counts/${id}/submit`), onSuccess: (r) => { toast.success(r.status === 'pending_approval' ? 'Submitted — variance needs approval' : r.message ?? 'Count posted'); qc.invalidateQueries(); } });
  if (error) return <Card><ErrorState error={error} /></Card>;
  if (isLoading || !c) return <Skeleton className="h-96" />;
  const open = ['draft', 'assigned', 'counting'].includes(c.status);
  const onScan = (code: string) => {
    const up = code.toUpperCase();
    const line = c.lines.find((l: any) => l.locationBarcode?.toUpperCase() === up || l.locationCode === up || l.barcode === code || l.sku === up);
    if (!line) { scanFeedback(false); toast.error(`${code} is not on this count sheet`); return; }
    scanFeedback(true);
    document.getElementById(`count-${line.id}`)?.focus();
  };
  const pending = Object.values(counts).filter((v) => v !== '').length;
  return (
    <div>
      <PageHeader back={{ to: '/stock-counts', label: 'Stock counts' }} title={<span className="flex items-center gap-2">{c.number}<StatusBadge status={c.status} />{c.isBlind && <Badge tone="violet">Blind</Badge>}</span>} description={`${humanize(c.type)} count · ${c.warehouse?.name} · tolerance ${c.tolerancePct}%`}
        actions={open && can('inventory.count') && <><Button loading={save.isPending} disabled={!pending} onClick={() => save.mutate()}>Save {pending || ''} count{pending === 1 ? '' : 's'}</Button><Button variant="primary" loading={submit.isPending} onClick={() => submit.mutate()}><Send /> Submit for review</Button></>} />
      {open && <Card className="mb-4 p-4"><ScanInput onScan={onScan} label="Scan a location or product to jump to its line" /></Card>}
      {c.status === 'pending_approval' && <Card className="mb-4 border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">Variances are above the approval threshold. A manager must approve before stock is adjusted. <Link to="/approvals" className="font-medium underline">Go to approvals</Link></Card>}
      <Card>
        <Table rows={c.lines} dense columns={[
          { key: 'l', header: 'Location', cell: (l: any) => <span className="font-mono text-xs font-semibold">{l.locationCode}</span> },
          { key: 'p', header: 'Product', cell: (l: any) => <div><div className="text-sm">{l.productName}</div><div className="text-xs text-ink-500">{l.sku}{l.batchNo ? ` · ${l.batchNo}` : ''}</div></div> },
          { key: 'e', header: 'Expected', align: 'right', cell: (l: any) => c.hideExpected ? <span className="text-xs text-ink-400">hidden</span> : qty(l.expectedQty) },
          { key: 'c', header: 'Counted', align: 'right', cell: (l: any) => open ? <Input id={`count-${l.id}`} type="number" min={0} step="any" inputMode="decimal" value={counts[l.id] ?? (l.countedQty ?? '')} onChange={(e) => setCounts({ ...counts, [l.id]: e.target.value })} className="ml-auto h-8 w-24 text-right" /> : qty(l.countedQty) },
          { key: 'v', header: 'Variance', align: 'right', cell: (l: any) => l.countedQty === null || c.hideExpected ? '—' : <span className={cn('num font-semibold', l.varianceQty < 0 ? 'text-red-600' : l.varianceQty > 0 ? 'text-emerald-700' : 'text-ink-400')}>{l.varianceQty > 0 ? '+' : ''}{qty(l.varianceQty)}</span> },
          { key: 'by', header: 'Counted by', hideOnMobile: true, cell: (l: any) => l.countedBy ? `${l.countedBy} · ${dateTime(l.countedAt)}` : '—' },
        ]} />
      </Card>
    </div>
  );
}
