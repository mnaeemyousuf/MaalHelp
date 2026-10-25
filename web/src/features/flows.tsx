import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertOctagon, Box, CheckCircle2, MapPin, Minus, Package, Plus, Printer, RotateCcw, XCircle } from 'lucide-react';
import { api, ApiError, errorMessage } from '@/lib/api';
import { cn, qty } from '@/lib/utils';
import { Badge, Button, Card, Field, Input, Select, Skeleton, Textarea } from '@/components/ui/core';
import { ScanInput, scanFeedback } from '@/components/ui/blocks';

/** Step-by-step pick: SCAN LOCATION → SCAN PRODUCT → QUANTITY → CONFIRM. */
export function PickFlow({ task, onDone, large }: { task: any; onDone: () => void; large?: boolean }) {
  const qc = useQueryClient();
  const remaining = task.quantity - task.pickedQty;
  const [step, setStep] = useState<'location' | 'product' | 'qty'>('location');
  const [locationCode, setLocationCode] = useState('');
  const [productCode, setProductCode] = useState('');
  const [quantity, setQuantity] = useState(remaining);
  const [serials, setSerials] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [short, setShort] = useState(false);
  const [shortReason, setShortReason] = useState('');
  const [key] = useState(() => crypto.randomUUID());
  const confirm = useMutation({
    meta: { silent: true },
    mutationFn: () => api.post<any>(`/picking/tasks/${task.id}/confirm`, { locationCode, productCode, quantity, serials: serials.split(/[\s,]+/).filter(Boolean) }, { idempotencyKey: key, queueOffline: { label: `Pick ${task.sku} ×${quantity} (${task.orderNumber})` } }),
    onSuccess: (r) => {
      scanFeedback(true);
      if (r?.queued) toast.info('Saved offline — will sync when connected.'); else toast.success(r.orderReadyToPack ? `Picked. ${task.orderNumber} is ready to pack.` : `Picked ${qty(quantity)} × ${task.sku}`);
      qc.invalidateQueries(); onDone();
    },
    onError: (err) => {
      scanFeedback(false);
      const e = err as ApiError;
      setError(e.message);
      if (e.code === 'WRONG_LOCATION') { setStep('location'); setLocationCode(''); }
      if (e.code === 'WRONG_PRODUCT') { setStep('product'); setProductCode(''); }
    },
  });
  const shortPick = useMutation({ mutationFn: () => api.post<any>(`/picking/tasks/${task.id}/short`, { reason: shortReason }), onSuccess: (r) => { toast.warning(`Short pick recorded. ${r.rereserved ? `${r.rereserved} unit(s) re-reserved elsewhere.` : 'Stock blocked pending a count.'}`); qc.invalidateQueries(); onDone(); } });

  const big = large ? 'text-2xl' : 'text-lg';
  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-ink-900 p-5 text-white">
        <div className="flex items-center justify-between text-xs text-ink-300"><span>{task.orderNumber} · {task.customerName}</span>{task.priority !== 'normal' && <Badge tone={task.priority === 'urgent' ? 'red' : 'amber'}>{task.priority}</Badge>}</div>
        <div className="mt-3 flex items-center gap-3"><MapPin className="size-6 text-brand-300" /><span className={cn('font-mono font-bold tracking-wide', large ? 'text-4xl' : 'text-3xl')}>{task.locationCode}</span></div>
        <div className="mt-3 text-sm text-ink-200">{task.productName}</div>
        <div className="mt-1 flex items-center justify-between"><span className="font-mono text-ink-300">{task.sku}{task.batchNo ? ` · batch ${task.batchNo}` : ''}</span><span className={cn('font-bold', big)}>Qty {qty(remaining)} <span className="text-sm font-normal text-ink-300">{task.uom}</span></span></div>
      </div>
      <ol className="grid grid-cols-3 gap-2 text-center text-xs font-semibold">
        {(['location', 'product', 'qty'] as const).map((s, i) => <li key={s} className={cn('rounded-lg py-2', step === s ? 'bg-brand-700 text-white' : (['location', 'product', 'qty'].indexOf(step) > i ? 'bg-brand-100 text-brand-800' : 'bg-ink-100 text-ink-500'))}>{i + 1}. {s === 'location' ? 'Scan location' : s === 'product' ? 'Scan product' : 'Quantity'}</li>)}
      </ol>
      {error && <div role="alert" className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-700"><XCircle className="mt-0.5 size-5 shrink-0" />{error}</div>}
      {step === 'location' && <ScanInput large={large} label={`Scan the location label at ${task.locationCode}`} onScan={(c) => { setError(null); setLocationCode(c); setStep('product'); }} />}
      {step === 'product' && <ScanInput large={large} label={`Scan ${task.sku}`} onScan={(c) => { setError(null); setProductCode(c); setStep('qty'); }} />}
      {step === 'qty' && (
        <Card className="space-y-4 p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">Quantity picked</div>
          <div className="flex items-center gap-3">
            <Button size={large ? 'xl' : 'lg'} onClick={() => setQuantity((q) => Math.max(1, q - 1))} aria-label="Less"><Minus /></Button>
            <Input type="number" inputMode="decimal" value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} className={cn('text-center font-bold', large ? 'h-16 text-3xl' : 'h-12 text-2xl')} />
            <Button size={large ? 'xl' : 'lg'} onClick={() => setQuantity((q) => Math.min(remaining, q + 1))} aria-label="More"><Plus /></Button>
          </div>
          {task.trackSerial && <Field label="Serial numbers"><Textarea value={serials} onChange={(e) => setSerials(e.target.value)} placeholder="Scan each serial" /></Field>}
          <Button variant="primary" size={large ? 'xl' : 'lg'} className="w-full" loading={confirm.isPending} disabled={quantity <= 0} onClick={() => { setError(null); confirm.mutate(); }}><CheckCircle2 /> Confirm pick</Button>
        </Card>
      )}
      <div className="flex justify-between">
        <Button variant="ghost" size="sm" onClick={() => { setStep('location'); setLocationCode(''); setProductCode(''); setError(null); }}><RotateCcw /> Start over</Button>
        <Button variant="ghost" size="sm" className="text-amber-700" onClick={() => setShort((v) => !v)}><AlertOctagon /> Can&apos;t find it / short</Button>
      </div>
      {short && (
        <Card className="space-y-3 border-amber-200 bg-amber-50/50 p-4">
          <p className="text-sm text-amber-900">The unpicked {qty(remaining)} unit(s) will be blocked at {task.locationCode} for a cycle count, and the system will try to reserve stock from another location.</p>
          <Field label="What happened?" required><Select value={shortReason} onChange={(e) => setShortReason(e.target.value)}><option value="">Select…</option><option>Location empty</option><option>Not enough units in location</option><option>Product damaged</option><option>Wrong product in location</option></Select></Field>
          <Button variant="danger" loading={shortPick.isPending} disabled={!shortReason} onClick={() => shortPick.mutate()}>Report short pick</Button>
        </Card>
      )}
    </div>
  );
}

/** Packing station: scan every item; ✓ correct product · ✗ wrong product · ✗ excess. */
export function PackStation({ orderId, onDone, large }: { orderId: string; onDone: () => void; large?: boolean }) {
  const qc = useQueryClient();
  const order = useQuery({ queryKey: ['order', orderId], queryFn: () => api.get<any>(`/sales-orders/${orderId}`) });
  const [log, setLog] = useState<{ ok: boolean; message: string }[]>([]);
  const [packages, setPackages] = useState<{ weightKg: number }[]>([{ weightKg: 0 }]);
  const [key] = useState(() => crypto.randomUUID());
  const scan = useMutation({
    mutationFn: (code: string) => api.post<any>(`/packing/${orderId}/scan`, { code }),
    onSuccess: (r) => { scanFeedback(r.result === 'ok'); setLog((l) => [{ ok: r.result === 'ok', message: r.message }, ...l].slice(0, 30)); qc.invalidateQueries({ queryKey: ['order', orderId] }); },
  });
  const reset = useMutation({ mutationFn: () => api.post(`/packing/${orderId}/reset`), onSuccess: () => { setLog([]); qc.invalidateQueries({ queryKey: ['order', orderId] }); } });
  const complete = useMutation({
    mutationFn: () => api.post<any>(`/packing/${orderId}/complete`, { packages }, { idempotencyKey: key }),
    onSuccess: (r) => { toast.success(`Packed — shipment ${r.shipmentNumber} ready to dispatch`); qc.invalidateQueries(); onDone(); },
  });
  if (!order.data) return <Skeleton className="h-80" />;
  const o = order.data;
  const lines = (o.lines as any[]).filter((l) => l.pickedQty > 0);
  const weight = lines.reduce((s, l) => s + l.pickedQty * (l.weightKg ?? 0), 0);
  const allPacked = lines.length > 0 && lines.every((l) => l.packedQty >= l.pickedQty);
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
      <div className="space-y-4">
        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between"><div><div className="text-sm font-semibold">{o.number} · {o.customer?.name}</div><div className="text-xs text-ink-500">{o.shippingAddress}</div></div>{o.priority !== 'normal' && <Badge tone="amber">{o.priority}</Badge>}</div>
          <ScanInput large={large} label="Scan each item into the carton" onScan={(c) => scan.mutateAsync(c).then(() => undefined)} />
        </Card>
        <Card>
          <div className="divide-y divide-ink-100">
            {lines.map((l) => {
              const done = l.packedQty >= l.pickedQty;
              return (
                <div key={l.id} className={cn('flex items-center gap-3 px-4 py-3', done && 'bg-emerald-50/50')}>
                  {done ? <CheckCircle2 className="size-6 text-emerald-600" /> : <Box className="size-6 text-ink-300" />}
                  <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{l.productName}</div><div className="text-xs text-ink-500">{l.sku}</div></div>
                  <div className={cn('num text-lg font-bold', done ? 'text-emerald-700' : 'text-ink-800')}>{qty(l.packedQty)} / {qty(l.pickedQty)}</div>
                </div>
              );
            })}
          </div>
        </Card>
      </div>
      <div className="space-y-4">
        <Card className="p-4">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">Scan results</div>
          <div className="max-h-52 space-y-1.5 overflow-y-auto">{log.length ? log.map((e, i) => <div key={i} className={cn('rounded-lg px-3 py-2 text-sm font-medium', e.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700')}>{e.message}</div>) : <p className="text-sm text-ink-500">Scan items to verify them.</p>}</div>
          {log.length > 0 && <Button size="sm" variant="ghost" className="mt-2" onClick={() => reset.mutate()}><RotateCcw /> Restart verification</Button>}
        </Card>
        <Card className="space-y-3 p-4">
          <div className="flex items-center justify-between"><span className="text-xs font-semibold uppercase tracking-wide text-ink-500">Packages</span><span className="text-xs text-ink-500">est. {qty(weight)} kg</span></div>
          {packages.map((p, i) => (
            <div key={i} className="flex items-center gap-2"><Package className="size-4 text-ink-400" /><span className="w-16 text-sm">Box {i + 1}</span><Input type="number" min={0} step="any" value={p.weightKg} onChange={(e) => setPackages(packages.map((x, j) => (j === i ? { weightKg: Number(e.target.value) } : x)))} className="h-8" aria-label="Weight kg" /><span className="text-xs text-ink-500">kg</span></div>
          ))}
          <div className="flex gap-2"><Button size="sm" onClick={() => setPackages([...packages, { weightKg: 0 }])}><Plus /> Box</Button>{packages.length > 1 && <Button size="sm" variant="ghost" onClick={() => setPackages(packages.slice(0, -1))}><Minus /> Box</Button>}</div>
          <Button variant="primary" size={large ? 'xl' : 'lg'} className="w-full" disabled={!allPacked} loading={complete.isPending} onClick={() => complete.mutate()}><CheckCircle2 /> {allPacked ? 'Close carton & finish packing' : 'Scan all items first'}</Button>
          <div className="flex flex-wrap gap-2 text-xs">
            <Link to={`/print/packing-slip/${orderId}`} target="_blank" className="inline-flex items-center gap-1 text-brand-700"><Printer className="size-3" /> Packing slip</Link>
            <Link to={`/print/shipping-label/${orderId}`} target="_blank" className="inline-flex items-center gap-1 text-brand-700"><Printer className="size-3" /> Shipping labels</Link>
          </div>
        </Card>
      </div>
    </div>
  );
}

export function DispatchForm({ order, onDone }: { order: any; onDone: () => void }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<'own' | 'courier'>('own');
  const [f, setF] = useState({ carrier: 'Own vehicle', vehicleNo: '', driverName: '', driverPhone: '', trackingNumber: '', freightCost: 0, bookWithCarrier: 'tcs' });
  const [key] = useState(() => crypto.randomUUID());
  const m = useMutation({
    mutationFn: () => api.post<any>(`/dispatch/${order.id}`, mode === 'own'
      ? { carrier: f.carrier || 'Own vehicle', vehicleNo: f.vehicleNo, driverName: f.driverName, driverPhone: f.driverPhone, freightCost: f.freightCost }
      : { carrier: ({ tcs: 'TCS', leopards: 'Leopards', mnp: 'M&P', dhl: 'DHL' } as Record<string, string>)[f.bookWithCarrier], trackingNumber: f.trackingNumber, bookWithCarrier: f.trackingNumber ? undefined : f.bookWithCarrier, freightCost: f.freightCost }, { idempotencyKey: key }),
    onSuccess: (r) => { toast.success(`Dispatched · ${r.shipment.number}${r.shipment.trackingNumber ? ` · ${r.shipment.trackingNumber}` : ''} · invoice ${r.invoice.number}`); qc.invalidateQueries(); onDone(); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-ink-100 p-1 text-sm font-medium">{(['own', 'courier'] as const).map((m0) => <button key={m0} onClick={() => setMode(m0)} className={cn('rounded-md py-2', mode === m0 ? 'bg-white shadow-sm' : 'text-ink-500')}>{m0 === 'own' ? 'Own vehicle / transporter' : 'Courier'}</button>)}</div>
      {mode === 'own' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Transporter"><Input value={f.carrier} onChange={(e) => setF({ ...f, carrier: e.target.value })} /></Field>
          <Field label="Vehicle number"><Input value={f.vehicleNo} onChange={(e) => setF({ ...f, vehicleNo: e.target.value.toUpperCase() })} placeholder="KHI-1234" /></Field>
          <Field label="Driver name"><Input value={f.driverName} onChange={(e) => setF({ ...f, driverName: e.target.value })} /></Field>
          <Field label="Driver phone"><Input value={f.driverPhone} onChange={(e) => setF({ ...f, driverPhone: e.target.value })} placeholder="+92 3xx xxxxxxx" /></Field>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Courier"><Select value={f.bookWithCarrier} onChange={(e) => setF({ ...f, bookWithCarrier: e.target.value })}><option value="tcs">TCS</option><option value="leopards">Leopards</option><option value="mnp">M&P</option><option value="dhl">DHL</option></Select></Field>
          <Field label="Tracking number" hint="Leave blank to book through the courier integration (development mock until credentials are added)"><Input value={f.trackingNumber} onChange={(e) => setF({ ...f, trackingNumber: e.target.value })} /></Field>
        </div>
      )}
      <Field label="Freight cost" hint="Counted in warehouse profitability"><Input type="number" min={0} value={f.freightCost} onChange={(e) => setF({ ...f, freightCost: Number(e.target.value) })} className="w-40" /></Field>
      <div className="rounded-lg bg-ink-50 p-3 text-xs text-ink-600">Dispatching removes the packed stock from inventory, records the shipment and issues the sales invoice for the shipped quantities.</div>
      <Button variant="primary" size="lg" className="w-full" loading={m.isPending} onClick={() => m.mutate()}>Dispatch {order.number}</Button>
    </div>
  );
}
