import { Plus, Trash2 } from 'lucide-react';
import { money, qty } from '@/lib/utils';
import { Badge, Button, Input } from '@/components/ui/core';
import { EntityPicker } from '@/components/ui/blocks';

export interface EditorLine { key: string; productId: string | null; label?: string; quantity: number; price: number; discountPct: number; available?: number; uom?: string }

export const newLine = (): EditorLine => ({ key: crypto.randomUUID(), productId: null, quantity: 1, price: 0, discountPct: 0 });

/** Editable product lines with live totals. `priceField` picks cost (PO) or selling price (SO). */
export function LineEditor({ lines, onChange, priceField, priceLabel, showAvailability }: { lines: EditorLine[]; onChange: (l: EditorLine[]) => void; priceField: 'costPrice' | 'sellingPrice'; priceLabel: string; showAvailability?: boolean }) {
  const set = (key: string, patch: Partial<EditorLine>) => onChange(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const subtotal = lines.reduce((s, l) => s + l.quantity * l.price * (1 - l.discountPct / 100), 0);
  return (
    <div>
      <div className="hidden grid-cols-[1fr_110px_130px_90px_120px_40px] gap-2 border-b border-ink-100 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-ink-500 md:grid">
        <span>Product</span><span className="text-right">Quantity</span><span className="text-right">{priceLabel}</span><span className="text-right">Disc. %</span><span className="text-right">Line total</span><span />
      </div>
      <div className="divide-y divide-ink-100">
        {lines.map((l) => {
          const short = showAvailability && l.available !== undefined && l.quantity > l.available;
          return (
            <div key={l.key} className="grid gap-2 px-4 py-3 md:grid-cols-[1fr_110px_130px_90px_120px_40px] md:items-center">
              <div>
                <EntityPicker value={l.productId} initialLabel={l.label} endpoint="/products" placeholder="Search product…" params={{ status: 'active' }}
                  map={(p) => ({ id: p.id, label: `${p.sku} — ${p.name}`, sub: `${qty(p.available)} available · ${p.uom}`, raw: p })}
                  onChange={(id, o) => set(l.key, { productId: id, label: o?.label, price: Number(o?.raw?.[priceField] ?? 0), available: Number(o?.raw?.available ?? 0), uom: o?.raw?.uom })} />
                {showAvailability && l.productId && <div className="mt-1 text-xs">{short ? <Badge tone="amber">Only {qty(l.available)} available — the rest will be back-ordered</Badge> : <span className="text-ink-500">{qty(l.available)} {l.uom} available</span>}</div>}
              </div>
              <Input type="number" min={0} step="any" value={l.quantity} onChange={(e) => set(l.key, { quantity: Number(e.target.value) })} className="text-right" aria-label="Quantity" />
              <Input type="number" min={0} step="any" value={l.price} onChange={(e) => set(l.key, { price: Number(e.target.value) })} className="text-right" aria-label={priceLabel} />
              <Input type="number" min={0} max={100} step="any" value={l.discountPct} onChange={(e) => set(l.key, { discountPct: Number(e.target.value) })} className="text-right" aria-label="Discount" />
              <div className="num text-right text-sm font-medium">{money(l.quantity * l.price * (1 - l.discountPct / 100))}</div>
              <Button size="icon" variant="ghost" onClick={() => onChange(lines.filter((x) => x.key !== l.key))} aria-label="Remove line" disabled={lines.length === 1}><Trash2 /></Button>
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between border-t border-ink-100 px-4 py-3">
        <Button size="sm" onClick={() => onChange([...lines, newLine()])}><Plus /> Add line</Button>
        <div className="text-right text-sm"><span className="text-ink-500">Subtotal before tax </span><b className="num">{money(subtotal)}</b><div className="text-xs text-ink-400">Tax is calculated from your tax settings when saved.</div></div>
      </div>
    </div>
  );
}
