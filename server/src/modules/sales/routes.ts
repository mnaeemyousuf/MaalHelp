import { z } from 'zod';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { PRIORITIES } from '@shared/domain';
import { db, num, rows, t, type DbOrTx, type Tx } from '../../db';
import { idParam, isoDate, pageQuery, paged, type Router } from '../../core/http';
import { AppError, badRequest, insufficientStock, invalidState, notFound } from '../../core/errors';
import { audit, diff } from '../../core/audit';
import type { Ctx } from '../../core/context';
import { nextNumber } from '../../core/numbering';
import { camel } from '../../core/case';
import { redactFinance } from '../../core/finance-visibility';
import { computeDocument } from '../finance/tax';
import { orderOutstanding, releaseReservations, reserveOrder } from './reservation';
import { emitEvent } from '../integrations/events';
import { moveStock, totalAvailable } from '../inventory/ledger';

export const customerBody = z.object({
  code: z.string().trim().toUpperCase().max(20).optional(),
  name: z.string().trim().min(2).max(160),
  contactName: z.string().trim().max(120).default(''),
  phone: z.string().trim().max(40).default(''),
  email: z.string().trim().email().or(z.literal('')).default(''),
  address: z.string().trim().max(400).default(''),
  city: z.string().trim().max(80).default(''),
  country: z.string().trim().length(2).default('PK'),
  ntn: z.string().trim().max(40).default(''),
  strn: z.string().trim().max(40).default(''),
  creditLimit: z.coerce.number().min(0).default(0),
  paymentTermsDays: z.coerce.number().int().min(0).max(365).default(30),
  taxExempt: z.boolean().default(false),
  isStorageClient: z.boolean().default(false),
  status: z.enum(['active', 'inactive', 'on_hold']).default('active'),
  notes: z.string().trim().max(1000).default(''),
});

export async function createCustomer(tx: DbOrTx, ctx: Ctx, body: z.infer<typeof customerBody>) {
  const code = body.code || (await nextNumber(tx, ctx.tenantId, 'CUS'));
  const [c] = await tx.insert(t.customers).values({ ...body, code, tenantId: ctx.tenantId }).returning();
  await audit(tx, ctx, { action: 'customer.created', entityType: 'customer', entityId: c!.id, newValue: { code, name: body.name } });
  return c!;
}

export function registerCustomerRoutes(r: Router) {
  r.get('/', { summary: 'Customers with outstanding balance', permission: ['customer.view', 'sales.view', 'billing.view'], query: pageQuery.extend({ status: z.string().optional(), storageClients: z.coerce.boolean().optional() }) }, async ({ ctx, query }) => {
    const like = query.q ? `%${query.q.toLowerCase()}%` : null;
    const list = await rows<Record<string, unknown>>(db(), sql`
      SELECT c.*, COUNT(*) OVER() AS total_count,
        COALESCE((SELECT SUM(i.total - i.amount_paid) FROM invoices i WHERE i.customer_id = c.id AND i.status IN ('issued', 'partially_paid')), 0)::float AS outstanding,
        COALESCE((SELECT SUM(i.total - i.amount_paid) FROM invoices i WHERE i.customer_id = c.id AND i.status IN ('issued', 'partially_paid') AND i.due_date < CURRENT_DATE), 0)::float AS overdue,
        COALESCE((SELECT SUM(so.total) FROM sales_orders so WHERE so.customer_id = c.id AND so.status NOT IN ('draft', 'cancelled')), 0)::float AS lifetime_sales,
        (SELECT MAX(so.created_at) FROM sales_orders so WHERE so.customer_id = c.id) AS last_order_at
      FROM customers c WHERE c.tenant_id = ${ctx.tenantId}
      ${like ? sql`AND (lower(c.name) LIKE ${like} OR lower(c.code) LIKE ${like} OR c.phone LIKE ${like} OR lower(c.city) LIKE ${like})` : sql``}
      ${query.status ? sql`AND c.status = ${query.status}` : sql``}
      ${query.storageClients ? sql`AND c.is_storage_client` : sql``}
      ORDER BY ${sql.raw(({ name: 'c.name', outstanding: 'outstanding', sales: 'lifetime_sales', overdue: 'overdue' } as Record<string, string>)[query.sort ?? ''] ?? 'c.name')} ${sql.raw(query.sort ? (query.dir === 'asc' ? 'ASC' : 'DESC') : 'ASC')}
      LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`);
    const data = list.map(({ total_count: _t, ...x }) => camel(x));
    return paged(ctx.permissions.has('finance.view') || ctx.permissions.has('billing.view') || ctx.permissions.has('sales.view') ? data : redactFinance(ctx, data), num(list[0]?.total_count), query.page, query.pageSize);
  });

  r.post('/', { summary: 'Create a customer', permission: 'customer.manage', body: customerBody }, async ({ ctx, body }) => db().transaction((tx) => createCustomer(tx, ctx, body)));

  r.patch('/:id', { summary: 'Update a customer', permission: 'customer.manage', params: idParam, body: customerBody.partial() }, async ({ ctx, params, body }) => {
    const [before] = await db().select().from(t.customers).where(and(eq(t.customers.id, params.id), eq(t.customers.tenantId, ctx.tenantId))).limit(1);
    if (!before) throw notFound('Customer');
    if (body.creditLimit !== undefined && body.creditLimit !== before.creditLimit && !ctx.permissions.has('finance.view')) throw new AppError(403, 'FORBIDDEN', 'Only finance users can change credit limits.');
    const [c] = await db().update(t.customers).set(body).where(eq(t.customers.id, params.id)).returning();
    await audit(db(), ctx, { action: 'customer.updated', entityType: 'customer', entityId: params.id, ...diff(before as Record<string, unknown>, body) });
    return c;
  });

  r.get('/:id', { summary: 'Customer 360: orders, purchases, payments, outstanding, returns, held inventory, profitability', permission: ['customer.view', 'sales.view'], params: idParam }, async ({ ctx, params }) => {
    const [c] = await db().select().from(t.customers).where(and(eq(t.customers.id, params.id), eq(t.customers.tenantId, ctx.tenantId))).limit(1);
    if (!c) throw notFound('Customer');
    const [orders, purchases, payments, invoices, returns, held, profit, storage] = await Promise.all([
      rows(db(), sql`SELECT id, number, status, order_date AS "orderDate", total::float AS total, priority FROM sales_orders WHERE tenant_id = ${ctx.tenantId} AND customer_id = ${c.id} ORDER BY created_at DESC LIMIT 50`),
      rows(db(), sql`SELECT p.id, p.sku, p.name, SUM(l.shipped_qty)::float AS quantity, SUM(l.shipped_qty * l.unit_price)::float AS revenue FROM sales_order_lines l JOIN sales_orders so ON so.id = l.sales_order_id JOIN products p ON p.id = l.product_id WHERE so.tenant_id = ${ctx.tenantId} AND so.customer_id = ${c.id} AND l.shipped_qty > 0 GROUP BY p.id ORDER BY revenue DESC LIMIT 20`),
      rows(db(), sql`SELECT id, number, amount::float AS amount, method, reference, paid_at AS "paidAt" FROM payments WHERE tenant_id = ${ctx.tenantId} AND customer_id = ${c.id} ORDER BY paid_at DESC LIMIT 50`),
      rows(db(), sql`SELECT id, number, type, issue_date AS "issueDate", due_date AS "dueDate", total::float AS total, amount_paid::float AS "amountPaid", status, (due_date < CURRENT_DATE AND status IN ('issued', 'partially_paid')) AS overdue FROM invoices WHERE tenant_id = ${ctx.tenantId} AND customer_id = ${c.id} ORDER BY issue_date DESC LIMIT 50`),
      rows(db(), sql`SELECT id, number, reason, status, credit_total::float AS "creditTotal", created_at AS "createdAt" FROM customer_returns WHERE tenant_id = ${ctx.tenantId} AND customer_id = ${c.id} ORDER BY created_at DESC LIMIT 50`),
      rows(db(), sql`SELECT p.sku, p.name, w.code AS "warehouseCode", SUM(b.quantity)::float AS quantity FROM inventory_balances b JOIN products p ON p.id = b.product_id JOIN warehouses w ON w.id = b.warehouse_id WHERE b.tenant_id = ${ctx.tenantId} AND b.owner_customer_id = ${c.id} AND b.quantity > 0 GROUP BY p.id, w.code ORDER BY quantity DESC`),
      rows<{ revenue: string; cost: string }>(db(), sql`SELECT COALESCE(SUM(l.shipped_qty * l.unit_price * (1 - l.discount_pct / 100)), 0) AS revenue, COALESCE(SUM(l.shipped_qty * l.unit_cost), 0) AS cost FROM sales_order_lines l JOIN sales_orders so ON so.id = l.sales_order_id WHERE so.tenant_id = ${ctx.tenantId} AND so.customer_id = ${c.id}`),
      rows<{ fees: string }>(db(), sql`SELECT COALESCE(SUM(total), 0) AS fees FROM invoices WHERE tenant_id = ${ctx.tenantId} AND customer_id = ${c.id} AND type = 'storage'`),
    ]);
    const outstanding = invoices.reduce((s, i) => s + (['issued', 'partially_paid'].includes(String(i.status)) ? num(i.total) - num(i.amountPaid) : 0), 0);
    const overdue = invoices.reduce((s, i) => s + (i.overdue ? num(i.total) - num(i.amountPaid) : 0), 0);
    const revenue = num(profit[0]?.revenue), cost = num(profit[0]?.cost), fees = num(storage[0]?.fees);
    return redactFinance(ctx, {
      ...c, orders, purchases, payments, invoices, returns, heldInventory: held, outstanding, overdue,
      creditAvailable: c.creditLimit > 0 ? Math.max(0, c.creditLimit - outstanding) : null,
      profitability: { revenue, cost, storageFees: fees, grossMargin: revenue - cost + fees, marginPct: revenue + fees > 0 ? Math.round(((revenue - cost + fees) / (revenue + fees)) * 1000) / 10 : null },
    });
  });
}

const soLine = z.object({ productId: z.string().uuid(), quantity: z.number().positive(), unitPrice: z.number().min(0).optional(), discountPct: z.number().min(0).max(100).default(0), taxRate: z.number().min(0).max(100).optional() });
export const soBody = z.object({
  customerId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  orderDate: isoDate().optional(),
  requiredDate: isoDate().nullish(),
  priority: z.enum(PRIORITIES).default('normal'),
  shippingAddress: z.string().trim().max(400).default(''),
  notes: z.string().trim().max(1000).default(''),
  allowPartial: z.boolean().default(true),
  confirm: z.boolean().default(false),
  overrideCreditLimit: z.boolean().default(false),
  lines: z.array(soLine).min(1, 'Add at least one product.').max(300),
});

async function priceLines(tx: DbOrTx, ctx: Ctx, customer: { taxExempt: boolean }, lines: z.infer<typeof soLine>[]) {
  const ids = [...new Set(lines.map((l) => l.productId))];
  const products = await tx.select().from(t.products).where(and(eq(t.products.tenantId, ctx.tenantId), inArray(t.products.id, ids)));
  if (products.length !== ids.length) throw badRequest('One or more products do not belong to your company.');
  const taxes = await tx.select().from(t.taxRates).where(eq(t.taxRates.tenantId, ctx.tenantId));
  const defaultTax = taxes.find((x) => x.isDefault && x.appliesTo !== 'purchase');
  const [tenant] = await tx.select({ inclusive: t.tenants.taxInclusivePricing }).from(t.tenants).where(eq(t.tenants.id, ctx.tenantId)).limit(1);
  const priced = lines.map((l) => {
    const p = products.find((x) => x.id === l.productId)!;
    if (p.status !== 'active') throw badRequest(`${p.sku} is ${p.status} and cannot be sold.`);
    const taxRate = customer.taxExempt ? 0 : l.taxRate ?? taxes.find((x) => x.id === p.taxRateId)?.rate ?? defaultTax?.rate ?? 0;
    return { ...l, unitPrice: l.unitPrice ?? p.sellingPrice, taxRate, sku: p.sku };
  });
  const doc = computeDocument(priced.map((l) => ({ quantity: l.quantity, unitPrice: l.unitPrice, discountPct: l.discountPct, taxRate: l.taxRate })), tenant?.inclusive ?? false);
  return { lines: priced.map((l, i) => ({ ...l, taxAmount: doc.lines[i]!.tax, lineTotal: doc.lines[i]!.total })), totals: doc.totals };
}

export async function getOrder(dbx: DbOrTx, tenantId: string, id: string, lock = false) {
  const q = dbx.select().from(t.salesOrders).where(and(eq(t.salesOrders.id, id), eq(t.salesOrders.tenantId, tenantId))).limit(1);
  const [o] = lock ? await q.for('update') : await q;
  if (!o) throw notFound('Sales order');
  return o;
}

export async function createSalesOrder(tx: Tx, ctx: Ctx, body: z.infer<typeof soBody>) {
  const [customer] = await tx.select().from(t.customers).where(and(eq(t.customers.id, body.customerId), eq(t.customers.tenantId, ctx.tenantId))).limit(1);
  if (!customer) throw notFound('Customer');
  if (customer.status !== 'active') throw badRequest(`Customer ${customer.name} is ${customer.status.replace('_', ' ')}.`);
  const [w] = await tx.select({ id: t.warehouses.id }).from(t.warehouses).where(and(eq(t.warehouses.id, body.warehouseId), eq(t.warehouses.tenantId, ctx.tenantId))).limit(1);
  if (!w) throw notFound('Warehouse');
  const { lines, totals } = await priceLines(tx, ctx, customer, body.lines);
  const number = await nextNumber(tx, ctx.tenantId, 'SO');
  const [tenant] = await tx.select({ currency: t.tenants.baseCurrency }).from(t.tenants).where(eq(t.tenants.id, ctx.tenantId)).limit(1);
  const [order] = await tx.insert(t.salesOrders).values({
    tenantId: ctx.tenantId, number, customerId: customer.id, warehouseId: w.id, status: 'draft', priority: body.priority,
    orderDate: body.orderDate ?? new Date().toISOString().slice(0, 10), requiredDate: body.requiredDate ?? null, currency: tenant?.currency ?? 'PKR',
    shippingAddress: body.shippingAddress || customer.address, notes: body.notes, allowPartial: body.allowPartial ? 1 : 0, createdBy: ctx.userId || null, ...totals,
  }).returning();
  await tx.insert(t.salesOrderLines).values(lines.map((l) => ({ tenantId: ctx.tenantId, salesOrderId: order!.id, productId: l.productId, quantity: l.quantity, unitPrice: l.unitPrice, discountPct: l.discountPct, taxRate: l.taxRate, taxAmount: l.taxAmount, lineTotal: l.lineTotal })));
  await audit(tx, ctx, { action: 'sales_order.created', entityType: 'sales_order', entityId: order!.id, newValue: { number, customer: customer.name, total: totals.total } });
  if (body.confirm) return confirmOrder(tx, ctx, order!.id, body.overrideCreditLimit);
  return { ...order!, reservation: null };
}

/** Confirms an order (credit check + stock check) and reserves stock immediately. */
export async function confirmOrder(tx: Tx, ctx: Ctx, orderId: string, overrideCreditLimit = false) {
  const order = await getOrder(tx, ctx.tenantId, orderId, true);
  if (order.status !== 'draft') throw invalidState(`Order ${order.number} is already ${order.status}.`);
  const [customer] = await tx.select().from(t.customers).where(eq(t.customers.id, order.customerId)).limit(1);
  if (customer && customer.creditLimit > 0) {
    const outstanding = await orderOutstanding(tx, ctx.tenantId, customer.id);
    if (outstanding + order.total > customer.creditLimit) {
      if (!overrideCreditLimit || ctx.roleKey !== 'owner') {
        throw new AppError(409, 'CREDIT_LIMIT_EXCEEDED', `${customer.name} would exceed the credit limit (outstanding ${outstanding.toLocaleString()} + order ${order.total.toLocaleString()} > limit ${customer.creditLimit.toLocaleString()}). An owner can override.`, { outstanding, creditLimit: customer.creditLimit });
      }
      await audit(tx, ctx, { action: 'sales_order.credit_override', entityType: 'sales_order', entityId: order.id, newValue: { outstanding, creditLimit: customer.creditLimit, total: order.total } });
    }
  }
  const lines = await tx.select().from(t.salesOrderLines).where(eq(t.salesOrderLines.salesOrderId, order.id));
  if (!order.allowPartial) {
    for (const l of lines) {
      const avail = await totalAvailable(tx, ctx.tenantId, l.productId, order.warehouseId);
      if (avail < l.quantity) {
        const [p] = await tx.select({ sku: t.products.sku }).from(t.products).where(eq(t.products.id, l.productId));
        throw insufficientStock(`${p?.sku}: only ${avail} available; order needs ${l.quantity}. Allow partial fulfilment or reduce the quantity.`, { productId: l.productId, available: avail });
      }
    }
  }
  await tx.update(t.salesOrders).set({ status: 'confirmed', confirmedAt: new Date() }).where(eq(t.salesOrders.id, order.id));
  const reservation = await reserveOrder(tx, ctx, order.id);
  if (!order.allowPartial && reservation.shortUnits > 0) throw insufficientStock('Stock is not available at pickable locations for the full order. Put away received goods or allow partial fulfilment.');
  if (reservation.reservedUnits > 0) await tx.update(t.salesOrders).set({ status: 'reserved', reservedAt: new Date() }).where(eq(t.salesOrders.id, order.id));
  await audit(tx, ctx, { action: 'sales_order.confirmed', entityType: 'sales_order', entityId: order.id, newValue: reservation });
  await emitEvent(tx, ctx.tenantId, 'sales_order.confirmed', { salesOrderId: order.id, number: order.number, ...reservation });
  const after = await getOrder(tx, ctx.tenantId, order.id);
  return { ...after, reservation };
}

export function registerSalesOrderRoutes(r: Router) {
  r.get('/', {
    summary: 'Sales orders',
    permission: ['sales.view', 'picking.execute', 'packing.execute', 'dispatch.execute'],
    query: pageQuery.extend({ status: z.string().optional(), customerId: z.string().uuid().optional(), warehouseId: z.string().uuid().optional(), from: isoDate().optional(), to: isoDate().optional(), delayed: z.coerce.boolean().optional() }),
  }, async ({ ctx, query }) => {
    const statuses = query.status?.split(',').filter(Boolean);
    const like = query.q ? `%${query.q.toLowerCase()}%` : null;
    const delayed = sql`(so.required_date < CURRENT_DATE AND so.status IN ('confirmed', 'reserved', 'picking', 'packed')) OR (so.required_date IS NULL AND so.status IN ('confirmed', 'reserved', 'picking') AND so.confirmed_at < now() - interval '3 days')`;
    const list = await rows<Record<string, unknown>>(db(), sql`
      SELECT so.id, so.number, so.status, so.priority, so.order_date AS "orderDate", so.required_date AS "requiredDate", so.total::float AS total, so.currency, so.created_at AS "createdAt",
        so.package_count AS "packageCount", c.id AS "customerId", c.name AS "customerName", w.code AS "warehouseCode", w.id AS "warehouseId",
        (SELECT COALESCE(SUM(quantity), 0)::float FROM sales_order_lines l WHERE l.sales_order_id = so.id) AS "orderedQty",
        (SELECT COALESCE(SUM(reserved_qty), 0)::float FROM sales_order_lines l WHERE l.sales_order_id = so.id) AS "reservedQty",
        (SELECT COALESCE(SUM(picked_qty), 0)::float FROM sales_order_lines l WHERE l.sales_order_id = so.id) AS "pickedQty",
        (SELECT COALESCE(SUM(shipped_qty), 0)::float FROM sales_order_lines l WHERE l.sales_order_id = so.id) AS "shippedQty",
        (${delayed}) AS delayed, COUNT(*) OVER() AS total_count
      FROM sales_orders so JOIN customers c ON c.id = so.customer_id JOIN warehouses w ON w.id = so.warehouse_id
      WHERE so.tenant_id = ${ctx.tenantId}
      ${statuses?.length ? sql`AND so.status IN (${sql.join(statuses.map((s) => sql`${s}`), sql`, `)})` : sql``}
      ${query.customerId ? sql`AND so.customer_id = ${query.customerId}` : sql``}
      ${query.warehouseId ? sql`AND so.warehouse_id = ${query.warehouseId}` : sql``}
      ${query.from ? sql`AND so.order_date >= ${query.from}` : sql``}
      ${query.to ? sql`AND so.order_date <= ${query.to}` : sql``}
      ${query.delayed ? sql`AND (${delayed})` : sql``}
      ${like ? sql`AND (lower(so.number) LIKE ${like} OR lower(c.name) LIKE ${like})` : sql``}
      ORDER BY ${sql.raw(({ number: 'so.number', total: 'so.total', customer: 'c.name', required: 'so.required_date', priority: "array_position(ARRAY['urgent','high','normal','low'], so.priority)" } as Record<string, string>)[query.sort ?? ''] ?? 'so.created_at')} ${sql.raw(query.dir === 'asc' ? 'ASC' : 'DESC')} NULLS LAST
      LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`);
    return paged(list.map(({ total_count: _t, ...x }) => x), num(list[0]?.total_count), query.page, query.pageSize);
  });

  r.get('/:id', { summary: 'Sales order with lines, availability, pick tasks, packages, shipment and invoice', permission: ['sales.view', 'picking.execute', 'packing.execute', 'dispatch.execute'], params: idParam }, async ({ ctx, params }) => {
    const order = await getOrder(db(), ctx.tenantId, params.id);
    const [lines, tasks, pkgs, shipment, invoice, customer, warehouse] = await Promise.all([
      rows(db(), sql`SELECT l.id, l.product_id AS "productId", p.sku, p.name AS "productName", p.barcode, p.uom, p.weight_kg::float AS "weightKg", l.quantity::float AS quantity, l.unit_price::float AS "unitPrice",
          l.discount_pct::float AS "discountPct", l.tax_rate::float AS "taxRate", l.tax_amount::float AS "taxAmount", l.line_total::float AS "lineTotal", l.reserved_qty::float AS "reservedQty",
          l.picked_qty::float AS "pickedQty", l.packed_qty::float AS "packedQty", l.shipped_qty::float AS "shippedQty", l.unit_cost::float AS "unitCost",
          COALESCE((SELECT SUM(b.quantity) FROM inventory_balances b JOIN locations loc ON loc.id = b.location_id WHERE b.tenant_id = ${ctx.tenantId} AND b.product_id = l.product_id AND b.warehouse_id = ${order.warehouseId} AND b.status = 'available' AND b.owner_customer_id IS NULL AND loc.is_pickable), 0)::float AS "availableNow"
        FROM sales_order_lines l JOIN products p ON p.id = l.product_id WHERE l.sales_order_id = ${order.id} ORDER BY p.sku`),
      rows(db(), sql`SELECT pt.id, pt.number, pt.status, pt.quantity::float AS quantity, pt.picked_qty::float AS "pickedQty", p.sku, l.code AS "locationCode", bt.batch_no AS "batchNo", u.name AS "pickedBy", pt.picked_at AS "pickedAt"
        FROM pick_tasks pt JOIN products p ON p.id = pt.product_id JOIN locations l ON l.id = pt.location_id LEFT JOIN batches bt ON bt.id = pt.batch_id LEFT JOIN users u ON u.id = pt.picked_by WHERE pt.sales_order_id = ${order.id} ORDER BY pt.created_at`),
      db().select().from(t.packages).where(eq(t.packages.salesOrderId, order.id)),
      db().select().from(t.shipments).where(eq(t.shipments.salesOrderId, order.id)),
      db().select().from(t.invoices).where(eq(t.invoices.salesOrderId, order.id)),
      db().select().from(t.customers).where(eq(t.customers.id, order.customerId)),
      db().select({ id: t.warehouses.id, code: t.warehouses.code, name: t.warehouses.name, address: t.warehouses.address, city: t.warehouses.city }).from(t.warehouses).where(eq(t.warehouses.id, order.warehouseId)),
    ]);
    const shipped = ['dispatched', 'delivered', 'completed'].includes(order.status);
    const backorder = lines.reduce((s, l) => s + Math.max(0, num(l.quantity) - (shipped ? num(l.shippedQty) : num(l.reservedQty))), 0);
    const readyToPack = tasks.length > 0 && tasks.every((x) => ['completed', 'short', 'cancelled'].includes(String(x.status))) && lines.some((l) => num(l.pickedQty) > 0);
    return redactFinance(ctx, { ...order, lines, pickTasks: tasks, packages: pkgs, shipments: shipment, invoices: invoice, customer: customer[0], warehouse: warehouse[0], backorderQty: backorder, readyToPack });
  });

  r.post('/', { summary: 'Create a sales order (optionally confirm + reserve in one step)', permission: 'sales.manage', idempotent: true, body: soBody }, async ({ ctx, body }) =>
    db().transaction((tx) => createSalesOrder(tx, ctx, body)));

  r.put('/:id', { summary: 'Edit a draft sales order', permission: 'sales.manage', params: idParam, body: soBody.omit({ confirm: true, overrideCreditLimit: true }) }, async ({ ctx, params, body }) => {
    return db().transaction(async (tx) => {
      const order = await getOrder(tx, ctx.tenantId, params.id, true);
      if (order.status !== 'draft') throw invalidState('Only draft orders can be edited.');
      const [customer] = await tx.select().from(t.customers).where(and(eq(t.customers.id, body.customerId), eq(t.customers.tenantId, ctx.tenantId))).limit(1);
      if (!customer) throw notFound('Customer');
      const { lines, totals } = await priceLines(tx, ctx, customer, body.lines);
      await tx.delete(t.salesOrderLines).where(eq(t.salesOrderLines.salesOrderId, order.id));
      await tx.insert(t.salesOrderLines).values(lines.map((l) => ({ tenantId: ctx.tenantId, salesOrderId: order.id, productId: l.productId, quantity: l.quantity, unitPrice: l.unitPrice, discountPct: l.discountPct, taxRate: l.taxRate, taxAmount: l.taxAmount, lineTotal: l.lineTotal })));
      const [updated] = await tx.update(t.salesOrders).set({ customerId: customer.id, warehouseId: body.warehouseId, priority: body.priority, requiredDate: body.requiredDate ?? null, notes: body.notes, shippingAddress: body.shippingAddress, allowPartial: body.allowPartial ? 1 : 0, ...totals }).where(eq(t.salesOrders.id, order.id)).returning();
      await audit(tx, ctx, { action: 'sales_order.updated', entityType: 'sales_order', entityId: order.id, oldValue: { total: order.total }, newValue: { total: totals.total } });
      return updated;
    });
  });

  r.post('/:id/confirm', { summary: 'Confirm and reserve stock (credit and availability checks)', permission: 'sales.manage', params: idParam, body: z.object({ overrideCreditLimit: z.boolean().default(false) }) }, async ({ ctx, params, body }) =>
    db().transaction((tx) => confirmOrder(tx, ctx, params.id, body.overrideCreditLimit)));

  r.post('/:id/reserve', { summary: 'Retry reservation for back-ordered quantities', permission: ['sales.manage', 'task.manage'], params: idParam }, async ({ ctx, params }) => {
    return db().transaction(async (tx) => {
      const order = await getOrder(tx, ctx.tenantId, params.id, true);
      if (!['confirmed', 'reserved', 'picking'].includes(order.status)) throw invalidState('Only confirmed orders awaiting fulfilment can be reserved.');
      const reservation = await reserveOrder(tx, ctx, order.id);
      if (reservation.reservedUnits > 0 && order.status === 'confirmed') await tx.update(t.salesOrders).set({ status: 'reserved', reservedAt: new Date() }).where(eq(t.salesOrders.id, order.id));
      await audit(tx, ctx, { action: 'sales_order.reserved', entityType: 'sales_order', entityId: order.id, newValue: reservation });
      return reservation;
    });
  });

  r.post('/:id/priority', { summary: 'Change order priority (re-prioritises its pick tasks)', permission: ['sales.manage', 'task.manage'], params: idParam, body: z.object({ priority: z.enum(PRIORITIES) }) }, async ({ ctx, params, body }) => {
    return db().transaction(async (tx) => {
      const order = await getOrder(tx, ctx.tenantId, params.id);
      await tx.update(t.salesOrders).set({ priority: body.priority }).where(eq(t.salesOrders.id, order.id));
      await tx.update(t.pickTasks).set({ priority: body.priority }).where(and(eq(t.pickTasks.salesOrderId, order.id), inArray(t.pickTasks.status, ['pending', 'in_progress'])));
      await audit(tx, ctx, { action: 'sales_order.priority_changed', entityType: 'sales_order', entityId: order.id, oldValue: { priority: order.priority }, newValue: body });
      return { ok: true };
    });
  });

  r.post('/:id/cancel', { summary: 'Cancel an order before dispatch (releases reservations)', permission: 'sales.manage', params: idParam, body: z.object({ reason: z.string().trim().min(3).max(300) }) }, async ({ ctx, params, body }) => {
    return db().transaction(async (tx) => {
      const order = await getOrder(tx, ctx.tenantId, params.id, true);
      if (!['draft', 'confirmed', 'reserved', 'picking', 'packed'].includes(order.status)) throw invalidState(`A ${order.status} order cannot be cancelled. Use a return instead.`);
      const released = await releaseReservations(tx, ctx, order.id, `Order cancelled: ${body.reason}`);
      // Picked stock already at the dispatch dock goes back to available there (put it away again).
      const picked = await tx.select().from(t.stockReservations).where(and(eq(t.stockReservations.salesOrderId, order.id), eq(t.stockReservations.status, 'picked')));
      const [dock] = await tx.select({ id: t.locations.id }).from(t.locations).where(and(eq(t.locations.tenantId, ctx.tenantId), eq(t.locations.warehouseId, order.warehouseId), eq(t.locations.isDispatch, true))).limit(1);
      for (const p of picked) {
        if (!dock || p.pickedQty <= 0) continue;
        const key = { warehouseId: p.warehouseId, locationId: dock.id, productId: p.productId, batchId: p.batchId, ownerCustomerId: p.ownerCustomerId };
        await moveStock(tx, ctx, { from: { ...key, status: 'reserved' }, to: { ...key, status: 'available' }, quantity: p.pickedQty, outType: 'reservation_release', inType: 'reservation_release', referenceType: 'sales_order', referenceId: order.id, referenceNo: order.number, reason: 'Order cancelled after picking' });
        await tx.update(t.stockReservations).set({ status: 'released' }).where(eq(t.stockReservations.id, p.id));
      }
      await tx.execute(sql`UPDATE shipments SET status = 'failed' WHERE sales_order_id = ${order.id} AND status = 'ready'`);
      await tx.update(t.salesOrders).set({ status: 'cancelled', cancelledAt: new Date(), notes: `${order.notes}\n[Cancelled] ${body.reason}`.trim() }).where(eq(t.salesOrders.id, order.id));
      await audit(tx, ctx, { action: 'sales_order.cancelled', entityType: 'sales_order', entityId: order.id, oldValue: { status: order.status }, newValue: { reason: body.reason, releasedUnits: released } });
      return { status: 'cancelled', releasedUnits: released };
    });
  });

  r.post('/:id/complete', { summary: 'Complete a delivered order', permission: 'sales.manage', params: idParam }, async ({ ctx, params }) => {
    const order = await getOrder(db(), ctx.tenantId, params.id);
    if (order.status !== 'delivered') throw invalidState('Only delivered orders can be completed.');
    await db().update(t.salesOrders).set({ status: 'completed', completedAt: new Date() }).where(eq(t.salesOrders.id, order.id));
    await audit(db(), ctx, { action: 'sales_order.completed', entityType: 'sales_order', entityId: order.id });
    return { status: 'completed' };
  });

  r.post('/:id/backorder', { summary: 'Create a new order for quantities not shipped (partial fulfilment)', permission: 'sales.manage', params: idParam }, async ({ ctx, params }) => {
    return db().transaction(async (tx) => {
      const order = await getOrder(tx, ctx.tenantId, params.id);
      if (!['dispatched', 'delivered', 'completed'].includes(order.status)) throw invalidState('Back-orders are created after the original order ships.');
      const lines = await tx.select().from(t.salesOrderLines).where(eq(t.salesOrderLines.salesOrderId, order.id));
      const remaining = lines.filter((l) => l.quantity - l.shippedQty > 1e-9).map((l) => ({ productId: l.productId, quantity: l.quantity - l.shippedQty, unitPrice: l.unitPrice, discountPct: l.discountPct, taxRate: l.taxRate }));
      if (!remaining.length) throw badRequest('Everything on this order has shipped.');
      const created = await createSalesOrder(tx, ctx, soBody.parse({ customerId: order.customerId, warehouseId: order.warehouseId, priority: order.priority, notes: `Back-order of ${order.number}`, shippingAddress: order.shippingAddress, lines: remaining }));
      await audit(tx, ctx, { action: 'sales_order.backorder_created', entityType: 'sales_order', entityId: order.id, newValue: { backorder: created.number } });
      return created;
    });
  });

  r.get('/availability/check', {
    summary: 'Real-time sellable availability for products in a warehouse',
    permission: ['sales.view', 'inventory.view'],
    query: z.object({ warehouseId: z.string().uuid(), productIds: z.string().min(1) }),
  }, async ({ ctx, query }) => {
    const ids = query.productIds.split(',').filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 200);
    if (!ids.length) return [];
    return rows(db(), sql`SELECT p.id AS "productId", p.sku,
        COALESCE(SUM(b.quantity) FILTER (WHERE b.status = 'available' AND loc.is_pickable), 0)::float AS sellable,
        COALESCE(SUM(b.quantity) FILTER (WHERE b.status = 'available' AND NOT loc.is_pickable), 0)::float AS "awaitingPutaway",
        COALESCE(SUM(b.quantity) FILTER (WHERE b.status = 'reserved'), 0)::float AS reserved
      FROM products p LEFT JOIN inventory_balances b ON b.product_id = p.id AND b.warehouse_id = ${query.warehouseId} AND b.owner_customer_id IS NULL AND b.quantity > 0
      LEFT JOIN locations loc ON loc.id = b.location_id
      WHERE p.tenant_id = ${ctx.tenantId} AND p.id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) GROUP BY p.id`);
  });
}
