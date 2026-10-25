import type { ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import { BRAND } from '@shared/brand';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { date, dateTime, humanize, money, qty } from '@/lib/utils';
import { Button, ErrorState, Skeleton } from '@/components/ui/core';
import { Barcode } from '@/components/ui/blocks';

const SOURCES: Record<string, (id: string) => string> = {
  grn: (id) => `/receiving/${id}`, po: (id) => `/purchase-orders/${id}`, invoice: (id) => `/invoices/${id}`,
  'packing-slip': (id) => `/sales-orders/${id}`, 'shipping-label': (id) => `/sales-orders/${id}`,
};

export function PrintDocument() {
  const { kind = '', id = '' } = useParams();
  const { me } = useAuth();
  const company = useQuery({ queryKey: ['company'], queryFn: () => api.get<any>('/company').catch(() => null) });
  const doc = useQuery({ queryKey: ['print', kind, id], queryFn: () => api.get<any>(SOURCES[kind]!(id)), enabled: !!SOURCES[kind] });
  if (!SOURCES[kind]) return <ErrorState error={new Error('Unknown document type')} />;
  if (doc.error) return <ErrorState error={doc.error} />;
  if (!doc.data) return <div className="p-10"><Skeleton className="h-96" /></div>;
  const c = company.data ?? { name: me?.tenant?.name };
  const d = doc.data;
  return (
    <div className="min-h-screen bg-ink-100 py-6 print:bg-white print:py-0">
      <div className="no-print mx-auto mb-4 flex max-w-[210mm] justify-between px-4"><span className="text-sm text-ink-500">Print preview</span><Button variant="primary" onClick={() => window.print()}><Printer /> Print / save as PDF</Button></div>
      {kind === 'shipping-label' ? <ShippingLabels order={d} company={c} /> : (
        <div className="print-area mx-auto max-w-[210mm] bg-white p-10 shadow-card">
          <Letterhead company={c} title={({ grn: 'Goods Receipt Note', po: 'Purchase Order', invoice: d.type === 'credit_note' ? 'Credit Note' : d.type === 'storage' ? 'Storage Invoice' : 'Sales Tax Invoice', 'packing-slip': 'Packing Slip' } as Record<string, string>)[kind]!} number={d.number} />
          {kind === 'grn' && <Grn g={d} />}
          {kind === 'po' && <Po po={d} />}
          {kind === 'invoice' && <Invoice inv={d} />}
          {kind === 'packing-slip' && <PackingSlip o={d} />}
          <footer className="mt-12 border-t border-ink-200 pt-3 text-center text-[10px] text-ink-400">Generated {dateTime(new Date())} with {BRAND.name} · {BRAND.tagline}</footer>
        </div>
      )}
    </div>
  );
}

function Letterhead({ company, title, number }: { company: any; title: string; number: string }) {
  return (
    <header className="mb-8 flex items-start justify-between gap-6 border-b-4 border-brand-700 pb-5">
      <div>
        <div className="text-xl font-bold text-ink-900">{company.legalName || company.name}</div>
        <div className="mt-1 text-xs leading-relaxed text-ink-600">{company.address}{company.city ? `, ${company.city}` : ''}<br />{[company.phone, company.email].filter(Boolean).join(' · ')}{company.ntn && <><br />NTN {company.ntn}{company.strn ? ` · STRN ${company.strn}` : ''}</>}</div>
      </div>
      <div className="text-right">
        <div className="text-2xl font-bold uppercase tracking-wide text-brand-800">{title}</div>
        <div className="mt-1 font-mono text-sm font-semibold">{number}</div>
        <div className="mt-2 inline-block"><Barcode value={number} height={8} scale={1} text={false} /></div>
      </div>
    </header>
  );
}

function Parties({ left, right }: { left: [string, ReactNode]; right: [string, ReactNode] }) {
  return <div className="mb-6 grid grid-cols-2 gap-6 text-sm">{[left, right].map(([h, b]) => <div key={h}><div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-brand-700">{h}</div><div className="leading-relaxed text-ink-800">{b}</div></div>)}</div>;
}

function Lines({ head, rows, foot }: { head: string[]; rows: ReactNode[][]; foot?: ReactNode }) {
  return (
    <table className="w-full text-sm">
      <thead><tr className="bg-brand-700 text-white">{head.map((h, i) => <th key={h} className={`px-3 py-2 text-left text-[11px] font-semibold uppercase ${i > 1 ? 'text-right' : ''}`}>{h}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i} className="border-b border-ink-200">{r.map((c, j) => <td key={j} className={`px-3 py-2 ${j > 1 ? 'whitespace-nowrap text-right num' : ''}`}>{c}</td>)}</tr>)}</tbody>
      {foot}
    </table>
  );
}

function Signatures({ labels }: { labels: string[] }) {
  return <div className="mt-16 grid grid-cols-3 gap-8 text-center text-xs text-ink-500">{labels.map((l) => <div key={l}><div className="mb-1 h-10 border-b border-ink-400" />{l}</div>)}</div>;
}

function Grn({ g }: { g: any }) {
  return <>
    <Parties left={['Received from', <>{g.supplier_name ?? (g.owner_name ? `${g.owner_name} (client stock)` : '—')}<br />PO: {g.po_number ?? 'none'}<br />Delivery note: {g.delivery_note_no || '—'}</>]} right={['Received at', <>{g.warehouse_name} ({g.warehouse_code})<br />{dateTime(g.received_at)}<br />By {g.received_by_name}{g.vehicle_no ? ` · vehicle ${g.vehicle_no}` : ''}</>]} />
    <Lines head={['SKU', 'Product', 'Expected', 'Received', 'Damaged', 'Batch / expiry', 'Location']} rows={g.lines.map((l: any) => [l.sku, l.productName, qty(l.expectedQty), qty(l.receivedQty), qty(l.damagedQty), l.batchNo ? `${l.batchNo}${l.expiryDate ? ` / ${date(l.expiryDate)}` : ''}` : '—', l.locationCode])} />
    {g.notes && <p className="mt-4 text-sm text-ink-600">Notes: {g.notes}</p>}
    <Signatures labels={['Delivered by', 'Received by', 'Checked by']} />
  </>;
}

function Po({ po }: { po: any }) {
  return <>
    <Parties left={['Supplier', <>{po.supplier?.name}<br />{po.supplier?.address}<br />{po.supplier?.phone}{po.supplier?.ntn ? <><br />NTN {po.supplier.ntn}</> : null}</>]} right={['Deliver to', <>{po.warehouse?.name}<br />{po.warehouse?.address}<br />Order date {date(po.orderDate)} · expected {date(po.expectedDate)}</>]} />
    <Lines head={['SKU', 'Product', 'Qty', 'Unit cost', 'Tax', 'Total']} rows={po.lines.map((l: any) => [l.sku, l.productName, qty(l.quantity), money(l.unitCost), `${l.taxRate}%`, money(l.lineTotal)])}
      foot={<tfoot><Tot label="Subtotal" v={money(po.subtotal)} cols={6} /><Tot label="Tax" v={money(po.taxTotal)} cols={6} /><Tot label="Total" v={money(po.total)} cols={6} strong /></tfoot>} />
    {po.notes && <p className="mt-4 whitespace-pre-line text-sm text-ink-600">{po.notes}</p>}
    <Signatures labels={['Prepared by', 'Approved by', 'Supplier acceptance']} />
  </>;
}

function Tot({ label, v, cols, strong }: { label: string; v: string; cols: number; strong?: boolean }) {
  return <tr><td colSpan={cols - 1} className={`px-3 py-1.5 text-right ${strong ? 'text-base font-bold' : 'text-ink-600'}`}>{label}</td><td className={`whitespace-nowrap px-3 py-1.5 text-right num ${strong ? 'text-base font-bold text-brand-800' : ''}`}>{v}</td></tr>;
}

function Invoice({ inv }: { inv: any }) {
  return <>
    <Parties left={['Bill to', <>{inv.customer?.name}<br />{inv.customer?.address}<br />{inv.customer?.phone}{inv.customer?.ntn ? <><br />NTN {inv.customer.ntn}{inv.customer.strn ? ` · STRN ${inv.customer.strn}` : ''}</> : null}</>]} right={['Invoice', <>Issued {date(inv.issueDate)}<br />Due {date(inv.dueDate)}<br />{inv.periodStart ? `Period ${date(inv.periodStart)} – ${date(inv.periodEnd)}` : `Currency ${inv.currency}`}</>]} />
    <Lines head={['#', 'Description', 'Qty', 'Unit price', 'Tax', 'Amount']} rows={inv.lines.map((l: any, i: number) => [i + 1, l.description, qty(l.quantity), money(l.unitPrice), `${l.taxRate}% · ${money(l.taxAmount)}`, money(l.lineTotal)])}
      foot={<tfoot><Tot label="Value excluding tax" v={money(inv.subtotal)} cols={6} /><Tot label="Sales tax" v={money(inv.taxTotal)} cols={6} /><Tot label="Total" v={money(inv.total)} cols={6} strong /><Tot label="Paid" v={money(inv.amountPaid)} cols={6} /><Tot label="Balance due" v={money(inv.total - inv.amountPaid)} cols={6} strong /></tfoot>} />
    {inv.notes && <p className="mt-4 text-sm text-ink-600">{inv.notes}</p>}
    <p className="mt-6 text-xs text-ink-500">Please quote the invoice number with your payment.</p>
  </>;
}

function PackingSlip({ o }: { o: any }) {
  return <>
    <Parties left={['Ship to', <>{o.customer?.name}<br />{o.shippingAddress}<br />{o.customer?.phone}</>]} right={['Order', <>{o.number} · {date(o.orderDate)}<br />From {o.warehouse?.name}<br />{o.packageCount || '—'} package(s) · {qty(o.totalWeightKg)} kg</>]} />
    <Lines head={['SKU', 'Product', 'Ordered', 'Packed', 'Back-ordered']} rows={o.lines.map((l: any) => { const packed = Math.max(l.packedQty, l.shippedQty, l.pickedQty); return [l.sku, l.productName, qty(l.quantity), qty(packed), qty(Math.max(0, l.quantity - packed))]; })} />
    <Signatures labels={['Packed by', 'Checked by', 'Received by customer']} />
  </>;
}

function ShippingLabels({ order, company }: { order: any; company: any }) {
  const pkgs = order.packages?.length ? order.packages : [{ packageNo: 1, barcode: order.number }];
  const ship = order.shipments?.[0];
  return (
    <div className="print-area mx-auto grid max-w-[210mm] gap-4">
      {pkgs.map((p: any) => (
        <div key={p.packageNo} className="print-break mx-auto w-[100mm] rounded border-2 border-ink-900 bg-white p-4 text-sm">
          <div className="flex items-center justify-between border-b-2 border-ink-900 pb-2"><span className="font-bold">{company.name}</span><span className="font-mono text-xs">Box {p.packageNo} / {pkgs.length}</span></div>
          <div className="py-3"><div className="text-[10px] font-semibold uppercase">Deliver to</div><div className="text-lg font-bold leading-tight">{order.customer?.name}</div><div className="text-sm">{order.shippingAddress}</div><div className="text-sm">{order.customer?.phone}</div></div>
          <div className="grid grid-cols-2 gap-2 border-y-2 border-ink-900 py-2 text-xs"><div>Order <b>{order.number}</b></div><div className="text-right">{ship?.carrier || 'Carrier'} {ship?.trackingNumber ? `· ${ship.trackingNumber}` : ''}</div><div>Weight {qty(p.weightKg ?? 0)} kg</div><div className="text-right">{date(new Date().toISOString())}</div></div>
          <div className="pt-3 text-center"><Barcode value={p.barcode} height={14} scale={2} /></div>
          {ship?.trackingNumber && <div className="pt-2 text-center"><Barcode value={ship.trackingNumber} height={10} scale={1} /></div>}
          <div className="pt-1 text-center text-[9px] text-ink-500">{humanize(order.priority)} priority</div>
        </div>
      ))}
    </div>
  );
}
