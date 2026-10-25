import { eq } from 'drizzle-orm';
import { t, type DbOrTx } from '../../db';
import type { Ctx } from '../../core/context';
import { nextNumber } from '../../core/numbering';
import { audit } from '../../core/audit';
import { emitEvent } from '../integrations/events';

export interface InvoiceLineInput {
  productId?: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
  taxAmount: number;
  lineTotal: number;
}

export interface InvoiceInput {
  type: 'sales' | 'storage' | 'credit_note';
  customerId: string;
  salesOrderId?: string | null;
  warehouseId?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  currency: string;
  notes?: string;
  lines: InvoiceLineInput[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function createInvoice(tx: DbOrTx, ctx: Ctx, input: InvoiceInput) {
  const [customer] = await tx.select({ terms: t.customers.paymentTermsDays }).from(t.customers).where(eq(t.customers.id, input.customerId)).limit(1);
  const total = round2(input.lines.reduce((s, l) => s + l.lineTotal, 0));
  const taxTotal = round2(input.lines.reduce((s, l) => s + l.taxAmount, 0));
  const issue = new Date();
  const [invoice] = await tx.insert(t.invoices).values({
    tenantId: ctx.tenantId,
    number: await nextNumber(tx, ctx.tenantId, 'INV'),
    type: input.type,
    customerId: input.customerId,
    salesOrderId: input.salesOrderId ?? null,
    warehouseId: input.warehouseId ?? null,
    periodStart: input.periodStart ?? null,
    periodEnd: input.periodEnd ?? null,
    issueDate: issue.toISOString().slice(0, 10),
    dueDate: new Date(issue.getTime() + (customer?.terms ?? 30) * 86400_000).toISOString().slice(0, 10),
    currency: input.currency,
    subtotal: round2(total - taxTotal),
    taxTotal,
    total,
    notes: input.notes ?? '',
    createdBy: ctx.userId || null,
  }).returning();
  if (input.lines.length) {
    await tx.insert(t.invoiceLines).values(input.lines.map((l) => ({ tenantId: ctx.tenantId, invoiceId: invoice!.id, ...l, productId: l.productId ?? null })));
  }
  await audit(tx, ctx, { action: 'invoice.issued', entityType: 'invoice', entityId: invoice!.id, newValue: { number: invoice!.number, type: input.type, total } });
  await emitEvent(tx, ctx.tenantId, 'invoice.issued', { invoiceId: invoice!.id, number: invoice!.number, total });
  return invoice!;
}
