import { z } from 'zod';
import { and, asc, eq, sql } from 'drizzle-orm';
import { BARCODE_SYMBOLOGIES, TEMPERATURE_CLASSES } from '@shared/domain';
import { db, num, one, rows, t, type DbOrTx } from '../../db';
import { idParam, isoDate, pageQuery, paged, type Router } from '../../core/http';
import { badRequest, conflict, notFound } from '../../core/errors';
import { audit, diff } from '../../core/audit';
import type { Ctx } from '../../core/context';
import { nextInternalBarcode } from '../../core/numbering';
import { redactFinance } from '../../core/finance-visibility';
import { assertWithinLimit } from '../platform/limits';

const productBody = z.object({
  sku: z.string().trim().toUpperCase().regex(/^[A-Z0-9._/-]{2,40}$/, 'SKU: 2–40 letters, digits, dot, dash, slash or underscore.'),
  name: z.string().trim().min(2).max(200),
  categoryId: z.string().uuid().nullish(),
  brand: z.string().trim().max(80).default(''),
  description: z.string().trim().max(2000).default(''),
  barcode: z.string().trim().max(64).nullish(),
  altBarcode: z.string().trim().max(64).nullish(),
  skuType: z.enum(['simple', 'variant', 'batch', 'serial', 'expirable', 'kit']).default('simple'),
  parentId: z.string().uuid().nullish(),
  variantAttributes: z.record(z.string(), z.string()).default({}),
  uom: z.string().trim().min(1).max(20).default('pcs'),
  purchaseUom: z.string().trim().min(1).max(20).default('pcs'),
  salesUom: z.string().trim().min(1).max(20).default('pcs'),
  conversionFactor: z.coerce.number().positive().default(1),
  weightKg: z.coerce.number().min(0).default(0),
  lengthCm: z.coerce.number().min(0).default(0),
  widthCm: z.coerce.number().min(0).default(0),
  heightCm: z.coerce.number().min(0).default(0),
  volumeM3: z.coerce.number().min(0).optional(),
  unitsPerPallet: z.coerce.number().min(0).default(0),
  costPrice: z.coerce.number().min(0).default(0),
  sellingPrice: z.coerce.number().min(0).default(0),
  minStock: z.coerce.number().min(0).default(0),
  reorderLevel: z.coerce.number().min(0).default(0),
  reorderQty: z.coerce.number().min(0).default(0),
  maxStock: z.coerce.number().min(0).default(0),
  defaultSupplierId: z.string().uuid().nullish(),
  taxRateId: z.string().uuid().nullish(),
  trackBatch: z.boolean().default(false),
  trackLot: z.boolean().default(false),
  trackSerial: z.boolean().default(false),
  trackExpiry: z.boolean().default(false),
  temperatureClass: z.enum(TEMPERATURE_CLASSES).default('ambient'),
  imageUrl: z.string().max(500).nullish(),
  status: z.enum(['active', 'inactive', 'discontinued']).default('active'),
});
export type ProductInput = z.infer<typeof productBody>;

const SORTS: Record<string, string> = {
  sku: 's.sku', name: 's.name', available: 's.available', value: 's.value', updated: 's.updated_at', created: 's.created_at', category: 's.category_name', reorder: 's.reorder_level',
};

function computeVolume(b: Partial<ProductInput>): number | undefined {
  if (b.volumeM3 !== undefined && b.volumeM3 > 0) return b.volumeM3;
  if (b.lengthCm && b.widthCm && b.heightCm) return Math.round(((b.lengthCm * b.widthCm * b.heightCm) / 1_000_000) * 1e6) / 1e6;
  return b.volumeM3;
}

async function assertRefs(dbx: DbOrTx, tenantId: string, b: Partial<ProductInput>) {
  const check = async (table: 'product_categories' | 'suppliers' | 'tax_rates' | 'products', id: string | null | undefined, label: string) => {
    if (!id) return;
    const row = await one(dbx, sql`SELECT 1 FROM ${sql.identifier(table)} WHERE id = ${id} AND tenant_id = ${tenantId}`);
    if (!row) throw notFound(label);
  };
  await check('product_categories', b.categoryId, 'Category');
  await check('suppliers', b.defaultSupplierId, 'Supplier');
  await check('tax_rates', b.taxRateId, 'Tax rate');
  await check('products', b.parentId, 'Parent product');
}

export async function createProduct(tx: DbOrTx, ctx: Ctx, body: ProductInput) {
  await assertWithinLimit(tx, ctx.tenantId, 'skus');
  await assertRefs(tx, ctx.tenantId, body);
  if (body.barcode) await assertBarcodeFree(tx, ctx.tenantId, body.barcode);
  const [p] = await tx.insert(t.products).values({
    ...body, tenantId: ctx.tenantId, volumeM3: computeVolume(body) ?? 0,
    categoryId: body.categoryId ?? null, parentId: body.parentId ?? null, defaultSupplierId: body.defaultSupplierId ?? null, taxRateId: body.taxRateId ?? null,
    barcode: body.barcode || null, altBarcode: body.altBarcode || null,
    trackBatch: body.trackBatch || body.trackExpiry || body.skuType === 'batch' || body.skuType === 'expirable',
    trackExpiry: body.trackExpiry || body.skuType === 'expirable',
    trackSerial: body.trackSerial || body.skuType === 'serial',
  }).returning();
  const codes = [body.barcode, body.altBarcode].filter((x): x is string => !!x);
  if (codes.length) {
    await tx.insert(t.productBarcodes).values(codes.map((code, i) => ({ tenantId: ctx.tenantId, productId: p!.id, barcode: code, symbology: guessSymbology(code), isPrimary: i === 0 })));
  }
  await audit(tx, ctx, { action: 'product.created', entityType: 'product', entityId: p!.id, newValue: { sku: body.sku, name: body.name } });
  return p!;
}

async function assertBarcodeFree(dbx: DbOrTx, tenantId: string, code: string, exceptProductId?: string) {
  const row = await one<{ sku: string }>(dbx, sql`SELECT p.sku FROM product_barcodes b JOIN products p ON p.id = b.product_id WHERE b.tenant_id = ${tenantId} AND b.barcode = ${code} ${exceptProductId ? sql`AND b.product_id <> ${exceptProductId}` : sql``} LIMIT 1`);
  if (row) throw conflict('DUPLICATE', `Barcode ${code} is already assigned to ${row.sku}.`);
}

export function guessSymbology(code: string): string {
  if (/^\d{13}$/.test(code)) return 'ean13';
  if (/^\d{8}$/.test(code)) return 'ean8';
  if (/^\d{12}$/.test(code)) return 'upca';
  return 'code128';
}

/** Resolves a scanned code to a product (SKU, primary/alternate/pack barcode). */
export async function lookupProduct(dbx: DbOrTx, tenantId: string, code: string) {
  const c = code.trim();
  return one<{ id: string; sku: string; name: string; uom: string; unitQty: number; trackBatch: boolean; trackExpiry: boolean; trackSerial: boolean; barcode: string | null; sellingPrice: number; weightKg: number }>(dbx, sql`
    SELECT p.id, p.sku, p.name, p.uom, COALESCE(pb.unit_qty, 1)::float AS "unitQty", p.track_batch AS "trackBatch", p.track_expiry AS "trackExpiry",
      p.track_serial AS "trackSerial", p.barcode, p.selling_price::float AS "sellingPrice", p.weight_kg::float AS "weightKg"
    FROM products p
    LEFT JOIN product_barcodes pb ON pb.product_id = p.id AND pb.barcode = ${c}
    WHERE p.tenant_id = ${tenantId} AND (upper(p.sku) = upper(${c}) OR pb.barcode = ${c} OR p.barcode = ${c} OR p.alt_barcode = ${c})
    ORDER BY (pb.barcode = ${c}) DESC NULLS LAST LIMIT 1`);
}

export function registerProductRoutes(r: Router) {
  r.get('/', {
    summary: 'List products with stock totals (search, filter, sort, paginate)',
    permission: ['product.view', 'inventory.view'],
    query: pageQuery.extend({
      categoryId: z.string().uuid().optional(),
      status: z.string().optional(),
      stock: z.enum(['low', 'out', 'overstock', 'in_stock']).optional(),
      warehouseId: z.string().uuid().optional(),
      supplierId: z.string().uuid().optional(),
    }),
  }, async ({ ctx, query }) => {
    const like = query.q ? `%${query.q.toLowerCase()}%` : null;
    const where = sql`p.tenant_id = ${ctx.tenantId}
      ${like ? sql`AND (lower(p.sku) LIKE ${like} OR lower(p.name) LIKE ${like} OR p.barcode LIKE ${like} OR lower(p.brand) LIKE ${like} OR EXISTS (SELECT 1 FROM product_barcodes pb WHERE pb.product_id = p.id AND pb.barcode LIKE ${like}))` : sql``}
      ${query.categoryId ? sql`AND p.category_id = ${query.categoryId}` : sql``}
      ${query.status ? sql`AND p.status = ${query.status}` : sql``}
      ${query.supplierId ? sql`AND p.default_supplier_id = ${query.supplierId}` : sql``}`;
    const having = query.stock === 'low' ? sql`WHERE s.available <= s.reorder_level AND s.reorder_level > 0`
      : query.stock === 'out' ? sql`WHERE s.available <= 0`
      : query.stock === 'overstock' ? sql`WHERE s.max_stock > 0 AND s.on_hand > s.max_stock`
      : query.stock === 'in_stock' ? sql`WHERE s.available > 0` : sql``;
    const sortCol = SORTS[query.sort ?? ''] ?? 's.updated_at';
    const base = sql`
      SELECT p.id, p.sku, p.name, p.brand, p.barcode, p.uom, p.status, p.sku_type, p.image_url, p.reorder_level, p.max_stock, p.min_stock, p.reorder_qty,
        p.cost_price, p.selling_price, p.track_batch, p.track_serial, p.track_expiry, p.updated_at, p.created_at, c.name AS category_name, p.category_id,
        COALESCE(st.available, 0) AS available, COALESCE(st.reserved, 0) AS reserved, COALESCE(st.on_hand, 0) AS on_hand, COALESCE(st.other, 0) AS other,
        COALESCE(st.on_hand, 0) * p.cost_price AS value
      FROM products p
      LEFT JOIN product_categories c ON c.id = p.category_id
      LEFT JOIN (
        SELECT product_id,
          SUM(quantity) FILTER (WHERE status = 'available') AS available,
          SUM(quantity) FILTER (WHERE status = 'reserved') AS reserved,
          SUM(quantity) FILTER (WHERE status NOT IN ('available', 'reserved')) AS other,
          SUM(quantity) AS on_hand
        FROM inventory_balances WHERE tenant_id = ${ctx.tenantId} AND owner_customer_id IS NULL
        ${query.warehouseId ? sql`AND warehouse_id = ${query.warehouseId}` : sql``}
        GROUP BY product_id
      ) st ON st.product_id = p.id
      WHERE ${where}`;
    const list = await rows<Record<string, unknown>>(db(), sql`
      SELECT * , COUNT(*) OVER() AS total_count FROM (${base}) s ${having}
      ORDER BY ${sql.raw(sortCol)} ${sql.raw(query.dir === 'asc' ? 'ASC' : 'DESC')} NULLS LAST, s.sku ASC
      LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`);
    const total = num(list[0]?.total_count);
    const data = list.map((p) => ({
      id: p.id, sku: p.sku, name: p.name, brand: p.brand, barcode: p.barcode, uom: p.uom, status: p.status, skuType: p.sku_type, imageUrl: p.image_url,
      categoryId: p.category_id, categoryName: p.category_name, reorderLevel: num(p.reorder_level), maxStock: num(p.max_stock), minStock: num(p.min_stock), reorderQty: num(p.reorder_qty),
      costPrice: num(p.cost_price), sellingPrice: num(p.selling_price), trackBatch: p.track_batch, trackSerial: p.track_serial, trackExpiry: p.track_expiry,
      available: num(p.available), reserved: num(p.reserved), onHand: num(p.on_hand), other: num(p.other), value: num(p.value), updatedAt: p.updated_at,
      stockState: num(p.available) <= 0 ? 'out' : num(p.reorder_level) > 0 && num(p.available) <= num(p.reorder_level) ? 'low' : num(p.max_stock) > 0 && num(p.on_hand) > num(p.max_stock) ? 'overstock' : 'ok',
    }));
    return paged(redactFinance(ctx, data), total, query.page, query.pageSize);
  });

  r.get('/lookup', {
    summary: 'Resolve a scanned barcode or SKU',
    permission: ['product.view', 'inventory.view', 'receiving.execute', 'picking.execute'],
    query: z.object({ code: z.string().trim().min(1).max(120) }),
  }, async ({ ctx, query }) => {
    const p = await lookupProduct(db(), ctx.tenantId, query.code);
    if (!p) throw notFound(`Product for code "${query.code}"`);
    return p;
  });

  r.get('/:id', { summary: 'Product 360: details, barcodes, stock by location, batches, movements', permission: ['product.view', 'inventory.view'], params: idParam }, async ({ ctx, params }) => {
    const [p] = await db().select().from(t.products).where(and(eq(t.products.id, params.id), eq(t.products.tenantId, ctx.tenantId))).limit(1);
    if (!p) throw notFound('Product');
    const [barcodes, stock, batchList, movements, velocity, variants] = await Promise.all([
      db().select().from(t.productBarcodes).where(eq(t.productBarcodes.productId, p.id)).orderBy(asc(t.productBarcodes.createdAt)),
      rows(db(), sql`SELECT b.id, b.status, b.quantity::float AS quantity, w.id AS "warehouseId", w.name AS "warehouseName", w.code AS "warehouseCode", l.id AS "locationId", l.code AS "locationCode", bt.batch_no AS "batchNo", bt.expiry_date AS "expiryDate", b.batch_id AS "batchId", c.name AS "ownerName", b.owner_customer_id AS "ownerCustomerId"
        FROM inventory_balances b JOIN warehouses w ON w.id = b.warehouse_id JOIN locations l ON l.id = b.location_id LEFT JOIN batches bt ON bt.id = b.batch_id LEFT JOIN customers c ON c.id = b.owner_customer_id
        WHERE b.tenant_id = ${ctx.tenantId} AND b.product_id = ${p.id} AND b.quantity > 0 ORDER BY w.code, l.code`),
      rows(db(), sql`SELECT bt.*, COALESCE((SELECT SUM(quantity) FROM inventory_balances b WHERE b.batch_id = bt.id), 0)::float AS on_hand FROM batches bt WHERE bt.tenant_id = ${ctx.tenantId} AND bt.product_id = ${p.id} ORDER BY bt.expiry_date NULLS LAST`),
      rows(db(), sql`SELECT m.id, m.transaction_type AS type, m.quantity::float AS quantity, m.status, m.balance_after::float AS "balanceAfter", m.reference_no AS "referenceNo", m.reason, m.created_at AS "createdAt", l.code AS "locationCode", w.code AS "warehouseCode", u.name AS "performedBy"
        FROM inventory_transactions m JOIN locations l ON l.id = m.location_id JOIN warehouses w ON w.id = m.warehouse_id LEFT JOIN users u ON u.id = m.performed_by
        WHERE m.tenant_id = ${ctx.tenantId} AND m.product_id = ${p.id} ORDER BY m.created_at DESC LIMIT 50`),
      one<{ out30: string; out90: string; last_out: string | null }>(db(), sql`SELECT COALESCE(-SUM(quantity) FILTER (WHERE created_at >= now() - interval '30 days'), 0) AS out30, COALESCE(-SUM(quantity) FILTER (WHERE created_at >= now() - interval '90 days'), 0) AS out90, MAX(created_at) AS last_out FROM inventory_transactions WHERE tenant_id = ${ctx.tenantId} AND product_id = ${p.id} AND transaction_type = 'dispatch'`),
      db().select({ id: t.products.id, sku: t.products.sku, name: t.products.name, variantAttributes: t.products.variantAttributes }).from(t.products).where(and(eq(t.products.parentId, p.id), eq(t.products.tenantId, ctx.tenantId))),
    ]);
    return redactFinance(ctx, {
      ...p, barcodes, stock, batches: batchList, movements, variants,
      velocity: { dispatched30d: num(velocity?.out30), dispatched90d: num(velocity?.out90), lastDispatchAt: velocity?.last_out ?? null, avgDailyDemand: Math.round((num(velocity?.out90) / 90) * 100) / 100 },
    });
  });

  r.post('/', { summary: 'Create a product', permission: 'product.manage', body: productBody }, async ({ ctx, body }) =>
    db().transaction((tx) => createProduct(tx, ctx, body)));

  r.patch('/:id', { summary: 'Update a product (price changes are audited)', permission: 'product.manage', params: idParam, body: productBody.partial() }, async ({ ctx, params, body }) => {
    return db().transaction(async (tx) => {
      const [before] = await tx.select().from(t.products).where(and(eq(t.products.id, params.id), eq(t.products.tenantId, ctx.tenantId))).limit(1);
      if (!before) throw notFound('Product');
      await assertRefs(tx, ctx.tenantId, body);
      if (body.barcode && body.barcode !== before.barcode) {
        await assertBarcodeFree(tx, ctx.tenantId, body.barcode, before.id);
        await tx.insert(t.productBarcodes).values({ tenantId: ctx.tenantId, productId: before.id, barcode: body.barcode, symbology: guessSymbology(body.barcode), isPrimary: true }).onConflictDoNothing();
      }
      const volume = computeVolume({ ...before, ...body } as Partial<ProductInput>);
      const [after] = await tx.update(t.products).set({ ...body, volumeM3: volume, updatedAt: new Date() }).where(eq(t.products.id, before.id)).returning();
      const changes = diff(before as Record<string, unknown>, body);
      const priceChanged = 'costPrice' in changes.newValue || 'sellingPrice' in changes.newValue;
      await audit(tx, ctx, { action: priceChanged ? 'product.price_changed' : 'product.updated', entityType: 'product', entityId: before.id, ...changes });
      return after;
    });
  });

  r.post('/:id/variants', {
    summary: 'Create a variant (size, colour…) that inherits the parent product',
    permission: 'product.manage',
    params: idParam,
    body: z.object({ skuSuffix: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{1,12}$/), attributes: z.record(z.string(), z.string()).refine((a) => Object.keys(a).length > 0, 'Add at least one attribute.'), sellingPrice: z.number().min(0).optional(), barcode: z.string().max(64).optional() }),
  }, async ({ ctx, params, body }) => {
    const [parent] = await db().select().from(t.products).where(and(eq(t.products.id, params.id), eq(t.products.tenantId, ctx.tenantId))).limit(1);
    if (!parent) throw notFound('Product');
    const { id: _id, createdAt: _c, updatedAt: _u, tenantId: _t, ...rest } = parent;
    return db().transaction((tx) => createProduct(tx, ctx, productBody.parse({
      ...rest, sku: `${parent.sku}-${body.skuSuffix}`, name: `${parent.name} (${Object.values(body.attributes).join(', ')})`, skuType: 'variant', parentId: parent.id,
      variantAttributes: body.attributes, sellingPrice: body.sellingPrice ?? parent.sellingPrice, barcode: body.barcode ?? null, altBarcode: null,
    })));
  });

  r.post('/:id/barcodes', {
    summary: 'Add a barcode (pack/carton barcodes can represent several units)',
    permission: 'product.manage',
    params: idParam,
    body: z.object({ barcode: z.string().trim().min(3).max(64).optional(), symbology: z.enum(BARCODE_SYMBOLOGIES).optional(), unitQty: z.number().positive().default(1), generate: z.boolean().default(false) }),
  }, async ({ ctx, params, body }) => {
    return db().transaction(async (tx) => {
      const [p] = await tx.select({ id: t.products.id, barcode: t.products.barcode }).from(t.products).where(and(eq(t.products.id, params.id), eq(t.products.tenantId, ctx.tenantId))).limit(1);
      if (!p) throw notFound('Product');
      const code = body.generate || !body.barcode ? await nextInternalBarcode(tx, ctx.tenantId) : body.barcode;
      await assertBarcodeFree(tx, ctx.tenantId, code);
      const [row] = await tx.insert(t.productBarcodes).values({ tenantId: ctx.tenantId, productId: p.id, barcode: code, symbology: body.generate || !body.barcode ? 'ean13' : body.symbology ?? guessSymbology(code), unitQty: body.unitQty, isPrimary: !p.barcode }).returning();
      if (!p.barcode) await tx.update(t.products).set({ barcode: code }).where(eq(t.products.id, p.id));
      await audit(tx, ctx, { action: 'product.barcode_added', entityType: 'product', entityId: p.id, newValue: { barcode: code, unitQty: body.unitQty } });
      return row;
    });
  });

  r.delete('/barcodes/:id', { summary: 'Remove a barcode', permission: 'product.manage', params: idParam }, async ({ ctx, params }) => {
    const [row] = await db().delete(t.productBarcodes).where(and(eq(t.productBarcodes.id, params.id), eq(t.productBarcodes.tenantId, ctx.tenantId))).returning();
    if (!row) throw notFound('Barcode');
    await db().update(t.products).set({ barcode: null }).where(and(eq(t.products.id, row.productId), eq(t.products.barcode, row.barcode)));
    await audit(db(), ctx, { action: 'product.barcode_removed', entityType: 'product', entityId: row.productId, oldValue: { barcode: row.barcode } });
    return { ok: true };
  });
}

export function registerCategoryRoutes(r: Router) {
  r.get('/', { summary: 'Product categories', permission: ['product.view', 'inventory.view'] }, async ({ ctx }) =>
    rows(db(), sql`SELECT c.*, (SELECT COUNT(*)::int FROM products p WHERE p.category_id = c.id) AS product_count, z.code AS preferred_zone_code
      FROM product_categories c LEFT JOIN locations z ON z.id = c.preferred_zone_id WHERE c.tenant_id = ${ctx.tenantId} ORDER BY c.name`));
  const body = z.object({ name: z.string().trim().min(2).max(80), parentId: z.string().uuid().nullish(), preferredZoneId: z.string().uuid().nullish(), temperatureClass: z.enum(TEMPERATURE_CLASSES).default('ambient') });
  r.post('/', { summary: 'Create a category', permission: 'product.manage', body }, async ({ ctx, body: b }) => {
    const [row] = await db().insert(t.productCategories).values({ ...b, parentId: b.parentId ?? null, preferredZoneId: b.preferredZoneId ?? null, tenantId: ctx.tenantId }).returning();
    await audit(db(), ctx, { action: 'category.created', entityType: 'category', entityId: row!.id, newValue: b });
    return row;
  });
  r.patch('/:id', { summary: 'Update a category (e.g. preferred putaway zone)', permission: 'product.manage', params: idParam, body: body.partial() }, async ({ ctx, params, body: b }) => {
    const [row] = await db().update(t.productCategories).set(b).where(and(eq(t.productCategories.id, params.id), eq(t.productCategories.tenantId, ctx.tenantId))).returning();
    if (!row) throw notFound('Category');
    await audit(db(), ctx, { action: 'category.updated', entityType: 'category', entityId: params.id, newValue: b });
    return row;
  });
}

export function registerBatchRoutes(r: Router) {
  r.get('/', {
    summary: 'Batches / lots with on-hand quantity and expiry',
    permission: 'inventory.view',
    query: pageQuery.extend({ productId: z.string().uuid().optional(), expiringWithinDays: z.coerce.number().int().min(0).max(3650).optional(), expired: z.coerce.boolean().optional() }),
  }, async ({ ctx, query }) => {
    const like = query.q ? `%${query.q.toLowerCase()}%` : null;
    const list = await rows<Record<string, unknown>>(db(), sql`
      SELECT bt.id, bt.batch_no AS "batchNo", bt.lot_no AS "lotNo", bt.mfg_date AS "mfgDate", bt.expiry_date AS "expiryDate", bt.status, bt.created_at AS "createdAt",
        p.id AS "productId", p.sku, p.name AS "productName", s.name AS "supplierName",
        COALESCE(SUM(b.quantity), 0)::float AS "onHand", COALESCE(SUM(b.quantity * p.cost_price), 0)::float AS value,
        (bt.expiry_date - CURRENT_DATE) AS "daysToExpiry", COUNT(*) OVER() AS total_count
      FROM batches bt JOIN products p ON p.id = bt.product_id LEFT JOIN suppliers s ON s.id = bt.supplier_id
      LEFT JOIN inventory_balances b ON b.batch_id = bt.id AND b.quantity > 0
      WHERE bt.tenant_id = ${ctx.tenantId}
      ${query.productId ? sql`AND bt.product_id = ${query.productId}` : sql``}
      ${like ? sql`AND (lower(bt.batch_no) LIKE ${like} OR lower(p.sku) LIKE ${like} OR lower(p.name) LIKE ${like})` : sql``}
      ${query.expiringWithinDays !== undefined ? sql`AND bt.expiry_date IS NOT NULL AND bt.expiry_date <= CURRENT_DATE + ${query.expiringWithinDays}::int AND bt.expiry_date >= CURRENT_DATE` : sql``}
      ${query.expired ? sql`AND bt.expiry_date < CURRENT_DATE` : sql``}
      GROUP BY bt.id, p.id, s.name
      ORDER BY bt.expiry_date ASC NULLS LAST, bt.batch_no
      LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`);
    return paged(redactFinance(ctx, list.map(({ total_count: _t, ...x }) => ({ ...x, daysToExpiry: x.daysToExpiry === null ? null : num(x.daysToExpiry) }))), num(list[0]?.total_count), query.page, query.pageSize);
  });

  r.post('/', {
    summary: 'Register a batch / lot',
    permission: ['inventory.adjust', 'receiving.execute', 'product.manage'],
    body: z.object({ productId: z.string().uuid(), batchNo: z.string().trim().min(1).max(60), lotNo: z.string().trim().max(60).default(''), mfgDate: isoDate().nullish(), expiryDate: isoDate().nullish(), supplierId: z.string().uuid().nullish() }),
  }, async ({ ctx, body }) => {
    const [p] = await db().select({ id: t.products.id }).from(t.products).where(and(eq(t.products.id, body.productId), eq(t.products.tenantId, ctx.tenantId))).limit(1);
    if (!p) throw notFound('Product');
    return ensureBatch(db(), ctx, { productId: p.id, batchNo: body.batchNo, lotNo: body.lotNo, mfgDate: body.mfgDate ?? null, expiryDate: body.expiryDate ?? null, supplierId: body.supplierId ?? null });
  });
}

/** Finds or creates a batch; expiry/mfg dates are filled if previously unknown. */
export async function ensureBatch(dbx: DbOrTx, ctx: Ctx, b: { productId: string; batchNo: string; lotNo?: string; mfgDate?: string | null; expiryDate?: string | null; supplierId?: string | null }) {
  if (b.expiryDate && b.mfgDate && b.expiryDate < b.mfgDate) throw badRequest('Expiry date cannot be before manufacture date.');
  const [row] = await dbx.insert(t.batches).values({ tenantId: ctx.tenantId, productId: b.productId, batchNo: b.batchNo.trim().toUpperCase(), lotNo: b.lotNo ?? '', mfgDate: b.mfgDate ?? null, expiryDate: b.expiryDate ?? null, supplierId: b.supplierId ?? null })
    .onConflictDoUpdate({
      target: [t.batches.tenantId, t.batches.productId, t.batches.batchNo],
      set: { expiryDate: sql`COALESCE(${t.batches.expiryDate}, EXCLUDED.expiry_date)`, mfgDate: sql`COALESCE(${t.batches.mfgDate}, EXCLUDED.mfg_date)` },
    }).returning();
  return row!;
}

export function registerSerialRoutes(r: Router) {
  r.get('/', {
    summary: 'Serial numbers and their current status / location',
    permission: 'inventory.view',
    query: pageQuery.extend({ productId: z.string().uuid().optional(), status: z.string().optional() }),
  }, async ({ ctx, query }) => {
    const like = query.q ? `%${query.q.toLowerCase()}%` : null;
    const list = await rows<Record<string, unknown>>(db(), sql`
      SELECT s.id, s.serial, s.status, s.updated_at AS "updatedAt", s.reference_type AS "referenceType", p.id AS "productId", p.sku, p.name AS "productName",
        w.code AS "warehouseCode", l.code AS "locationCode", bt.batch_no AS "batchNo", c.name AS "ownerName", COUNT(*) OVER() AS total_count
      FROM serial_numbers s JOIN products p ON p.id = s.product_id LEFT JOIN warehouses w ON w.id = s.warehouse_id LEFT JOIN locations l ON l.id = s.location_id
      LEFT JOIN batches bt ON bt.id = s.batch_id LEFT JOIN customers c ON c.id = s.owner_customer_id
      WHERE s.tenant_id = ${ctx.tenantId}
      ${query.productId ? sql`AND s.product_id = ${query.productId}` : sql``}
      ${query.status ? sql`AND s.status = ${query.status}` : sql``}
      ${like ? sql`AND (lower(s.serial) LIKE ${like} OR lower(p.sku) LIKE ${like})` : sql``}
      ORDER BY s.updated_at DESC LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`);
    return paged(list.map(({ total_count: _t, ...x }) => x), num(list[0]?.total_count), query.page, query.pageSize);
  });

  r.get('/:serial/history', { summary: 'Full movement history of one serial number', permission: 'inventory.view', params: z.object({ serial: z.string().min(1).max(120) }) }, async ({ ctx, params }) => {
    const serials = await rows<Record<string, unknown>>(db(), sql`SELECT s.*, p.sku, p.name AS product_name FROM serial_numbers s JOIN products p ON p.id = s.product_id WHERE s.tenant_id = ${ctx.tenantId} AND s.serial = ${params.serial}`);
    if (!serials.length) throw notFound('Serial number');
    const history = await rows(db(), sql`SELECT m.transaction_type AS type, m.quantity::float AS quantity, m.reference_no AS "referenceNo", m.created_at AS "createdAt", l.code AS "locationCode", w.code AS "warehouseCode"
      FROM inventory_transactions m JOIN locations l ON l.id = m.location_id JOIN warehouses w ON w.id = m.warehouse_id
      WHERE m.tenant_id = ${ctx.tenantId} AND m.serial_id IN (${sql.join(serials.map((s) => sql`${s.id as string}`), sql`, `)}) ORDER BY m.created_at`);
    return { serials, history };
  });
}
