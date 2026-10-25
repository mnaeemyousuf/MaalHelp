import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BarChart3, FileDown, FileSpreadsheet, FileText, Printer, Sparkles } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn, date, dateTime, humanize, money, pct, qty, today } from '@/lib/utils';
import { Button, Card, EmptyState, ErrorState, Field, Input, Select, Skeleton, StatusBadge } from '@/components/ui/core';
import { EntityPicker, PageHeader } from '@/components/ui/blocks';
import { SearchInput, Table, useServerList } from '@/components/ui/table';
import { useWarehouses } from './Inventory';
import { useCategories } from './Products';

export function Reports() {
  const { can } = useAuth();
  const { data, isLoading, error } = useQuery({ queryKey: ['report-catalog'], queryFn: () => api.get<any[]>('/reports') });
  const groups = ['Inventory', 'Warehouse', 'Sales', 'Purchasing', 'Financial'];
  return (
    <div>
      <PageHeader title="Reports" description="Every report supports filters, search, sorting, pagination, Excel / CSV / PDF export and printing." actions={can('ai.use') && <Link to="/ai?tab=report"><Button><Sparkles /> AI monthly report</Button></Link>} />
      {error ? <Card><ErrorState error={error} /></Card> : isLoading ? <Skeleton className="h-96" /> : (
        <div className="space-y-6">
          {groups.map((g) => {
            const items = data?.filter((r) => r.category === g) ?? [];
            if (!items.length) return null;
            return (
              <section key={g}>
                <h2 className="mb-3 text-sm font-semibold text-ink-700">{g}</h2>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  {items.map((r) => (
                    <Link key={r.key} to={`/reports/${r.key}`} className="card group p-4 hover:border-brand-300">
                      <div className="flex items-center gap-2"><BarChart3 className="size-4 text-brand-600" /><span className="text-sm font-semibold text-ink-900 group-hover:text-brand-800">{r.name}</span></div>
                      <p className="mt-1.5 text-xs text-ink-500">{r.description}</p>
                    </Link>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function cell(v: any, type: string) {
  if (v === null || v === undefined || v === '') return <span className="text-ink-300">—</span>;
  switch (type) {
    case 'money': return <span className="num">{money(v)}</span>;
    case 'number': return <span className="num">{qty(v)}</span>;
    case 'percent': return <span className="num">{pct(v)}</span>;
    case 'date': return date(v);
    case 'datetime': return <span className="whitespace-nowrap">{dateTime(v)}</span>;
    case 'status': return <StatusBadge status={String(v)} />;
    default: return String(v);
  }
}

export function ReportView() {
  const { key } = useParams();
  const warehouses = useWarehouses();
  const categories = useCategories();
  const catalog = useQuery({ queryKey: ['report-catalog'], queryFn: () => api.get<any[]>('/reports') });
  const def = catalog.data?.find((r) => r.key === key);
  const [f, setF] = useState<Record<string, string>>({ from: today(-29), to: today() });
  const [exporting, setExporting] = useState<string | null>(null);
  const params = Object.fromEntries(Object.entries(f).filter(([k, v]) => v && (def?.filters.includes(k) ?? true)));
  const list = useServerList<any>(`/reports/${key}`, params, { pageSize: 50, enabled: !!def });
  const columns = (list.meta.report?.columns ?? def?.columns ?? []) as { key: string; label: string; type: string }[];
  const totals = list.meta.totals as Record<string, number> | null;
  const doExport = async (format: 'csv' | 'xlsx' | 'pdf') => {
    setExporting(format);
    try { await api.download(`/reports/${key}/export`, { ...params, q: list.q || undefined, sort: list.sort.key, dir: list.sort.dir, format }, `${key}_${today()}.${format}`); }
    catch (e) { toast.error(errorMessage(e)); } finally { setExporting(null); }
  };
  if (catalog.isLoading) return <Skeleton className="h-96" />;
  if (!def) return <Card><EmptyState title="Report not available" description="This report does not exist or your role cannot run it." /></Card>;
  const has = (k: string) => def.filters.includes(k);
  return (
    <div>
      <PageHeader back={{ to: '/reports', label: 'Reports' }} title={def.name} description={def.description}
        actions={<div className="no-print flex flex-wrap gap-2">
          <Button loading={exporting === 'xlsx'} onClick={() => doExport('xlsx')}><FileSpreadsheet /> Excel</Button>
          <Button loading={exporting === 'csv'} onClick={() => doExport('csv')}><FileDown /> CSV</Button>
          <Button loading={exporting === 'pdf'} onClick={() => doExport('pdf')}><FileText /> PDF</Button>
          <Button onClick={() => window.print()}><Printer /> Print</Button>
        </div>} />
      <Card className="print-area">
        <div className="no-print flex flex-wrap items-end gap-3 border-b border-ink-100 p-3">
          <Field label="Search"><SearchInput value={list.q} onChange={list.setQ} placeholder="Search all columns" className="w-56" /></Field>
          {has('from') && <Field label="From"><Input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} className="w-36" /></Field>}
          {has('to') && <Field label="To"><Input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} className="w-36" /></Field>}
          {has('warehouseId') && <Field label="Warehouse"><Select value={f.warehouseId ?? ''} onChange={(e) => setF({ ...f, warehouseId: e.target.value })} className="w-40"><option value="">All</option>{warehouses.data?.map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}</Select></Field>}
          {has('categoryId') && <Field label="Category"><Select value={f.categoryId ?? ''} onChange={(e) => setF({ ...f, categoryId: e.target.value })} className="w-44"><option value="">All</option>{categories.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>}
          {has('days') && <Field label="Days"><Input type="number" min={1} value={f.days ?? (def.key === 'expiry' ? '90' : '90')} onChange={(e) => setF({ ...f, days: e.target.value })} className="w-24" /></Field>}
          {has('customerId') && <Field label="Customer"><div className="w-52"><EntityPicker value={f.customerId || null} onChange={(id) => setF({ ...f, customerId: id ?? '' })} endpoint="/customers" map={(c) => ({ id: c.id, label: c.name })} placeholder="All customers" /></div></Field>}
          {has('supplierId') && <Field label="Supplier"><div className="w-52"><EntityPicker value={f.supplierId || null} onChange={(id) => setF({ ...f, supplierId: id ?? '' })} endpoint="/suppliers" map={(s) => ({ id: s.id, label: s.name })} placeholder="All suppliers" /></div></Field>}
          {has('productId') && <Field label="Product"><div className="w-56"><EntityPicker value={f.productId || null} onChange={(id) => setF({ ...f, productId: id ?? '' })} endpoint="/products" map={(p) => ({ id: p.id, label: `${p.sku} — ${p.name}` })} placeholder="All products" /></div></Field>}
        </div>
        <div className="hidden px-4 pt-4 print:block"><h2 className="text-lg font-semibold">{def.name}</h2><p className="text-xs text-ink-500">{has('from') ? `${f.from} to ${f.to} · ` : ''}{list.meta.total ?? 0} rows · printed {dateTime(new Date())}</p></div>
        <Table rows={list.rows} loading={list.loading} error={list.error} onRetry={list.refetch} sort={list.sort} onSort={list.onSort} dense
          empty={<EmptyState icon={BarChart3} title="No data for these filters" description="Try widening the date range or clearing filters." />}
          columns={columns.map((c, i) => ({ key: c.key, header: c.label, sortKey: c.key, align: ['money', 'number', 'percent'].includes(c.type) ? 'right' as const : 'left' as const, hideOnMobile: i > 3, cell: (r: any) => cell(r[c.key], c.type) }))}
          footer={totals ? <tr>{columns.map((c, i) => <td key={c.key} className={cn('px-4 py-2 text-sm', ['money', 'number', 'percent'].includes(c.type) && 'text-right')}>{i === 0 ? 'Total (all matching rows)' : totals[c.key] !== undefined ? cell(totals[c.key], c.type) : ''}</td>)}</tr> : undefined} />
        <div className="no-print">{list.pagination}</div>
      </Card>
      {totals && <p className="mt-2 text-xs text-ink-500">Totals cover every row matching the filters, not only the rows on this page.</p>}
    </div>
  );
}

