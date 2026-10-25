import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Building2, Pencil, Plus, Users } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { date, money, pct, qty } from '@/lib/utils';
import { Badge, Button, Card, CardHeader, Checkbox, EmptyState, ErrorState, Field, Input, Skeleton, StatusBadge, Textarea, Select } from '@/components/ui/core';
import { Dialog, Tabs } from '@/components/ui/overlay';
import { KeyValue, PageHeader, StatCard } from '@/components/ui/blocks';
import { SearchInput, Table, useServerList } from '@/components/ui/table';

type Kind = 'customer' | 'supplier';

function PartyForm({ kind, party, onClose }: { kind: Kind; party?: any; onClose: () => void }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [f, setF] = useState<any>(party ?? { name: '', code: '', contactName: '', phone: '', email: '', address: '', city: '', ntn: '', strn: '', paymentTermsDays: 30, creditLimit: 0, leadTimeDays: 7, isStorageClient: false, notes: '', status: 'active' });
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.type === 'number' ? Number(e.target.value) : e.target.value });
  const path = kind === 'customer' ? '/customers' : '/suppliers';
  const m = useMutation({
    mutationFn: () => {
      const body: any = { name: f.name, code: f.code || undefined, contactName: f.contactName, phone: f.phone, email: f.email, address: f.address, city: f.city, ntn: f.ntn, strn: f.strn, paymentTermsDays: f.paymentTermsDays, notes: f.notes, status: f.status };
      if (kind === 'customer') { body.isStorageClient = f.isStorageClient; if (can('finance.view')) body.creditLimit = f.creditLimit; } else body.leadTimeDays = f.leadTimeDays;
      if (party) delete body.code;
      return party ? api.patch(`${path}/${party.id}`, body) : api.post(path, body);
    },
    onSuccess: () => { toast.success(`${kind === 'customer' ? 'Customer' : 'Supplier'} saved`); qc.invalidateQueries(); onClose(); },
  });
  return (
    <Dialog open onOpenChange={onClose} title={party ? `Edit ${party.name}` : `New ${kind}`} size="lg" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={!f.name} onClick={() => m.mutate()}>Save</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" required className="sm:col-span-2"><Input value={f.name} onChange={set('name')} /></Field>
        {!party && <Field label="Code" hint="Leave blank to auto-number"><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>}
        <Field label="Contact person"><Input value={f.contactName} onChange={set('contactName')} /></Field>
        <Field label="Phone" hint="+92 3xx xxxxxxx"><Input value={f.phone} onChange={set('phone')} /></Field>
        <Field label="Email"><Input type="email" value={f.email} onChange={set('email')} /></Field>
        <Field label="Address" className="sm:col-span-2"><Input value={f.address} onChange={set('address')} /></Field>
        <Field label="City"><Input value={f.city} onChange={set('city')} /></Field>
        <Field label="NTN"><Input value={f.ntn} onChange={set('ntn')} placeholder="1234567-8" /></Field>
        <Field label="STRN"><Input value={f.strn} onChange={set('strn')} /></Field>
        <Field label="Payment terms (days)"><Input type="number" min={0} value={f.paymentTermsDays} onChange={set('paymentTermsDays')} /></Field>
        {kind === 'customer' && can('finance.view') && <Field label="Credit limit" hint="0 = no limit"><Input type="number" min={0} value={f.creditLimit} onChange={set('creditLimit')} /></Field>}
        {kind === 'supplier' && <Field label="Lead time (days)" hint="Used by smart reorder"><Input type="number" min={0} value={f.leadTimeDays} onChange={set('leadTimeDays')} /></Field>}
        {party && <Field label="Status"><Select value={f.status} onChange={set('status')}><option value="active">Active</option><option value="inactive">Inactive</option>{kind === 'customer' ? <option value="on_hold">On hold</option> : <option value="blocked">Blocked</option>}</Select></Field>}
        {kind === 'customer' && <div className="sm:col-span-2"><Checkbox label="Storage client (3PL)" hint="This customer stores its own goods in your warehouse and is billed for storage." checked={f.isStorageClient} onChange={(v) => setF({ ...f, isStorageClient: v })} /></div>}
        <Field label="Notes" className="sm:col-span-2"><Textarea value={f.notes} onChange={set('notes')} /></Field>
      </div>
    </Dialog>
  );
}

export function Customers() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [create, setCreate] = useState(false);
  const list = useServerList<any>('/customers', {});
  return (
    <div>
      <PageHeader title="Customers" description="Buyers and storage clients, with balances and credit." actions={can('customer.manage') && <Button variant="primary" onClick={() => setCreate(true)}><Plus /> New customer</Button>} />
      <Card>
        <div className="border-b border-ink-100 p-3"><SearchInput value={list.q} onChange={list.setQ} placeholder="Name, code, phone or city" className="w-full sm:w-80" /></div>
        <Table rows={list.rows} loading={list.loading} error={list.error} sort={list.sort} onSort={list.onSort} onRowClick={(r) => navigate(`/customers/${r.id}`)}
          empty={<EmptyState icon={Users} title="No customers yet" action={can('customer.manage') && <Button variant="primary" onClick={() => setCreate(true)}>Add customer</Button>} />}
          columns={[
            { key: 'name', header: 'Customer', sortKey: 'name', cell: (r) => <div><div className="flex items-center gap-1.5 font-medium text-ink-900">{r.name}{r.isStorageClient && <Badge tone="violet">3PL</Badge>}</div><div className="text-xs text-ink-500">{r.code} · {r.city}</div></div> },
            { key: 'phone', header: 'Phone', hideOnMobile: true, cell: (r) => r.phone || '—' },
            { key: 'sales', header: 'Lifetime sales', align: 'right', sortKey: 'sales', hideOnMobile: true, cell: (r) => money(r.lifetimeSales, { compact: true }) },
            { key: 'out', header: 'Outstanding', align: 'right', sortKey: 'outstanding', cell: (r) => <span className="num font-medium">{money(r.outstanding)}</span> },
            { key: 'over', header: 'Overdue', align: 'right', sortKey: 'overdue', cell: (r) => r.overdue > 0 ? <span className="num font-medium text-red-600">{money(r.overdue)}</span> : <span className="text-ink-300">—</span> },
            { key: 'limit', header: 'Credit limit', align: 'right', hideOnMobile: true, cell: (r) => r.creditLimit ? money(r.creditLimit, { compact: true }) : '—' },
            { key: 'last', header: 'Last order', hideOnMobile: true, cell: (r) => date(r.lastOrderAt) },
          ]} />
        {list.pagination}
      </Card>
      {create && <PartyForm kind="customer" onClose={() => setCreate(false)} />}
    </div>
  );
}

export function CustomerDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const [tab, setTab] = useState('orders');
  const [edit, setEdit] = useState(false);
  const { data: c, isLoading, error } = useQuery({ queryKey: ['customer', id], queryFn: () => api.get<any>(`/customers/${id}`) });
  if (error) return <Card><ErrorState error={error} /></Card>;
  if (isLoading || !c) return <Skeleton className="h-96" />;
  return (
    <div>
      <PageHeader back={{ to: '/customers', label: 'Customers' }} title={<span className="flex items-center gap-2">{c.name}<StatusBadge status={c.status} />{c.isStorageClient && <Badge tone="violet">Storage client</Badge>}</span>} description={`${c.code} · ${c.city} · ${c.phone}`}
        actions={<>{can('sales.manage') && <Link to="/orders/new"><Button variant="primary"><Plus /> New order</Button></Link>}{can('customer.manage') && <Button onClick={() => setEdit(true)}><Pencil /> Edit</Button>}</>} />
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Outstanding" value={money(c.outstanding)} tone={c.outstanding > 0 ? 'warn' : 'good'} />
        <StatCard label="Overdue" value={money(c.overdue)} tone={c.overdue > 0 ? 'danger' : 'good'} />
        <StatCard label="Credit available" value={c.creditAvailable === null ? 'No limit' : money(c.creditAvailable)} sub={c.creditLimit ? `limit ${money(c.creditLimit)}` : undefined} />
        {c.profitability && <><StatCard label="Revenue (shipped)" value={money(c.profitability.revenue, { compact: true })} /><StatCard label="Gross margin" value={money(c.profitability.grossMargin, { compact: true })} sub={c.profitability.marginPct !== null ? pct(c.profitability.marginPct) : undefined} tone="good" /></>}
        <StatCard label="Stock held for customer" value={qty(c.heldInventory.reduce((s: number, h: any) => s + h.quantity, 0))} sub={`${c.heldInventory.length} SKU-warehouse lines`} />
      </div>
      <Tabs value={tab} onValueChange={setTab} tabs={[{ value: 'orders', label: 'Orders', count: c.orders.length }, { value: 'purchases', label: 'What they buy' }, { value: 'invoices', label: 'Invoices', count: c.invoices.length }, { value: 'payments', label: 'Payments', count: c.payments.length }, { value: 'returns', label: 'Returns', count: c.returns.length }, { value: 'held', label: 'Held inventory', count: c.heldInventory.length }, { value: 'info', label: 'Details' }]} />
      <Card className="mt-4">
        {tab === 'orders' && <Table rows={c.orders} empty={<EmptyState title="No orders" />} columns={[{ key: 'n', header: 'Order', cell: (o: any) => <Link to={`/orders/${o.id}`} className="font-medium hover:text-brand-700">{o.number}</Link> }, { key: 'd', header: 'Date', cell: (o: any) => date(o.orderDate) }, { key: 't', header: 'Total', align: 'right', cell: (o: any) => money(o.total) }, { key: 's', header: 'Status', cell: (o: any) => <StatusBadge status={o.status} /> }]} />}
        {tab === 'purchases' && <Table rows={c.purchases} empty={<EmptyState title="Nothing shipped yet" />} columns={[{ key: 's', header: 'SKU', cell: (p: any) => p.sku }, { key: 'n', header: 'Product', cell: (p: any) => p.name }, { key: 'q', header: 'Units', align: 'right', cell: (p: any) => qty(p.quantity) }, { key: 'r', header: 'Revenue', align: 'right', cell: (p: any) => money(p.revenue) }]} />}
        {tab === 'invoices' && <Table rows={c.invoices} empty={<EmptyState title="No invoices" />} columns={[{ key: 'n', header: 'Invoice', cell: (i: any) => <Link to={`/billing/invoices/${i.id}`} className="font-medium hover:text-brand-700">{i.number}</Link> }, { key: 't', header: 'Type', cell: (i: any) => <Badge>{i.type.replace('_', ' ')}</Badge> }, { key: 'd', header: 'Due', cell: (i: any) => <span className={i.overdue ? 'text-red-600' : ''}>{date(i.dueDate)}</span> }, { key: 'a', header: 'Total', align: 'right', cell: (i: any) => money(i.total) }, { key: 'b', header: 'Balance', align: 'right', cell: (i: any) => money(i.total - i.amountPaid) }, { key: 's', header: 'Status', cell: (i: any) => <StatusBadge status={i.overdue ? 'overdue' : i.status} /> }]} />}
        {tab === 'payments' && <Table rows={c.payments} empty={<EmptyState title="No payments" />} columns={[{ key: 'n', header: 'Payment', cell: (p: any) => p.number }, { key: 'd', header: 'Date', cell: (p: any) => date(p.paidAt) }, { key: 'm', header: 'Method', cell: (p: any) => p.method.replace('_', ' ') }, { key: 'r', header: 'Reference', cell: (p: any) => p.reference }, { key: 'a', header: 'Amount', align: 'right', cell: (p: any) => money(p.amount) }]} />}
        {tab === 'returns' && <Table rows={c.returns} empty={<EmptyState title="No returns" />} columns={[{ key: 'n', header: 'Return', cell: (r: any) => r.number }, { key: 'r', header: 'Reason', cell: (r: any) => r.reason.replace('_', ' ') }, { key: 'd', header: 'Date', cell: (r: any) => date(r.createdAt) }, { key: 'c', header: 'Credit', align: 'right', cell: (r: any) => money(r.creditTotal) }]} />}
        {tab === 'held' && <Table rows={c.heldInventory} empty={<EmptyState title="No stock held for this customer" />} columns={[{ key: 's', header: 'SKU', cell: (h: any) => h.sku }, { key: 'n', header: 'Product', cell: (h: any) => h.name }, { key: 'w', header: 'Warehouse', cell: (h: any) => h.warehouseCode }, { key: 'q', header: 'Quantity', align: 'right', cell: (h: any) => qty(h.quantity) }]} />}
        {tab === 'info' && <div className="p-5"><KeyValue cols={3} items={[['Contact', c.contactName], ['Email', c.email], ['Phone', c.phone], ['Address', c.address], ['NTN', c.ntn], ['STRN', c.strn], ['Payment terms', `${c.paymentTermsDays} days`], ['Tax exempt', c.taxExempt ? 'Yes' : 'No'], ['Notes', c.notes]]} /></div>}
      </Card>
      {edit && <PartyForm kind="customer" party={c} onClose={() => setEdit(false)} />}
    </div>
  );
}

export function Suppliers() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [create, setCreate] = useState(false);
  const list = useServerList<any>('/suppliers', {});
  return (
    <div>
      <PageHeader title="Suppliers" description="Vendors with open purchase orders, payables and delivery performance." actions={can('supplier.manage') && <Button variant="primary" onClick={() => setCreate(true)}><Plus /> New supplier</Button>} />
      <Card>
        <div className="border-b border-ink-100 p-3"><SearchInput value={list.q} onChange={list.setQ} placeholder="Name, code or phone" className="w-full sm:w-80" /></div>
        <Table rows={list.rows} loading={list.loading} error={list.error} sort={list.sort} onSort={list.onSort} onRowClick={(r) => navigate(`/suppliers/${r.id}`)}
          empty={<EmptyState icon={Building2} title="No suppliers yet" action={can('supplier.manage') && <Button variant="primary" onClick={() => setCreate(true)}>Add supplier</Button>} />}
          columns={[
            { key: 'name', header: 'Supplier', sortKey: 'name', cell: (r) => <div><div className="font-medium text-ink-900">{r.name}</div><div className="text-xs text-ink-500">{r.code} · {r.city}</div></div> },
            { key: 'lead', header: 'Lead time', align: 'right', hideOnMobile: true, cell: (r) => `${r.leadTimeDays} d` },
            { key: 'open', header: 'Open POs', align: 'right', cell: (r) => r.openPos },
            { key: 'purchased', header: 'Purchased', align: 'right', sortKey: 'purchased', hideOnMobile: true, cell: (r) => money(r.purchased, { compact: true }) },
            { key: 'pay', header: 'Payable', align: 'right', sortKey: 'payable', cell: (r) => <span className="num font-medium">{money(r.payable)}</span> },
            { key: 's', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
          ]} />
        {list.pagination}
      </Card>
      {create && <PartyForm kind="supplier" onClose={() => setCreate(false)} />}
    </div>
  );
}

export function SupplierDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const [tab, setTab] = useState('pos');
  const [edit, setEdit] = useState(false);
  const { data: s, isLoading, error } = useQuery({ queryKey: ['supplier', id], queryFn: () => api.get<any>(`/suppliers/${id}`) });
  if (error) return <Card><ErrorState error={error} /></Card>;
  if (isLoading || !s) return <Skeleton className="h-96" />;
  const p = s.performance;
  return (
    <div>
      <PageHeader back={{ to: '/suppliers', label: 'Suppliers' }} title={<span className="flex items-center gap-2">{s.name}<StatusBadge status={s.status} /></span>} description={`${s.code} · ${s.city} · ${s.phone}`} actions={<>{can('purchase.manage') && <Link to="/purchasing/new"><Button variant="primary"><Plus /> New PO</Button></Link>}{can('supplier.manage') && <Button onClick={() => setEdit(true)}><Pencil /> Edit</Button>}</>} />
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Performance score" value={p.score ?? '—'} sub="on-time, completeness, damage" tone={p.score === null ? 'default' : p.score >= 85 ? 'good' : p.score >= 70 ? 'warn' : 'danger'} />
        <StatCard label="On-time delivery" value={p.onTimePct === null ? '—' : pct(p.onTimePct)} sub={`${p.receipts} receipts`} />
        <StatCard label="Short deliveries" value={pct(p.shortDeliveryPct)} tone={p.shortDeliveryPct > 10 ? 'warn' : 'default'} />
        <StatCard label="Damaged on arrival" value={pct(p.damagedPct)} tone={p.damagedPct > 2 ? 'warn' : 'default'} />
        <StatCard label="Avg lead time" value={p.avgLeadTimeDays === null ? '—' : `${p.avgLeadTimeDays} d`} sub={`promised ${s.leadTimeDays} d`} />
        <StatCard label="Outstanding payable" value={money(s.outstanding)} sub={`${p.priceChanges180d} price changes in 6 months`} />
      </div>
      <Tabs value={tab} onValueChange={setTab} tabs={[{ value: 'pos', label: 'Purchase orders', count: s.purchaseOrders.length }, { value: 'receipts', label: 'Receipts', count: s.receipts.length }, { value: 'products', label: 'Products', count: s.products.length }, { value: 'bills', label: 'Bills', count: s.bills.length }, { value: 'payments', label: 'Payments', count: s.payments.length }, { value: 'returns', label: 'Returns', count: s.returns.length }]} />
      <Card className="mt-4">
        {tab === 'pos' && <Table rows={s.purchaseOrders} empty={<EmptyState title="No purchase orders" />} columns={[{ key: 'n', header: 'PO', cell: (o: any) => <Link to={`/purchasing/${o.id}`} className="font-medium hover:text-brand-700">{o.number}</Link> }, { key: 'd', header: 'Ordered', cell: (o: any) => date(o.orderDate) }, { key: 'e', header: 'Expected', cell: (o: any) => date(o.expectedDate) }, { key: 't', header: 'Total', align: 'right', cell: (o: any) => money(o.total) }, { key: 's', header: 'Status', cell: (o: any) => <StatusBadge status={o.status} /> }]} />}
        {tab === 'receipts' && <Table rows={s.receipts} empty={<EmptyState title="No receipts" />} columns={[{ key: 'n', header: 'GRN', cell: (g: any) => <Link to={`/receiving/${g.id}`} className="font-medium hover:text-brand-700">{g.number}</Link> }, { key: 'p', header: 'PO', cell: (g: any) => g.poNumber }, { key: 'd', header: 'Received', cell: (g: any) => date(g.receivedAt) }, { key: 'v', header: 'Value', align: 'right', cell: (g: any) => money(g.totalValue) }]} />}
        {tab === 'products' && <Table rows={s.products} empty={<EmptyState title="No products" />} columns={[{ key: 's', header: 'SKU', cell: (x: any) => <Link to={`/products/${x.id}`} className="hover:text-brand-700">{x.sku}</Link> }, { key: 'n', header: 'Product', cell: (x: any) => x.name }, { key: 'q', header: 'Ordered', align: 'right', cell: (x: any) => qty(x.orderedQty) }, { key: 'c', header: 'Last cost', align: 'right', cell: (x: any) => money(x.lastCost) }]} />}
        {tab === 'bills' && <Table rows={s.bills} empty={<EmptyState title="No bills" />} columns={[{ key: 'n', header: 'Bill', cell: (b: any) => b.number }, { key: 'd', header: 'Due', cell: (b: any) => date(b.dueDate) }, { key: 't', header: 'Total', align: 'right', cell: (b: any) => money(b.total) }, { key: 'p', header: 'Paid', align: 'right', cell: (b: any) => money(b.amountPaid) }, { key: 's', header: 'Status', cell: (b: any) => <StatusBadge status={b.status} /> }]} />}
        {tab === 'payments' && <Table rows={s.payments} empty={<EmptyState title="No payments" />} columns={[{ key: 'n', header: 'Payment', cell: (x: any) => x.number }, { key: 'd', header: 'Date', cell: (x: any) => date(x.paidAt) }, { key: 'm', header: 'Method', cell: (x: any) => x.method.replace('_', ' ') }, { key: 'a', header: 'Amount', align: 'right', cell: (x: any) => money(x.amount) }]} />}
        {tab === 'returns' && <Table rows={s.returns} empty={<EmptyState title="No returns to this supplier" />} columns={[{ key: 'n', header: 'Return', cell: (x: any) => x.number }, { key: 'r', header: 'Reason', cell: (x: any) => x.reason }, { key: 'd', header: 'Date', cell: (x: any) => date(x.createdAt) }, { key: 't', header: 'Value', align: 'right', cell: (x: any) => money(x.total) }]} />}
      </Card>
      {edit && <PartyForm kind="supplier" party={s} onClose={() => setEdit(false)} />}
    </div>
  );
}
