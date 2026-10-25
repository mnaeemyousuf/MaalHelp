import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { EXPENSE_CATEGORIES, PAYMENT_METHODS, STORAGE_BASES, STORAGE_CHARGE_TYPES } from '@shared/domain';
import { db, num, one, rows, t, type DbOrTx, type Tx } from '../../db';
import { idParam, isoDate, pageQuery, paged, type Router } from '../../core/http';
import { badRequest, conflict, invalidState, notFound } from '../../core/errors';
import { audit } from '../../core/audit';
import type { Ctx } from '../../core/context';
import { nextNumber } from '../../core/numbering';
import { createApprovalRequest, findApplicableRule, registerApprovalHandler } from '../approvals/engine';
import { createInvoice } from './invoicing';
import { emitEvent } from '../integrations/events';

const round2 = (n: number) => Math.round(n * 100) / 100;

// ───────────────────────── Invoices & bills ─────────────────────────

export function registerInvoiceRoutes(r: Router) {
  r.get('/', {
    summary: 'Customer invoices (sales, storage, credit notes)',
    permission: 'billing.view',
    query: pageQuery.extend({ status: z.string().optional(), type: z.string().optional(), customerId: z.string().uuid().optional(), overdue: z.coerce.boolean().optional(), from: isoDate().optional(), to: isoDate().optional() }),
  }, async ({ ctx, query }) => {
    const like = query.q ? `%${query.q.toLowerCase()}%` : null;
    const statuses = query.status?.split(',').filter(Boolean);
    const list = await rows<Record<string, unknown>>(db(), sql`
      SELECT i.id, i.number, i.type, i.status, i.issue_date AS "issueDate", i.due_date AS "dueDate", i.total::float AS total, i.tax_total::float AS "taxTotal", i.amount_paid::float AS "amountPaid",
        (i.total - i.amount_paid)::float AS balance, i.currency, c.id AS "customerId", c.name AS "customerName", so.number AS "orderNumber",
        (i.due_date < CURRENT_DATE AND i.status IN ('issued', 'partially_paid') AND i.total > 0) AS overdue, (CURRENT_DATE - i.due_date) AS "daysOverdue", COUNT(*) OVER() AS total_count
      FROM invoices i JOIN customers c ON c.id = i.customer_id LEFT JOIN sales_orders so ON so.id = i.sales_order_id
      WHERE i.tenant_id = ${ctx.tenantId}
      ${statuses?.length ? sql`AND i.status IN (${sql.join(statuses.map((s) => sql`${s}`), sql`, `)})` : sql``}
      ${query.type ? sql`AND i.type = ${query.type}` : sql``}
      ${query.customerId ? sql`AND i.customer_id = ${query.customerId}` : sql``}
      ${query.overdue ? sql`AND i.due_date < CURRENT_DATE AND i.status IN ('issued', 'partially_paid') AND i.total > 0` : sql``}
      ${query.from ? sql`AND i.issue_date >= ${query.from}` : sql``}
      ${query.to ? sql`AND i.issue_date <= ${query.to}` : sql``}
      ${like ? sql`AND (lower(i.number) LIKE ${like} OR lower(c.name) LIKE ${like} OR lower(COALESCE(so.number, '')) LIKE ${like})` : sql``}
      ORDER BY i.issue_date DESC, i.number DESC LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`);
    return paged(list.map(({ total_count: _t, ...x }) => ({ ...x, daysOverdue: num(x.daysOverdue) })), num(list[0]?.total_count), query.page, query.pageSize);
  });

  r.get('/:id', { summary: 'Invoice with lines and payments (printable)', permission: ['billing.view', 'packing.execute', 'dispatch.execute'], params: idParam }, async ({ ctx, params }) => {
    const [inv] = await db().select().from(t.invoices).where(and(eq(t.invoices.id, params.id), eq(t.invoices.tenantId, ctx.tenantId))).limit(1);
    if (!inv) throw notFound('Invoice');
    const [lines, pays, customer, tenant] = await Promise.all([
      db().select().from(t.invoiceLines).where(eq(t.invoiceLines.invoiceId, inv.id)),
      db().select().from(t.payments).where(eq(t.payments.invoiceId, inv.id)),
      db().select().from(t.customers).where(eq(t.customers.id, inv.customerId)),
      db().select({ name: t.tenants.name, legalName: t.tenants.legalName, address: t.tenants.address, city: t.tenants.city, phone: t.tenants.phone, email: t.tenants.email, ntn: t.tenants.ntn, strn: t.tenants.strn }).from(t.tenants).where(eq(t.tenants.id, ctx.tenantId)),
    ]);
    return { ...inv, lines, payments: pays, customer: customer[0], company: tenant[0] };
  });

  r.post('/:id/void', { summary: 'Void an unpaid invoice (reason required)', permission: 'billing.manage', params: idParam, body: z.object({ reason: z.string().trim().min(3).max(300) }) }, async ({ ctx, params, body }) => {
    const [inv] = await db().select().from(t.invoices).where(and(eq(t.invoices.id, params.id), eq(t.invoices.tenantId, ctx.tenantId))).limit(1);
    if (!inv) throw notFound('Invoice');
    if (inv.amountPaid !== 0) throw invalidState('Invoices with payments cannot be voided. Issue a credit note instead.');
    await db().update(t.invoices).set({ status: 'void', notes: `${inv.notes}\n[Void] ${body.reason}`.trim() }).where(eq(t.invoices.id, inv.id));
    await db().update(t.storageCharges).set({ invoiceId: null }).where(eq(t.storageCharges.invoiceId, inv.id));
    await audit(db(), ctx, { action: 'invoice.voided', entityType: 'invoice', entityId: inv.id, newValue: body });
    return { ok: true };
  });
}

export function registerBillRoutes(r: Router) {
  r.get('/', { summary: 'Supplier bills (payables)', permission: 'billing.view', query: pageQuery.extend({ status: z.string().optional(), supplierId: z.string().uuid().optional(), overdue: z.coerce.boolean().optional() }) }, async ({ ctx, query }) => {
    const like = query.q ? `%${query.q.toLowerCase()}%` : null;
    const statuses = query.status?.split(',').filter(Boolean);
    const list = await rows<Record<string, unknown>>(db(), sql`
      SELECT b.id, b.number, b.status, b.bill_date AS "billDate", b.due_date AS "dueDate", b.total::float AS total, b.amount_paid::float AS "amountPaid", (b.total - b.amount_paid)::float AS balance,
        b.supplier_invoice_no AS "supplierInvoiceNo", b.currency, s.id AS "supplierId", s.name AS "supplierName", po.number AS "poNumber", g.number AS "grnNumber",
        (b.due_date < CURRENT_DATE AND b.status IN ('open', 'partially_paid')) AS overdue, COUNT(*) OVER() AS total_count
      FROM supplier_bills b JOIN suppliers s ON s.id = b.supplier_id LEFT JOIN purchase_orders po ON po.id = b.purchase_order_id LEFT JOIN goods_receipts g ON g.id = b.receipt_id
      WHERE b.tenant_id = ${ctx.tenantId}
      ${statuses?.length ? sql`AND b.status IN (${sql.join(statuses.map((s) => sql`${s}`), sql`, `)})` : sql``}
      ${query.supplierId ? sql`AND b.supplier_id = ${query.supplierId}` : sql``}
      ${query.overdue ? sql`AND b.due_date < CURRENT_DATE AND b.status IN ('open', 'partially_paid')` : sql``}
      ${like ? sql`AND (lower(b.number) LIKE ${like} OR lower(s.name) LIKE ${like} OR lower(COALESCE(po.number, '')) LIKE ${like})` : sql``}
      ORDER BY b.bill_date DESC, b.number DESC LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`);
    return paged(list.map(({ total_count: _t, ...x }) => x), num(list[0]?.total_count), query.page, query.pageSize);
  });

  r.patch('/:id', { summary: "Record the supplier's own invoice number on a bill", permission: 'billing.manage', params: idParam, body: z.object({ supplierInvoiceNo: z.string().trim().max(60) }) }, async ({ ctx, params, body }) => {
    const [b] = await db().update(t.supplierBills).set(body).where(and(eq(t.supplierBills.id, params.id), eq(t.supplierBills.tenantId, ctx.tenantId))).returning();
    if (!b) throw notFound('Bill');
    await audit(db(), ctx, { action: 'bill.updated', entityType: 'supplier_bill', entityId: b.id, newValue: body });
    return b;
  });
}

export function registerPaymentRoutes(r: Router) {
  r.get('/', { summary: 'Payments received and made', permission: 'billing.view', query: pageQuery.extend({ direction: z.enum(['in', 'out']).optional(), from: isoDate().optional(), to: isoDate().optional() }) }, async ({ ctx, query }) => {
    const list = await rows<Record<string, unknown>>(db(), sql`
      SELECT p.id, p.number, p.direction, p.amount::float AS amount, p.currency, p.method, p.bank, p.reference, p.paid_at AS "paidAt", p.notes,
        COALESCE(c.name, s.name) AS "partyName", COALESCE(i.number, b.number) AS "documentNumber", u.name AS "recordedBy", COUNT(*) OVER() AS total_count
      FROM payments p LEFT JOIN customers c ON c.id = p.customer_id LEFT JOIN suppliers s ON s.id = p.supplier_id
      LEFT JOIN invoices i ON i.id = p.invoice_id LEFT JOIN supplier_bills b ON b.id = p.bill_id LEFT JOIN users u ON u.id = p.created_by
      WHERE p.tenant_id = ${ctx.tenantId}
      ${query.direction ? sql`AND p.direction = ${query.direction}` : sql``}
      ${query.from ? sql`AND p.paid_at >= ${query.from}` : sql``}
      ${query.to ? sql`AND p.paid_at <= ${query.to}` : sql``}
      ORDER BY p.paid_at DESC, p.created_at DESC LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`);
    return paged(list.map(({ total_count: _t, ...x }) => x), num(list[0]?.total_count), query.page, query.pageSize);
  });

  r.post('/', {
    summary: 'Record a payment against an invoice (money in) or supplier bill (money out). Over-payment is refused.',
    permission: 'billing.manage',
    idempotent: true,
    body: z.object({
      invoiceId: z.string().uuid().optional(),
      billId: z.string().uuid().optional(),
      amount: z.number().positive(),
      method: z.enum(PAYMENT_METHODS).default('bank_transfer'),
      bank: z.string().trim().max(80).default(''),
      reference: z.string().trim().max(80).default(''),
      paidAt: isoDate().optional(),
      notes: z.string().trim().max(300).default(''),
    }).refine((b) => !!b.invoiceId !== !!b.billId, 'Choose exactly one invoice or bill.'),
  }, async ({ ctx, body }) => {
    return db().transaction(async (tx) => {
      const paidAt = body.paidAt ?? new Date().toISOString().slice(0, 10);
      const number = await nextNumber(tx, ctx.tenantId, 'PAY');
      if (body.invoiceId) {
        const [inv] = await tx.select().from(t.invoices).where(and(eq(t.invoices.id, body.invoiceId), eq(t.invoices.tenantId, ctx.tenantId))).for('update').limit(1);
        if (!inv) throw notFound('Invoice');
        if (!['issued', 'partially_paid'].includes(inv.status) || inv.total <= 0) throw invalidState(`Invoice ${inv.number} is ${inv.status} and cannot take payments.`);
        const balance = round2(inv.total - inv.amountPaid);
        if (body.amount > balance + 0.005) throw badRequest(`Amount exceeds the outstanding balance of ${balance.toLocaleString()}.`);
        const paid = round2(inv.amountPaid + body.amount);
        await tx.update(t.invoices).set({ amountPaid: paid, status: paid >= inv.total - 0.005 ? 'paid' : 'partially_paid' }).where(eq(t.invoices.id, inv.id));
        const [p] = await tx.insert(t.payments).values({ tenantId: ctx.tenantId, number, direction: 'in', partyType: 'customer', customerId: inv.customerId, invoiceId: inv.id, amount: body.amount, currency: inv.currency, method: body.method, bank: body.bank, reference: body.reference, paidAt, notes: body.notes, createdBy: ctx.userId }).returning();
        await audit(tx, ctx, { action: 'payment.received', entityType: 'invoice', entityId: inv.id, newValue: { number, amount: body.amount, method: body.method } });
        await emitEvent(tx, ctx.tenantId, 'payment.recorded', { paymentId: p!.id, direction: 'in', amount: body.amount });
        return p;
      }
      const [bill] = await tx.select().from(t.supplierBills).where(and(eq(t.supplierBills.id, body.billId!), eq(t.supplierBills.tenantId, ctx.tenantId))).for('update').limit(1);
      if (!bill) throw notFound('Bill');
      if (!['open', 'partially_paid'].includes(bill.status)) throw invalidState(`Bill ${bill.number} is ${bill.status}.`);
      const balance = round2(bill.total - bill.amountPaid);
      if (body.amount > balance + 0.005) throw badRequest(`Amount exceeds the outstanding balance of ${balance.toLocaleString()}.`);
      const paid = round2(bill.amountPaid + body.amount);
      await tx.update(t.supplierBills).set({ amountPaid: paid, status: paid >= bill.total - 0.005 ? 'paid' : 'partially_paid' }).where(eq(t.supplierBills.id, bill.id));
      const [p] = await tx.insert(t.payments).values({ tenantId: ctx.tenantId, number, direction: 'out', partyType: 'supplier', supplierId: bill.supplierId, billId: bill.id, amount: body.amount, currency: bill.currency, method: body.method, bank: body.bank, reference: body.reference, paidAt, notes: body.notes, createdBy: ctx.userId }).returning();
      await audit(tx, ctx, { action: 'payment.made', entityType: 'supplier_bill', entityId: bill.id, newValue: { number, amount: body.amount, method: body.method } });
      await emitEvent(tx, ctx.tenantId, 'payment.recorded', { paymentId: p!.id, direction: 'out', amount: body.amount });
      return p;
    });
  });

  r.get('/aging', { summary: 'Receivables and payables aging (current, 1–30, 31–60, 61–90, 90+ days)', permission: ['billing.view', 'finance.view'] }, async ({ ctx }) => {
    const bucket = (dateCol: string) => sql.raw(`CASE WHEN CURRENT_DATE <= ${dateCol} THEN 'current' WHEN CURRENT_DATE - ${dateCol} <= 30 THEN 'd1_30' WHEN CURRENT_DATE - ${dateCol} <= 60 THEN 'd31_60' WHEN CURRENT_DATE - ${dateCol} <= 90 THEN 'd61_90' ELSE 'd90_plus' END`);
    const [receivables, payables] = await Promise.all([
      rows<Record<string, unknown>>(db(), sql`SELECT c.id, c.name, ${bucket('i.due_date')} AS bucket, SUM(i.total - i.amount_paid)::float AS amount FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.tenant_id = ${ctx.tenantId} AND i.status IN ('issued', 'partially_paid') GROUP BY c.id, 3`),
      rows<Record<string, unknown>>(db(), sql`SELECT s.id, s.name, ${bucket('b.due_date')} AS bucket, SUM(b.total - b.amount_paid)::float AS amount FROM supplier_bills b JOIN suppliers s ON s.id = b.supplier_id WHERE b.tenant_id = ${ctx.tenantId} AND b.status IN ('open', 'partially_paid') GROUP BY s.id, 3`),
    ]);
    const pivot = (list: Record<string, unknown>[]) => {
      const map = new Map<string, Record<string, number | string>>();
      for (const r0 of list) {
        const row = map.get(String(r0.id)) ?? { id: String(r0.id), name: String(r0.name), current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, total: 0 };
        row[String(r0.bucket)] = round2(Number(row[String(r0.bucket)]) + num(r0.amount));
        row.total = round2(Number(row.total) + num(r0.amount));
        map.set(String(r0.id), row);
      }
      return [...map.values()].filter((x) => Math.abs(Number(x.total)) > 0.005).sort((a, b) => Number(b.total) - Number(a.total));
    };
    return { receivables: pivot(receivables), payables: pivot(payables) };
  });
}

// ───────────────────────── Expenses ─────────────────────────

registerApprovalHandler('expense', {
  approve: async (tx, ctx, id) => { await tx.update(t.expenses).set({ status: 'approved', approvedBy: ctx.userId }).where(and(eq(t.expenses.id, id), eq(t.expenses.tenantId, ctx.tenantId))); },
  reject: async (tx, ctx, id) => { await tx.update(t.expenses).set({ status: 'rejected', approvedBy: ctx.userId }).where(and(eq(t.expenses.id, id), eq(t.expenses.tenantId, ctx.tenantId))); },
});

export function registerExpenseRoutes(r: Router) {
  r.get('/', { summary: 'Warehouse expenses', permission: 'expense.view', query: pageQuery.extend({ warehouseId: z.string().uuid().optional(), category: z.string().optional(), from: isoDate().optional(), to: isoDate().optional(), status: z.string().optional() }) }, async ({ ctx, query }) => {
    const like = query.q ? `%${query.q.toLowerCase()}%` : null;
    const list = await rows<Record<string, unknown>>(db(), sql`
      SELECT e.id, e.number, e.category, e.department, e.cost_center AS "costCenter", e.vendor, e.amount::float AS amount, e.tax_amount::float AS "taxAmount", e.currency, e.expense_date AS "expenseDate",
        e.payment_method AS "paymentMethod", e.reference, e.notes, e.status, w.id AS "warehouseId", w.code AS "warehouseCode", u.name AS "createdBy", COUNT(*) OVER() AS total_count,
        SUM(e.amount) OVER()::float AS filtered_total
      FROM expenses e LEFT JOIN warehouses w ON w.id = e.warehouse_id LEFT JOIN users u ON u.id = e.created_by
      WHERE e.tenant_id = ${ctx.tenantId}
      ${query.warehouseId ? sql`AND e.warehouse_id = ${query.warehouseId}` : sql``}
      ${query.category ? sql`AND e.category = ${query.category}` : sql``}
      ${query.status ? sql`AND e.status = ${query.status}` : sql``}
      ${query.from ? sql`AND e.expense_date >= ${query.from}` : sql``}
      ${query.to ? sql`AND e.expense_date <= ${query.to}` : sql``}
      ${like ? sql`AND (lower(e.vendor) LIKE ${like} OR lower(e.notes) LIKE ${like} OR lower(e.number) LIKE ${like})` : sql``}
      ORDER BY e.expense_date DESC, e.created_at DESC LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`);
    const result = paged(list.map(({ total_count: _t, filtered_total: _f, ...x }) => x), num(list[0]?.total_count), query.page, query.pageSize);
    return Object.assign(result, { meta: { ...result.meta, filteredTotal: num(list[0]?.filtered_total) } });
  });

  r.post('/', {
    summary: 'Record an expense (above the threshold it waits for approval)',
    permission: 'expense.manage',
    idempotent: true,
    body: z.object({
      warehouseId: z.string().uuid().nullish(),
      category: z.enum(EXPENSE_CATEGORIES),
      department: z.string().trim().max(80).default(''),
      costCenter: z.string().trim().max(80).default(''),
      vendor: z.string().trim().max(120).default(''),
      amount: z.number().positive(),
      taxAmount: z.number().min(0).default(0),
      expenseDate: isoDate(),
      paymentMethod: z.enum(PAYMENT_METHODS).default('cash'),
      reference: z.string().trim().max(80).default(''),
      notes: z.string().trim().max(500).default(''),
    }),
  }, async ({ ctx, body }) => {
    return db().transaction(async (tx) => {
      if (body.warehouseId) {
        const [w] = await tx.select({ id: t.warehouses.id }).from(t.warehouses).where(and(eq(t.warehouses.id, body.warehouseId), eq(t.warehouses.tenantId, ctx.tenantId))).limit(1);
        if (!w) throw notFound('Warehouse');
      }
      const rule = await findApplicableRule(tx, ctx.tenantId, 'expense', body.amount);
      const number = await nextNumber(tx, ctx.tenantId, 'EXP');
      const [e] = await tx.insert(t.expenses).values({ ...body, warehouseId: body.warehouseId ?? null, tenantId: ctx.tenantId, number, currency: ctx.currency, status: rule ? 'pending_approval' : 'approved', createdBy: ctx.userId }).returning();
      if (rule) {
        const requestId = await createApprovalRequest(tx, ctx, { entityType: 'expense', entityId: e!.id, entityNumber: number, amount: body.amount, rule, summary: `${body.category} expense of ${body.amount.toLocaleString()}${body.vendor ? ` to ${body.vendor}` : ''}` });
        await tx.update(t.expenses).set({ approvalRequestId: requestId }).where(eq(t.expenses.id, e!.id));
      }
      await audit(tx, ctx, { action: 'expense.recorded', entityType: 'expense', entityId: e!.id, newValue: { number, category: body.category, amount: body.amount, requiresApproval: !!rule } });
      return { ...e!, status: rule ? 'pending_approval' : 'approved' };
    });
  });
}

// ───────────────────────── Storage billing (3PL / rental) ─────────────────────────

interface DailyMeasure { units: number; cbm: number; kg: number; pallets: number; bins: number }

/** Reconstructs the customer's daily stored quantities from the immutable ledger. */
async function dailyStorage(dbx: DbOrTx, tenantId: string, customerId: string, start: string, end: string, warehouseId: string | null): Promise<DailyMeasure[]> {
  const list = await rows<Record<string, string>>(dbx, sql`
    WITH days AS (SELECT generate_series(${start}::date, ${end}::date, interval '1 day')::date AS d),
    mv AS (
      SELECT product_id, location_id, created_at::date AS dt, SUM(quantity) AS q FROM inventory_transactions
      WHERE tenant_id = ${tenantId} AND owner_customer_id = ${customerId} ${warehouseId ? sql`AND warehouse_id = ${warehouseId}` : sql``}
      GROUP BY 1, 2, 3
    ),
    daily AS (SELECT days.d, mv.product_id, mv.location_id, SUM(mv.q) AS qty FROM days JOIN mv ON mv.dt <= days.d GROUP BY days.d, mv.product_id, mv.location_id)
    SELECT days.d, COALESCE(SUM(daily.qty), 0) AS units, COALESCE(SUM(daily.qty * p.volume_m3), 0) AS cbm, COALESCE(SUM(daily.qty * p.weight_kg), 0) AS kg,
      COALESCE(SUM(CASE WHEN p.units_per_pallet > 0 THEN daily.qty / p.units_per_pallet ELSE 0 END), 0) AS pallets,
      COUNT(DISTINCT daily.location_id) FILTER (WHERE daily.qty > 0) AS bins
    FROM days LEFT JOIN daily ON daily.d = days.d LEFT JOIN products p ON p.id = daily.product_id
    GROUP BY days.d ORDER BY days.d`);
  return list.map((d) => ({ units: num(d.units), cbm: num(d.cbm), kg: num(d.kg), pallets: Math.ceil(num(d.pallets) - 1e-9), bins: num(d.bins) }));
}

async function handlingCounts(dbx: DbOrTx, tenantId: string, customerId: string, start: string, end: string) {
  const row = await one<Record<string, string>>(dbx, sql`
    SELECT COUNT(DISTINCT COALESCE(reference_id::text, reference_no)) FILTER (WHERE transaction_type = 'receipt') AS in_docs, COALESCE(SUM(quantity) FILTER (WHERE transaction_type = 'receipt'), 0) AS in_units,
      COUNT(DISTINCT COALESCE(reference_id::text, reference_no)) FILTER (WHERE transaction_type = 'dispatch') AS out_docs, COALESCE(-SUM(quantity) FILTER (WHERE transaction_type = 'dispatch'), 0) AS out_units
    FROM inventory_transactions WHERE tenant_id = ${tenantId} AND owner_customer_id = ${customerId} AND created_at >= ${start}::date AND created_at < ${end}::date + 1`);
  return { inDocs: num(row?.in_docs), inUnits: num(row?.in_units), outDocs: num(row?.out_docs), outUnits: num(row?.out_units) };
}

const DAY_MEASURE: Partial<Record<(typeof STORAGE_BASES)[number], keyof DailyMeasure>> = {
  pallet_day: 'pallets', box_day: 'units', unit_day: 'units', cbm_day: 'cbm', kg_day: 'kg', bin_day: 'bins',
};

export async function computeStorageCharges(dbx: DbOrTx, tenantId: string, contractId: string, start: string, end: string) {
  const [contract] = await dbx.select().from(t.storageContracts).where(and(eq(t.storageContracts.id, contractId), eq(t.storageContracts.tenantId, tenantId))).limit(1);
  if (!contract) throw notFound('Storage contract');
  if (end < start) throw badRequest('Period end must be after the start.');
  const rates = await dbx.select().from(t.storageRates).where(eq(t.storageRates.contractId, contract.id));
  const days = await dailyStorage(dbx, tenantId, contract.customerId, start, end, contract.warehouseId);
  const handling = await handlingCounts(dbx, tenantId, contract.customerId, start, end);
  const dayCount = days.length;
  const months = dayCount / 30;
  const charges = rates.map((rate) => {
    const measure = DAY_MEASURE[rate.basis as keyof typeof DAY_MEASURE];
    let quantity = 0;
    let description = '';
    if (measure) {
      quantity = days.reduce((s, d) => s + d[measure], 0); // unit-days
      const avg = dayCount ? quantity / dayCount : 0;
      description = `${rate.chargeType.replace('_', ' ')}: avg ${Math.round(avg * 100) / 100} ${String(measure)} × ${dayCount} days`;
    } else if (rate.basis === 'sqm_month' || rate.basis === 'sqft_month' || rate.basis === 'fixed_month') {
      quantity = rate.basis === 'fixed_month' ? Math.max(rate.contractedQty, 1) * months : rate.contractedQty * months;
      description = `${rate.chargeType.replace('_', ' ')}: ${rate.contractedQty || 1} ${rate.basis.replace('_month', '')} × ${Math.round(months * 100) / 100} months`;
    } else {
      const inbound = ['inbound_handling', 'unloading'].includes(rate.chargeType);
      const outbound = ['outbound_handling', 'loading', 'picking', 'packing'].includes(rate.chargeType);
      if (rate.basis === 'per_unit') quantity = inbound ? handling.inUnits : outbound ? handling.outUnits : handling.inUnits + handling.outUnits;
      else quantity = inbound ? handling.inDocs : outbound ? handling.outDocs : handling.inDocs + handling.outDocs;
      description = `${rate.chargeType.replace(/_/g, ' ')}: ${quantity} ${rate.basis === 'per_unit' ? (quantity === 1 ? 'unit' : 'units') : (quantity === 1 ? 'transaction' : 'transactions')}`;
    }
    return { rateId: rate.id, chargeType: rate.chargeType, basis: rate.basis, quantity: Math.round(quantity * 1000) / 1000, days: dayCount, rate: rate.rate, amount: round2(quantity * rate.rate), description: rate.description ? `${rate.description} — ${description}` : description };
  });
  const subtotal = round2(charges.reduce((s, c) => s + c.amount, 0));
  const minimum = round2(contract.minimumMonthlyCharge * months);
  if (minimum > subtotal) charges.push({ rateId: null as never, chargeType: 'additional_handling', basis: 'fixed_month', quantity: 1, days: dayCount, rate: round2(minimum - subtotal), amount: round2(minimum - subtotal), description: 'Minimum monthly charge top-up' });
  return { contract, charges, total: round2(charges.reduce((s, c) => s + c.amount, 0)), days: dayCount, averageUnits: dayCount ? Math.round((days.reduce((s, d) => s + d.units, 0) / dayCount) * 100) / 100 : 0, handling };
}

export async function generateStorageInvoice(tx: Tx, ctx: Ctx, contractId: string, start: string, end: string) {
  const overlap = await one<{ n: number }>(tx, sql`SELECT COUNT(*)::int AS n FROM storage_charges WHERE tenant_id = ${ctx.tenantId} AND contract_id = ${contractId} AND invoice_id IS NOT NULL AND period_start <= ${end}::date AND period_end >= ${start}::date`);
  if ((overlap?.n ?? 0) > 0) throw conflict('ALREADY_BILLED', 'This period overlaps a period that has already been invoiced for this contract.');
  const preview = await computeStorageCharges(tx, ctx.tenantId, contractId, start, end);
  if (preview.total <= 0) throw badRequest('Nothing to bill for this period.');
  const [taxRate] = await tx.select().from(t.taxRates).where(and(eq(t.taxRates.tenantId, ctx.tenantId), eq(t.taxRates.isDefault, true))).limit(1);
  const [customer] = await tx.select({ taxExempt: t.customers.taxExempt }).from(t.customers).where(eq(t.customers.id, preview.contract.customerId));
  const ratePct = customer?.taxExempt ? 0 : taxRate?.rate ?? 0;
  const invoice = await createInvoice(tx, ctx, {
    type: 'storage', customerId: preview.contract.customerId, warehouseId: preview.contract.warehouseId, periodStart: start, periodEnd: end, currency: preview.contract.currency,
    notes: `Storage & handling ${start} to ${end} (contract ${preview.contract.number})`,
    lines: preview.charges.filter((c) => c.amount > 0).map((c) => ({ description: c.description, quantity: c.quantity, unitPrice: c.rate, taxRate: ratePct, taxAmount: round2(c.amount * ratePct / 100), lineTotal: round2(c.amount * (1 + ratePct / 100)) })),
  });
  for (const c of preview.charges) {
    await tx.insert(t.storageCharges).values({ tenantId: ctx.tenantId, contractId, customerId: preview.contract.customerId, rateId: c.rateId ?? null, periodStart: start, periodEnd: end, chargeType: c.chargeType, basis: c.basis, quantity: c.quantity, days: c.days, rate: c.rate, amount: c.amount, description: c.description, invoiceId: invoice.id, source: preview.handling });
  }
  await audit(tx, ctx, { action: 'storage.invoiced', entityType: 'storage_contract', entityId: contractId, newValue: { invoice: invoice.number, total: invoice.total, start, end } });
  return { invoice, ...preview };
}

const rateBody = z.object({ chargeType: z.enum(STORAGE_CHARGE_TYPES), basis: z.enum(STORAGE_BASES), rate: z.number().min(0), contractedQty: z.number().min(0).default(0), description: z.string().trim().max(200).default('') });

export function registerStorageBillingRoutes(r: Router) {
  r.get('/contracts', { summary: 'Storage contracts with rates', permission: 'billing.view' }, async ({ ctx }) => {
    const contracts = await rows<Record<string, unknown>>(db(), sql`
      SELECT sc.*, c.name AS customer_name, w.code AS warehouse_code,
        (SELECT COALESCE(SUM(b.quantity), 0)::float FROM inventory_balances b WHERE b.owner_customer_id = sc.customer_id AND b.tenant_id = sc.tenant_id) AS units_stored,
        (SELECT MAX(period_end) FROM storage_charges ch WHERE ch.contract_id = sc.id AND ch.invoice_id IS NOT NULL) AS last_billed_to
      FROM storage_contracts sc JOIN customers c ON c.id = sc.customer_id LEFT JOIN warehouses w ON w.id = sc.warehouse_id
      WHERE sc.tenant_id = ${ctx.tenantId} ORDER BY sc.created_at DESC`);
    const rates = await db().select().from(t.storageRates).where(eq(t.storageRates.tenantId, ctx.tenantId));
    return contracts.map((c) => ({ ...c, rates: rates.filter((x) => x.contractId === c.id) }));
  });

  r.post('/contracts', {
    summary: 'Create a storage contract with its rates',
    permission: 'billing.manage',
    body: z.object({ customerId: z.string().uuid(), warehouseId: z.string().uuid().nullish(), startDate: isoDate(), endDate: isoDate().nullish(), currency: z.string().length(3).optional(), minimumMonthlyCharge: z.number().min(0).default(0), notes: z.string().max(500).default(''), rates: z.array(rateBody).min(1) }),
  }, async ({ ctx, body }) => {
    return db().transaction(async (tx) => {
      const [c] = await tx.select({ id: t.customers.id }).from(t.customers).where(and(eq(t.customers.id, body.customerId), eq(t.customers.tenantId, ctx.tenantId))).limit(1);
      if (!c) throw notFound('Customer');
      await tx.update(t.customers).set({ isStorageClient: true }).where(eq(t.customers.id, c.id));
      const [contract] = await tx.insert(t.storageContracts).values({ tenantId: ctx.tenantId, number: await nextNumber(tx, ctx.tenantId, 'CON'), customerId: c.id, warehouseId: body.warehouseId ?? null, startDate: body.startDate, endDate: body.endDate ?? null, currency: body.currency ?? ctx.currency, minimumMonthlyCharge: body.minimumMonthlyCharge, notes: body.notes }).returning();
      await tx.insert(t.storageRates).values(body.rates.map((r0) => ({ ...r0, tenantId: ctx.tenantId, contractId: contract!.id })));
      await audit(tx, ctx, { action: 'storage_contract.created', entityType: 'storage_contract', entityId: contract!.id, newValue: { number: contract!.number, rates: body.rates } });
      return contract;
    });
  });

  r.post('/contracts/:id/rates', { summary: 'Add a rate to a contract', permission: 'billing.manage', params: idParam, body: rateBody }, async ({ ctx, params, body }) => {
    const [c] = await db().select({ id: t.storageContracts.id }).from(t.storageContracts).where(and(eq(t.storageContracts.id, params.id), eq(t.storageContracts.tenantId, ctx.tenantId))).limit(1);
    if (!c) throw notFound('Storage contract');
    const [rate] = await db().insert(t.storageRates).values({ ...body, tenantId: ctx.tenantId, contractId: c.id }).returning();
    await audit(db(), ctx, { action: 'storage_rate.added', entityType: 'storage_contract', entityId: c.id, newValue: body });
    return rate;
  });

  r.delete('/rates/:id', { summary: 'Remove a contract rate', permission: 'billing.manage', params: idParam }, async ({ ctx, params }) => {
    const [rate] = await db().delete(t.storageRates).where(and(eq(t.storageRates.id, params.id), eq(t.storageRates.tenantId, ctx.tenantId))).returning();
    if (!rate) throw notFound('Rate');
    await audit(db(), ctx, { action: 'storage_rate.removed', entityType: 'storage_contract', entityId: rate.contractId, oldValue: rate });
    return { ok: true };
  });

  r.get('/contracts/:id/preview', { summary: 'Preview storage and handling charges for a period (computed from the ledger)', permission: 'billing.view', params: idParam, query: z.object({ periodStart: isoDate(), periodEnd: isoDate() }) }, async ({ ctx, params, query }) =>
    computeStorageCharges(db(), ctx.tenantId, params.id, query.periodStart, query.periodEnd));

  r.post('/contracts/:id/invoice', { summary: 'Generate the storage invoice for a period', permission: 'billing.manage', params: idParam, body: z.object({ periodStart: isoDate(), periodEnd: isoDate() }) }, async ({ ctx, params, body }) =>
    db().transaction((tx) => generateStorageInvoice(tx, ctx, params.id, body.periodStart, body.periodEnd)));
}

// ───────────────────────── Profitability ─────────────────────────

export async function profitability(dbx: DbOrTx, tenantId: string, from: string, to: string, warehouseId?: string | null) {
  const wf = (col: string) => (warehouseId ? sql`AND ${sql.raw(col)} = ${warehouseId}` : sql``);
  const [rev, cogs, purchases, exp, freight, byWh] = await Promise.all([
    one<Record<string, string>>(dbx, sql`SELECT COALESCE(SUM(subtotal) FILTER (WHERE type IN ('sales', 'credit_note')), 0) AS sales, COALESCE(SUM(subtotal) FILTER (WHERE type = 'storage'), 0) AS storage FROM invoices WHERE tenant_id = ${tenantId} AND status <> 'void' AND issue_date BETWEEN ${from} AND ${to} ${wf('warehouse_id')}`),
    one<Record<string, string>>(dbx, sql`SELECT COALESCE(-SUM(quantity * unit_cost), 0) AS cogs FROM inventory_transactions WHERE tenant_id = ${tenantId} AND transaction_type = 'dispatch' AND owner_customer_id IS NULL AND created_at >= ${from}::date AND created_at < ${to}::date + 1 ${wf('warehouse_id')}`),
    one<Record<string, string>>(dbx, sql`SELECT COALESCE(SUM(subtotal), 0) AS purchases FROM supplier_bills WHERE tenant_id = ${tenantId} AND status <> 'void' AND bill_date BETWEEN ${from} AND ${to} ${wf('warehouse_id')}`),
    rows<Record<string, string>>(dbx, sql`SELECT category, SUM(amount) AS amount FROM expenses WHERE tenant_id = ${tenantId} AND status = 'approved' AND expense_date BETWEEN ${from} AND ${to} ${wf('warehouse_id')} GROUP BY category ORDER BY 2 DESC`),
    one<Record<string, string>>(dbx, sql`SELECT COALESCE(SUM(freight_cost), 0) AS freight FROM shipments WHERE tenant_id = ${tenantId} AND dispatched_at >= ${from}::date AND dispatched_at < ${to}::date + 1 ${wf('warehouse_id')}`),
    warehouseId ? Promise.resolve([]) : rows<Record<string, string>>(dbx, sql`
      SELECT w.id, w.code, w.name,
        COALESCE((SELECT SUM(subtotal) FROM invoices i WHERE i.warehouse_id = w.id AND i.status <> 'void' AND i.issue_date BETWEEN ${from} AND ${to}), 0) AS revenue,
        COALESCE((SELECT -SUM(quantity * unit_cost) FROM inventory_transactions m WHERE m.warehouse_id = w.id AND m.transaction_type = 'dispatch' AND m.owner_customer_id IS NULL AND m.created_at >= ${from}::date AND m.created_at < ${to}::date + 1), 0) AS cogs,
        COALESCE((SELECT SUM(amount) FROM expenses e WHERE e.warehouse_id = w.id AND e.status = 'approved' AND e.expense_date BETWEEN ${from} AND ${to}), 0) AS expenses,
        COALESCE((SELECT SUM(freight_cost) FROM shipments s WHERE s.warehouse_id = w.id AND s.dispatched_at >= ${from}::date AND s.dispatched_at < ${to}::date + 1), 0) AS freight
      FROM warehouses w WHERE w.tenant_id = ${tenantId} ORDER BY w.code`),
  ]);
  const sales = num(rev?.sales), storage = num(rev?.storage), cost = num(cogs?.cogs), fr = num(freight?.freight);
  const expenses = exp.map((e) => ({ category: e.category, amount: num(e.amount) }));
  const expenseTotal = expenses.reduce((s, e) => s + e.amount, 0);
  const labor = expenses.filter((e) => ['salaries', 'labor'].includes(String(e.category))).reduce((s, e) => s + e.amount, 0);
  const transport = expenses.filter((e) => ['transportation', 'fuel'].includes(String(e.category))).reduce((s, e) => s + e.amount, 0) + fr;
  const revenue = sales + storage;
  const grossProfit = revenue - cost;
  const operatingCost = expenseTotal + fr;
  return {
    period: { from, to }, basis: 'Estimated management view from invoices, ledger cost and recorded expenses. Not a statutory financial statement.',
    revenue: { sales: round2(sales), storageAndHandling: round2(storage), total: round2(revenue) },
    costs: { costOfGoodsSold: round2(cost), purchases: round2(num(purchases?.purchases)), expenses: round2(expenseTotal), labor: round2(labor), transportation: round2(transport), freight: round2(fr) },
    grossProfit: round2(grossProfit), grossMarginPct: revenue > 0 ? Math.round((grossProfit / revenue) * 1000) / 10 : null,
    operatingCost: round2(operatingCost), netProfit: round2(grossProfit - operatingCost), netMarginPct: revenue > 0 ? Math.round(((grossProfit - operatingCost) / revenue) * 1000) / 10 : null,
    expensesByCategory: expenses,
    byWarehouse: byWh.map((w) => {
      const revenueW = num(w.revenue), net = revenueW - num(w.cogs) - num(w.expenses) - num(w.freight);
      return { id: w.id, code: w.code, name: w.name, revenue: round2(revenueW), cogs: round2(num(w.cogs)), expenses: round2(num(w.expenses) + num(w.freight)), netProfit: round2(net), marginPct: revenueW > 0 ? Math.round((net / revenueW) * 1000) / 10 : null };
    }),
  };
}

export function registerProfitabilityRoutes(r: Router) {
  r.get('/', { summary: 'Estimated profitability (revenue, COGS, operating cost, net) — company and per warehouse', permission: 'report.financial', query: z.object({ from: isoDate(), to: isoDate(), warehouseId: z.string().uuid().optional() }) }, async ({ ctx, query }) =>
    profitability(db(), ctx.tenantId, query.from, query.to, query.warehouseId));
}
