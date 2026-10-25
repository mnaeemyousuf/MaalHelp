import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Barcode as BarcodeIcon, PackageOpen, Pencil, Plus, Printer, Upload } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { date, dateTime, humanize, money, qty } from '@/lib/utils';
import { Badge, Button, Card, CardHeader, Checkbox, EmptyState, ErrorState, Field, Input, Select, Skeleton, StatusBadge, Textarea } from '@/components/ui/core';
import { Dialog, Drawer, Tabs } from '@/components/ui/overlay';
import { Barcode, KeyValue, PageHeader, StatCard } from '@/components/ui/blocks';
import { SearchInput, Table, useServerList } from '@/components/ui/table';

export function useCategories() {
  return useQuery({ queryKey: ['categories'], queryFn: () => api.get<any[]>('/product-categories'), staleTime: 60_000 });
}

export function Products() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const categories = useCategories();
  const [categoryId, setCategoryId] = useState('');
  const stock = params.get('stock') ?? '';
  const [editing, setEditing] = useState<any | null>(null);
  const list = useServerList<any>('/products', { categoryId: categoryId || undefined, stock: stock || undefined }, { defaultSort: 'sku' });
  return (
    <div>
      <PageHeader title="Products" description="Product master: SKUs, barcodes, units, dimensions, pricing, reorder levels and tracking rules."
        actions={<>
          {can('import.execute') && <Link to="/settings/import?entity=products"><Button><Upload /> Import</Button></Link>}
          {can('product.manage') && <Button variant="primary" onClick={() => setEditing({})}><Plus /> New product</Button>}
        </>} />
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-ink-100 p-3">
          <SearchInput value={list.q} onChange={list.setQ} placeholder="Search SKU, name, brand or barcode" className="w-full sm:w-80" />
          <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="w-48"><option value="">All categories</option>{categories.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
          <div className="flex flex-wrap gap-1">
            {[['', 'All'], ['low', 'Low stock'], ['out', 'Out of stock'], ['overstock', 'Overstock'], ['in_stock', 'In stock']].map(([v, l]) => (
              <button key={v} onClick={() => setParams(v ? { stock: v } : {})} className={`rounded-full px-3 py-1 text-xs font-medium ${stock === v ? 'bg-brand-700 text-white' : 'bg-ink-100 text-ink-600 hover:bg-ink-200'}`}>{l}</button>
            ))}
          </div>
        </div>
        <Table rows={list.rows} loading={list.loading} error={list.error} onRetry={list.refetch} sort={list.sort} onSort={list.onSort} onRowClick={(r) => navigate(`/products/${r.id}`)}
          empty={<EmptyState icon={PackageOpen} title={list.q || stock ? 'No products match' : 'No products yet'} description="Add your first product or import your catalogue from Excel." action={can('product.manage') && <Button variant="primary" onClick={() => setEditing({})}><Plus /> New product</Button>} />}
          columns={[
            { key: 'sku', header: 'Product', sortKey: 'sku', cell: (r) => <div className="min-w-0"><div className="truncate font-medium text-ink-900">{r.name}</div><div className="text-xs text-ink-500">{r.sku}{r.brand ? ` · ${r.brand}` : ''}</div></div> },
            { key: 'category', header: 'Category', sortKey: 'category', hideOnMobile: true, cell: (r) => r.categoryName ?? '—' },
            { key: 'tracking', header: 'Tracking', hideOnMobile: true, cell: (r) => <div className="flex gap-1">{r.trackBatch && <Badge tone="blue">Batch</Badge>}{r.trackExpiry && <Badge tone="amber">Expiry</Badge>}{r.trackSerial && <Badge tone="violet">Serial</Badge>}{!r.trackBatch && !r.trackSerial && <span className="text-xs text-ink-400">Simple</span>}</div> },
            { key: 'available', header: 'Available', align: 'right', sortKey: 'available', cell: (r) => <span className="num font-semibold">{qty(r.available)}</span> },
            { key: 'reserved', header: 'Reserved', align: 'right', hideOnMobile: true, cell: (r) => <span className="num text-ink-500">{qty(r.reserved)}</span> },
            { key: 'reorder', header: 'Reorder at', align: 'right', sortKey: 'reorder', hideOnMobile: true, cell: (r) => <span className="num text-ink-500">{qty(r.reorderLevel)}</span> },
            { key: 'state', header: 'Stock', cell: (r) => <StatusBadge status={r.stockState} label={{ out: 'Out of stock', low: 'Low', overstock: 'Overstock', ok: 'Healthy' }[r.stockState as string]} /> },
            ...(can('finance.view') ? [{ key: 'price', header: 'Cost / price', align: 'right' as const, hideOnMobile: true, cell: (r: any) => <div className="num text-xs"><div>{money(r.costPrice)}</div><div className="text-ink-500">{money(r.sellingPrice)}</div></div> }] : [{ key: 'price', header: 'Price', align: 'right' as const, hideOnMobile: true, cell: (r: any) => <span className="num">{money(r.sellingPrice)}</span> }]),
          ]} />
        {list.pagination}
      </Card>
      {editing && <ProductForm product={editing.id ? editing : null} onClose={() => setEditing(null)} onSaved={(p) => { setEditing(null); navigate(`/products/${p.id}`); }} />}
    </div>
  );
}

const blank = { sku: '', name: '', categoryId: '', brand: '', description: '', barcode: '', uom: 'pcs', purchaseUom: 'pcs', salesUom: 'pcs', conversionFactor: 1, weightKg: 0, lengthCm: 0, widthCm: 0, heightCm: 0, unitsPerPallet: 0, costPrice: 0, sellingPrice: 0, minStock: 0, reorderLevel: 0, reorderQty: 0, maxStock: 0, defaultSupplierId: '', taxRateId: '', trackBatch: false, trackSerial: false, trackExpiry: false, temperatureClass: 'ambient', status: 'active', skuType: 'simple' };

export function ProductForm({ product, onClose, onSaved }: { product: any | null; onClose: () => void; onSaved: (p: any) => void }) {
  const qc = useQueryClient();
  const { me, can } = useAuth();
  const categories = useCategories();
  const suppliers = useQuery({ queryKey: ['suppliers-all'], queryFn: () => api.get<any[]>('/suppliers', { pageSize: 200 }) });
  const taxes = useQuery({ queryKey: ['tax-rates'], queryFn: () => api.get<any[]>('/tax-rates') });
  const [f, setF] = useState<any>(() => ({ ...blank, ...(product ?? {}), categoryId: product?.categoryId ?? '', defaultSupplierId: product?.defaultSupplierId ?? '', taxRateId: product?.taxRateId ?? '', barcode: product?.barcode ?? '' }));
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.type === 'number' ? Number(e.target.value) : e.target.value });
  const units: string[] = me?.tenant?.settings?.units ?? ['pcs', 'box', 'carton', 'kg', 'litre'];
  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, categoryId: f.categoryId || null, defaultSupplierId: f.defaultSupplierId || null, taxRateId: f.taxRateId || null, barcode: f.barcode || null };
      for (const k of ['id', 'createdAt', 'updatedAt', 'tenantId', 'barcodes', 'stock', 'batches', 'movements', 'variants', 'velocity', 'altBarcode', 'imageUrl', 'parentId', 'variantAttributes', 'volumeM3', 'trackLot']) delete body[k];
      return product ? api.patch<any>(`/products/${product.id}`, body) : api.post<any>('/products', body);
    },
    onSuccess: (p) => { toast.success(product ? 'Product updated' : 'Product created'); qc.invalidateQueries({ queryKey: ['/products'] }); qc.invalidateQueries({ queryKey: ['product'] }); onSaved(p); },
  });
  const volume = f.lengthCm && f.widthCm && f.heightCm ? (f.lengthCm * f.widthCm * f.heightCm) / 1e6 : 0;
  return (
    <Drawer open onOpenChange={onClose} title={product ? `Edit ${product.sku}` : 'New product'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={!f.sku || !f.name} onClick={() => save.mutate()}>{product ? 'Save changes' : 'Create product'}</Button></>}>
      <div className="space-y-6">
        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="col-span-full mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">Identity</legend>
          <Field label="SKU" required hint="Letters, digits and dashes"><Input value={f.sku} onChange={(e) => setF({ ...f, sku: e.target.value.toUpperCase() })} disabled={!!product} /></Field>
          <Field label="Barcode (EAN / UPC / internal)" hint="Leave blank and generate an internal barcode later"><Input value={f.barcode} onChange={set('barcode')} /></Field>
          <Field label="Product name" required className="sm:col-span-2"><Input value={f.name} onChange={set('name')} /></Field>
          <Field label="Category"><Select value={f.categoryId} onChange={set('categoryId')}><option value="">—</option>{categories.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
          <Field label="Brand"><Input value={f.brand} onChange={set('brand')} /></Field>
          <Field label="Description" className="sm:col-span-2"><Textarea value={f.description} onChange={set('description')} /></Field>
        </fieldset>
        <fieldset className="grid gap-4 sm:grid-cols-3">
          <legend className="col-span-full mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">Units</legend>
          <Field label="Base unit"><Select value={f.uom} onChange={set('uom')}>{units.map((u) => <option key={u}>{u}</option>)}</Select></Field>
          <Field label="Purchase unit"><Select value={f.purchaseUom} onChange={set('purchaseUom')}>{units.map((u) => <option key={u}>{u}</option>)}</Select></Field>
          <Field label="Sales unit"><Select value={f.salesUom} onChange={set('salesUom')}>{units.map((u) => <option key={u}>{u}</option>)}</Select></Field>
          <Field label="Base units per purchase unit" hint="e.g. 12 pcs per carton"><Input type="number" min={1} value={f.conversionFactor} onChange={set('conversionFactor')} /></Field>
          <Field label="Units per pallet" hint="Used for pallet capacity & billing"><Input type="number" min={0} value={f.unitsPerPallet} onChange={set('unitsPerPallet')} /></Field>
          <Field label="Temperature"><Select value={f.temperatureClass} onChange={set('temperatureClass')}><option value="ambient">Ambient</option><option value="chilled">Chilled</option><option value="frozen">Frozen</option></Select></Field>
        </fieldset>
        <fieldset className="grid gap-4 sm:grid-cols-4">
          <legend className="col-span-full mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">Dimensions (per base unit)</legend>
          <Field label="Weight kg"><Input type="number" step="any" min={0} value={f.weightKg} onChange={set('weightKg')} /></Field>
          <Field label="Length cm"><Input type="number" step="any" min={0} value={f.lengthCm} onChange={set('lengthCm')} /></Field>
          <Field label="Width cm"><Input type="number" step="any" min={0} value={f.widthCm} onChange={set('widthCm')} /></Field>
          <Field label="Height cm"><Input type="number" step="any" min={0} value={f.heightCm} onChange={set('heightCm')} /></Field>
          {volume > 0 && <p className="col-span-full -mt-2 text-xs text-ink-500">Volume {volume.toFixed(4)} m³ — used for cubic utilisation and putaway.</p>}
        </fieldset>
        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="col-span-full mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">Pricing & tax</legend>
          {can('finance.view') && <Field label="Cost price" hint="Updated automatically to a moving average on receipt"><Input type="number" step="any" min={0} value={f.costPrice} onChange={set('costPrice')} /></Field>}
          <Field label="Selling price"><Input type="number" step="any" min={0} value={f.sellingPrice} onChange={set('sellingPrice')} /></Field>
          <Field label="Tax rate"><Select value={f.taxRateId} onChange={set('taxRateId')}><option value="">Company default</option>{taxes.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
          <Field label="Default supplier"><Select value={f.defaultSupplierId} onChange={set('defaultSupplierId')}><option value="">—</option>{suppliers.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
        </fieldset>
        <fieldset className="grid gap-4 sm:grid-cols-4">
          <legend className="col-span-full mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">Stock levels</legend>
          <Field label="Minimum"><Input type="number" min={0} value={f.minStock} onChange={set('minStock')} /></Field>
          <Field label="Reorder level"><Input type="number" min={0} value={f.reorderLevel} onChange={set('reorderLevel')} /></Field>
          <Field label="Reorder qty"><Input type="number" min={0} value={f.reorderQty} onChange={set('reorderQty')} /></Field>
          <Field label="Maximum"><Input type="number" min={0} value={f.maxStock} onChange={set('maxStock')} /></Field>
        </fieldset>
        <fieldset className="space-y-3">
          <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">Tracking</legend>
          <Checkbox label="Batch / lot tracking" hint="Receivers must enter a batch number; picking follows FEFO." checked={f.trackBatch} onChange={(v) => setF({ ...f, trackBatch: v })} />
          <Checkbox label="Expiry tracking" hint="Receivers enter expiry dates; alerts before expiry; expired stock is blocked from picking." checked={f.trackExpiry} onChange={(v) => setF({ ...f, trackExpiry: v, trackBatch: v || f.trackBatch })} />
          <Checkbox label="Serial number tracking" hint="Every unit is scanned in and out individually." checked={f.trackSerial} onChange={(v) => setF({ ...f, trackSerial: v })} />
          {product && <Field label="Status"><Select value={f.status} onChange={set('status')} className="w-48"><option value="active">Active</option><option value="inactive">Inactive</option><option value="discontinued">Discontinued</option></Select></Field>}
        </fieldset>
      </div>
    </Drawer>
  );
}

export function ProductDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [tab, setTab] = useState('stock');
  const [edit, setEdit] = useState(false);
  const [labels, setLabels] = useState(false);
  const { data: p, isLoading, error, refetch } = useQuery({ queryKey: ['product', id], queryFn: () => api.get<any>(`/products/${id}`) });
  const genBarcode = useMutation({ mutationFn: (unitQty: number) => api.post(`/products/${id}/barcodes`, { generate: true, unitQty }), onSuccess: () => { toast.success('Internal barcode generated'); qc.invalidateQueries({ queryKey: ['product', id] }); } });
  if (error) return <Card><ErrorState error={error} onRetry={refetch} /></Card>;
  if (isLoading || !p) return <div className="space-y-4"><Skeleton className="h-16 w-1/2" /><Skeleton className="h-40" /><Skeleton className="h-80" /></div>;
  const totals = (p.stock as any[]).reduce((acc, s) => { acc[s.status] = (acc[s.status] ?? 0) + s.quantity; acc.all += s.quantity; return acc; }, { all: 0 } as Record<string, number>);
  return (
    <div>
      <PageHeader back={{ to: '/products', label: 'Products' }} title={p.name}
        description={<span className="flex flex-wrap items-center gap-2"><span className="font-mono">{p.sku}</span>{p.brand && <span>· {p.brand}</span>}<StatusBadge status={p.status} />{p.trackBatch && <Badge tone="blue">Batch</Badge>}{p.trackExpiry && <Badge tone="amber">Expiry</Badge>}{p.trackSerial && <Badge tone="violet">Serial</Badge>}</span>}
        actions={<>
          <Button onClick={() => setLabels(true)}><Printer /> Print labels</Button>
          {can('product.manage') && <Button variant="primary" onClick={() => setEdit(true)}><Pencil /> Edit</Button>}
        </>} />
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <StatCard label="On hand" value={qty(totals.all)} sub={p.uom} />
        <StatCard label="Available" value={qty(totals.available ?? 0)} tone={(totals.available ?? 0) <= p.reorderLevel ? 'warn' : 'good'} sub={`reorder at ${qty(p.reorderLevel)}`} />
        <StatCard label="Reserved" value={qty(totals.reserved ?? 0)} />
        <StatCard label="Avg daily demand" value={qty(p.velocity.avgDailyDemand)} sub={`${qty(p.velocity.dispatched30d)} shipped in 30 days`} />
        <StatCard label="Days of cover" value={p.velocity.avgDailyDemand > 0 ? Math.round((totals.available ?? 0) / p.velocity.avgDailyDemand) : '—'} sub="estimate at current demand" />
        {can('finance.view') ? <StatCard label="Stock value" value={money(totals.all * p.costPrice, { compact: true })} sub={`avg cost ${money(p.costPrice)}`} /> : <StatCard label="Price" value={money(p.sellingPrice)} />}
      </div>
      <Tabs value={tab} onValueChange={setTab} tabs={[{ value: 'stock', label: 'Stock by location', count: p.stock.length }, { value: 'movements', label: 'Movements' }, { value: 'batches', label: 'Batches', count: p.batches.length }, { value: 'barcodes', label: 'Barcodes', count: p.barcodes.length }, { value: 'details', label: 'Details' }]} />
      <div className="mt-4">
        {tab === 'stock' && <Card><Table rows={p.stock} empty={<EmptyState title="No stock on hand" description="Receive this product to see where it is stored." />} columns={[
          { key: 'w', header: 'Warehouse', cell: (s: any) => s.warehouseName },
          { key: 'l', header: 'Location', cell: (s: any) => <span className="font-mono text-xs font-medium">{s.locationCode}</span> },
          { key: 'status', header: 'Status', cell: (s: any) => <StatusBadge status={s.status} /> },
          { key: 'b', header: 'Batch', cell: (s: any) => s.batchNo ? `${s.batchNo}${s.expiryDate ? ` · exp ${date(s.expiryDate)}` : ''}` : '—' },
          { key: 'o', header: 'Owner', cell: (s: any) => s.ownerName ?? 'Company' },
          { key: 'q', header: 'Quantity', align: 'right', cell: (s: any) => <span className="num font-semibold">{qty(s.quantity)}</span> },
        ]} /></Card>}
        {tab === 'movements' && <Card><Table rows={p.movements} dense empty={<EmptyState title="No movements yet" />} columns={[
          { key: 'd', header: 'When', cell: (m: any) => dateTime(m.createdAt) },
          { key: 't', header: 'Movement', cell: (m: any) => <div><Badge tone={m.quantity > 0 ? 'green' : 'gray'}>{humanize(m.type)}</Badge><div className="text-xs text-ink-500">{m.referenceNo}</div></div> },
          { key: 'l', header: 'Location', cell: (m: any) => <span className="font-mono text-xs">{m.warehouseCode} · {m.locationCode}</span> },
          { key: 's', header: 'Status', cell: (m: any) => <StatusBadge status={m.status} /> },
          { key: 'q', header: 'Qty', align: 'right', cell: (m: any) => <span className="num font-semibold">{m.quantity > 0 ? '+' : ''}{qty(m.quantity)}</span> },
          { key: 'b', header: 'Balance', align: 'right', cell: (m: any) => <span className="num text-ink-500">{qty(m.balanceAfter)}</span> },
          { key: 'u', header: 'By', cell: (m: any) => m.performedBy ?? 'System' },
        ]} /><div className="border-t border-ink-100 px-4 py-3 text-right"><Link to={`/inventory?tab=ledger&productId=${p.id}`} className="text-xs font-medium text-brand-700">Full ledger →</Link></div></Card>}
        {tab === 'batches' && <Card><Table rows={p.batches} empty={<EmptyState title="No batches" description={p.trackBatch ? 'Batches are created on receipt.' : 'This product is not batch-tracked.'} />} columns={[
          { key: 'n', header: 'Batch', cell: (b: any) => <span className="font-mono">{b.batch_no}</span> },
          { key: 'm', header: 'Mfg', cell: (b: any) => date(b.mfg_date) },
          { key: 'e', header: 'Expiry', cell: (b: any) => date(b.expiry_date) },
          { key: 's', header: 'Status', cell: (b: any) => <StatusBadge status={b.status} /> },
          { key: 'q', header: 'On hand', align: 'right', cell: (b: any) => <span className="num font-semibold">{qty(b.on_hand)}</span> },
        ]} /></Card>}
        {tab === 'barcodes' && (
          <Card>
            <CardHeader title="Barcodes" description="Scanning any of these identifies the product. Pack barcodes count several units per scan." actions={can('product.manage') && <><Button size="sm" onClick={() => genBarcode.mutate(1)} loading={genBarcode.isPending}><BarcodeIcon /> Generate internal barcode</Button></>} />
            {p.barcodes.length ? (
              <div className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
                {p.barcodes.map((b: any) => (
                  <div key={b.id} className="rounded-xl border border-ink-200 p-4 text-center">
                    <Barcode value={b.barcode} type={b.symbology === 'ean13' ? 'ean13' : 'code128'} />
                    <div className="mt-2 flex justify-center gap-1"><Badge>{b.symbology.toUpperCase()}</Badge>{b.isPrimary && <Badge tone="teal">Primary</Badge>}{b.unitQty !== 1 && <Badge tone="violet">{qty(b.unitQty)} units / scan</Badge>}</div>
                  </div>
                ))}
              </div>
            ) : <EmptyState icon={BarcodeIcon} title="No barcode" description="Generate an internal EAN-13 barcode and print labels for unmarked goods." />}
          </Card>
        )}
        {tab === 'details' && (
          <Card className="p-5">
            <KeyValue cols={4} items={[
              ['Category', p.categoryId ? '' : '—'], ['Unit', `${p.uom} (buy ${p.purchaseUom}, sell ${p.salesUom})`], ['Conversion', `${qty(p.conversionFactor)} ${p.uom} per ${p.purchaseUom}`], ['Temperature', humanize(p.temperatureClass)],
              ['Weight', `${qty(p.weightKg, 3)} kg`], ['Dimensions', `${qty(p.lengthCm)} × ${qty(p.widthCm)} × ${qty(p.heightCm)} cm`], ['Volume', `${qty(p.volumeM3, 4)} m³`], ['Units per pallet', qty(p.unitsPerPallet)],
              ['Min / max', `${qty(p.minStock)} / ${qty(p.maxStock)}`], ['Reorder level / qty', `${qty(p.reorderLevel)} / ${qty(p.reorderQty)}`], ['Selling price', money(p.sellingPrice)], ['Last dispatch', date(p.velocity.lastDispatchAt)],
            ]} />
            {p.description && <p className="mt-4 text-sm text-ink-600">{p.description}</p>}
            {p.variants.length > 0 && <div className="mt-4"><div className="text-xs font-semibold text-ink-500">Variants</div><div className="mt-1 flex flex-wrap gap-2">{p.variants.map((v: any) => <Link key={v.id} to={`/products/${v.id}`}><Badge tone="blue">{v.sku}</Badge></Link>)}</div></div>}
          </Card>
        )}
      </div>
      {edit && <ProductForm product={p} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); refetch(); }} />}
      {labels && <LabelDialog onClose={() => setLabels(false)} items={[{ code: p.barcode ?? p.sku, title: p.name, sub: `${p.sku} · ${money(p.sellingPrice)}`, symbology: p.barcode && /^\d{13}$/.test(p.barcode) ? 'ean13' : 'code128' }]} />}
    </div>
  );
}

/** Printable label sheet (product, location, package). Uses the browser print dialog. */
export function LabelDialog({ items, onClose, title = 'Print labels' }: { items: { code: string; title: string; sub?: string; symbology?: 'code128' | 'ean13' | 'qrcode' }[]; onClose: () => void; title?: string }) {
  const [copies, setCopies] = useState(items.length > 1 ? 1 : 6);
  const [kind, setKind] = useState<'barcode' | 'qrcode'>('barcode');
  useEffect(() => { document.body.classList.add('printing-labels'); return () => document.body.classList.remove('printing-labels'); }, []);
  const all = items.flatMap((it) => Array.from({ length: copies }, () => it));
  return (
    <Dialog open onOpenChange={onClose} title={title} size="xl"
      footer={<><Button onClick={onClose}>Close</Button><Button variant="primary" onClick={() => window.print()}><Printer /> Print</Button></>}>
      <div className="no-print mb-4 flex flex-wrap gap-4">
        <Field label="Copies of each"><Input type="number" min={1} max={100} value={copies} onChange={(e) => setCopies(Math.max(1, Number(e.target.value)))} className="w-24" /></Field>
        <Field label="Symbol"><Select value={kind} onChange={(e) => setKind(e.target.value as never)} className="w-40"><option value="barcode">Barcode</option><option value="qrcode">QR code</option></Select></Field>
        <p className="self-end text-xs text-ink-500">Labels are 50 × 25 mm. Choose your label printer in the print dialog.</p>
      </div>
      <div className="print-area label-sheet">
        {all.map((it, i) => (
          <div key={i} className="label flex flex-col items-center justify-center rounded border border-dashed border-ink-300 p-1.5 text-center">
            <div className="w-full truncate text-[9px] font-semibold leading-tight">{it.title}</div>
            <Barcode value={it.code} type={kind === 'qrcode' ? 'qrcode' : it.symbology ?? 'code128'} height={8} scale={kind === 'qrcode' ? 2 : 1} className="my-0.5" />
            {it.sub && <div className="w-full truncate text-[8px] text-ink-600">{it.sub}</div>}
          </div>
        ))}
      </div>
    </Dialog>
  );
}
