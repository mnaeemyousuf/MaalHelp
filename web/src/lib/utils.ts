import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { CURRENCIES, humanize } from '@shared/domain';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

let currentCurrency = 'PKR';
export function setCurrency(code: string) {
  currentCurrency = code in CURRENCIES ? code : 'PKR';
}
export function currency() {
  return currentCurrency;
}

/** Money in the tenant currency. compact=true gives 4.2M / 180K style. */
export function money(value: unknown, opts: { compact?: boolean; code?: string; decimals?: number } = {}): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return '—';
  const code = opts.code ?? currentCurrency;
  const meta = CURRENCIES[code as keyof typeof CURRENCIES] ?? CURRENCIES.PKR;
  if (opts.compact && Math.abs(n) >= 1000) {
    const units: [number, string][] = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
    const [div, suffix] = units.find(([d]) => Math.abs(n) >= d)!;
    return `${meta.symbol} ${(n / div).toFixed(Math.abs(n / div) >= 100 ? 0 : 1)}${suffix}`;
  }
  return `${meta.symbol} ${n.toLocaleString(meta.locale, { maximumFractionDigits: opts.decimals ?? meta.decimals, minimumFractionDigits: 0 })}`;
}

export function qty(value: unknown, decimals = 2): string {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: decimals }) : '—';
}

export function pct(value: unknown, decimals = 1): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(decimals)}%` : '—';
}

export function date(value: unknown, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }): string {
  if (!value) return '—';
  const d = new Date(String(value).length === 10 ? `${value}T00:00:00` : String(value));
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-GB', opts);
}

export function dateTime(value: unknown): string {
  if (!value) return '—';
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function relativeTime(value: unknown): string {
  if (!value) return '';
  const diff = Date.now() - new Date(typeof value === 'number' ? value : String(value)).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return date(value);
}

export function today(offsetDays = 0): string {
  return new Date(Date.now() + offsetDays * 86400_000).toISOString().slice(0, 10);
}

export { humanize };

export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0]!.toUpperCase()).join('');
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
