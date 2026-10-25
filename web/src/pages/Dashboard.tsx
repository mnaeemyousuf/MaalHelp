import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AlertTriangle, ArrowRight, Boxes, CalendarClock, CircleDollarSign, ClipboardList, Hourglass, PackageCheck, PackagePlus, RefreshCw, ScanLine, Sparkles, Truck, Warehouse, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn, date, money, pct, qty, relativeTime, today } from '@/lib/utils';
import { Badge, Button, Card, CardHeader, ErrorState, Input, Progress, Select, Skeleton, StatusBadge } from '@/components/ui/core';
import { PageHeader, StatCard } from '@/components/ui/blocks';

const RANGES = [['today', 'Today'], ['yesterday', 'Yesterday'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['month', 'This month'], ['year', 'This year'], ['custom', 'Custom…']] as const;
const STATUS_COLORS: Record<string, string> = { available: '#2647d8', reserved: '#8b5cf6', damaged: '#ef4444', quarantine: '#f59e0b', expired: '#b91c1c', in_transit: '#0ea5e9', blocked: '#94a3b8' };

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

export function Dashboard() {
  const { me, can } = useAuth();
  const [range, setRange] = useState<string>('today');
  const [from, setFrom] = useState(today(-6));
  const [to, setTo] = useState(today());
  const [warehouseId, setWarehouseId] = useState('');
  const warehouses = useQuery({ queryKey: ['warehouses'], queryFn: () => api.get<any[]>('/warehouses') });
  const { data, isLoading, error, refetch, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ['dashboard', range, from, to, warehouseId],
    queryFn: () => api.get<any>('/dashboard', { range, from: range === 'custom' ? from : undefined, to: range === 'custom' ? to : undefined, warehouseId: warehouseId || undefined }),
    refetchInterval: 120_000,
  });
  const finance = can('finance.view');

  return (
    <div>
      <PageHeader
        title={`${greeting()}, ${me?.user.name.split(' ')[0] ?? ''}`}
        description={<>Here&apos;s what is happening at <b className="font-semibold text-ink-700">{me?.tenant?.name}</b>{data ? ` · ${data.range.label}` : ''}{dataUpdatedAt ? ` · updated ${relativeTime(dataUpdatedAt)}` : ''}</>}
        actions={<>
          <Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className="w-44"><option value="">All warehouses</option>{warehouses.data?.map((w) => <option key={w.id} value={w.id}>{w.code} · {w.name}</option>)}</Select>
          <Select value={range} onChange={(e) => setRange(e.target.value)} className="w-40">{RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
          {range === 'custom' && <><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-36" /><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-36" /></>}
          <Button size="icon" variant="ghost" onClick={() => refetch()} aria-label="Refresh"><RefreshCw className={cn(isFetching && 'animate-spin')} /></Button>
        </>}
      />
      {error ? <Card><ErrorState error={error} onRetry={refetch} /></Card> : isLoading || !data ? <DashboardSkeleton /> : (
        <div className="space-y-6">
          <Intelligence data={data} />

          <section>
            <SectionTitle icon={Boxes} title="Inventory" />
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
              {finance && <StatCard label="Inventory value" value={money(data.inventory.inventoryValue, { compact: true })} sub={`${qty(data.inventory.totalUnits, 0)} units on hand`} to="/reports/inventory_valuation" action="Valuation" />}
              <StatCard label="SKUs in stock" value={qty(data.inventory.skusInStock, 0)} sub={`of ${qty(data.inventory.totalSkus, 0)} active SKUs`} to="/products" action="Products" />
              <StatCard label="Available / reserved" value={qty(data.inventory.available, 0)} sub={`${qty(data.inventory.reserved, 0)} reserved for orders`} to="/inventory?status=available" action="Stock" />
              <StatCard label="Low stock SKUs" value={data.inventory.lowStockSkus} sub={`${data.inventory.outOfStockSkus} out of stock`} tone={data.inventory.lowStockSkus ? 'warn' : 'good'} icon={AlertTriangle} to="/ai?tab=reorder" action="Reorder" />
              <StatCard label="Damaged · quarantine · expired" value={qty(data.inventory.damaged + data.inventory.quarantine + data.inventory.expired, 0)} sub={finance ? `${money(data.inventory.impairedValue, { compact: true })} impaired value` : 'units not sellable'} tone={data.inventory.expired ? 'danger' : 'default'} to="/reports/damaged_stock" action="Review" />
              {finance ? <StatCard label="Dead stock" value={money(data.inventory.deadStockValue, { compact: true })} sub={`${data.inventory.deadStockSkus} SKUs idle ${data.inventory.deadStockDays}+ days`} tone={data.inventory.deadStockValue ? 'warn' : 'good'} to="/reports/dead_stock" action="Clear stock" />
                : <StatCard label="Dead stock SKUs" value={data.inventory.deadStockSkus} sub={`idle ${data.inventory.deadStockDays}+ days`} to="/reports/dead_stock" action="View" />}
            </div>
          </section>

          <div className="grid gap-6 xl:grid-cols-3">
            <Card className="xl:col-span-2">
              <CardHeader title="Stock movement" description="Units received vs dispatched per day" actions={<Link to="/reports/stock_movement" className="text-xs font-medium text-brand-700">Movement report →</Link>} />
              <div className="h-64 px-2 py-4">
                <ResponsiveContainer>
                  <AreaChart data={data.trend} margin={{ left: 0, right: 12, top: 4 }}>
                    <defs>
                      <linearGradient id="gin" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#2647d8" stopOpacity={0.3} /><stop offset="100%" stopColor="#2647d8" stopOpacity={0} /></linearGradient>
                      <linearGradient id="gout" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#f59e0b" stopOpacity={0.3} /><stop offset="100%" stopColor="#f59e0b" stopOpacity={0} /></linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                    <XAxis dataKey="day" tickFormatter={(d) => date(d, { day: 'numeric', month: 'short' })} tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} minTickGap={24} />
                    <YAxis tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} width={40} />
                    <Tooltip labelFormatter={(d) => date(d)} contentStyle={{ borderRadius: 10, border: '1px solid #e2e8f0', fontSize: 12 }} />
                    <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                    <Area type="monotone" dataKey="inbound" name="Received" stroke="#2647d8" strokeWidth={2} fill="url(#gin)" />
                    <Area type="monotone" dataKey="outbound" name="Dispatched" stroke="#d97706" strokeWidth={2} fill="url(#gout)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </Card>
            <Card>
              <CardHeader title="Stock by status" description="Company-owned units" />
              <StockStatusPie data={data.inventory} />
            </Card>
          </div>

          <section>
            <SectionTitle icon={Warehouse} title="Warehouses & space" link={{ to: '/warehouses', label: 'Manage warehouses' }} />
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <Card className="p-4">
                <div className="text-xs font-medium text-ink-500">Total capacity used</div>
                <div className="num mt-1 text-2xl font-semibold">{pct(data.warehouse.capacityPct)}</div>
                <div className="mt-2"><Progress value={data.warehouse.capacityPct} /></div>
                <div className="mt-2 text-xs text-ink-500">{qty(data.warehouse.occupiedLocations, 0)} occupied · {qty(data.warehouse.emptyLocations, 0)} empty locations</div>
              </Card>
              {data.warehouse.warehouses.map((w: any) => (
                <Link key={w.id} to={`/warehouses/${w.id}`} className="card block p-4 hover:border-brand-300">
                  <div className="flex items-center justify-between"><span className="text-sm font-semibold text-ink-800">{w.name}</span><Badge tone={w.utilizationPct >= 95 ? 'red' : w.utilizationPct >= 85 ? 'amber' : 'green'}>{pct(w.utilizationPct, 0)}</Badge></div>
                  <div className="mt-3"><Progress value={w.utilizationPct} /></div>
                  <div className="mt-2 flex justify-between text-xs text-ink-500"><span>{qty(w.used, 0)} / {qty(w.capacity, 0)} {w.capacityUnit}</span><span>{w.emptyLocations} empty bins</span></div>
                  {finance && <div className="mt-1 text-xs text-ink-500">Stock value {money(w.stockValue, { compact: true })}</div>}
                </Link>
              ))}
            </div>
          </section>

          <section>
            <SectionTitle icon={ClipboardList} title={`Operations · ${data.range.label}`} />
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
              <StatCard label="Receipts" value={data.operations.receipts} sub={`${qty(data.operations.unitsReceived, 0)} units in`} icon={PackagePlus} to="/receiving" action="GRNs" />
              <StatCard label="Dispatches" value={data.operations.dispatches} sub={`${qty(data.operations.unitsDispatched, 0)} units out`} icon={Truck} to="/dispatch" action="Shipments" />
              <StatCard label="POs to receive" value={data.operations.pendingReceipts} sub={data.operations.overdueReceipts ? `${data.operations.overdueReceipts} overdue` : 'on schedule'} tone={data.operations.overdueReceipts ? 'warn' : 'default'} to="/receiving/new" action="Receive" />
              <StatCard label="Putaway pending" value={data.operations.pendingPutaway} sub="at receiving dock" to="/putaway" action="Put away" tone={data.operations.pendingPutaway ? 'warn' : 'default'} />
              <StatCard label="Orders to pick" value={data.operations.pendingPicking} sub={`${data.operations.pendingPickTasks} pick tasks`} icon={ScanLine} to="/picking" action="Assign" />
              <StatCard label="To pack" value={data.operations.pendingPacking} icon={PackageCheck} to="/packing" action="Pack" />
              <StatCard label="Ready to dispatch" value={data.operations.pendingDispatch} to="/dispatch" action="Dispatch" />
              <StatCard label="Delayed orders" value={data.operations.delayedOrders} tone={data.operations.delayedOrders ? 'danger' : 'good'} icon={Hourglass} to="/orders?delayed=1" action="Resolve" />
            </div>
          </section>

          {finance && data.financial && (
            <section>
              <SectionTitle icon={CircleDollarSign} title={`Financial · ${data.range.label}`} link={{ to: '/profitability', label: 'Profitability' }} />
              <div className="grid gap-6 xl:grid-cols-3">
                <div className="grid grid-cols-2 gap-3 xl:col-span-1">
                  <StatCard label="Sales (net)" value={money(data.financial.sales, { compact: true })} sub={data.financial.storageRevenue ? `+ ${money(data.financial.storageRevenue, { compact: true })} storage` : 'invoiced'} to="/reports/sales_by_customer" action="Sales" />
                  <StatCard label="Purchases" value={money(data.financial.purchases, { compact: true })} sub="goods received (billed)" to="/reports/purchases_by_supplier" action="Purchases" />
                  <StatCard label="Receivables" value={money(data.financial.receivables, { compact: true })} sub={`${money(data.financial.overdueReceivables, { compact: true })} overdue`} tone={data.financial.overdueReceivables ? 'warn' : 'default'} icon={Wallet} to="/billing?tab=aging" action="Collect" />
                  <StatCard label="Payables" value={money(data.financial.payables, { compact: true })} sub="owed to suppliers" to="/billing?tab=bills" action="Pay" />
                  <StatCard label="Est. gross margin" value={money(data.financial.grossMargin, { compact: true })} sub={data.financial.grossMarginPct !== null ? `${pct(data.financial.grossMarginPct)} of shipped revenue` : 'no shipments'} tone="good" />
                  <StatCard label="Cash in / out" value={money(data.financial.cashIn - data.financial.cashOut, { compact: true })} sub={`${money(data.financial.cashIn, { compact: true })} in · ${money(data.financial.cashOut, { compact: true })} out`} to="/billing?tab=payments" action="Payments" />
                </div>
                <Card className="xl:col-span-2">
                  <CardHeader title="Sales, purchases & expenses" description="Last 6 months, net of tax" />
                  <div className="h-72 px-2 py-4">
                    <ResponsiveContainer>
                      <BarChart data={data.salesTrend} margin={{ left: 0, right: 12 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                        <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
                        <YAxis tickFormatter={(v) => money(v, { compact: true }).replace(/^\S+ /, '')} tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} width={48} />
                        <Tooltip formatter={(v) => money(v)} contentStyle={{ borderRadius: 10, border: '1px solid #e2e8f0', fontSize: 12 }} />
                        <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                        <Bar dataKey="sales" name="Sales" fill="#2647d8" radius={[4, 4, 0, 0]} />
                        <Bar dataKey="purchases" name="Purchases" fill="#94a3b8" radius={[4, 4, 0, 0]} />
                        <Bar dataKey="expenses" name="Expenses" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </Card>
              </div>
            </section>
          )}

          <div className="grid gap-6 lg:grid-cols-2 xl:grid-cols-3">
            <ListCard title="Low stock" link={{ to: '/ai?tab=reorder', label: 'Smart reorder' }} empty="Nothing below reorder level." rows={data.lowStock} render={(p: any) => (
              <Link to={`/products/${p.id}`} className="flex items-center justify-between gap-3 px-5 py-2.5 hover:bg-ink-50">
                <div className="min-w-0"><div className="truncate text-sm font-medium text-ink-800">{p.name}</div><div className="text-xs text-ink-500">{p.sku} · reorder at {qty(p.reorderLevel, 0)}{p.incoming ? ` · ${qty(p.incoming, 0)} on order` : ''}</div></div>
                <Badge tone={Number(p.available) <= 0 ? 'red' : 'amber'}>{qty(p.available, 0)} left</Badge>
              </Link>
            )} />
            <ListCard title="Expiring within 30 days" link={{ to: '/reports/expiry', label: 'Expiry report' }} empty="No batches expiring soon." rows={data.expiring} render={(b: any) => (
              <Link to={`/products/${b.productId}`} className="flex items-center justify-between gap-3 px-5 py-2.5 hover:bg-ink-50">
                <div className="min-w-0"><div className="truncate text-sm font-medium text-ink-800">{b.name}</div><div className="text-xs text-ink-500">Batch {b.batchNo} · {qty(b.quantity, 0)} units · {b.warehouses}</div></div>
                <Badge tone={b.daysLeft < 0 ? 'red' : b.daysLeft <= 7 ? 'amber' : 'blue'}><CalendarClock className="size-3" />{b.daysLeft < 0 ? 'Expired' : `${b.daysLeft}d`}</Badge>
              </Link>
            )} />
            <ListCard title="Delayed orders" link={{ to: '/orders?delayed=1', label: 'All delayed' }} empty="No delayed orders. Great!" rows={data.delayed} render={(o: any) => (
              <Link to={`/orders/${o.id}`} className="flex items-center justify-between gap-3 px-5 py-2.5 hover:bg-ink-50">
                <div className="min-w-0"><div className="text-sm font-medium text-ink-800">{o.number} · <span className="font-normal">{o.customerName}</span></div><div className="text-xs text-ink-500">{o.requiredDate ? `Required ${date(o.requiredDate)}` : `Confirmed ${date(o.confirmedAt)}`}</div></div>
                <StatusBadge status={o.status} />
              </Link>
            )} />
            <ListCard title="Top stock by value" link={{ to: '/reports/inventory_valuation', label: 'Valuation' }} rows={data.topProducts} empty="No stock yet." render={(p: any) => (
              <Link to={`/products/${p.id}`} className="flex items-center justify-between gap-3 px-5 py-2.5 hover:bg-ink-50">
                <div className="min-w-0"><div className="truncate text-sm font-medium text-ink-800">{p.name}</div><div className="text-xs text-ink-500">{p.sku} · {qty(p.quantity, 0)} units</div></div>
                {finance && <span className="num text-sm font-medium text-ink-700">{money(p.value, { compact: true })}</span>}
              </Link>
            )} />
            <ListCard title="Recent alerts" link={{ to: '/alerts', label: 'Alert center' }} rows={data.alerts} empty="No open alerts." render={(a: any) => (
              <Link to={a.actionUrl ?? '/alerts'} className="flex items-start gap-3 px-5 py-2.5 hover:bg-ink-50">
                <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', a.severity === 'critical' ? 'bg-red-500' : a.severity === 'warning' ? 'bg-amber-500' : 'bg-sky-500')} />
                <div className="min-w-0"><div className="text-sm font-medium text-ink-800">{a.title}</div><div className="truncate text-xs text-ink-500">{a.body}</div></div>
              </Link>
            )} />
          </div>
        </div>
      )}
    </div>
  );
}

function SectionTitle({ icon: Icon, title, link }: { icon: React.ComponentType<{ className?: string }>; title: string; link?: { to: string; label: string } }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-ink-700"><Icon className="size-4 text-brand-700" />{title}</h2>
      {link && <Link to={link.to} className="text-xs font-medium text-brand-700 hover:underline">{link.label} →</Link>}
    </div>
  );
}

function Intelligence({ data }: { data: any }) {
  const items = data.attention as any[];
  const b = data.briefing;
  return (
    <div className="overflow-hidden rounded-2xl border border-brand-200 bg-gradient-to-br from-brand-50 via-white to-accent-50 shadow-card">
      <div className="grid gap-0 lg:grid-cols-[1.1fr_1fr]">
        <div className="p-5 sm:p-6">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-brand-700"><Sparkles className="size-4" /> Today&apos;s intelligence {b && <Badge tone="teal">{b.generatedBy === 'mistral' ? 'Written by Mistral AI from your data' : 'Generated from your data'}</Badge>}</div>
          <h2 className="mt-2 text-lg font-semibold text-ink-900">{items.length ? `${Math.min(items.length, 9)} thing${items.length > 1 ? 's' : ''} need${items.length > 1 ? '' : 's'} your attention today` : 'Nothing urgent today — operations look healthy'}</h2>
          {b?.content && <p className="mt-2 text-sm leading-relaxed text-ink-600">{b.content}</p>}
          <div className="mt-4 flex flex-wrap gap-2">
            <Link to="/ai"><Button variant="primary" size="sm"><Sparkles /> Ask AI</Button></Link>
            <Link to="/alerts"><Button size="sm">View all alerts</Button></Link>
          </div>
        </div>
        <div className="border-t border-brand-100 bg-white/60 lg:border-l lg:border-t-0">
          {items.length === 0 ? <div className="p-6 text-sm text-ink-500">All clear. Low stock, delays, capacity and receivables are within normal ranges.</div> : (
            <ol className="divide-y divide-brand-100/70">
              {items.slice(0, 5).map((it, i) => (
                <li key={it.key} className="flex items-start gap-3 px-5 py-3">
                  <span className={cn('mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-xs font-bold', it.severity === 'critical' ? 'bg-red-100 text-red-700' : it.severity === 'warning' ? 'bg-amber-100 text-amber-800' : 'bg-sky-100 text-sky-700')}>{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-ink-900">{it.title}</div>
                    <div className="text-xs text-ink-500">{it.detail}</div>
                    <div className="mt-1.5 flex flex-wrap gap-3 text-xs font-medium">
                      <Link to={it.action.href} className="inline-flex items-center gap-1 text-brand-700 hover:underline">{it.action.label} <ArrowRight className="size-3" /></Link>
                      {it.secondary && <Link to={it.secondary.href} className="text-ink-500 hover:text-ink-800">{it.secondary.label}</Link>}
                      <Link to={`/ai?q=${encodeURIComponent(`Investigate: ${it.title}`)}`} className="text-ink-500 hover:text-ink-800">Investigate</Link>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}

function StockStatusPie({ data }: { data: any }) {
  const parts = ['available', 'reserved', 'in_transit', 'quarantine', 'damaged', 'expired', 'blocked'].map((k) => ({ name: k.replace('_', ' '), key: k, value: Number(data[k === 'in_transit' ? 'inTransit' : k] ?? 0) })).filter((p) => p.value > 0);
  const total = parts.reduce((s, p) => s + p.value, 0);
  if (!total) return <div className="p-6 text-sm text-ink-500">No stock yet.</div>;
  return (
    <div className="flex flex-col items-center gap-2 p-4 sm:flex-row xl:flex-col 2xl:flex-row">
      <div className="h-44 w-44 shrink-0">
        <ResponsiveContainer><PieChart><Pie data={parts} dataKey="value" innerRadius={50} outerRadius={78} paddingAngle={2} stroke="none">{parts.map((p) => <Cell key={p.key} fill={STATUS_COLORS[p.key]} />)}</Pie><Tooltip formatter={(v) => qty(v, 0)} /></PieChart></ResponsiveContainer>
      </div>
      <ul className="w-full space-y-1.5 text-sm">
        {parts.map((p) => <li key={p.key} className="flex items-center gap-2"><span className="size-2.5 rounded-full" style={{ background: STATUS_COLORS[p.key] }} /><span className="flex-1 capitalize text-ink-600">{p.name}</span><span className="num font-medium">{qty(p.value, 0)}</span><span className="w-10 text-right text-xs text-ink-400">{Math.round((p.value / total) * 100)}%</span></li>)}
      </ul>
    </div>
  );
}

function ListCard({ title, rows, render, link, empty }: { title: string; rows: any[]; render: (r: any) => React.ReactNode; link?: { to: string; label: string }; empty: string }) {
  return (
    <Card>
      <CardHeader title={title} actions={link && <Link to={link.to} className="text-xs font-medium text-brand-700">{link.label} →</Link>} />
      {rows?.length ? <div className="divide-y divide-ink-100 py-1">{rows.map((r, i) => <div key={r.id ?? r.batchId ?? i}>{render(r)}</div>)}</div> : <div className="px-5 py-8 text-center text-sm text-ink-500">{empty}</div>}
    </Card>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-44 w-full rounded-2xl" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}</div>
      <div className="grid gap-6 xl:grid-cols-3"><Skeleton className="h-72 rounded-xl xl:col-span-2" /><Skeleton className="h-72 rounded-xl" /></div>
    </div>
  );
}
