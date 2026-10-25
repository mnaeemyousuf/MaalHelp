import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { AlertTriangle, Inbox, Loader2, RefreshCw } from 'lucide-react';
import { cn, humanize } from '@/lib/utils';

// ─────────────── Button ───────────────
const buttonStyles = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-brand-700 text-white shadow-sm hover:bg-brand-800 active:bg-brand-900',
        secondary: 'border border-ink-200 bg-white text-ink-700 shadow-sm hover:bg-ink-50 hover:text-ink-900',
        ghost: 'text-ink-600 hover:bg-ink-100 hover:text-ink-900',
        danger: 'bg-red-600 text-white shadow-sm hover:bg-red-700',
        soft: 'bg-brand-50 text-brand-800 hover:bg-brand-100',
        link: 'text-brand-700 underline-offset-4 hover:underline px-0',
      },
      size: { sm: 'h-8 px-3 text-xs', md: 'h-9 px-3.5 text-sm', lg: 'h-11 px-5 text-base', xl: 'h-16 px-6 text-lg rounded-xl [&_svg]:size-6', icon: 'size-9' },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonStyles> { loading?: boolean }
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, loading, children, disabled, ...props }, ref) => (
  <button ref={ref} className={cn(buttonStyles({ variant, size }), className)} disabled={disabled || loading} {...props}>
    {loading && <Loader2 className="animate-spin" />}
    {children}
  </button>
));
Button.displayName = 'Button';
export { buttonStyles };

// ─────────────── Form controls ───────────────
const field = 'w-full rounded-lg border border-ink-200 bg-white px-3 text-sm text-ink-900 shadow-sm placeholder:text-ink-400 focus:border-brand-500 focus:outline-none focus:ring-3 focus:ring-brand-500/15 disabled:bg-ink-50 disabled:text-ink-500 aria-[invalid=true]:border-red-400';
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...p }, ref) => <input ref={ref} className={cn(field, 'h-9', className)} {...p} />);
Input.displayName = 'Input';
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...p }, ref) => <textarea ref={ref} className={cn(field, 'min-h-20 py-2', className)} {...p} />);
Textarea.displayName = 'Textarea';
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, children, ...p }, ref) => (
  <select ref={ref} className={cn(field, 'h-9 pr-8', className)} {...p}>{children}</select>
));
Select.displayName = 'Select';

export function Field({ label, hint, error, required, children, className }: { label: string; hint?: ReactNode; error?: string; required?: boolean; children: ReactNode; className?: string }) {
  return (
    <label className={cn('flex flex-col gap-1.5', className)}>
      <span className="text-xs font-medium text-ink-600">{label}{required && <span className="text-red-500"> *</span>}</span>
      {children}
      {error ? <span className="text-xs text-red-600">{error}</span> : hint ? <span className="text-xs text-ink-500">{hint}</span> : null}
    </label>
  );
}

export function Checkbox({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 text-sm">
      <input type="checkbox" className="mt-0.5 size-4 rounded border-ink-300 accent-brand-700" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span><span className="text-ink-800">{label}</span>{hint && <span className="block text-xs text-ink-500">{hint}</span>}</span>
    </label>
  );
}

// ─────────────── Card ───────────────
export function Card({ className, children, ...p }: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('card', className)} {...p}>{children}</div>;
}
export function CardHeader({ title, description, actions, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-3 border-b border-ink-100 px-5 py-4', className)}>
      <div className="min-w-0"><h3 className="text-sm font-semibold">{title}</h3>{description && <p className="mt-0.5 text-xs text-ink-500">{description}</p>}</div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

// ─────────────── Badges ───────────────
type Tone = 'gray' | 'green' | 'amber' | 'red' | 'blue' | 'violet' | 'teal';
const tones: Record<Tone, string> = {
  gray: 'bg-ink-100 text-ink-700 ring-ink-200', green: 'bg-emerald-50 text-emerald-700 ring-emerald-200', amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  red: 'bg-red-50 text-red-700 ring-red-200', blue: 'bg-sky-50 text-sky-700 ring-sky-200', violet: 'bg-violet-50 text-violet-700 ring-violet-200', teal: 'bg-brand-50 text-brand-800 ring-brand-200',
};
export function Badge({ tone = 'gray', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset whitespace-nowrap', tones[tone], className)}>{children}</span>;
}

const STATUS_TONES: Record<string, Tone> = {
  // generic lifecycle
  draft: 'gray', pending: 'amber', pending_approval: 'amber', submitted: 'blue', requested: 'blue', approved: 'teal', confirmed: 'blue', reserved: 'violet',
  picking: 'violet', in_progress: 'violet', packed: 'teal', ready: 'teal', dispatched: 'blue', in_transit: 'blue', delivered: 'green', completed: 'green', posted: 'green', received: 'green',
  partially_received: 'amber', fully_received: 'green', closed: 'gray', cancelled: 'gray', rejected: 'red', failed: 'red', returned: 'amber', short: 'red', void: 'gray',
  issued: 'blue', partially_paid: 'amber', paid: 'green', open: 'amber', overdue: 'red', counting: 'violet', assigned: 'blue', review: 'amber',
  // inventory statuses
  available: 'green', damaged: 'red', quarantine: 'amber', expired: 'red', blocked: 'gray',
  // stock state
  low: 'amber', out: 'red', overstock: 'violet', ok: 'green', active: 'green', inactive: 'gray', trial: 'blue', suspended: 'red',
  // severity
  critical: 'red', warning: 'amber', info: 'blue', high: 'amber', urgent: 'red', normal: 'gray', medium: 'blue',
  connected: 'green', disconnected: 'gray', error: 'red', extracted: 'teal', processing: 'violet', uploaded: 'gray',
};
export function StatusBadge({ status, label }: { status: string | null | undefined; label?: string }) {
  if (!status) return <span className="text-ink-400">—</span>;
  return <Badge tone={STATUS_TONES[status] ?? 'gray'}>{label ?? humanize(status)}</Badge>;
}

// ─────────────── States ───────────────
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton', className)} />;
}
export function SkeletonRows({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="divide-y divide-ink-100">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex gap-4 px-4 py-3.5">{Array.from({ length: cols }).map((__, j) => <Skeleton key={j} className={cn('h-4', j === 0 ? 'w-1/4' : 'flex-1')} />)}</div>
      ))}
    </div>
  );
}
export function EmptyState({ icon: Icon = Inbox, title, description, action }: { icon?: React.ComponentType<{ className?: string }>; title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="mb-3 grid size-12 place-items-center rounded-xl bg-ink-100 text-ink-400"><Icon className="size-6" /></div>
      <p className="text-sm font-semibold text-ink-800">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-ink-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Something went wrong while loading this page.';
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <div className="mb-3 grid size-12 place-items-center rounded-xl bg-red-50 text-red-500"><AlertTriangle className="size-6" /></div>
      <p className="text-sm font-semibold text-ink-800">Couldn&apos;t load this data</p>
      <p className="mt-1 max-w-md text-sm text-ink-500">{message}</p>
      {onRetry && <Button className="mt-4" onClick={onRetry}><RefreshCw /> Try again</Button>}
    </div>
  );
}
export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-5 animate-spin text-ink-400', className)} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-ink-200 bg-ink-50 px-1.5 py-0.5 font-sans text-[10px] font-medium text-ink-500">{children}</kbd>;
}

export function Progress({ value, tone }: { value: number; tone?: 'auto' | 'brand' }) {
  const v = Math.max(0, Math.min(100, value));
  const color = tone === 'brand' ? 'bg-brand-600' : v >= 95 ? 'bg-red-500' : v >= 85 ? 'bg-amber-500' : 'bg-brand-600';
  return <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-100"><div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${v}%` }} /></div>;
}
