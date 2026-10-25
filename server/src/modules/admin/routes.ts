import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { db, num, rows, t } from '../../db';
import { idParam, isoDate, pageQuery, paged, type Router } from '../../core/http';
import { notFound } from '../../core/errors';
import { canDecide, decideApproval } from '../approvals/engine';
import { scanAlerts } from '../analytics/insights';

export function registerAlertRoutes(r: Router) {
  r.get('/', {
    summary: 'Alert center (only alerts the user is permitted to see)',
    permission: ['alert.view', 'dashboard.view', 'inventory.view'],
    query: pageQuery.extend({ severity: z.enum(['critical', 'warning', 'info']).optional(), status: z.enum(['open', 'resolved', 'all']).default('open'), unread: z.coerce.boolean().optional(), category: z.string().optional() }),
  }, async ({ ctx, query }) => {
    const perms = [...ctx.permissions];
    if (!perms.length) return paged([], 0, query.page, query.pageSize);
    const list = await rows<Record<string, unknown>>(db(), sql`
      SELECT n.id, n.severity, n.category, n.title, n.body, n.entity_type AS "entityType", n.entity_id AS "entityId", n.action_url AS "actionUrl", n.created_at AS "createdAt", n.resolved_at AS "resolvedAt",
        EXISTS (SELECT 1 FROM notification_reads r WHERE r.notification_id = n.id AND r.user_id = ${ctx.userId}) AS read, COUNT(*) OVER() AS total_count
      FROM notifications n
      WHERE n.tenant_id = ${ctx.tenantId} AND (n.user_id IS NULL OR n.user_id = ${ctx.userId}) AND n.permission IN (${sql.join(perms.map((p) => sql`${p}`), sql`, `)})
      ${query.status === 'open' ? sql`AND n.resolved_at IS NULL` : query.status === 'resolved' ? sql`AND n.resolved_at IS NOT NULL` : sql``}
      ${query.severity ? sql`AND n.severity = ${query.severity}` : sql``}
      ${query.category ? sql`AND n.category = ${query.category}` : sql``}
      ${query.unread ? sql`AND NOT EXISTS (SELECT 1 FROM notification_reads r WHERE r.notification_id = n.id AND r.user_id = ${ctx.userId})` : sql``}
      ORDER BY array_position(ARRAY['critical','warning','info'], n.severity), n.created_at DESC
      LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`);
    const counts = await rows<Record<string, string>>(db(), sql`
      SELECT n.severity, COUNT(*) AS n, COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM notification_reads r WHERE r.notification_id = n.id AND r.user_id = ${ctx.userId})) AS unread
      FROM notifications n WHERE n.tenant_id = ${ctx.tenantId} AND n.resolved_at IS NULL AND (n.user_id IS NULL OR n.user_id = ${ctx.userId}) AND n.permission IN (${sql.join(perms.map((p) => sql`${p}`), sql`, `)}) GROUP BY n.severity`);
    const res = paged(list.map(({ total_count: _t, ...x }) => x), num(list[0]?.total_count), query.page, query.pageSize);
    return Object.assign(res, { meta: { ...res.meta, counts: Object.fromEntries(counts.map((c) => [c.severity, { total: num(c.n), unread: num(c.unread) }])) } });
  });

  r.post('/:id/read', { summary: 'Mark an alert as read', permission: ['alert.view', 'dashboard.view', 'inventory.view'], params: idParam }, async ({ ctx, params }) => {
    const [n] = await db().select({ id: t.notifications.id }).from(t.notifications).where(and(eq(t.notifications.id, params.id), eq(t.notifications.tenantId, ctx.tenantId))).limit(1);
    if (!n) throw notFound('Alert');
    await db().insert(t.notificationReads).values({ notificationId: n.id, userId: ctx.userId }).onConflictDoNothing();
    return { ok: true };
  });

  r.post('/read-all', { summary: 'Mark all visible alerts as read', permission: ['alert.view', 'dashboard.view', 'inventory.view'] }, async ({ ctx }) => {
    const perms = [...ctx.permissions];
    await db().execute(sql`INSERT INTO notification_reads (notification_id, user_id) SELECT n.id, ${ctx.userId} FROM notifications n WHERE n.tenant_id = ${ctx.tenantId} AND n.resolved_at IS NULL AND n.permission IN (${sql.join(perms.map((p) => sql`${p}`), sql`, `)}) ON CONFLICT DO NOTHING`);
    return { ok: true };
  });

  r.post('/:id/resolve', { summary: 'Resolve an alert', permission: ['alert.view', 'task.manage'], params: idParam }, async ({ ctx, params }) => {
    const [n] = await db().update(t.notifications).set({ resolvedAt: new Date() }).where(and(eq(t.notifications.id, params.id), eq(t.notifications.tenantId, ctx.tenantId))).returning({ id: t.notifications.id });
    if (!n) throw notFound('Alert');
    return { ok: true };
  });

  r.post('/scan', { summary: 'Re-evaluate alert conditions now', permission: ['alert.view', 'dashboard.view'] }, async ({ ctx }) => db().transaction((tx) => scanAlerts(tx, ctx.tenantId)));
}

export function registerApprovalRoutes(r: Router) {
  r.get('/', { summary: 'Approval requests; "canDecide" tells the UI whether this user may act', permission: ['approval.decide', 'settings.manage', 'inventory.adjust', 'purchase.manage', 'expense.manage'], query: pageQuery.extend({ status: z.enum(['pending', 'approved', 'rejected', 'cancelled', 'all']).default('pending') }) }, async ({ ctx, query }) => {
    const list = await rows<Record<string, unknown>>(db(), sql`
      SELECT a.id, a.entity_type AS "entityType", a.entity_id AS "entityId", a.entity_number AS "entityNumber", a.approver_role_key AS "approverRoleKey", a.amount::float AS amount, a.summary,
        a.status, a.comment, a.created_at AS "createdAt", a.decided_at AS "decidedAt", a.requested_by AS "requestedById", ru.name AS "requestedBy", du.name AS "decidedBy", COUNT(*) OVER() AS total_count
      FROM approval_requests a LEFT JOIN users ru ON ru.id = a.requested_by LEFT JOIN users du ON du.id = a.decided_by
      WHERE a.tenant_id = ${ctx.tenantId} ${query.status === 'all' ? sql`` : sql`AND a.status = ${query.status}`}
      ORDER BY a.created_at DESC LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`);
    return paged(list.map(({ total_count: _t, ...x }) => ({ ...x, canDecide: x.status === 'pending' && canDecide(ctx, { approverRoleKey: String(x.approverRoleKey), requestedBy: (x.requestedById as string) ?? null }) })), num(list[0]?.total_count), query.page, query.pageSize);
  });

  r.post('/:id/decide', { summary: 'Approve or reject a request (posts the underlying transaction on approval)', permission: 'approval.decide', params: idParam, body: z.object({ decision: z.enum(['approved', 'rejected']), comment: z.string().trim().max(500).default('') }) }, async ({ ctx, params, body }) => {
    await db().transaction((tx) => decideApproval(tx, ctx, params.id, body.decision, body.comment));
    return { status: body.decision };
  });
}

export function registerAuditRoutes(r: Router) {
  r.get('/', {
    summary: 'Append-only audit trail (who, what, old/new value, IP, device, when)',
    permission: 'audit.view',
    query: pageQuery.extend({ entityType: z.string().optional(), entityId: z.string().optional(), userId: z.string().uuid().optional(), action: z.string().optional(), from: isoDate().optional(), to: isoDate().optional() }),
  }, async ({ ctx, query }) => {
    const like = query.q ? `%${query.q.toLowerCase()}%` : null;
    const list = await rows<Record<string, unknown>>(db(), sql`
      SELECT a.id, a.action, a.entity_type AS "entityType", a.entity_id AS "entityId", a.old_value AS "oldValue", a.new_value AS "newValue", a.ip, a.device, a.created_at AS "createdAt",
        a.user_email AS "userEmail", u.name AS "userName", COUNT(*) OVER() AS total_count
      FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.tenant_id = ${ctx.tenantId}
      ${query.entityType ? sql`AND a.entity_type = ${query.entityType}` : sql``}
      ${query.entityId ? sql`AND a.entity_id = ${query.entityId}` : sql``}
      ${query.userId ? sql`AND a.user_id = ${query.userId}` : sql``}
      ${query.action ? sql`AND a.action LIKE ${`${query.action}%`}` : sql``}
      ${query.from ? sql`AND a.created_at >= ${query.from}::date` : sql``}
      ${query.to ? sql`AND a.created_at < ${query.to}::date + 1` : sql``}
      ${like ? sql`AND (lower(a.action) LIKE ${like} OR lower(a.user_email) LIKE ${like} OR lower(a.new_value::text) LIKE ${like} OR a.entity_id LIKE ${like})` : sql``}
      ORDER BY a.created_at DESC LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`);
    return paged(list.map(({ total_count: _t, ...x }) => x), num(list[0]?.total_count), query.page, query.pageSize);
  });
}

/** Global search (Ctrl+K) across 13 entity types. Results respect the user's permissions. */
export function registerSearchRoutes(r: Router) {
  r.get('/', { summary: 'Global search: SKU, product, barcode, customer, supplier, order, PO, GRN, shipment, warehouse, location, batch, serial', query: z.object({ q: z.string().trim().min(1).max(100) }) }, async ({ ctx, query }) => {
    const like = `%${query.q.toLowerCase()}%`;
    const exact = query.q.trim();
    const can = (p: string) => ctx.permissions.has(p);
    const groups: Promise<Record<string, unknown>[]>[] = [];
    const add = (perm: string[], q: ReturnType<typeof sql>) => { if (perm.some(can)) groups.push(rows(db(), q)); };
    add(['product.view', 'inventory.view'], sql`SELECT 'product' AS type, p.id, p.sku AS title, p.name AS subtitle, '/products/' || p.id AS href FROM products p WHERE p.tenant_id = ${ctx.tenantId} AND (lower(p.sku) LIKE ${like} OR lower(p.name) LIKE ${like} OR p.barcode = ${exact} OR p.alt_barcode = ${exact} OR EXISTS (SELECT 1 FROM product_barcodes b WHERE b.product_id = p.id AND b.barcode = ${exact})) ORDER BY (lower(p.sku) = lower(${exact})) DESC, p.sku LIMIT 8`);
    add(['customer.view', 'sales.view'], sql`SELECT 'customer' AS type, id, name AS title, COALESCE(NULLIF(city, ''), phone) AS subtitle, '/customers/' || id AS href FROM customers WHERE tenant_id = ${ctx.tenantId} AND (lower(name) LIKE ${like} OR lower(code) LIKE ${like} OR phone LIKE ${like}) LIMIT 5`);
    add(['purchase.view', 'supplier.manage'], sql`SELECT 'supplier' AS type, id, name AS title, COALESCE(NULLIF(city, ''), phone) AS subtitle, '/suppliers/' || id AS href FROM suppliers WHERE tenant_id = ${ctx.tenantId} AND (lower(name) LIKE ${like} OR lower(code) LIKE ${like} OR phone LIKE ${like}) LIMIT 5`);
    add(['sales.view', 'picking.execute', 'packing.execute', 'dispatch.execute'], sql`SELECT 'sales_order' AS type, so.id, so.number AS title, c.name || ' · ' || so.status AS subtitle, '/orders/' || so.id AS href FROM sales_orders so JOIN customers c ON c.id = so.customer_id WHERE so.tenant_id = ${ctx.tenantId} AND lower(so.number) LIKE ${like} ORDER BY so.created_at DESC LIMIT 5`);
    add(['purchase.view', 'receiving.execute'], sql`SELECT 'purchase_order' AS type, po.id, po.number AS title, s.name || ' · ' || po.status AS subtitle, '/purchasing/' || po.id AS href FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.tenant_id = ${ctx.tenantId} AND lower(po.number) LIKE ${like} ORDER BY po.created_at DESC LIMIT 5`);
    add(['receiving.execute', 'purchase.view'], sql`SELECT 'grn' AS type, id, number AS title, to_char(received_at, 'DD Mon YYYY') AS subtitle, '/receiving/' || id AS href FROM goods_receipts WHERE tenant_id = ${ctx.tenantId} AND lower(number) LIKE ${like} LIMIT 5`);
    add(['dispatch.execute', 'sales.view'], sql`SELECT 'shipment' AS type, id, number AS title, COALESCE(NULLIF(tracking_number, ''), status) AS subtitle, '/dispatch?shipment=' || id AS href FROM shipments WHERE tenant_id = ${ctx.tenantId} AND (lower(number) LIKE ${like} OR lower(tracking_number) LIKE ${like}) LIMIT 5`);
    add(['warehouse.view'], sql`SELECT 'warehouse' AS type, id, code || ' · ' || name AS title, city AS subtitle, '/warehouses/' || id AS href FROM warehouses WHERE tenant_id = ${ctx.tenantId} AND (lower(code) LIKE ${like} OR lower(name) LIKE ${like}) LIMIT 5`);
    add(['warehouse.view', 'inventory.view'], sql`SELECT 'location' AS type, l.id, l.code AS title, w.code || ' · ' || l.type AS subtitle, '/inventory?locationId=' || l.id AS href FROM locations l JOIN warehouses w ON w.id = l.warehouse_id WHERE l.tenant_id = ${ctx.tenantId} AND (lower(l.code) LIKE ${like} OR upper(l.barcode) = upper(${exact})) LIMIT 5`);
    add(['inventory.view'], sql`SELECT 'batch' AS type, bt.id, bt.batch_no AS title, p.sku || COALESCE(' · exp ' || bt.expiry_date::text, '') AS subtitle, '/products/' || p.id AS href FROM batches bt JOIN products p ON p.id = bt.product_id WHERE bt.tenant_id = ${ctx.tenantId} AND lower(bt.batch_no) LIKE ${like} LIMIT 5`);
    add(['inventory.view'], sql`SELECT 'serial' AS type, s.id, s.serial AS title, p.sku || ' · ' || s.status AS subtitle, '/inventory?tab=serials&q=' || s.serial AS href FROM serial_numbers s JOIN products p ON p.id = s.product_id WHERE s.tenant_id = ${ctx.tenantId} AND lower(s.serial) LIKE ${like} LIMIT 5`);
    add(['billing.view'], sql`SELECT 'invoice' AS type, i.id, i.number AS title, c.name || ' · ' || i.status AS subtitle, '/billing/invoices/' || i.id AS href FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.tenant_id = ${ctx.tenantId} AND lower(i.number) LIKE ${like} LIMIT 5`);
    add(['transfer.request', 'transfer.execute', 'transfer.approve'], sql`SELECT 'transfer' AS type, id, number AS title, status AS subtitle, '/transfers/' || id AS href FROM stock_transfers WHERE tenant_id = ${ctx.tenantId} AND lower(number) LIKE ${like} LIMIT 5`);
    return (await Promise.all(groups)).flat();
  });
}

