import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowRightLeft, Download, MoreHorizontal, PencilLine, ShieldAlert, Boxes } from 'lucide-react';
import { ADJUSTMENT_REASONS, INVENTORY_STATUSES, TRANSACTION_TYPES } from '@shared/domain';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { date, dateTime, humanize, money, qty } from '@/lib/utils';
import { Badge, Button, Card, EmptyState, Field, Input, Select, StatusBadge, Textarea } from '@/components/ui/core';
import { Dialog, Menu, Tabs } from '@/components/ui/overlay';
import { PageHeader, EntityPicker } from '@/components/ui/blocks';
import { SearchInput, Table, useServerList } from '@/components/ui/table';

export function useWarehouses() {
  return useQuery({ queryKey: ['warehouses'], queryFn: () => api.get<any[]>('/warehouses'), staleTime: 60_000 });
}

export function Inventory() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'stock';
  return (
    <div>
      <PageHeader title="Inventory" description="Every unit by warehouse, location, batch, owner and status — backed by an immutable ledger."
        actions={<Link to="/reports/current_inventory"><Button><Download /> Reports & export</Button></Link>} />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v })} tabs={[{ value: 'stock', label: 'Stock on hand' }, { value: 'ledger', label: 'Movement ledger' }, { value: 'batches', label: 'Batches & expiry' }, { value: 'serials', label: 'Serial numbers' }, { value: 'adjustments', label: 'Adjustments' }]} />
      <div className="mt-4">
        {tab === 'stock' && <StockTab />}
        {tab === 'ledger' && <LedgerTab />}
        {tab === 'batches' && <BatchesTab />}
        {tab === 'serials' && <SerialsTab />}
        {tab === 'adjustments' && <AdjustmentsTab />}
      </div>
    </div>
  );
}

function StockTab() {
  const [params] = useSearchParams();
  const { can } = useAuth();
  const warehouses = useWarehouses();
  const [warehouseId, setWarehouseId] = useState(params.get('warehouseId') ?? '');
  const [status, setStatus] = useState(params.get('status') ?? '');
  const [owner, setOwner] = useState('all');
  const [action, setAction] = useState<{ kind: 'adjust' | 'status' | 'move'; row: any } | null>(null);
  const list = useServerList<any>('/inventory', { warehouseId: warehouseId || undefined, status: status || undefined, owner, locationId: params.get('locationId') ?? undefined, productId: params.get('productId') ?? undefined }, { defaultSort: 'updated' });
  const summary = useQuery({ queryKey: ['inventory-summary', warehouseId], queryFn: () => api.get<any>('/inventory/summary', { warehouseId: warehouseId || undefined }) });
  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        {INVENTORY_STATUSES.map((s) => {
          const r = summary.data?.byStatus.find((x: any) => x.status === s);
          return (
            <button key={s} onClick={() => setStatus(status === s ? '' : s)} className={`card p-3 text-left transition ${status === s ? 'border-brand-400 ring-2 ring-brand-100' : 'hover:border-ink-300'}`}>
              <div className="flex items-center justify-between"><StatusBadge status={s} />{r?.skus ? <span className="text-[11px] text-ink-400">{r.skus} SKUs</span> : null}</div>
              <div className="num mt-2 text-lg font-semibold">{qty(r?.units ?? 0, 0)}</div>
              {r?.value !== undefined && <div className="text-[11px] text-ink-500">{money(r.value, { compact: true })}</div>}
            </button>
          );
        })}
      </div>
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-ink-100 p-3">
          <SearchInput value={list.q} onChange={list.setQ} placeholder="SKU, product, location or batch" className="w-full sm:w-72" />
          <Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className="w-44"><option value="">All warehouses</option>{warehouses.data?.map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}</Select>
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40"><option value="">All statuses</option>{INVENTORY_STATUSES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</Select>
          <Select value={owner} onChange={(e) => setOwner(e.target.value)} className="w-48"><option value="all">All owners</option><option value="company">Company-owned</option><option value="customer">Customer-owned (3PL)</option></Select>
        </div>
        <Table rows={list.rows} loading={list.loading} error={list.error} onRetry={list.refetch} sort={list.sort} onSort={list.onSort}
          empty={<EmptyState icon={Boxes} title="No stock found" description="Receive goods or import opening inventory to see stock here." action={<Link to="/receiving/new"><Button variant="primary">Receive goods</Button></Link>} />}
          columns={[
            { key: 'sku', header: 'Product', sortKey: 'sku', cell: (r) => <Link to={`/products/${r.productId}`} className="block"><div className="font-medium text-ink-900 hover:text-brand-700">{r.productName}</div><div className="text-xs text-ink-500">{r.sku}</div></Link> },
            { key: 'location', header: 'Location', sortKey: 'location', cell: (r) => <div><div className="font-mono text-xs font-medium">{r.locationCode}</div><div className="text-xs text-ink-500">{r.warehouseCode}</div></div> },
            { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
            { key: 'batch', header: 'Batch / expiry', hideOnMobile: true, sortKey: 'expiry', cell: (r) => r.batchNo ? <div><div className="text-xs">{r.batchNo}</div>{r.expiryDate && <div className="text-xs text-ink-500">exp {date(r.expiryDate)}</div>}</div> : <span className="text-ink-300">—</span> },
            { key: 'owner', header: 'Owner', hideOnMobile: true, cell: (r) => r.ownerName ? <Badge tone="violet">{r.ownerName}</Badge> : <span className="text-xs text-ink-500">Company</span> },
            { key: 'quantity', header: 'Quantity', align: 'right', sortKey: 'quantity', cell: (r) => <span className="num font-semibold">{qty(r.quantity)} <span className="text-xs font-normal text-ink-400">{r.uom}</span></span> },
            ...(can('finance.view') ? [{ key: 'value', header: 'Value', align: 'right' as const, sortKey: 'value', hideOnMobile: true, cell: (r: any) => <span className="num">{money(r.value)}</span> }] : []),
            { key: 'actions', header: '', align: 'right', cell: (r) => can('inventory.adjust', 'transfer.execute') && r.status !== 'reserved' && r.status !== 'in_transit' ? (
              <Menu trigger={<Button size="icon" variant="ghost" aria-label="Actions" onClick={(e) => e.stopPropagation()}><MoreHorizontal /></Button>} items={[
                ...(can('inventory.adjust') ? [{ label: 'Adjust quantity', icon: <PencilLine />, onSelect: () => setAction({ kind: 'adjust', row: r }) }, { label: 'Change status', icon: <ShieldAlert />, onSelect: () => setAction({ kind: 'status', row: r }) }] : []),
                ...(can('transfer.execute', 'inventory.adjust') ? [{ label: 'Move to another location', icon: <ArrowRightLeft />, onSelect: () => setAction({ kind: 'move', row: r }) }] : []),
              ]} />) : null },
          ]} />
        {list.pagination}
      </Card>
      {action?.kind === 'adjust' && <AdjustDialog row={action.row} onClose={() => setAction(null)} />}
      {action?.kind === 'status' && <StatusDialog row={action.row} onClose={() => setAction(null)} />}
      {action?.kind === 'move' && <MoveDialog row={action.row} onClose={() => setAction(null)} />}
    </>
  );
}

function useInventoryMutation(path: string, onDone: () => void, success: (res: any) => string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: unknown) => api.post<any>(path, body, { idempotencyKey: crypto.randomUUID() }),
    onSuccess: (res) => { toast.success(success(res)); qc.invalidateQueries({ queryKey: ['/inventory'] }); qc.invalidateQueries({ queryKey: ['inventory-summary'] }); onDone(); },
  });
}

function AdjustDialog({ row, onClose }: { row: any; onClose: () => void }) {
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState<string>('correction');
  const [notes, setNotes] = useState('');
  const m = useInventoryMutation('/inventory/adjustments', onClose, (r) => r.status === 'pending_approval' ? `${r.number} sent for approval (above the value threshold).` : `${r.number} posted to the ledger.`);
  const n = Number(delta);
  return (
    <Dialog open onOpenChange={onClose} title="Adjust stock" description={`${row.sku} · ${row.locationCode} · currently ${qty(row.quantity)} ${row.status}`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={!n || notes.trim().length < 3} onClick={() => m.mutate({ warehouseId: row.warehouseId, locationId: row.locationId, productId: row.productId, batchId: row.batchId, ownerCustomerId: row.ownerCustomerId, status: row.status, quantityDelta: n, reasonCode: reason, notes })}>Submit adjustment</Button></>}>
      <div className="space-y-4">
        <div className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800">Adjustments never edit history — a new ledger entry is recorded. Large adjustments are routed for approval automatically.</div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Quantity change" hint="Use a minus sign to reduce, e.g. -3" required><Input type="number" step="any" value={delta} onChange={(e) => setDelta(e.target.value)} autoFocus /></Field>
          <Field label="Reason" required><Select value={reason} onChange={(e) => setReason(e.target.value)}>{ADJUSTMENT_REASONS.map((r) => <option key={r} value={r}>{humanize(r)}</option>)}</Select></Field>
        </div>
        <Field label="Explanation" required hint="Visible to approvers and auditors."><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What happened? e.g. 2 cartons crushed by forklift" /></Field>
        {!!n && <p className="text-sm text-ink-600">New balance: <b className="num">{qty(Number(row.quantity) + n)}</b></p>}
      </div>
    </Dialog>
  );
}

function StatusDialog({ row, onClose }: { row: any; onClose: () => void }) {
  const [to, setTo] = useState(row.status === 'available' ? 'damaged' : 'available');
  const [quantity, setQuantity] = useState(String(row.quantity));
  const [reason, setReason] = useState('');
  const m = useInventoryMutation('/inventory/status-change', onClose, () => 'Status changed and recorded in the ledger.');
  return (
    <Dialog open onOpenChange={onClose} title="Change stock status" description={`${row.sku} · ${row.locationCode} · ${qty(row.quantity)} ${row.status}`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={reason.trim().length < 3} onClick={() => m.mutate({ warehouseId: row.warehouseId, locationId: row.locationId, productId: row.productId, batchId: row.batchId, ownerCustomerId: row.ownerCustomerId, fromStatus: row.status, toStatus: to, quantity: Number(quantity), reason })}>Change status</Button></>}>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="New status"><Select value={to} onChange={(e) => setTo(e.target.value)}>{['available', 'damaged', 'quarantine', 'blocked', 'expired'].filter((s) => s !== row.status).map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</Select></Field>
          <Field label="Quantity"><Input type="number" step="any" max={row.quantity} value={quantity} onChange={(e) => setQuantity(e.target.value)} /></Field>
        </div>
        <Field label="Reason" required><Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Released after quality inspection" /></Field>
      </div>
    </Dialog>
  );
}

function MoveDialog({ row, onClose }: { row: any; onClose: () => void }) {
  const [toLocationId, setTo] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(String(row.quantity));
  const m = useInventoryMutation('/inventory/relocate', onClose, () => 'Stock moved.');
  return (
    <Dialog open onOpenChange={onClose} title="Move stock" description={`${row.sku} from ${row.locationCode}`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={!toLocationId} onClick={() => m.mutate({ warehouseId: row.warehouseId, fromLocationId: row.locationId, toLocationId, productId: row.productId, batchId: row.batchId, ownerCustomerId: row.ownerCustomerId, status: row.status, quantity: Number(quantity) })}>Move</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Destination location" required><LocationPicker warehouseId={row.warehouseId} value={toLocationId} onChange={setTo} /></Field>
        <Field label="Quantity"><Input type="number" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} /></Field>
      </div>
    </Dialog>
  );
}

/** Location picker for one warehouse, leaf (storable) locations only. */
export function LocationPicker({ warehouseId, value, onChange, includeDocks = true }: { warehouseId: string; value: string | null; onChange: (id: string | null, row?: any) => void; includeDocks?: boolean }) {
  const { data } = useQuery({ queryKey: ['locations', warehouseId, 'leaf'], queryFn: () => api.get<any[]>(`/warehouses/${warehouseId}/locations`, { leafOnly: true }), enabled: !!warehouseId, staleTime: 60_000 });
  const [q, setQ] = useState('');
  const options = (data ?? []).filter((l) => (includeDocks || (l.type !== 'dock' && l.type !== 'staging')) && (!q || l.code.toLowerCase().includes(q.toLowerCase())));
  return (
    <div className="space-y-1.5">
      <Input placeholder="Filter by code…" value={q} onChange={(e) => setQ(e.target.value)} className="h-8" />
      <Select value={value ?? ''} onChange={(e) => onChange(e.target.value || null, data?.find((l) => l.id === e.target.value))}>
        <option value="">Select location…</option>
        {options.slice(0, 400).map((l) => <option key={l.id} value={l.id}>{l.code} {l.type === 'bin' ? '' : `(${l.name})`} · {l.state === 'empty' ? 'empty' : `${Math.round(l.utilization * 100)}% used`}</option>)}
      </Select>
    </div>
  );
}

export function ProductPicker({ value, onChange, initialLabel }: { value: string | null; onChange: (id: string | null, p?: any) => void; initialLabel?: string }) {
  return <EntityPicker value={value} onChange={(id, o) => onChange(id, o?.raw)} endpoint="/products" placeholder="Search products by SKU, name or barcode" initialLabel={initialLabel}
    map={(p) => ({ id: p.id, label: `${p.sku} — ${p.name}`, sub: `${qty(p.available)} available · ${p.uom}`, raw: p })} />;
}

function LedgerTab() {
  const warehouses = useWarehouses();
  const [warehouseId, setWarehouseId] = useState('');
  const [type, setType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const { can } = useAuth();
  const list = useServerList<any>('/inventory/ledger', { warehouseId: warehouseId || undefined, type: type || undefined, from: from || undefined, to: to || undefined });
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-100 p-3">
        <SearchInput value={list.q} onChange={list.setQ} placeholder="SKU, reference or location" className="w-full sm:w-64" />
        <Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className="w-40"><option value="">All warehouses</option>{warehouses.data?.map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}</Select>
        <Select value={type} onChange={(e) => setType(e.target.value)} className="w-44"><option value="">All movement types</option>{TRANSACTION_TYPES.map((t) => <option key={t} value={t}>{humanize(t)}</option>)}</Select>
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-36" aria-label="From" />
        <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-36" aria-label="To" />
        <span className="ml-auto text-xs text-ink-500">Ledger entries are permanent. Corrections appear as new entries.</span>
      </div>
      <Table rows={list.rows} loading={list.loading} error={list.error} onRetry={list.refetch} dense
        empty={<EmptyState title="No movements match" description="Try a wider date range." />}
        columns={[
          { key: 'createdAt', header: 'When', cell: (r) => <span className="whitespace-nowrap text-xs">{dateTime(r.createdAt)}</span> },
          { key: 'type', header: 'Movement', cell: (r) => <div><Badge tone={r.quantity > 0 ? 'green' : 'gray'}>{humanize(r.type)}</Badge>{r.referenceNo && <div className="mt-0.5 text-xs text-ink-500">{r.referenceNo}</div>}</div> },
          { key: 'sku', header: 'Product', cell: (r) => <div><div className="text-sm font-medium">{r.sku}</div><div className="max-w-56 truncate text-xs text-ink-500">{r.productName}</div></div> },
          { key: 'loc', header: 'Location', hideOnMobile: true, cell: (r) => <span className="font-mono text-xs">{r.warehouseCode} · {r.locationCode}</span> },
          { key: 'status', header: 'Status', hideOnMobile: true, cell: (r) => <StatusBadge status={r.status} /> },
          { key: 'quantity', header: 'Qty', align: 'right', cell: (r) => <span className={`num font-semibold ${r.quantity > 0 ? 'text-emerald-700' : 'text-ink-800'}`}>{r.quantity > 0 ? '+' : ''}{qty(r.quantity)}</span> },
          { key: 'balanceAfter', header: 'Balance', align: 'right', hideOnMobile: true, cell: (r) => <span className="num text-ink-500">{qty(r.balanceAfter)}</span> },
          ...(can('finance.view') ? [{ key: 'value', header: 'Value', align: 'right' as const, hideOnMobile: true, cell: (r: any) => <span className="num text-xs">{money(r.value)}</span> }] : []),
          { key: 'by', header: 'By', hideOnMobile: true, cell: (r) => <div><div className="text-xs">{r.performedBy ?? 'System'}</div>{r.reason && <div className="max-w-48 truncate text-xs text-ink-400" title={r.reason}>{r.reason}</div>}</div> },
        ]} />
      {list.pagination}
    </Card>
  );
}

function BatchesTab() {
  const [filter, setFilter] = useState('');
  const list = useServerList<any>('/batches', { expiringWithinDays: filter === 'soon' ? 30 : undefined, expired: filter === 'expired' ? true : undefined });
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-100 p-3">
        <SearchInput value={list.q} onChange={list.setQ} placeholder="Batch number or product" className="w-full sm:w-64" />
        <Select value={filter} onChange={(e) => setFilter(e.target.value)} className="w-48"><option value="">All batches</option><option value="soon">Expiring within 30 days</option><option value="expired">Expired</option></Select>
      </div>
      <Table rows={list.rows} loading={list.loading} error={list.error}
        empty={<EmptyState title="No batches" description="Batches are created when batch-tracked products are received." />}
        columns={[
          { key: 'batchNo', header: 'Batch', cell: (r) => <div><div className="font-mono text-sm font-medium">{r.batchNo}</div>{r.lotNo && <div className="text-xs text-ink-500">Lot {r.lotNo}</div>}</div> },
          { key: 'product', header: 'Product', cell: (r) => <Link to={`/products/${r.productId}`}><div className="font-medium hover:text-brand-700">{r.productName}</div><div className="text-xs text-ink-500">{r.sku}</div></Link> },
          { key: 'supplier', header: 'Supplier', hideOnMobile: true, cell: (r) => r.supplierName ?? '—' },
          { key: 'mfg', header: 'Mfg', hideOnMobile: true, cell: (r) => date(r.mfgDate) },
          { key: 'expiry', header: 'Expiry', cell: (r) => r.expiryDate ? <div className="flex items-center gap-2">{date(r.expiryDate)}<Badge tone={r.daysToExpiry < 0 ? 'red' : r.daysToExpiry <= 30 ? 'amber' : 'green'}>{r.daysToExpiry < 0 ? 'expired' : `${r.daysToExpiry}d`}</Badge></div> : '—' },
          { key: 'onHand', header: 'On hand', align: 'right', cell: (r) => <span className="num font-semibold">{qty(r.onHand)}</span> },
        ]} />
      {list.pagination}
    </Card>
  );
}

function SerialsTab() {
  const [status, setStatus] = useState('');
  const list = useServerList<any>('/serials', { status: status || undefined });
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-100 p-3">
        <SearchInput value={list.q} onChange={list.setQ} placeholder="Serial number or SKU" className="w-full sm:w-64" />
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-44"><option value="">All statuses</option>{['in_stock', 'reserved', 'dispatched', 'returned', 'scrapped'].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</Select>
      </div>
      <Table rows={list.rows} loading={list.loading} error={list.error} empty={<EmptyState title="No serial numbers" description="Serial numbers are captured when serial-tracked products are received." />}
        columns={[
          { key: 'serial', header: 'Serial', cell: (r) => <span className="font-mono text-sm font-medium">{r.serial}</span> },
          { key: 'product', header: 'Product', cell: (r) => <div><div className="text-sm">{r.productName}</div><div className="text-xs text-ink-500">{r.sku}</div></div> },
          { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status === 'in_stock' ? 'available' : r.status} label={humanize(r.status)} /> },
          { key: 'where', header: 'Location', cell: (r) => r.locationCode ? <span className="font-mono text-xs">{r.warehouseCode} · {r.locationCode}</span> : '—' },
          { key: 'updatedAt', header: 'Last change', hideOnMobile: true, cell: (r) => dateTime(r.updatedAt) },
        ]} />
      {list.pagination}
    </Card>
  );
}

function AdjustmentsTab() {
  const [status, setStatus] = useState('');
  const { can } = useAuth();
  const list = useServerList<any>('/inventory/adjustments', { status: status || undefined });
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-100 p-3">
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-48"><option value="">All adjustments</option><option value="pending_approval">Pending approval</option><option value="posted">Posted</option><option value="rejected">Rejected</option></Select>
        {can('approval.decide') && <Link to="/approvals" className="ml-auto text-sm font-medium text-brand-700">Review approvals →</Link>}
      </div>
      <Table rows={list.rows} loading={list.loading} error={list.error} empty={<EmptyState title="No adjustments" description="Use the row menu on Stock on hand to record damage, loss or corrections." />}
        columns={[
          { key: 'number', header: 'Number', cell: (r) => <div><div className="font-medium">{r.number}</div><div className="text-xs text-ink-500">{dateTime(r.createdAt)}</div></div> },
          { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
          { key: 'sku', header: 'Product', cell: (r) => <div><div className="text-sm">{r.sku}</div><div className="font-mono text-xs text-ink-500">{r.warehouseCode} · {r.locationCode}</div></div> },
          { key: 'reason', header: 'Reason', hideOnMobile: true, cell: (r) => <div><div className="text-sm">{humanize(r.reasonCode)}</div><div className="max-w-56 truncate text-xs text-ink-500" title={r.notes}>{r.notes}</div></div> },
          { key: 'qty', header: 'Change', align: 'right', cell: (r) => <span className="num font-semibold">{r.quantityDelta > 0 ? '+' : ''}{qty(r.quantityDelta)}</span> },
          ...(can('finance.view') ? [{ key: 'value', header: 'Value', align: 'right' as const, cell: (r: any) => <span className="num">{money(r.value)}</span> }] : []),
          { key: 'people', header: 'Requested / approved', hideOnMobile: true, cell: (r) => <div className="text-xs"><div>{r.requestedBy}</div><div className="text-ink-500">{r.approvedBy ?? '—'}</div></div> },
        ]} />
      {list.pagination}
    </Card>
  );
}
