import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Ban, CheckCircle2, ClipboardList, Copy, Plus, Printer, ScanLine, Truck } from 'lucide-react';
import { PRIORITIES } from '@shared/domain';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn, date, dateTime, humanize, money, qty, today } from '@/lib/utils';
import { Badge, Button, Card, CardHeader, Checkbox, EmptyState, ErrorState, Field, Input, Select, Skeleton, StatusBadge, Textarea } from '@/components/ui/core';
import { ConfirmDialog } from '@/components/ui/overlay';
import { EntityPicker, KeyValue, PageHeader } from '@/components/ui/blocks';
import { SearchInput, Table, useServerList } from '@/components/ui/table';
import { LineEditor, newLine, type EditorLine } from '@/components/LineEditor';
import { useWarehouses } from './Inventory';

const SO_FLOW = ['draft', 'confirmed', 'reserved', 'picking', 'packed', 'dispatched', 'delivered', 'completed'];

export function Orders() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { can } = useAuth();
  const status = params.get('status') ?? '';
  const delayed = params.get('delayed') === '1';
  const list = useServerList<any>('/sales-orders', { status: status || undefined, delayed: delayed || undefined });
  const filters = [['', 'All'], ['draft', 'Draft'], ['confirmed', 'Back-ordered'], ['reserved,picking', 'In fulfilment'], ['packed', 'Ready to ship'], ['dispatched', 'Dispatched'], ['delivered,completed', 'Delivered'], ['cancelled', 'Cancelled']];
  return (
    <div>
      <PageHeader title="Sales orders" description="Confirming an order reserves real available stock (FEFO) so it can never be oversold." actions={can('sales.manage') && <Link to="/orders/new"><Button variant="primary"><Plus /> New order</Button></Link>} />
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-ink-100 p-3">
          <SearchInput value={list.q} onChange={list.setQ} placeholder="Order number or customer" className="w-full sm:w-72" />
          <div className="flex flex-wrap gap-1">
            {filters.map(([v, l]) => <button key={v} onClick={() => setParams(v ? { status: v } : {})} className={cn('rounded-full px-3 py-1 text-xs font-medium', status === v && !delayed ? 'bg-brand-700 text-white' : 'bg-ink-100 text-ink-600 hover:bg-ink-200')}>{l}</button>)}
            <button onClick={() => setParams(delayed ? {} : { delayed: '1' })} className={cn('rounded-full px-3 py-1 text-xs font-medium', delayed ? 'bg-red-600 text-white' : 'bg-red-50 text-red-700 hover:bg-red-100')}>Delayed</button>
          </div>
        </div>
        <Table rows={list.rows} loading={list.loading} error={list.error} onRetry={list.refetch} sort={list.sort} onSort={list.onSort} onRowClick={(r) => navigate(`/orders/${r.id}`)}
          empty={<EmptyState icon={ClipboardList} title={delayed ? 'No delayed orders' : 'No orders found'} action={can('sales.manage') && !delayed && <Link to="/orders/new"><Button variant="primary">Create order</Button></Link>} />}
          columns={[
            { key: 'number', header: 'Order', sortKey: 'number', cell: (r) => <div><div className="flex items-center gap-1.5 font-medium text-ink-900">{r.number}{r.delayed && <Badge tone="red">Delayed</Badge>}</div><div className="text-xs text-ink-500">{date(r.orderDate)}</div></div> },
            { key: 'customer', header: 'Customer', sortKey: 'customer', cell: (r) => r.customerName },
            { key: 'priority', header: 'Priority', sortKey: 'priority', hideOnMobile: true, cell: (r) => r.priority === 'normal' ? <span className="text-xs text-ink-500">Normal</span> : <StatusBadge status={r.priority} /> },
            { key: 'required', header: 'Required', sortKey: 'required', hideOnMobile: true, cell: (r) => date(r.requiredDate) },
            { key: 'fulfil', header: 'Fulfilment', hideOnMobile: true, cell: (r) => <span className="num text-xs text-ink-600">{qty(r.shippedQty || r.pickedQty || r.reservedQty, 0)} / {qty(r.orderedQty, 0)} {r.shippedQty ? 'shipped' : r.pickedQty ? 'picked' : 'reserved'}</span> },
            { key: 'total', header: 'Total', align: 'right', sortKey: 'total', cell: (r) => <span className="num font-medium">{money(r.total)}</span> },
            { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} label={r.status === 'confirmed' ? 'Back-ordered' : undefined} /> },
          ]} />
        {list.pagination}
      </Card>
    </div>
  );
}

export function OrderForm() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { me } = useAuth();
  const warehouses = useWarehouses();
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [customer, setCustomer] = useState<any>(null);
  const [warehouseId, setWarehouseId] = useState('');
  const [priority, setPriority] = useState('normal');
  const [requiredDate, setRequiredDate] = useState(today(2));
  const [address, setAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [allowPartial, setAllowPartial] = useState(true);
  const [lines, setLines] = useState<EditorLine[]>([newLine()]);
  const [creditIssue, setCreditIssue] = useState<string | null>(null);
  const [key] = useState(() => crypto.randomUUID());
  const avail = useQuery({
    queryKey: ['availability', warehouseId, lines.map((l) => l.productId).join(',')],
    queryFn: () => api.get<any[]>('/sales-orders/availability/check', { warehouseId, productIds: lines.map((l) => l.productId).filter(Boolean).join(',') }),
    enabled: !!warehouseId && lines.some((l) => l.productId),
  });
  const withAvail = lines.map((l) => ({ ...l, available: avail.data?.find((a) => a.productId === l.productId)?.sellable ?? l.available }));
  const total = lines.reduce((s, l) => s + l.quantity * l.price * (1 - l.discountPct / 100), 0);
  const valid = customerId && warehouseId && lines.every((l) => l.productId && l.quantity > 0);
  const save = useMutation({
    meta: { silent: true },
    mutationFn: ({ confirm, override }: { confirm: boolean; override?: boolean }) => api.post<any>('/sales-orders', {
      customerId, warehouseId, priority, requiredDate, shippingAddress: address, notes, allowPartial, confirm, overrideCreditLimit: !!override,
      lines: lines.map((l) => ({ productId: l.productId, quantity: l.quantity, unitPrice: l.price, discountPct: l.discountPct })),
    }, { idempotencyKey: `${key}-${confirm}-${override ?? false}` }),
    onSuccess: (o) => {
      const r = o.reservation;
      toast.success(r ? (r.shortUnits ? `${o.number} confirmed: ${r.reservedUnits} units reserved, ${r.shortUnits} back-ordered` : `${o.number} confirmed and fully reserved — ${r.pickTasks} pick task(s) created`) : `${o.number} saved as draft`);
      qc.invalidateQueries({ queryKey: ['/sales-orders'] });
      navigate(`/orders/${o.id}`);
    },
    onError: (err) => { if (err instanceof ApiError && err.code === 'CREDIT_LIMIT_EXCEEDED') setCreditIssue(err.message); else toast.error(errorMessage(err)); },
  });
  return (
    <div>
      <PageHeader back={{ to: '/orders', label: 'Sales orders' }} title="New sales order" />
      <div className="grid gap-6 xl:grid-cols-[320px_1fr]">
        <Card className="h-fit space-y-4 p-5">
          <Field label="Customer" required><EntityPicker value={customerId} onChange={(id, o) => { setCustomerId(id); setCustomer(o?.raw); setAddress(o?.raw?.address ?? ''); }} endpoint="/customers" map={(c) => ({ id: c.id, label: c.name, sub: `${c.city} · ${c.outstanding !== undefined ? `owes ${money(c.outstanding)}` : ''}`, raw: c })} /></Field>
          {customer && customer.creditLimit > 0 && <div className="rounded-lg bg-ink-50 p-3 text-xs text-ink-600">Credit limit {money(customer.creditLimit)} · outstanding {money(customer.outstanding)} · {customer.overdue ? <span className="text-red-600">{money(customer.overdue)} overdue</span> : 'nothing overdue'}</div>}
          <Field label="Ship from" required><Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}><option value="">Select warehouse…</option>{warehouses.data?.map((w) => <option key={w.id} value={w.id}>{w.code} · {w.name}</option>)}</Select></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Priority"><Select value={priority} onChange={(e) => setPriority(e.target.value)}>{PRIORITIES.map((p) => <option key={p} value={p}>{humanize(p)}</option>)}</Select></Field>
            <Field label="Required by"><Input type="date" value={requiredDate} onChange={(e) => setRequiredDate(e.target.value)} /></Field>
          </div>
          <Field label="Delivery address"><Textarea value={address} onChange={(e) => setAddress(e.target.value)} className="min-h-14" /></Field>
          <Field label="Notes"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} className="min-h-14" /></Field>
          <Checkbox label="Allow partial fulfilment" hint="Ship what is available now and back-order the rest." checked={allowPartial} onChange={setAllowPartial} />
        </Card>
        <Card>
          <CardHeader title="Products" description="Availability shows sellable stock at pickable locations in the selected warehouse." />
          <LineEditor lines={withAvail} onChange={setLines} priceField="sellingPrice" priceLabel="Unit price" showAvailability={!!warehouseId} />
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-ink-100 px-4 py-3">
            <span className="mr-auto text-sm text-ink-600">Order value before tax <b className="num">{money(total)}</b></span>
            <Button loading={save.isPending} disabled={!valid} onClick={() => save.mutate({ confirm: false })}>Save draft</Button>
            <Button variant="primary" loading={save.isPending} disabled={!valid} onClick={() => save.mutate({ confirm: true })}><CheckCircle2 /> Confirm & reserve</Button>
          </div>
        </Card>
      </div>
      <ConfirmDialog open={!!creditIssue} onOpenChange={() => setCreditIssue(null)} title="Credit limit exceeded" description={creditIssue ?? ''} confirmLabel={me?.role.key === 'owner' ? 'Override and confirm' : 'OK'} onConfirm={async () => { if (me?.role.key === 'owner') await save.mutateAsync({ confirm: true, override: true }); }} />
    </div>
  );
}

export function OrderDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [cancel, setCancel] = useState(false);
  const { data: o, isLoading, error, refetch } = useQuery({ queryKey: ['order', id], queryFn: () => api.get<any>(`/sales-orders/${id}`) });
  const act = useMutation({ mutationFn: ({ action, body }: { action: string; body?: unknown }) => api.post<any>(`/sales-orders/${id}/${action}`, body ?? {}), onSuccess: (r, v) => { if (v.action === 'backorder') { toast.success(`Back-order ${r.number} created`); navigate(`/orders/${r.id}`); } else toast.success('Order updated'); qc.invalidateQueries(); } });
  if (error) return <Card><ErrorState error={error} onRetry={refetch} /></Card>;
  if (isLoading || !o) return <Skeleton className="h-96" />;
  const idx = SO_FLOW.indexOf(o.status);
  const shipment = o.shipments?.[0];
  return (
    <div>
      <PageHeader back={{ to: '/orders', label: 'Sales orders' }} title={<span className="flex items-center gap-2">{o.number} <StatusBadge status={o.status} label={o.status === 'confirmed' ? 'Back-ordered' : undefined} />{o.priority !== 'normal' && <StatusBadge status={o.priority} />}</span>} description={`${o.customer?.name} · ships from ${o.warehouse?.name}`}
        actions={<>
          {o.status === 'draft' && can('sales.manage') && <Button variant="primary" loading={act.isPending} onClick={() => act.mutate({ action: 'confirm' })}><CheckCircle2 /> Confirm & reserve</Button>}
          {['confirmed', 'reserved', 'picking'].includes(o.status) && o.backorderQty > 0 && can('sales.manage') && <Button loading={act.isPending} onClick={() => act.mutate({ action: 'reserve' })}>Retry reservation</Button>}
          {['reserved', 'picking'].includes(o.status) && can('picking.execute') && <Link to={`/picking?order=${o.id}`}><Button variant="primary"><ScanLine /> Pick</Button></Link>}
          {o.readyToPack && ['reserved', 'picking'].includes(o.status) && can('packing.execute') && <Link to={`/packing?order=${o.id}`}><Button variant="primary">Pack</Button></Link>}
          {o.status === 'packed' && can('dispatch.execute') && <Link to={`/dispatch?order=${o.id}`}><Button variant="primary"><Truck /> Dispatch</Button></Link>}
          {o.status === 'delivered' && can('sales.manage') && <Button onClick={() => act.mutate({ action: 'complete' })}>Mark completed</Button>}
          {['dispatched', 'delivered', 'completed'].includes(o.status) && o.backorderQty > 0 && can('sales.manage') && <Button onClick={() => act.mutate({ action: 'backorder' })}><Copy /> Create back-order</Button>}
          <Link to={`/print/packing-slip/${o.id}`} target="_blank"><Button><Printer /> Packing slip</Button></Link>
          {['draft', 'confirmed', 'reserved', 'picking', 'packed'].includes(o.status) && can('sales.manage') && <Button variant="ghost" className="text-red-600" onClick={() => setCancel(true)}><Ban /> Cancel</Button>}
        </>} />
      {o.status !== 'cancelled' && (
        <Card className="mb-4 px-5 py-4">
          <ol className="flex flex-wrap items-center gap-2 text-xs">{SO_FLOW.map((s, i) => <li key={s} className="flex items-center gap-2"><span className={cn('rounded-full px-2.5 py-1 font-medium capitalize', i < idx ? 'bg-brand-100 text-brand-800' : i === idx ? 'bg-brand-700 text-white' : 'bg-ink-100 text-ink-400')}>{s}</span>{i < SO_FLOW.length - 1 && <span className="text-ink-300">→</span>}</li>)}</ol>
          {o.backorderQty > 0 && o.status !== 'draft' && <p className="mt-2 text-xs text-amber-700">{qty(o.backorderQty)} unit(s) are not yet reserved (back-ordered). They will be reserved when stock is available — use “Retry reservation”.</p>}
        </Card>
      )}
      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          <Card>
            <CardHeader title="Lines" />
            <Table rows={o.lines} columns={[
              { key: 'p', header: 'Product', cell: (l: any) => <div><div className="font-medium">{l.productName}</div><div className="text-xs text-ink-500">{l.sku} · {qty(l.availableNow)} available now</div></div> },
              { key: 'q', header: 'Ordered', align: 'right', cell: (l: any) => qty(l.quantity) },
              { key: 'r', header: 'Reserved', align: 'right', cell: (l: any) => <span className={cn('num', l.reservedQty < l.quantity && 'text-amber-700')}>{qty(l.reservedQty)}</span> },
              { key: 'pk', header: 'Picked', align: 'right', cell: (l: any) => qty(l.pickedQty) },
              { key: 's', header: 'Shipped', align: 'right', cell: (l: any) => qty(l.shippedQty) },
              { key: 'pr', header: 'Price', align: 'right', hideOnMobile: true, cell: (l: any) => money(l.unitPrice) },
              { key: 't', header: 'Total', align: 'right', cell: (l: any) => <span className="num font-medium">{money(l.lineTotal)}</span> },
            ]} footer={<tr><td colSpan={6} className="px-4 py-2 text-right text-sm">Subtotal {money(o.subtotal)} · Tax {money(o.taxTotal)}</td><td className="px-4 py-2 text-right">{money(o.total)}</td></tr>} />
          </Card>
          <Card>
            <CardHeader title="Pick tasks" description="Created automatically from reservations, FEFO by batch expiry." />
            <Table rows={o.pickTasks} dense empty={<div className="p-5 text-sm text-ink-500">No pick tasks yet — confirm the order to reserve stock.</div>} columns={[
              { key: 'n', header: 'Task', cell: (t: any) => t.number }, { key: 's', header: 'SKU', cell: (t: any) => t.sku },
              { key: 'l', header: 'Location', cell: (t: any) => <span className="font-mono text-xs">{t.locationCode}</span> }, { key: 'b', header: 'Batch', cell: (t: any) => t.batchNo ?? '—' },
              { key: 'q', header: 'Qty', align: 'right', cell: (t: any) => `${qty(t.pickedQty)} / ${qty(t.quantity)}` }, { key: 'st', header: 'Status', cell: (t: any) => <StatusBadge status={t.status} /> },
              { key: 'by', header: 'Picked by', hideOnMobile: true, cell: (t: any) => t.pickedBy ? `${t.pickedBy} · ${dateTime(t.pickedAt)}` : '—' },
            ]} />
          </Card>
        </div>
        <div className="space-y-4">
          <Card className="p-5"><KeyValue cols={2} items={[['Order date', date(o.orderDate)], ['Required', date(o.requiredDate)], ['Customer phone', o.customer?.phone || '—'], ['Payment terms', `${o.customer?.paymentTermsDays ?? 30} days`], ['Packages', o.packageCount || '—'], ['Weight', o.totalWeightKg ? `${qty(o.totalWeightKg)} kg` : '—']]} /><p className="mt-3 text-xs text-ink-600"><b>Deliver to:</b> {o.shippingAddress || '—'}</p>{o.notes && <p className="mt-2 whitespace-pre-line text-xs text-ink-500">{o.notes}</p>}</Card>
          {shipment && <Card className="p-5"><div className="mb-2 flex items-center justify-between"><h3 className="text-sm font-semibold">Shipment {shipment.number}</h3><StatusBadge status={shipment.status} /></div><KeyValue cols={2} items={[['Carrier', shipment.carrier || '—'], ['Tracking', shipment.trackingNumber || '—'], ['Vehicle', shipment.vehicleNo || '—'], ['Driver', shipment.driverName || '—'], ['Dispatched', dateTime(shipment.dispatchedAt)], ['Delivered', dateTime(shipment.deliveredAt)]]} /><div className="mt-3 flex gap-2"><Link to={`/print/shipping-label/${o.id}`} target="_blank"><Button size="sm"><Printer /> Shipping labels</Button></Link><Link to={`/dispatch?shipment=${shipment.id}`}><Button size="sm">Track</Button></Link></div></Card>}
          {o.invoices?.length > 0 && <Card><CardHeader title="Invoices" />{o.invoices.map((i: any) => <Link key={i.id} to={`/billing/invoices/${i.id}`} className="flex items-center justify-between border-b border-ink-100 px-5 py-2.5 text-sm last:border-0 hover:bg-ink-50"><span className="font-medium">{i.number}</span><span className="flex items-center gap-2"><span className="num">{money(i.total)}</span><StatusBadge status={i.status} /></span></Link>)}</Card>}
        </div>
      </div>
      <ConfirmDialog open={cancel} onOpenChange={setCancel} title={`Cancel ${o.number}?`} description="Reserved stock is released back to available. Picked items return to available at the dispatch dock." tone="danger" confirmLabel="Cancel order" reason={{ label: 'Reason', required: true, placeholder: 'e.g. Customer cancelled by phone' }} onConfirm={(reason) => act.mutateAsync({ action: 'cancel', body: { reason } })} />
    </div>
  );
}
