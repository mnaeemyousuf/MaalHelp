import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle2, MapPinned, PackagePlus, Plus, Printer, Trash2 } from 'lucide-react';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn, date, dateTime, money, qty } from '@/lib/utils';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, Input, Select, Skeleton, StatusBadge, Textarea } from '@/components/ui/core';
import { ConfirmDialog, Dialog } from '@/components/ui/overlay';
import { EntityPicker, KeyValue, PageHeader, ScanInput, scanFeedback } from '@/components/ui/blocks';
import { SearchInput, Table, useServerList } from '@/components/ui/table';
import { LocationPicker, useWarehouses } from './Inventory';

export function Receiving() {
  const navigate = useNavigate();
  const warehouses = useWarehouses();
  const [warehouseId, setWarehouseId] = useState('');
  const list = useServerList<any>('/receiving', { warehouseId: warehouseId || undefined });
  const expected = useQuery({ queryKey: ['receivable-pos'], queryFn: () => api.get<any[]>('/purchase-orders', { receivable: true, pageSize: 50, sort: 'expected', dir: 'asc' }) });
  return (
    <div>
      <PageHeader title="Receiving" description="Goods receipts (GRNs). Every receipt updates stock instantly and creates putaway tasks for the dock." actions={<Link to="/receiving/new"><Button variant="primary"><PackagePlus /> Receive goods</Button></Link>} />
      {!!expected.data?.length && (
        <Card className="mb-6">
          <CardHeader title="Expected deliveries" description="Approved purchase orders waiting to be received" />
          <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
            {expected.data.slice(0, 8).map((po) => (
              <Link key={po.id} to={`/receiving/new?po=${po.id}`} className={cn('rounded-xl border p-3 hover:border-brand-300 hover:bg-brand-50/40', po.overdue ? 'border-amber-300 bg-amber-50/40' : 'border-ink-200')}>
                <div className="flex items-center justify-between"><span className="text-sm font-semibold">{po.number}</span><StatusBadge status={po.overdue ? 'overdue' : po.status} label={po.overdue ? 'Overdue' : undefined} /></div>
                <div className="mt-1 truncate text-xs text-ink-600">{po.supplierName}</div>
                <div className="mt-2 flex justify-between text-xs text-ink-500"><span>{po.warehouseCode} · due {date(po.expectedDate)}</span><span className="num">{qty(po.receivedQty, 0)}/{qty(po.orderedQty, 0)}</span></div>
              </Link>
            ))}
          </div>
        </Card>
      )}
      <Card>
        <div className="flex flex-wrap gap-2 border-b border-ink-100 p-3">
          <SearchInput value={list.q} onChange={list.setQ} placeholder="GRN, PO or supplier" className="w-full sm:w-72" />
          <Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className="w-44"><option value="">All warehouses</option>{warehouses.data?.map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}</Select>
        </div>
        <Table rows={list.rows} loading={list.loading} error={list.error} onRetry={list.refetch} onRowClick={(r) => navigate(`/receiving/${r.id}`)}
          empty={<EmptyState icon={PackagePlus} title="No goods received yet" action={<Link to="/receiving/new"><Button variant="primary">Receive goods</Button></Link>} />}
          columns={[
            { key: 'number', header: 'GRN', cell: (r) => <div><div className="font-medium text-ink-900">{r.number}</div><div className="text-xs text-ink-500">{dateTime(r.receivedAt)}</div></div> },
            { key: 'po', header: 'Source', cell: (r) => r.poNumber ? <div><div className="text-sm">{r.poNumber}</div><div className="text-xs text-ink-500">{r.supplierName}</div></div> : r.ownerName ? <Badge tone="violet">3PL · {r.ownerName}</Badge> : <span className="text-xs text-ink-500">Blind receipt{r.supplierName ? ` · ${r.supplierName}` : ''}</span> },
            { key: 'wh', header: 'Warehouse', hideOnMobile: true, cell: (r) => r.warehouseCode },
            { key: 'lines', header: 'Lines / units', align: 'right', cell: (r) => <span className="num">{r.lines} · {qty(r.units, 0)}</span> },
            { key: 'var', header: 'Variances', hideOnMobile: true, cell: (r) => r.variances ? <Badge tone="amber">{r.variances} short/over</Badge> : <Badge tone="green">Exact</Badge> },
            { key: 'by', header: 'Received by', hideOnMobile: true, cell: (r) => r.receivedBy },
          ]} />
        {list.pagination}
      </Card>
    </div>
  );
}

interface Line { key: string; purchaseOrderLineId?: string; productId: string; sku: string; name: string; barcode?: string | null; uom?: string; expected: number; quantity: number; damagedQty: number; quarantineQty: number; batchNo: string; expiryDate: string; serials: string; qcStatus: 'passed' | 'pending' | 'failed'; locationId: string | null; trackBatch: boolean; trackExpiry: boolean; trackSerial: boolean; unitCost?: number }

export function ReceiveGoods() {
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { can } = useAuth();
  const warehouses = useWarehouses();
  const prefill = (location.state as any)?.prefill as any | undefined;
  const [mode, setMode] = useState<'po' | 'blind' | 'owner'>(params.get('po') ? 'po' : prefill ? 'blind' : 'po');
  const [poId, setPoId] = useState<string | null>(params.get('po'));
  const [warehouseId, setWarehouseId] = useState<string>(prefill?.warehouseId ?? '');
  const [supplierId, setSupplierId] = useState<string | null>(prefill?.supplierId ?? null);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [deliveryNoteNo, setDeliveryNoteNo] = useState(prefill?.deliveryNoteNo ?? '');
  const [vehicleNo, setVehicleNo] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [overReceipt, setOverReceipt] = useState<string | null>(null);
  const [done, setDone] = useState<any | null>(null);
  const [idemKey] = useState(() => crypto.randomUUID());

  const po = useQuery({ queryKey: ['po', poId], queryFn: () => api.get<any>(`/purchase-orders/${poId}`), enabled: mode === 'po' && !!poId });
  useEffect(() => {
    if (!po.data) return;
    setWarehouseId(po.data.warehouseId);
    setLines(po.data.lines.filter((l: any) => l.remainingQty > 0).map((l: any) => ({ key: l.id, purchaseOrderLineId: l.id, productId: l.productId, sku: l.sku, name: l.productName, barcode: l.barcode, uom: l.uom, expected: l.remainingQty, quantity: 0, damagedQty: 0, quarantineQty: 0, batchNo: '', expiryDate: '', serials: '', qcStatus: 'passed', locationId: null, trackBatch: l.trackBatch, trackExpiry: l.trackExpiry, trackSerial: l.trackSerial, unitCost: l.unitCost })));
  }, [po.data]);
  useEffect(() => {
    if (!prefill?.lines || lines.length) return;
    void Promise.all(prefill.lines.map((l: any) => api.get<any>(`/products/${l.productId}`))).then((ps) => setLines(ps.map((p, i) => blankLine(p, prefill.lines[i]))));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const blankLine = (p: any, extra: any = {}): Line => ({ key: crypto.randomUUID(), productId: p.id, sku: p.sku, name: p.name, barcode: p.barcode, uom: p.uom, expected: 0, quantity: extra.quantity ?? (p.unitQty ?? 1), damagedQty: 0, quarantineQty: 0, batchNo: extra.batchNo ?? '', expiryDate: extra.expiryDate ?? '', serials: '', qcStatus: 'passed', locationId: null, trackBatch: p.trackBatch, trackExpiry: p.trackExpiry, trackSerial: p.trackSerial, unitCost: extra.unitCost });
  const update = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const onScan = async (code: string) => {
    try {
      const p = await api.get<any>('/products/lookup', { code });
      const existing = lines.find((l) => l.productId === p.id);
      if (existing) { update(existing.key, { quantity: existing.quantity + (p.unitQty ?? 1) }); scanFeedback(true); toast.success(`${p.sku} +${p.unitQty ?? 1}`); return; }
      if (mode === 'po') { scanFeedback(false); toast.error(`${p.sku} is not on this purchase order.`); return; }
      setLines((ls) => [...ls, blankLine(p)]); scanFeedback(true);
    } catch (err) { scanFeedback(false); toast.error(errorMessage(err)); }
  };

  const active = lines.filter((l) => l.quantity > 0);
  const issues = active.flatMap((l) => [
    l.trackBatch && !l.batchNo ? `${l.sku}: batch number required` : null,
    l.trackExpiry && !l.expiryDate ? `${l.sku}: expiry date required` : null,
    l.trackSerial && l.serials.split(/[\s,]+/).filter(Boolean).length !== l.quantity ? `${l.sku}: scan ${l.quantity} serial numbers` : null,
    l.damagedQty + l.quarantineQty > l.quantity ? `${l.sku}: damaged + quarantine exceed received` : null,
  ].filter(Boolean) as string[]);

  const submit = useMutation({
    meta: { silent: true },
    mutationFn: (confirmOverReceipt: boolean) => api.post<any>('/receiving', {
      purchaseOrderId: mode === 'po' ? poId : null, supplierId: mode === 'blind' ? supplierId : null, ownerCustomerId: mode === 'owner' ? ownerId : null, warehouseId, deliveryNoteNo, vehicleNo, notes, confirmOverReceipt,
      lines: active.map((l) => ({ purchaseOrderLineId: l.purchaseOrderLineId ?? null, productId: l.productId, quantity: l.quantity, damagedQty: l.damagedQty, quarantineQty: l.quarantineQty, batchNo: l.batchNo || null, expiryDate: l.expiryDate || null, serials: l.serials.split(/[\s,]+/).filter(Boolean), qcStatus: l.qcStatus, locationId: l.locationId, unitCost: l.unitCost })),
    }, { idempotencyKey: confirmOverReceipt ? `${idemKey}-over` : idemKey }),
    onSuccess: (res) => { setDone(res); qc.invalidateQueries(); },
    onError: (err) => { if (err instanceof ApiError && err.code === 'OVER_RECEIPT') setOverReceipt(err.message); else toast.error(errorMessage(err)); },
  });

  if (done) return (
    <Card className="mx-auto max-w-xl p-8 text-center">
      <CheckCircle2 className="mx-auto size-14 text-emerald-500" />
      <h2 className="mt-3 text-xl font-semibold">{done.number} recorded</h2>
      <p className="mt-1 text-sm text-ink-600">Stock is updated in the ledger.{done.putawayTaskIds?.length ? ` ${done.putawayTaskIds.length} putaway task(s) are waiting at the receiving dock.` : ''}</p>
      {done.variances?.length > 0 && <p className="mt-2 text-sm text-amber-700">Variances: {done.variances.join(', ')}</p>}
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <Link to={`/print/grn/${done.id}`} target="_blank"><Button><Printer /> Print GRN</Button></Link>
        {done.putawayTaskIds?.length > 0 && <Link to="/putaway"><Button variant="primary"><MapPinned /> Put away now</Button></Link>}
        <Button variant="ghost" onClick={() => navigate(0)}>Receive another</Button>
      </div>
    </Card>
  );

  return (
    <div>
      <PageHeader back={{ to: '/receiving', label: 'Receiving' }} title="Receive goods" description="1. Choose the delivery · 2. Scan each product · 3. Check quantities, batch and expiry · 4. Confirm" />
      <div className="grid gap-6 xl:grid-cols-[360px_1fr]">
        <Card className="h-fit p-5">
          <div className="mb-4 grid grid-cols-3 gap-1 rounded-lg bg-ink-100 p-1 text-xs font-medium">
            {[['po', 'Purchase order'], ['blind', 'Without PO'], ['owner', '3PL client']].map(([v, l]) => <button key={v} onClick={() => { setMode(v as never); setLines([]); }} className={cn('rounded-md py-1.5', mode === v ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-500')}>{l}</button>)}
          </div>
          <div className="space-y-4">
            {mode === 'po' && <Field label="Purchase order" required><EntityPicker value={poId} onChange={setPoId} endpoint="/purchase-orders" params={{ receivable: 1 }} placeholder="Select an approved PO" initialLabel={po.data ? `${po.data.number} · ${po.data.supplier?.name}` : undefined} map={(p) => ({ id: p.id, label: `${p.number} · ${p.supplierName}`, sub: `${p.warehouseCode} · due ${date(p.expectedDate)} · ${qty(p.receivedQty, 0)}/${qty(p.orderedQty, 0)} received` })} /></Field>}
            {mode === 'blind' && <Field label="Supplier (optional)"><EntityPicker value={supplierId} onChange={setSupplierId} endpoint="/suppliers" map={(s) => ({ id: s.id, label: s.name, sub: s.city })} /></Field>}
            {mode === 'owner' && <Field label="Stock owner (storage client)" required hint="Goods stay owned by the client and are billed as storage."><EntityPicker value={ownerId} onChange={setOwnerId} endpoint="/customers" params={{ storageClients: 1 }} map={(c) => ({ id: c.id, label: c.name, sub: c.code })} /></Field>}
            <Field label="Warehouse" required><Select value={warehouseId} disabled={mode === 'po' && !!po.data} onChange={(e) => setWarehouseId(e.target.value)}><option value="">Select…</option>{warehouses.data?.map((w) => <option key={w.id} value={w.id}>{w.code} · {w.name}</option>)}</Select></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Delivery note no."><Input value={deliveryNoteNo} onChange={(e) => setDeliveryNoteNo(e.target.value)} /></Field>
              <Field label="Vehicle no."><Input value={vehicleNo} onChange={(e) => setVehicleNo(e.target.value)} placeholder="KHI-1234" /></Field>
            </div>
            <Field label="Notes"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} className="min-h-14" /></Field>
          </div>
        </Card>
        <div className="space-y-4">
          <Card className="p-4"><ScanInput onScan={onScan} large label="Scan product barcode" placeholder={mode === 'po' && !po.data ? 'Select the purchase order first' : 'Scan or type SKU / barcode'} disabled={mode === 'po' && !po.data} /></Card>
          <Card>
            <CardHeader title={`Lines (${active.length} received of ${lines.length})`} description={mode === 'po' ? 'Expected quantities come from the PO. Short and over deliveries are recorded automatically.' : 'Scan products to add lines.'}
              actions={mode !== 'po' && <EntityPicker value={null} onChange={async (id) => { if (id) { const p = await api.get<any>(`/products/${id}`); setLines((ls) => [...ls, blankLine(p)]); } }} endpoint="/products" placeholder="+ Add product" map={(p) => ({ id: p.id, label: `${p.sku} — ${p.name}` })} />} />
            {!lines.length ? <EmptyState icon={PackagePlus} title={mode === 'po' ? 'Choose a purchase order' : 'Scan the first product'} description="Lines appear here as you scan." /> : (
              <div className="divide-y divide-ink-100">
                {lines.map((l) => (
                  <div key={l.key} className={cn('grid gap-3 px-4 py-3 sm:grid-cols-3 lg:grid-cols-[minmax(0,1.6fr)_110px_110px_170px]', l.quantity > 0 && 'bg-emerald-50/30')}>
                    <div className="min-w-0 sm:col-span-3 lg:col-span-1">
                      <div className="truncate text-sm font-medium text-ink-900">{l.name}</div>
                      <div className="text-xs text-ink-500">{l.sku}{l.expected ? ` · expected ${qty(l.expected)} ${l.uom ?? ''}` : ''}</div>
                      <div className="mt-1 flex gap-1">{l.quantity > 0 && l.expected > 0 && l.quantity !== l.expected && <Badge tone={l.quantity < l.expected ? 'amber' : 'violet'}>{l.quantity < l.expected ? `Short ${qty(l.expected - l.quantity)}` : `Over ${qty(l.quantity - l.expected)}`}</Badge>}{l.trackSerial && <Badge tone="violet">Serials</Badge>}</div>
                    </div>
                    <Field label="Received"><Input type="number" min={0} step="any" value={l.quantity} onChange={(e) => update(l.key, { quantity: Number(e.target.value) })} /></Field>
                    <Field label="Damaged"><Input type="number" min={0} step="any" value={l.damagedQty} onChange={(e) => update(l.key, { damagedQty: Number(e.target.value) })} /></Field>
                    <Field label="Quality"><Select value={l.qcStatus} onChange={(e) => update(l.key, { qcStatus: e.target.value as never })}><option value="passed">Passed</option><option value="pending">Hold (QC)</option><option value="failed">Failed → quarantine</option></Select></Field>
                    <div className="grid grid-cols-2 gap-2 sm:col-span-3 lg:col-span-4 lg:grid-cols-4">
                      {(l.trackBatch || l.trackExpiry) && <Field label="Batch"><Input value={l.batchNo} onChange={(e) => update(l.key, { batchNo: e.target.value.toUpperCase() })} /></Field>}
                      {l.trackExpiry && <Field label="Expiry"><Input type="date" value={l.expiryDate} onChange={(e) => update(l.key, { expiryDate: e.target.value })} /></Field>}
                      {l.trackSerial && <Field label="Serial numbers" className="col-span-2"><Textarea value={l.serials} onChange={(e) => update(l.key, { serials: e.target.value })} placeholder="Scan one per line" className="min-h-14 font-mono text-xs" /></Field>}
                      {warehouseId && <Field label="Location" className="col-span-2" hint="Default: receiving dock → putaway task"><LocationPicker warehouseId={warehouseId} value={l.locationId} onChange={(id) => update(l.key, { locationId: id })} /></Field>}
                      {mode !== 'po' && <Button size="sm" variant="ghost" className="col-span-2 justify-start text-red-600" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}><Trash2 /> Remove</Button>}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ink-100 bg-ink-50/50 px-4 py-3">
              <div className="text-xs">{issues.length ? <span className="text-red-600">{issues[0]}{issues.length > 1 ? ` (+${issues.length - 1} more)` : ''}</span> : active.length ? <span className="text-ink-600">{active.length} line(s), {qty(active.reduce((s, l) => s + l.quantity, 0))} units ready</span> : <span className="text-ink-500">Enter received quantities</span>}</div>
              <Button variant="primary" size="lg" loading={submit.isPending} disabled={!warehouseId || !active.length || issues.length > 0 || (mode === 'owner' && !ownerId) || !can('receiving.execute')} onClick={() => submit.mutate(false)}><CheckCircle2 /> Confirm receipt</Button>
            </div>
          </Card>
        </div>
      </div>
      <ConfirmDialog open={!!overReceipt} onOpenChange={() => setOverReceipt(null)} title="Over-receipt" description={overReceipt ?? ''} confirmLabel="Accept over-receipt" onConfirm={() => submit.mutateAsync(true)} />
    </div>
  );
}

export function ReceiptDetail() {
  const { id } = useParams();
  const { data, isLoading, error } = useQuery({ queryKey: ['grn', id], queryFn: () => api.get<any>(`/receiving/${id}`) });
  if (error) return <Card><ErrorState error={error} /></Card>;
  if (isLoading || !data) return <Skeleton className="h-96" />;
  return (
    <div>
      <PageHeader back={{ to: '/receiving', label: 'Receiving' }} title={data.number} description={`Received ${dateTime(data.received_at)} by ${data.received_by_name ?? '—'}`} actions={<Link to={`/print/grn/${data.id}`} target="_blank"><Button><Printer /> Print GRN</Button></Link>} />
      <Card className="mb-4 p-5"><KeyValue cols={4} items={[['Purchase order', data.po_number ?? 'None (blind receipt)'], ['Supplier', data.supplier_name ?? '—'], ['Owner', data.owner_name ?? 'Company'], ['Warehouse', `${data.warehouse_code} · ${data.warehouse_name}`], ['Delivery note', data.delivery_note_no || '—'], ['Vehicle', data.vehicle_no || '—'], ['Value', data.total_value !== undefined ? money(data.total_value) : '—'], ['Notes', data.notes || '—']]} /></Card>
      <Card className="mb-4"><CardHeader title="Lines" /><Table rows={data.lines} columns={[
        { key: 'sku', header: 'Product', cell: (l: any) => <div><div className="font-medium">{l.productName}</div><div className="text-xs text-ink-500">{l.sku}</div></div> },
        { key: 'exp', header: 'Expected', align: 'right', cell: (l: any) => qty(l.expectedQty) },
        { key: 'rec', header: 'Received', align: 'right', cell: (l: any) => <b className="num">{qty(l.receivedQty)}</b> },
        { key: 'dmg', header: 'Damaged', align: 'right', cell: (l: any) => l.damagedQty ? <span className="text-red-600">{qty(l.damagedQty)}</span> : '—' },
        { key: 'var', header: 'Variance', cell: (l: any) => <StatusBadge status={l.varianceType === 'exact' ? 'ok' : l.varianceType === 'short' ? 'short' : 'review'} label={l.varianceType} /> },
        { key: 'qc', header: 'QC', cell: (l: any) => <StatusBadge status={l.qcStatus === 'passed' ? 'approved' : 'pending'} label={l.qcStatus} /> },
        { key: 'b', header: 'Batch / expiry', cell: (l: any) => l.batchNo ? `${l.batchNo}${l.expiryDate ? ` · ${date(l.expiryDate)}` : ''}` : '—' },
        { key: 'loc', header: 'Received to', cell: (l: any) => <span className="font-mono text-xs">{l.locationCode}</span> },
      ]} /></Card>
      {data.putawayTasks.length > 0 && <Card><CardHeader title="Putaway" /><Table rows={data.putawayTasks} dense columns={[{ key: 'n', header: 'Task', cell: (t: any) => t.number }, { key: 's', header: 'SKU', cell: (t: any) => t.sku }, { key: 'q', header: 'Qty', align: 'right', cell: (t: any) => qty(t.quantity) }, { key: 'sg', header: 'Suggested', cell: (t: any) => <span className="font-mono text-xs">{t.suggestedCode ?? '—'}</span> }, { key: 'a', header: 'Put to', cell: (t: any) => <span className="font-mono text-xs">{t.actualCode ?? '—'}</span> }, { key: 'st', header: 'Status', cell: (t: any) => <StatusBadge status={t.status} /> }]} /></Card>}
    </div>
  );
}

export function Putaway() {
  const { can } = useAuth();
  const warehouses = useWarehouses();
  const [warehouseId, setWarehouseId] = useState('');
  const [status, setStatus] = useState<'pending' | 'completed'>('pending');
  const [task, setTask] = useState<any | null>(null);
  const list = useServerList<any>('/putaway/tasks', { status, warehouseId: warehouseId || undefined });
  return (
    <div>
      <PageHeader title="Putaway" description="Move received stock from the dock into storage. The system recommends the best location and explains why." actions={<Link to="/m/putaway"><Button>Open mobile putaway</Button></Link>} />
      <Card>
        <div className="flex flex-wrap gap-2 border-b border-ink-100 p-3">
          <div className="flex gap-1 rounded-lg bg-ink-100 p-1 text-xs font-medium">{(['pending', 'completed'] as const).map((s) => <button key={s} onClick={() => setStatus(s)} className={cn('rounded-md px-3 py-1.5 capitalize', status === s ? 'bg-white shadow-sm' : 'text-ink-500')}>{s}</button>)}</div>
          <Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className="w-44"><option value="">All warehouses</option>{warehouses.data?.map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}</Select>
        </div>
        <Table rows={list.rows} loading={list.loading} error={list.error} onRetry={list.refetch}
          empty={<EmptyState icon={MapPinned} title={status === 'pending' ? 'Nothing waiting for putaway' : 'No completed putaway yet'} description="Putaway tasks are created when goods are received to the dock." />}
          columns={[
            { key: 'n', header: 'Task', cell: (r) => <div><div className="font-medium">{r.number}</div><div className="text-xs text-ink-500">{r.grnNumber}</div></div> },
            { key: 'p', header: 'Product', cell: (r) => <div><div className="text-sm">{r.productName}</div><div className="text-xs text-ink-500">{r.sku}{r.batchNo ? ` · ${r.batchNo}` : ''}</div></div> },
            { key: 'q', header: 'Qty', align: 'right', cell: (r) => <b className="num">{qty(r.quantity)}</b> },
            { key: 'from', header: 'From', hideOnMobile: true, cell: (r) => <span className="font-mono text-xs">{r.warehouseCode} · {r.fromCode}</span> },
            { key: 'sug', header: status === 'pending' ? 'Recommended' : 'Put to', cell: (r) => status === 'pending' ? (r.suggestedCode ? <div><span className="font-mono text-xs font-semibold text-brand-800">{r.suggestedCode}</span><div className="max-w-64 truncate text-xs text-ink-500" title={r.suggestionReason}>{r.suggestionReason}</div></div> : <Badge tone="amber">Choose manually</Badge>) : <div><span className="font-mono text-xs">{r.actualCode}</span>{r.overrideReason && <div className="text-xs text-amber-700">Override: {r.overrideReason}</div>}</div> },
            { key: 'a', header: '', align: 'right', cell: (r) => status === 'pending' && can('putaway.execute') ? <Button size="sm" variant="primary" onClick={() => setTask(r)}>Put away</Button> : <span className="text-xs text-ink-500">{r.completedBy}</span> },
          ]} />
        {list.pagination}
      </Card>
      {task && <PutawayDialog task={task} onClose={() => setTask(null)} />}
    </div>
  );
}

function PutawayDialog({ task, onClose }: { task: any; onClose: () => void }) {
  const qc = useQueryClient();
  const sug = useQuery({ queryKey: ['putaway-suggest', task.id], queryFn: () => api.get<any>('/putaway/suggest', { warehouseId: task.warehouseId, productId: task.productId, quantity: task.quantity, batchId: task.batchId ?? undefined }) });
  const [locationId, setLocationId] = useState<string | null>(task.suggestedLocationId);
  const [reason, setReason] = useState('');
  const [quantity, setQuantity] = useState(task.quantity);
  const [key] = useState(() => crypto.randomUUID());
  const override = !!task.suggestedLocationId && locationId !== task.suggestedLocationId;
  const m = useMutation({ mutationFn: () => api.post<any>(`/putaway/tasks/${task.id}/complete`, { locationId, quantity, overrideReason: reason || undefined }, { idempotencyKey: key }), onSuccess: (r) => { toast.success(`Put away to ${r.location}${r.remaining ? ` · ${r.remaining} left on a new task` : ''}`); qc.invalidateQueries(); onClose(); } });
  const candidates = useMemo(() => sug.data?.candidates ?? [], [sug.data]);
  return (
    <Dialog open onOpenChange={onClose} title={`Put away ${task.sku}`} description={`${qty(task.quantity)} ${task.uom} from ${task.fromCode} · velocity: ${sug.data?.velocity ?? '…'} mover`} size="lg"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={!locationId || (override && reason.trim().length < 3)} onClick={() => m.mutate()}>Confirm putaway</Button></>}>
      <div className="space-y-4">
        <div className="grid gap-2">
          {candidates.map((c: any, i: number) => (
            <button key={c.locationId} onClick={() => setLocationId(c.locationId)} className={cn('flex items-start gap-3 rounded-xl border p-3 text-left', locationId === c.locationId ? 'border-brand-500 bg-brand-50 ring-2 ring-brand-100' : 'border-ink-200 hover:border-ink-300')}>
              <span className={cn('grid size-6 shrink-0 place-items-center rounded-full text-xs font-bold', i === 0 ? 'bg-brand-700 text-white' : 'bg-ink-100 text-ink-600')}>{i + 1}</span>
              <div className="flex-1"><div className="flex items-center gap-2"><span className="font-mono text-sm font-semibold">{c.code}</span>{i === 0 && <Badge tone="teal">Recommended</Badge>}<span className="ml-auto text-xs text-ink-500">score {c.score}</span></div><div className="mt-0.5 text-xs text-ink-600">{c.reasons.join(' · ')}</div></div>
            </button>
          ))}
          {sug.isLoading && <Skeleton className="h-20" />}
        </div>
        <Field label="Or choose another location"><LocationPicker warehouseId={task.warehouseId} value={locationId} onChange={setLocationId} includeDocks={false} /></Field>
        <Field label="Quantity" hint="Put away part of it and the rest stays on a new task"><Input type="number" min={1} max={task.quantity} value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} className="w-40" /></Field>
        {override && <Field label="Override reason" required hint="Recorded in the audit trail. Locations outside the recommendations need a manager."><Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Recommended bin physically blocked by pallets" /></Field>}
      </div>
    </Dialog>
  );
}

