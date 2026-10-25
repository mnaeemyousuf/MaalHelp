import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Calculator, FileText, HandCoins, Plus, Printer, Receipt, Wallet } from 'lucide-react';
import { EXPENSE_CATEGORIES, PAYMENT_METHODS, STORAGE_BASES, STORAGE_CHARGE_TYPES } from '@shared/domain';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn, date, humanize, money, pct, qty, today } from '@/lib/utils';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, Input, Select, Skeleton, StatusBadge, Textarea } from '@/components/ui/core';
import { Dialog, Tabs } from '@/components/ui/overlay';
import { EntityPicker, KeyValue, PageHeader, StatCard } from '@/components/ui/blocks';
import { SearchInput, Table, useServerList } from '@/components/ui/table';
import { useWarehouses } from './Inventory';

function PaymentDialog({ doc, kind, onClose }: { doc: any; kind: 'invoice' | 'bill'; onClose: () => void }) {
  const qc = useQueryClient();
  const balance = doc.balance ?? doc.total - doc.amountPaid;
  const [f, setF] = useState({ amount: balance, method: 'bank_transfer', bank: '', reference: '', paidAt: today(), notes: '' });
  const m = useMutation({ mutationFn: () => api.post('/payments', { ...(kind === 'invoice' ? { invoiceId: doc.id } : { billId: doc.id }), ...f }, { idempotencyKey: crypto.randomUUID() }), onSuccess: () => { toast.success('Payment recorded'); qc.invalidateQueries(); onClose(); } });
  return (
    <Dialog open onOpenChange={onClose} title={`${kind === 'invoice' ? 'Receive payment for' : 'Pay'} ${doc.number}`} description={`Outstanding ${money(balance)}`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={!(f.amount > 0) || f.amount > balance + 0.01} onClick={() => m.mutate()}>Record payment</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Amount" required><Input type="number" min={0} max={balance} step="any" value={f.amount} onChange={(e) => setF({ ...f, amount: Number(e.target.value) })} /></Field>
        <Field label="Date"><Input type="date" value={f.paidAt} onChange={(e) => setF({ ...f, paidAt: e.target.value })} /></Field>
        <Field label="Method"><Select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>{PAYMENT_METHODS.map((m0) => <option key={m0} value={m0}>{({ raast: 'Raast', jazzcash: 'JazzCash', easypaisa: 'Easypaisa' } as Record<string, string>)[m0] ?? humanize(m0)}</option>)}</Select></Field>
        <Field label="Bank"><Input value={f.bank} onChange={(e) => setF({ ...f, bank: e.target.value })} placeholder="e.g. HBL, Meezan" /></Field>
        <Field label="Reference / cheque no." className="sm:col-span-2"><Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
      </div>
    </Dialog>
  );
}

export function Billing() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'invoices';
  return (
    <div>
      <PageHeader title="Billing" description="Customer invoices, supplier bills, payments and aging. Invoices are issued automatically at dispatch; bills on goods receipt." />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v })} tabs={[{ value: 'invoices', label: 'Invoices' }, { value: 'bills', label: 'Supplier bills' }, { value: 'payments', label: 'Payments' }, { value: 'aging', label: 'Aging' }]} />
      <div className="mt-4">{tab === 'invoices' ? <Invoices /> : tab === 'bills' ? <Bills /> : tab === 'payments' ? <Payments /> : <Aging />}</div>
    </div>
  );
}

function Invoices() {
  const { can } = useAuth();
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [pay, setPay] = useState<any>(null);
  const list = useServerList<any>('/invoices', { status: status === 'overdue' ? undefined : status || undefined, overdue: status === 'overdue' || undefined, type: type || undefined });
  return (
    <Card>
      <div className="flex flex-wrap gap-2 border-b border-ink-100 p-3">
        <SearchInput value={list.q} onChange={list.setQ} placeholder="Invoice, order or customer" className="w-full sm:w-64" />
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-44"><option value="">All statuses</option><option value="issued,partially_paid">Unpaid</option><option value="overdue">Overdue</option><option value="paid">Paid</option><option value="void">Void</option></Select>
        <Select value={type} onChange={(e) => setType(e.target.value)} className="w-40"><option value="">All types</option><option value="sales">Sales</option><option value="storage">Storage</option><option value="credit_note">Credit notes</option></Select>
      </div>
      <Table rows={list.rows} loading={list.loading} error={list.error} empty={<EmptyState icon={Receipt} title="No invoices" description="Invoices are created when orders are dispatched or storage is billed." />}
        columns={[
          { key: 'n', header: 'Invoice', cell: (r) => <Link to={`/billing/invoices/${r.id}`} className="block"><div className="font-medium hover:text-brand-700">{r.number}</div><div className="text-xs text-ink-500">{date(r.issueDate)}</div></Link> },
          { key: 'c', header: 'Customer', cell: (r) => <div><div className="text-sm">{r.customerName}</div><div className="text-xs text-ink-500">{r.orderNumber ?? humanize(r.type)}</div></div> },
          { key: 'due', header: 'Due', cell: (r) => <span className={cn(r.overdue && 'font-medium text-red-600')}>{date(r.dueDate)}{r.overdue ? ` · ${r.daysOverdue}d late` : ''}</span> },
          { key: 't', header: 'Total', align: 'right', cell: (r) => money(r.total) },
          { key: 'b', header: 'Balance', align: 'right', cell: (r) => <span className="num font-medium">{money(r.balance)}</span> },
          { key: 's', header: 'Status', cell: (r) => <StatusBadge status={r.overdue ? 'overdue' : r.status} /> },
          { key: 'a', header: '', align: 'right', cell: (r) => can('billing.manage') && ['issued', 'partially_paid'].includes(r.status) && r.total > 0 && <Button size="sm" onClick={() => setPay(r)}>Receive</Button> },
        ]} />
      {list.pagination}
      {pay && <PaymentDialog doc={pay} kind="invoice" onClose={() => setPay(null)} />}
    </Card>
  );
}

function Bills() {
  const { can } = useAuth();
  const [status, setStatus] = useState('open,partially_paid');
  const [pay, setPay] = useState<any>(null);
  const list = useServerList<any>('/supplier-bills', { status: status || undefined });
  return (
    <Card>
      <div className="flex flex-wrap gap-2 border-b border-ink-100 p-3">
        <SearchInput value={list.q} onChange={list.setQ} placeholder="Bill, PO or supplier" className="w-full sm:w-64" />
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-44"><option value="">All</option><option value="open,partially_paid">Unpaid</option><option value="paid">Paid</option></Select>
      </div>
      <Table rows={list.rows} loading={list.loading} error={list.error} empty={<EmptyState title="No supplier bills" description="Bills are generated automatically when goods are received against a PO." />}
        columns={[
          { key: 'n', header: 'Bill', cell: (r) => <div><div className="font-medium">{r.number}</div><div className="text-xs text-ink-500">{r.poNumber} · {r.grnNumber}</div></div> },
          { key: 's', header: 'Supplier', cell: (r) => r.supplierName },
          { key: 'due', header: 'Due', cell: (r) => <span className={cn(r.overdue && 'font-medium text-red-600')}>{date(r.dueDate)}</span> },
          { key: 't', header: 'Total', align: 'right', cell: (r) => money(r.total) },
          { key: 'b', header: 'Balance', align: 'right', cell: (r) => <span className="num font-medium">{money(r.balance)}</span> },
          { key: 'st', header: 'Status', cell: (r) => <StatusBadge status={r.overdue ? 'overdue' : r.status} /> },
          { key: 'a', header: '', align: 'right', cell: (r) => can('billing.manage') && ['open', 'partially_paid'].includes(r.status) && <Button size="sm" onClick={() => setPay(r)}>Pay</Button> },
        ]} />
      {list.pagination}
      {pay && <PaymentDialog doc={pay} kind="bill" onClose={() => setPay(null)} />}
    </Card>
  );
}

function Payments() {
  const [direction, setDirection] = useState('');
  const list = useServerList<any>('/payments', { direction: direction || undefined });
  return (
    <Card>
      <div className="border-b border-ink-100 p-3"><Select value={direction} onChange={(e) => setDirection(e.target.value)} className="w-48"><option value="">Money in & out</option><option value="in">Received from customers</option><option value="out">Paid to suppliers</option></Select></div>
      <Table rows={list.rows} loading={list.loading} error={list.error} empty={<EmptyState icon={Wallet} title="No payments recorded" />}
        columns={[
          { key: 'n', header: 'Payment', cell: (r) => <div><div className="font-medium">{r.number}</div><div className="text-xs text-ink-500">{date(r.paidAt)}</div></div> },
          { key: 'd', header: 'Direction', cell: (r) => <Badge tone={r.direction === 'in' ? 'green' : 'gray'}>{r.direction === 'in' ? 'Received' : 'Paid'}</Badge> },
          { key: 'p', header: 'Party', cell: (r) => r.partyName }, { key: 'doc', header: 'Document', cell: (r) => r.documentNumber },
          { key: 'm', header: 'Method', hideOnMobile: true, cell: (r) => `${humanize(r.method)}${r.bank ? ` · ${r.bank}` : ''}` }, { key: 'ref', header: 'Reference', hideOnMobile: true, cell: (r) => r.reference || '—' },
          { key: 'a', header: 'Amount', align: 'right', cell: (r) => <span className="num font-semibold">{money(r.amount)}</span> },
        ]} />
      {list.pagination}
    </Card>
  );
}

function Aging() {
  const { data, isLoading } = useQuery({ queryKey: ['aging'], queryFn: () => api.get<any>('/payments/aging') });
  if (isLoading || !data) return <Skeleton className="h-80" />;
  const cols = (link: string) => [
    { key: 'name', header: 'Name', cell: (r: any) => <Link to={`/${link}/${r.id}`} className="font-medium hover:text-brand-700">{r.name}</Link> },
    ...['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'].map((k) => ({ key: k, header: ({ current: 'Not due', d1_30: '1–30', d31_60: '31–60', d61_90: '61–90', d90_plus: '90+' } as Record<string, string>)[k], align: 'right' as const, cell: (r: any) => r[k] ? <span className={cn('num', k === 'd90_plus' && 'font-semibold text-red-600', k === 'd61_90' && 'text-amber-700')}>{money(r[k])}</span> : <span className="text-ink-300">—</span> })),
    { key: 'total', header: 'Total', align: 'right' as const, cell: (r: any) => <b className="num">{money(r.total)}</b> },
  ];
  return (
    <div className="space-y-4">
      <Card><CardHeader title="Receivables aging" description="What customers owe, by days past due" /><Table rows={data.receivables} columns={cols('customers')} empty={<div className="p-6 text-center text-sm text-ink-500">No outstanding receivables.</div>} /></Card>
      <Card><CardHeader title="Payables aging" description="What you owe suppliers" /><Table rows={data.payables} columns={cols('suppliers')} empty={<div className="p-6 text-center text-sm text-ink-500">No outstanding payables.</div>} /></Card>
    </div>
  );
}

export function InvoiceDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const [pay, setPay] = useState(false);
  const { data: inv, isLoading, error } = useQuery({ queryKey: ['invoice', id], queryFn: () => api.get<any>(`/invoices/${id}`) });
  if (error) return <Card><ErrorState error={error} /></Card>;
  if (isLoading || !inv) return <Skeleton className="h-96" />;
  return (
    <div>
      <PageHeader back={{ to: '/billing', label: 'Billing' }} title={<span className="flex items-center gap-2">{inv.number}<StatusBadge status={inv.status} /><Badge>{humanize(inv.type)}</Badge></span>} description={`${inv.customer?.name} · issued ${date(inv.issueDate)} · due ${date(inv.dueDate)}`}
        actions={<><Link to={`/print/invoice/${inv.id}`} target="_blank"><Button><Printer /> Print invoice</Button></Link>{can('billing.manage') && ['issued', 'partially_paid'].includes(inv.status) && inv.total > 0 && <Button variant="primary" onClick={() => setPay(true)}>Receive payment</Button>}</>} />
      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <Card><Table rows={inv.lines} columns={[{ key: 'd', header: 'Description', cell: (l: any) => l.description }, { key: 'q', header: 'Qty', align: 'right', cell: (l: any) => qty(l.quantity) }, { key: 'p', header: 'Price', align: 'right', cell: (l: any) => money(l.unitPrice) }, { key: 't', header: 'Tax', align: 'right', cell: (l: any) => `${l.taxRate}% · ${money(l.taxAmount)}` }, { key: 'lt', header: 'Total', align: 'right', cell: (l: any) => <b className="num">{money(l.lineTotal)}</b> }]}
          footer={<tr><td colSpan={4} className="px-4 py-2 text-right text-sm">Subtotal {money(inv.subtotal)} · Tax {money(inv.taxTotal)}</td><td className="px-4 py-2 text-right">{money(inv.total)}</td></tr>} /></Card>
        <div className="space-y-4">
          <Card className="p-5"><KeyValue cols={2} items={[['Total', money(inv.total)], ['Paid', money(inv.amountPaid)], ['Balance', money(inv.total - inv.amountPaid)], ['Currency', inv.currency], ...(inv.periodStart ? [['Period', `${date(inv.periodStart)} – ${date(inv.periodEnd)}`] as [string, string]] : [])]} />{inv.notes && <p className="mt-3 text-xs text-ink-600">{inv.notes}</p>}</Card>
          <Card><CardHeader title="Payments" />{inv.payments.length ? inv.payments.map((p: any) => <div key={p.id} className="flex justify-between border-b border-ink-100 px-5 py-2.5 text-sm last:border-0"><span>{p.number} · {date(p.paidAt)}</span><b className="num">{money(p.amount)}</b></div>) : <p className="px-5 py-4 text-sm text-ink-500">No payments yet.</p>}</Card>
        </div>
      </div>
      {pay && <PaymentDialog doc={inv} kind="invoice" onClose={() => setPay(false)} />}
    </div>
  );
}

export function StorageBilling() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [create, setCreate] = useState(false);
  const [preview, setPreview] = useState<any>(null);
  const contracts = useQuery({ queryKey: ['contracts'], queryFn: () => api.get<any[]>('/storage-billing/contracts') });
  return (
    <div>
      <PageHeader title="Storage billing" description="Rent warehouse space to clients. Charges are calculated from the immutable ledger: pallets, boxes, m³, bins, kg or area per day, plus handling fees." actions={can('billing.manage') && <Button variant="primary" onClick={() => setCreate(true)}><Plus /> New contract</Button>} />
      {contracts.isLoading ? <Skeleton className="h-64" /> : !contracts.data?.length ? <Card><EmptyState icon={HandCoins} title="No storage contracts" description="Create a contract for a client who stores goods with you. Receive their goods as customer-owned stock." action={can('billing.manage') && <Button variant="primary" onClick={() => setCreate(true)}>Create contract</Button>} /></Card> : (
        <div className="grid gap-4 lg:grid-cols-2">
          {contracts.data.map((c) => (
            <Card key={c.id}>
              <CardHeader title={`${c.customer_name}`} description={`${c.number} · ${c.warehouse_code ?? 'all warehouses'} · since ${date(c.start_date)}`} actions={<StatusBadge status={c.status} />} />
              <div className="space-y-3 p-5">
                <KeyValue cols={3} items={[['Units stored now', qty(c.units_stored, 0)], ['Minimum / month', money(c.minimum_monthly_charge)], ['Billed up to', date(c.last_billed_to)]]} />
                <div className="rounded-lg border border-ink-100">
                  {c.rates.map((r: any) => <div key={r.id} className="flex items-center justify-between border-b border-ink-100 px-3 py-2 text-sm last:border-0"><span>{humanize(r.chargeType)} <span className="text-xs text-ink-500">· {humanize(r.basis)}{r.contractedQty ? ` × ${r.contractedQty}` : ''}</span></span><b className="num">{money(r.rate)}</b></div>)}
                </div>
                <Button size="sm" onClick={() => setPreview(c)}><Calculator /> Preview & invoice a period</Button>
              </div>
            </Card>
          ))}
        </div>
      )}
      {create && <ContractForm onClose={() => setCreate(false)} />}
      {preview && <StoragePreview contract={preview} onClose={() => { setPreview(null); qc.invalidateQueries({ queryKey: ['contracts'] }); }} />}
    </div>
  );
}

function ContractForm({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const warehouses = useWarehouses();
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [warehouseId, setWarehouseId] = useState('');
  const [startDate, setStartDate] = useState(today());
  const [minimum, setMinimum] = useState(0);
  const [rates, setRates] = useState([{ chargeType: 'storage', basis: 'pallet_day', rate: 50, contractedQty: 0, description: 'Pallet storage' }, { chargeType: 'inbound_handling', basis: 'per_unit', rate: 10, contractedQty: 0, description: '' }, { chargeType: 'outbound_handling', basis: 'per_unit', rate: 10, contractedQty: 0, description: '' }]);
  const m = useMutation({ mutationFn: () => api.post('/storage-billing/contracts', { customerId, warehouseId: warehouseId || null, startDate, minimumMonthlyCharge: minimum, rates }), onSuccess: () => { toast.success('Contract created'); qc.invalidateQueries({ queryKey: ['contracts'] }); onClose(); } });
  return (
    <Dialog open onOpenChange={onClose} title="New storage contract" size="xl" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={!customerId || !rates.length} onClick={() => m.mutate()}>Create contract</Button></>}>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-4">
          <Field label="Client" required className="sm:col-span-2"><EntityPicker value={customerId} onChange={setCustomerId} endpoint="/customers" map={(c) => ({ id: c.id, label: c.name, sub: c.code })} /></Field>
          <Field label="Warehouse"><Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}><option value="">Any</option>{warehouses.data?.map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}</Select></Field>
          <Field label="Start date"><Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></Field>
          <Field label="Minimum monthly charge"><Input type="number" min={0} value={minimum} onChange={(e) => setMinimum(Number(e.target.value))} /></Field>
        </div>
        <div className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">Rates</div>
          {rates.map((r, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_110px_110px_1fr]">
              <Select value={r.chargeType} onChange={(e) => setRates(rates.map((x, j) => (j === i ? { ...x, chargeType: e.target.value } : x)))}>{STORAGE_CHARGE_TYPES.map((t) => <option key={t} value={t}>{humanize(t)}</option>)}</Select>
              <Select value={r.basis} onChange={(e) => setRates(rates.map((x, j) => (j === i ? { ...x, basis: e.target.value } : x)))}>{STORAGE_BASES.map((b) => <option key={b} value={b}>{humanize(b)}</option>)}</Select>
              <Input type="number" min={0} value={r.rate} onChange={(e) => setRates(rates.map((x, j) => (j === i ? { ...x, rate: Number(e.target.value) } : x)))} aria-label="Rate" />
              <Input type="number" min={0} value={r.contractedQty} disabled={!['sqm_month', 'sqft_month', 'fixed_month'].includes(r.basis)} onChange={(e) => setRates(rates.map((x, j) => (j === i ? { ...x, contractedQty: Number(e.target.value) } : x)))} aria-label="Contracted quantity" placeholder="Area/qty" />
              <div className="flex gap-1"><Input value={r.description} onChange={(e) => setRates(rates.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} placeholder="Label on invoice" /><Button size="icon" variant="ghost" onClick={() => setRates(rates.filter((_, j) => j !== i))} aria-label="Remove">×</Button></div>
            </div>
          ))}
          <Button size="sm" onClick={() => setRates([...rates, { chargeType: 'picking', basis: 'per_transaction', rate: 100, contractedQty: 0, description: '' }])}><Plus /> Add rate</Button>
          <p className="text-xs text-ink-500">Per-day bases (pallet, box, m³, bin, kg, unit) are averaged from the client's daily stock in the ledger. Area and fixed bases use the contracted quantity per month.</p>
        </div>
      </div>
    </Dialog>
  );
}

function StoragePreview({ contract, onClose }: { contract: any; onClose: () => void }) {
  const [periodStart, setStart] = useState(today(-30));
  const [periodEnd, setEnd] = useState(today(-1));
  const { can } = useAuth();
  const preview = useQuery({ queryKey: ['storage-preview', contract.id, periodStart, periodEnd], queryFn: () => api.get<any>(`/storage-billing/contracts/${contract.id}/preview`, { periodStart, periodEnd }) });
  const m = useMutation({ mutationFn: () => api.post<any>(`/storage-billing/contracts/${contract.id}/invoice`, { periodStart, periodEnd }), onSuccess: (r) => { toast.success(`Invoice ${r.invoice.number} issued for ${money(r.invoice.total)}`); onClose(); } });
  return (
    <Dialog open onOpenChange={onClose} title={`Storage charges · ${contract.customer_name}`} size="lg" footer={<><Button onClick={onClose}>Close</Button>{can('billing.manage') && <Button variant="primary" loading={m.isPending} disabled={!preview.data?.total} onClick={() => m.mutate()}><FileText /> Issue invoice</Button>}</>}>
      <div className="mb-4 flex gap-3"><Field label="From"><Input type="date" value={periodStart} onChange={(e) => setStart(e.target.value)} /></Field><Field label="To"><Input type="date" value={periodEnd} onChange={(e) => setEnd(e.target.value)} /></Field></div>
      {preview.isLoading ? <Skeleton className="h-40" /> : preview.error ? <ErrorState error={preview.error} /> : (
        <>
          <Table rows={preview.data.charges} dense columns={[{ key: 'd', header: 'Charge', cell: (c: any) => c.description }, { key: 'q', header: 'Quantity', align: 'right', cell: (c: any) => qty(c.quantity) }, { key: 'r', header: 'Rate', align: 'right', cell: (c: any) => money(c.rate) }, { key: 'a', header: 'Amount', align: 'right', cell: (c: any) => <b className="num">{money(c.amount)}</b> }]} />
          <div className="mt-3 flex justify-between text-sm"><span className="text-ink-500">{preview.data.days} days · avg {qty(preview.data.averageUnits)} units stored · {preview.data.handling.inDocs} inbound / {preview.data.handling.outDocs} outbound documents</span><b className="num">{money(preview.data.total)} + tax</b></div>
        </>
      )}
    </Dialog>
  );
}

export function Expenses() {
  const { can } = useAuth();
  const warehouses = useWarehouses();
  const [warehouseId, setWarehouseId] = useState('');
  const [category, setCategory] = useState('');
  const [create, setCreate] = useState(false);
  const list = useServerList<any>('/expenses', { warehouseId: warehouseId || undefined, category: category || undefined });
  return (
    <div>
      <PageHeader title="Expenses" description="Warehouse operating costs by warehouse, department and cost center. Large expenses route for owner approval." actions={can('expense.manage') && <Button variant="primary" onClick={() => setCreate(true)}><Plus /> Record expense</Button>} />
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-ink-100 p-3">
          <SearchInput value={list.q} onChange={list.setQ} placeholder="Vendor or note" className="w-full sm:w-60" />
          <Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className="w-40"><option value="">All warehouses</option>{warehouses.data?.map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}</Select>
          <Select value={category} onChange={(e) => setCategory(e.target.value)} className="w-44"><option value="">All categories</option>{EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{humanize(c)}</option>)}</Select>
          <span className="ml-auto text-sm text-ink-600">Filtered total <b className="num">{money(list.meta.filteredTotal ?? 0)}</b></span>
        </div>
        <Table rows={list.rows} loading={list.loading} error={list.error} empty={<EmptyState icon={Wallet} title="No expenses recorded" />}
          columns={[
            { key: 'd', header: 'Date', cell: (r) => <div><div>{date(r.expenseDate)}</div><div className="text-xs text-ink-500">{r.number}</div></div> },
            { key: 'c', header: 'Category', cell: (r) => <Badge>{humanize(r.category)}</Badge> }, { key: 'v', header: 'Vendor', cell: (r) => r.vendor || '—' },
            { key: 'w', header: 'Warehouse', cell: (r) => r.warehouseCode ?? 'Company' }, { key: 'cc', header: 'Cost center', hideOnMobile: true, cell: (r) => r.costCenter || '—' },
            { key: 'a', header: 'Amount', align: 'right', cell: (r) => <b className="num">{money(r.amount)}</b> }, { key: 's', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
          ]} />
        {list.pagination}
      </Card>
      {create && <ExpenseForm onClose={() => setCreate(false)} />}
    </div>
  );
}

function ExpenseForm({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const warehouses = useWarehouses();
  const [f, setF] = useState({ warehouseId: '', category: 'electricity', department: '', costCenter: '', vendor: '', amount: 0, taxAmount: 0, expenseDate: today(), paymentMethod: 'bank_transfer', reference: '', notes: '' });
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.type === 'number' ? Number(e.target.value) : e.target.value });
  const m = useMutation({ mutationFn: () => api.post<any>('/expenses', { ...f, warehouseId: f.warehouseId || null }, { idempotencyKey: crypto.randomUUID() }), onSuccess: (r) => { toast.success(r.status === 'pending_approval' ? 'Expense recorded — waiting for approval' : 'Expense recorded'); qc.invalidateQueries(); onClose(); } });
  return (
    <Dialog open onOpenChange={onClose} title="Record an expense" size="lg" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={!(f.amount > 0)} onClick={() => m.mutate()}>Save</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Category"><Select value={f.category} onChange={set('category')}>{EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{humanize(c)}</option>)}</Select></Field>
        <Field label="Warehouse"><Select value={f.warehouseId} onChange={set('warehouseId')}><option value="">Company-wide</option>{warehouses.data?.map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}</Select></Field>
        <Field label="Amount" required><Input type="number" min={0} value={f.amount} onChange={set('amount')} /></Field>
        <Field label="Date"><Input type="date" value={f.expenseDate} onChange={set('expenseDate')} /></Field>
        <Field label="Vendor / paid to"><Input value={f.vendor} onChange={set('vendor')} /></Field>
        <Field label="Payment method"><Select value={f.paymentMethod} onChange={set('paymentMethod')}>{PAYMENT_METHODS.map((m0) => <option key={m0} value={m0}>{humanize(m0)}</option>)}</Select></Field>
        <Field label="Department"><Input value={f.department} onChange={set('department')} /></Field>
        <Field label="Cost center"><Input value={f.costCenter} onChange={set('costCenter')} /></Field>
        <Field label="Notes" className="sm:col-span-2"><Textarea value={f.notes} onChange={set('notes')} /></Field>
      </div>
    </Dialog>
  );
}

export function Profitability() {
  const warehouses = useWarehouses();
  const [from, setFrom] = useState(today(-89));
  const [to, setTo] = useState(today());
  const [warehouseId, setWarehouseId] = useState('');
  const { data, isLoading, error } = useQuery({ queryKey: ['profit', from, to, warehouseId], queryFn: () => api.get<any>('/profitability', { from, to, warehouseId: warehouseId || undefined }) });
  return (
    <div>
      <PageHeader title="Profitability" description="Estimated management view: revenue from invoices, cost of goods from the ledger, operating costs from expenses and freight."
        actions={<><Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className="w-44"><option value="">Whole company</option>{warehouses.data?.map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}</Select><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-36" /><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-36" /></>} />
      {error ? <Card><ErrorState error={error} /></Card> : isLoading || !data ? <Skeleton className="h-96" /> : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <StatCard label="Revenue" value={money(data.revenue.total, { compact: true })} sub={`sales ${money(data.revenue.sales, { compact: true })} · storage ${money(data.revenue.storageAndHandling, { compact: true })}`} />
            <StatCard label="Cost of goods sold" value={money(data.costs.costOfGoodsSold, { compact: true })} />
            <StatCard label="Gross profit" value={money(data.grossProfit, { compact: true })} sub={data.grossMarginPct !== null ? `${pct(data.grossMarginPct)} margin` : undefined} tone="good" />
            <StatCard label="Operating costs" value={money(data.operatingCost, { compact: true })} sub={`labour ${money(data.costs.labor, { compact: true })} · transport ${money(data.costs.transportation, { compact: true })}`} />
            <StatCard label="Estimated net profit" value={money(data.netProfit, { compact: true })} sub={data.netMarginPct !== null ? `${pct(data.netMarginPct)} net margin` : undefined} tone={data.netProfit >= 0 ? 'good' : 'danger'} />
            <StatCard label="Purchases (billed)" value={money(data.costs.purchases, { compact: true })} sub="for reference — not in profit" />
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            {!warehouseId && <Card><CardHeader title="By warehouse" /><Table rows={data.byWarehouse} columns={[{ key: 'n', header: 'Warehouse', cell: (w: any) => w.name }, { key: 'r', header: 'Revenue', align: 'right', cell: (w: any) => money(w.revenue, { compact: true }) }, { key: 'c', header: 'COGS', align: 'right', cell: (w: any) => money(w.cogs, { compact: true }) }, { key: 'e', header: 'Expenses', align: 'right', cell: (w: any) => money(w.expenses, { compact: true }) }, { key: 'p', header: 'Net', align: 'right', cell: (w: any) => <b className={cn('num', w.netProfit < 0 && 'text-red-600')}>{money(w.netProfit, { compact: true })}</b> }, { key: 'm', header: 'Margin', align: 'right', cell: (w: any) => pct(w.marginPct) }]} /></Card>}
            <Card><CardHeader title="Expenses by category" />
              <div className="h-72 p-4"><ResponsiveContainer><BarChart data={data.expensesByCategory} layout="vertical" margin={{ left: 20 }}><CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e2e8f0" /><XAxis type="number" tickFormatter={(v) => money(v, { compact: true })} tick={{ fontSize: 11 }} /><YAxis type="category" dataKey="category" tickFormatter={humanize} tick={{ fontSize: 11 }} width={90} /><Tooltip formatter={(v) => money(v)} /><Bar dataKey="amount" fill="#2647d8" radius={[0, 4, 4, 0]} /></BarChart></ResponsiveContainer></div>
            </Card>
          </div>
          <p className="text-xs text-ink-500">{data.basis}</p>
        </div>
      )}
    </div>
  );
}
