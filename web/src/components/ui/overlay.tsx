import { useState, type ReactNode } from 'react';
import * as D from '@radix-ui/react-dialog';
import * as M from '@radix-ui/react-dropdown-menu';
import * as T from '@radix-ui/react-tabs';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button, Field, Textarea } from './core';

export function Dialog({ open, onOpenChange, title, description, children, footer, size = 'md' }: { open: boolean; onOpenChange: (v: boolean) => void; title: ReactNode; description?: ReactNode; children: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  const width = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' }[size];
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-ink-900/40 backdrop-blur-[2px] animate-fade-in" />
        <D.Content className={cn('fixed left-1/2 top-[6vh] z-50 flex max-h-[88vh] w-[calc(100vw-1.5rem)] -translate-x-1/2 flex-col rounded-2xl bg-white shadow-pop animate-slide-up', width)}>
          <div className="flex items-start justify-between gap-4 border-b border-ink-100 px-5 py-4">
            <div><D.Title className="text-base font-semibold text-ink-900">{title}</D.Title>{description && <D.Description className="mt-0.5 text-sm text-ink-500">{description}</D.Description>}</div>
            <D.Close className="rounded-md p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700" aria-label="Close"><X className="size-4" /></D.Close>
          </div>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-ink-100 bg-ink-50/60 px-5 py-3 rounded-b-2xl">{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

export function Drawer({ open, onOpenChange, title, children, footer, side = 'right' }: { open: boolean; onOpenChange: (v: boolean) => void; title: ReactNode; children: ReactNode; footer?: ReactNode; side?: 'right' | 'left' }) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-ink-900/30 animate-fade-in" />
        <D.Content className={cn('fixed top-0 z-50 flex h-full w-full max-w-xl flex-col bg-white shadow-pop', side === 'right' ? 'right-0' : 'left-0')}>
          <div className="flex items-center justify-between border-b border-ink-100 px-5 py-4">
            <D.Title className="text-base font-semibold">{title}</D.Title>
            <D.Close className="rounded-md p-1 text-ink-400 hover:bg-ink-100" aria-label="Close"><X className="size-4" /></D.Close>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-ink-100 px-5 py-3">{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

/** Confirmation for irreversible / consequential actions. Optional required reason. */
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel = 'Confirm', tone = 'primary', reason, onConfirm }: {
  open: boolean; onOpenChange: (v: boolean) => void; title: string; description?: ReactNode; confirmLabel?: string; tone?: 'primary' | 'danger';
  reason?: { label: string; placeholder?: string; required?: boolean }; onConfirm: (reason: string) => Promise<unknown> | void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const disabled = reason?.required && text.trim().length < 3;
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) { onOpenChange(v); if (!v) setText(''); } }} title={title} description={description} size="sm"
      footer={<>
        <Button onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
        <Button variant={tone} loading={busy} disabled={disabled} onClick={async () => { setBusy(true); try { await onConfirm(text.trim()); onOpenChange(false); setText(''); } finally { setBusy(false); } }}>{confirmLabel}</Button>
      </>}>
      {reason ? <Field label={reason.label} required={reason.required}><Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={reason.placeholder} autoFocus /></Field> : <p className="text-sm text-ink-600">This action will be recorded in the audit trail.</p>}
    </Dialog>
  );
}

export function Menu({ trigger, items }: { trigger: ReactNode; items: ({ label: string; icon?: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean } | 'separator')[] }) {
  return (
    <M.Root>
      <M.Trigger asChild>{trigger}</M.Trigger>
      <M.Portal>
        <M.Content align="end" sideOffset={6} className="z-50 min-w-48 rounded-xl border border-ink-200 bg-white p-1 shadow-pop animate-fade-in">
          {items.map((it, i) => it === 'separator'
            ? <M.Separator key={i} className="my-1 h-px bg-ink-100" />
            : <M.Item key={i} disabled={it.disabled} onSelect={it.onSelect} className={cn('flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm outline-none data-[highlighted]:bg-ink-100 data-[disabled]:opacity-40 [&_svg]:size-4', it.danger ? 'text-red-600' : 'text-ink-700')}>{it.icon}{it.label}</M.Item>)}
        </M.Content>
      </M.Portal>
    </M.Root>
  );
}

export function Tabs({ value, onValueChange, tabs, children }: { value: string; onValueChange: (v: string) => void; tabs: { value: string; label: ReactNode; count?: number }[]; children?: ReactNode }) {
  return (
    <T.Root value={value} onValueChange={onValueChange}>
      <T.List className="scrollbar-thin -mb-px flex gap-1 overflow-x-auto border-b border-ink-200">
        {tabs.map((t) => (
          <T.Trigger key={t.value} value={t.value} className="flex items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3 py-2.5 text-sm font-medium text-ink-500 hover:text-ink-800 data-[state=active]:border-brand-600 data-[state=active]:text-brand-800">
            {t.label}{t.count !== undefined && <span className="rounded-full bg-ink-100 px-1.5 text-[11px] text-ink-600">{t.count}</span>}
          </T.Trigger>
        ))}
      </T.List>
      {children}
    </T.Root>
  );
}
