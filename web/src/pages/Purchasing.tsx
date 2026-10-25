import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Ban, CheckCircle2, PackagePlus, Plus, Printer, Send, ShoppingCart, Sparkles } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn, date, money, qty, today } from '@/lib/utils';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, Input, Progress, Select, Skeleton, StatusBadge, Textarea } from '@/components/ui/core';
import { ConfirmDialog } from '@/components/ui/overlay';
import { EntityPicker, KeyValue, PageHeader } from '@/components/ui/blocks';
import { SearchInput, Table, useServerList } from '@/components/ui/table';
import { LineEditor, newLine, type EditorLine } from '@/components/LineEditor';
import { useWarehouses } from './Inventory';

const PO_FLOW = ['draft', 'submitted', 'approved', 'partially_received', 'fully_received', 'closed'];

export function Purchasing() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [status, setStatus] = useState('');
  const list = useServerList<any>('/purchase-orders', { status: status || undefined });
  return (
    <div>
      <PageHeader title="Purchase orders" description="Draft → Submitted → Approved → Partially / Fully received → Closed. Large orders route to the owner for approval."
        actions={<>{can('ai.use') && <Link to="/ai?tab=reorder"><Button><Sparkles /> Smart reorder</Button></Link>}{can('purchase.manage') && <Link to="/purchasing/new"><Button variant="primary"><Plus /> New purchase order</Button></Link>}</>} />
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-ink-100 p-3">
          <SearchInput value={list.q} onChange={list.setQ} placeholder="PO number or supplier" className="w-full sm:w-72" />
          <div className="flex flex-wrap gap-1">{[['', 'All'], ['draft', 'Draft'], ['submitted', 'Awaiting approval'], ['approved,partially_received', 'To receive'], ['fully_received,closed', 'Received'], ['cancelled', 'Cancelled']].map(([v, l]) => <button key={v} onClick={() => setStatus(v)} className={cn('rounded-full px-3 py-1 text-xs font-medium', status === v ? 'bg-brand-700 text-white' : 'bg-ink-100 text-ink-600 hover:bg-ink-200')}>{l}</button>)}</div>
        </div>
        <Table rows={list.rows} loading={list.loading} error={list.error} onRetry={list.refetch} sort={list.sort} onSort={list.onSort} onRowClick={(r) => navigate(`/purchasing/${r.id}`)}
          empty={<EmptyState icon={ShoppingCart} title="No purchase orders yet" action={can('purchase.manage') && <Link to="/purchasing/new"><Button variant="primary">Create purchase order</Button></Link>} />}
          columns={[
            { key: 'number', header: 'PO', sortKey: 'number', cell: (r) => <div><div className="font-medium text-ink-900">{r.number}</div><div className="text-xs text-ink-500">{date(r.orderDate)}{r.source !== 'manual' && <Badge tone="violet" className="ml-1">{r.source === 'ai_reorder' ? 'Smart reorder' : r.source}</Badge>}</div></div> },
            { key: 'supplier', header: 'Supplier', sortKey: 'supplier', cell: (r) => r.supplierName },
            { key: 'wh', header: 'Warehouse', hideOnMobile: true, cell: (r) => r.warehouseCode },
            { key: 'expected', header: 'Expected', sortKey: 'expected', cell: (r) => <span className={cn(r.overdue && 'font-medium text-red-600')}>{date(r.expectedDate)}{r.overdue ? ' · late' : ''}</span> },
            { key: 'progress', header: 'Received', hideOnMobile: true, cell: (r) => <div className="w-32"><Progress value={r.orderedQty ? (r.receivedQty / r.orderedQty) * 100 : 0} tone="brand" /><div className="mt-1 text-xs text-ink-500">{qty(r.receivedQty, 0)} / {qty(r.orderedQty, 0)}</div></div> },
            { key: 'total', header: 'Total', align: 'right', sortKey: 'total', cell: (r) => <span className="num font-medium">{money(r.total)}</span> },
            { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
          ]} />
        {list.pagination}
      </Card>
    </div>
  );
}

export function PurchaseOrderForm() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const warehouses = useWarehouses();
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [warehouseId, setWarehouseId] = useState('');
  const [expectedDate, setExpectedDate] = useState(today(7));
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<EditorLine[]>([newLine()]);
  const valid = supplierId && warehouseId && lines.every((l) => l.productId && l.quantity > 0);
  const save = useMutation({
    mutationFn: async (submit: boolean) => {
      const po = await api.post<any>('/purchase-orders', { supplierId, warehouseId, expectedDate, notes, lines: lines.map((l) => ({ productId: l.productId, quantity: l.quantity, unitCost: l.price, discountPct: l.discountPct })) });
      const result = submit ? await api.post<any>(`/purchase-orders/${po.id}/submit`) : null;
      return { po, result };
    },
    onSuccess: ({ po, result }) => {
      toast.success(result ? (result.approvalRequired ? `${po.number} submitted — waiting for ${result.approverRole.replace('_', ' ')} approval` : `${po.number} submitted${result.status === 'approved' ? ' and approved' : ''}`) : `${po.number} saved as draft`);
      qc.invalidateQueries({ queryKey: ['/purchase-orders'] });
      navigate(`/purchasing/${po.id}`);
    },
  });
  return (
    <div>
      <PageHeader back={{ to: '/purchasing', label: 'Purchase orders' }} title="New purchase order" />
      <div className="grid gap-6 xl:grid-cols-[320px_1fr]">
        <Card className="h-fit space-y-4 p-5">
          <Field label="Supplier" required><EntityPicker value={supplierId} onChange={setSupplierId} endpoint="/suppliers" map={(s) => ({ id: s.id, label: s.name, sub: `${s.city ?? ''} · lead time ${s.leadTimeDays ?? '?'} days` })} /></Field>
          <Field label="Deliver to warehouse" required><Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}><option value="">Select…</option>{warehouses.data?.map((w) => <option key={w.id} value={w.id}>{w.code} · {w.name}</option>)}</Select></Field>
          <Field label="Expected delivery"><Input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} /></Field>
          <Field label="Notes to supplier"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        </Card>
        <Card>
          <CardHeader title="Products" description="Unit cost defaults to the product's current average cost." />
          <LineEditor lines={lines} onChange={setLines} priceField="costPrice" priceLabel="Unit cost" />
          <div className="flex justify-end gap-2 border-t border-ink-100 px-4 py-3">
            <Button loading={save.isPending} disabled={!valid} onClick={() => save.mutate(false)}>Save draft</Button>
            <Button variant="primary" loading={save.isPending} disabled={!valid} onClick={() => save.mutate(true)}><Send /> Save & submit</Button>
          </div>
        </Card>
      </div>
    </div>
  );
}

export function PurchaseOrderDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<'cancel' | 'close' | null>(null);
  const { data: po, isLoading, error, refetch } = useQuery({ queryKey: ['po', id], queryFn: () => api.get<any>(`/purchase-orders/${id}`) });
  const act = useMutation({
    mutationFn: ({ action, body }: { action: string; body?: unknown }) => api.post<any>(`/purchase-orders/${id}/${action}`, body ?? {}),
    onSuccess: (r, v) => { toast.success(v.action === 'submit' && r.approvalRequired ? `Submitted — waiting for ${r.approverRole.replace('_', ' ')} approval` : 'Purchase order updated'); qc.invalidateQueries(); },
  });
  if (error) return <Card><ErrorState error={error} onRetry={refetch} /></Card>;
  if (isLoading || !po) return <Skeleton className="h-96" />;
  const stepIdx = PO_FLOW.indexOf(po.status);
  return (
    <div>
      <PageHeader back={{ to: '/purchasing', label: 'Purchase orders' }} title={po.number} description={`${po.supplier?.name} · deliver to ${po.warehouse?.name}`}
        actions={<>
          <Link to={`/print/po/${po.id}`} target="_blank"><Button><Printer /> Print</Button></Link>
          {po.status === 'draft' && can('purchase.manage') && <Button variant="primary" loading={act.isPending} onClick={() => act.mutate({ action: 'submit' })}><Send /> Submit</Button>}
          {po.status === 'submitted' && !po.approvalRequestId && can('purchase.approve') && <Button variant="primary" loading={act.isPending} onClick={() => act.mutate({ action: 'approve' })}><CheckCircle2 /> Approve</Button>}
          {po.status === 'submitted' && po.approvalRequestId && <Link to="/approvals"><Button>View approval</Button></Link>}
          {['approved', 'partially_received'].includes(po.status) && can('receiving.execute') && <Link to={`/receiving/new?po=${po.id}`}><Button variant="primary"><PackagePlus /> Receive goods</Button></Link>}
          {['approved', 'partially_received', 'fully_received'].includes(po.status) && can('purchase.manage') && <Button onClick={() => setConfirm('close')}>Close PO</Button>}
          {['draft', 'submitted', 'approved'].includes(po.status) && can('purchase.manage') && <Button variant="ghost" className="text-red-600" onClick={() => setConfirm('cancel')}><Ban /> Cancel</Button>}
        </>} />
      {po.status !== 'cancelled' && (
        <Card className="mb-4 px-5 py-4">
          <ol className="flex flex-wrap items-center gap-2 text-xs">
            {PO_FLOW.map((s, i) => <li key={s} className="flex items-center gap-2"><span className={cn('rounded-full px-2.5 py-1 font-medium', i < stepIdx ? 'bg-brand-100 text-brand-800' : i === stepIdx ? 'bg-brand-700 text-white' : 'bg-ink-100 text-ink-400')}>{s.replace('_', ' ')}</span>{i < PO_FLOW.length - 1 && <span className="text-ink-300">→</span>}</li>)}
          </ol>
          {po.approval && <p className="mt-2 text-xs text-ink-600">Approval: <StatusBadge status={po.approval.status} /> by {po.approval.approverRoleKey.replace('_', ' ')} {po.approval.comment ? `· “${po.approval.comment}”` : ''}</p>}
        </Card>
      )}
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader title="Lines" />
          <Table rows={po.lines} columns={[
            { key: 'p', header: 'Product', cell: (l: any) => <div><div className="font-medium">{l.productName}</div><div className="text-xs text-ink-500">{l.sku}</div></div> },
            { key: 'q', header: 'Ordered', align: 'right', cell: (l: any) => qty(l.quantity) },
            { key: 'r', header: 'Received', align: 'right', cell: (l: any) => <span className={cn('num font-medium', l.receivedQty >= l.quantity ? 'text-emerald-700' : l.receivedQty > 0 ? 'text-amber-700' : '')}>{qty(l.receivedQty)}</span> },
            { key: 'd', header: 'Damaged', align: 'right', hideOnMobile: true, cell: (l: any) => l.damagedQty ? qty(l.damagedQty) : '—' },
            { key: 'c', header: 'Unit cost', align: 'right', cell: (l: any) => money(l.unitCost) },
            { key: 't', header: 'Tax', align: 'right', hideOnMobile: true, cell: (l: any) => `${l.taxRate}%` },
            { key: 'lt', header: 'Total', align: 'right', cell: (l: any) => <span className="num font-medium">{money(l.lineTotal)}</span> },
          ]} footer={<tr><td colSpan={6} className="px-4 py-2 text-right text-sm">Subtotal {money(po.subtotal)} · Tax {money(po.taxTotal)}</td><td className="px-4 py-2 text-right text-sm">{money(po.total)}</td></tr>} />
        </Card>
        <div className="space-y-4">
          <Card className="p-5"><KeyValue cols={2} items={[['Order date', date(po.orderDate)], ['Expected', date(po.expectedDate)], ['Currency', po.currency], ['Source', po.source.replace('_', ' ')], ['Supplier phone', po.supplier?.phone || '—'], ['Supplier NTN', po.supplier?.ntn || '—']]} />{po.notes && <p className="mt-3 whitespace-pre-line text-xs text-ink-600">{po.notes}</p>}</Card>
          <Card><CardHeader title="Goods receipts" />{po.receipts.length ? po.receipts.map((g: any) => <Link key={g.id} to={`/receiving/${g.id}`} className="flex justify-between border-b border-ink-100 px-5 py-2.5 text-sm last:border-0 hover:bg-ink-50"><span className="font-medium">{g.number}</span><span className="text-ink-500">{date(g.receivedAt)}</span></Link>) : <p className="px-5 py-4 text-sm text-ink-500">Nothing received yet.</p>}</Card>
        </div>
      </div>
      <ConfirmDialog open={confirm === 'cancel'} onOpenChange={() => setConfirm(null)} title={`Cancel ${po.number}?`} tone="danger" confirmLabel="Cancel PO" reason={{ label: 'Reason', required: true }} onConfirm={(reason) => act.mutateAsync({ action: 'cancel', body: { reason } })} />
      <ConfirmDialog open={confirm === 'close'} onOpenChange={() => setConfirm(null)} title={`Close ${po.number}?`} description="Remaining quantities will not be received. The supplier bill reflects what was received." confirmLabel="Close PO" onConfirm={() => act.mutateAsync({ action: 'close' })} />
    </div>
  );
}
