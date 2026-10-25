import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Camera, CameraOff, ChevronDown, ScanLine, X } from 'lucide-react';
import { toSVG } from 'bwip-js/browser';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button, Input, Spinner } from './core';

export function PageHeader({ title, description, actions, back, children }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; back?: { to: string; label: string }; children?: ReactNode }) {
  return (
    <div className="mb-6">
      {back && <Link to={back.to} className="mb-2 inline-flex items-center gap-1 text-xs font-medium text-ink-500 hover:text-brand-700">← {back.label}</Link>}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
          {description && <p className="mt-1 text-sm text-ink-500">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

export function StatCard({ label, value, sub, icon: Icon, tone = 'default', to, action }: { label: string; value: ReactNode; sub?: ReactNode; icon?: React.ComponentType<{ className?: string }>; tone?: 'default' | 'warn' | 'danger' | 'good'; to?: string; action?: string }) {
  const toneCls = { default: 'bg-brand-50 text-brand-700', warn: 'bg-amber-50 text-amber-700', danger: 'bg-red-50 text-red-600', good: 'bg-emerald-50 text-emerald-700' }[tone];
  const body = (
    <div className={cn('card flex h-full flex-col p-4 transition', to && 'hover:border-brand-300 hover:shadow-md')}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-medium text-ink-500">{label}</span>
        {Icon && <span className={cn('grid size-8 place-items-center rounded-lg', toneCls)}><Icon className="size-4" /></span>}
      </div>
      <div className="num mt-1 text-2xl font-semibold tracking-tight text-ink-900">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-ink-500">{sub}</div>}
      {to && action && <div className="mt-auto pt-3 text-xs font-medium text-brand-700 inline-flex items-center gap-1">{action} <ArrowRight className="size-3" /></div>}
    </div>
  );
  return to ? <Link to={to} className="block">{body}</Link> : body;
}

export function KeyValue({ items, cols = 2 }: { items: [string, ReactNode][]; cols?: 2 | 3 | 4 }) {
  return (
    <dl className={cn('grid gap-x-6 gap-y-3 text-sm', cols === 2 ? 'sm:grid-cols-2' : cols === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2 lg:grid-cols-4')}>
      {items.map(([k, v]) => <div key={k}><dt className="text-xs text-ink-500">{k}</dt><dd className="mt-0.5 font-medium text-ink-800">{v ?? '—'}</dd></div>)}
    </dl>
  );
}

/** Renders Code 128 / EAN-13 / QR as crisp SVG for screens and printed labels. */
export function Barcode({ value, type = 'code128', height = 12, scale = 2, text = true, className }: { value: string; type?: 'code128' | 'ean13' | 'qrcode' | 'upca' | 'ean8'; height?: number; scale?: number; text?: boolean; className?: string }) {
  const svg = useMemo(() => {
    try {
      const bcid = type === 'ean13' && !/^\d{12,13}$/.test(value) ? 'code128' : type;
      return toSVG({ bcid, text: value, scale, height: bcid === 'qrcode' ? undefined : height, includetext: text && bcid !== 'qrcode', textxalign: 'center', paddingwidth: 2, paddingheight: 2 } as never);
    } catch { return ''; }
  }, [value, type, height, scale, text]);
  if (!svg) return <span className="text-xs text-red-600">Invalid barcode</span>;
  return <span className={cn('inline-block [&>svg]:h-auto [&>svg]:max-w-full', className)} dangerouslySetInnerHTML={{ __html: svg }} />;
}

function feedback(ok: boolean) {
  try {
    navigator.vibrate?.(ok ? 40 : [80, 60, 80]);
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    o.frequency.value = ok ? 880 : 220;
    o.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + (ok ? 0.08 : 0.25));
  } catch { /* feedback is best-effort */ }
}
export const scanFeedback = feedback;

/**
 * Scan input for warehouse floors. Works with:
 *  - hardware/Bluetooth scanners (keyboard wedge: types the code and presses Enter)
 *  - the phone camera (EAN, UPC, Code 128, QR via ZXing)
 *  - manual typing
 */
export function ScanInput({ onScan, placeholder = 'Scan or type a code', autoFocus = true, large, label, disabled }: { onScan: (code: string) => void | Promise<void>; placeholder?: string; autoFocus?: boolean; large?: boolean; label?: string; disabled?: boolean }) {
  const [value, setValue] = useState('');
  const [camera, setCamera] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const submit = async (code: string) => {
    const c = code.trim();
    if (!c) return;
    setBusy(true);
    try { await onScan(c); setValue(''); } finally { setBusy(false); inputRef.current?.focus(); }
  };
  return (
    <div className="space-y-2">
      {label && <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">{label}</div>}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <ScanLine className={cn('pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400', large ? 'size-6' : 'size-4')} />
          <Input ref={inputRef} autoFocus={autoFocus} disabled={disabled || busy} value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} inputMode="text" autoComplete="off" autoCapitalize="characters"
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submit(value); } }}
            className={cn(large ? 'h-14 pl-11 text-lg' : 'pl-9')} />
          {busy && <Spinner className="absolute right-3 top-1/2 -translate-y-1/2" />}
        </div>
        <Button type="button" size={large ? 'lg' : 'md'} variant={camera ? 'primary' : 'secondary'} onClick={() => setCamera((v) => !v)} aria-label="Use camera" className={large ? 'h-14 w-14 px-0' : ''}>{camera ? <CameraOff /> : <Camera />}</Button>
      </div>
      {camera && <CameraScanner onResult={(code) => { setCamera(false); void submit(code); }} onClose={() => setCamera(false)} />}
    </div>
  );
}

function CameraScanner({ onResult, onClose }: { onResult: (code: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      try {
        const { BrowserMultiFormatReader } = await import('@zxing/browser');
        const reader = new BrowserMultiFormatReader();
        const controls = await reader.decodeFromVideoDevice(undefined, videoRef.current!, (result) => {
          if (result && !cancelled) { cancelled = true; feedback(true); controls.stop(); onResult(result.getText()); }
        });
        stop = () => controls.stop();
      } catch (e) {
        setError(e instanceof Error && e.name === 'NotAllowedError' ? 'Camera permission was denied. Allow camera access or type the code.' : 'Camera not available on this device. Use a scanner or type the code.');
      }
    })();
    return () => { cancelled = true; stop?.(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="relative overflow-hidden rounded-xl bg-ink-900">
      {error ? <p className="p-4 text-sm text-white">{error}</p> : <video ref={videoRef} className="aspect-video w-full object-cover" muted playsInline />}
      <div className="pointer-events-none absolute inset-x-8 top-1/2 h-0.5 -translate-y-1/2 bg-red-500/80 shadow-[0_0_12px_rgba(239,68,68,0.9)]" />
      <button onClick={onClose} className="absolute right-2 top-2 rounded-full bg-black/50 p-1.5 text-white" aria-label="Close camera"><X className="size-4" /></button>
    </div>
  );
}

export interface PickerOption { id: string; label: string; sub?: string; raw?: any }

/** Async searchable select for products, customers, suppliers, locations, users… */
export function EntityPicker({ value, onChange, endpoint, map, placeholder = 'Search…', params, disabled, initialLabel }: {
  value: string | null; onChange: (id: string | null, option?: PickerOption) => void; endpoint: string; map: (row: any) => PickerOption;
  placeholder?: string; params?: Record<string, string | number | undefined>; disabled?: boolean; initialLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [label, setLabel] = useState(initialLabel ?? '');
  const ref = useRef<HTMLDivElement>(null);
  const { data, isFetching } = useQuery({
    queryKey: ['picker', endpoint, q, params],
    queryFn: async () => { const res = await api.page<any>(endpoint, { q: q || undefined, pageSize: 20, ...params }); return (Array.isArray(res.data) ? res.data : []).map(map); },
    enabled: open,
  });
  useEffect(() => { if (!value) setLabel(''); }, [value]);
  useEffect(() => { if (initialLabel) setLabel(initialLabel); }, [initialLabel]);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  return (
    <div className="relative" ref={ref}>
      <button type="button" disabled={disabled} onClick={() => setOpen((v) => !v)} className="flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-ink-200 bg-white px-3 text-left text-sm shadow-sm hover:border-ink-300 disabled:bg-ink-50">
        <span className={cn('truncate', !label && 'text-ink-400')}>{label || placeholder}</span>
        <ChevronDown className="size-4 shrink-0 text-ink-400" />
      </button>
      {open && (
        <div className="absolute z-40 mt-1 w-full min-w-64 rounded-xl border border-ink-200 bg-white p-1.5 shadow-pop">
          <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type to search" className="mb-1 h-8" />
          <div className="max-h-64 overflow-y-auto">
            {isFetching && !data && <div className="p-3"><Spinner /></div>}
            {data?.length === 0 && <div className="p-3 text-sm text-ink-500">No matches</div>}
            {data?.map((o) => (
              <button type="button" key={o.id} onClick={() => { onChange(o.id, o); setLabel(o.label); setOpen(false); setQ(''); }} className={cn('flex w-full flex-col rounded-lg px-2.5 py-1.5 text-left hover:bg-ink-100', o.id === value && 'bg-brand-50')}>
                <span className="text-sm text-ink-800">{o.label}</span>{o.sub && <span className="text-xs text-ink-500">{o.sub}</span>}
              </button>
            ))}
          </div>
          {value && <button type="button" onClick={() => { onChange(null); setLabel(''); setOpen(false); }} className="mt-1 w-full rounded-lg px-2.5 py-1.5 text-left text-xs text-ink-500 hover:bg-ink-100">Clear selection</button>}
        </div>
      )}
    </div>
  );
}

export function Section({ title, description, children, actions }: { title: string; description?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="grid gap-4 py-6 first:pt-0 md:grid-cols-3 border-b border-ink-100 last:border-0">
      <div><h3 className="text-sm font-semibold">{title}</h3>{description && <p className="mt-1 text-xs text-ink-500">{description}</p>}{actions && <div className="mt-3">{actions}</div>}</div>
      <div className="md:col-span-2">{children}</div>
    </section>
  );
}
