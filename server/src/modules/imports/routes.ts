import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { IMPORT_ENTITIES, type ImportEntity } from '@shared/domain';
import { db, rows as q, t, type Tx } from '../../db';
import { idParam, SENT, type Router } from '../../core/http';
import { badRequest, invalidState, notFound } from '../../core/errors';
import { audit } from '../../core/audit';
import type { Ctx } from '../../core/context';
import { nextNumber } from '../../core/numbering';
import { createProduct } from '../products/routes';
import { createCustomer, customerBody } from '../sales/routes';
import { createSupplier, supplierBody } from '../purchasing/routes';
import { createWarehouse } from '../warehouses/routes';
import { postMovement } from '../inventory/ledger';
import { ensureBatch } from '../products/routes';
import { createInvoice } from '../finance/invoicing';

const MAX_ROWS = 5000;

const bool = z.preprocess((v) => (typeof v === 'string' ? ['yes', 'y', 'true', '1'].includes(v.trim().toLowerCase()) : Boolean(v)), z.boolean());
const numOpt = (def = 0) => z.preprocess((v) => (v === '' || v === null || v === undefined ? def : Number(String(v).replace(/,/g, ''))), z.number().min(0));
const str = (max = 200) => z.preprocess((v) => (v === null || v === undefined ? '' : String(v).trim()), z.string().max(max));
const date = z.preprocess((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v === '' || v === null || v === undefined ? null : String(v).trim().slice(0, 10)), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').nullable());

const SCHEMAS: Record<ImportEntity, z.ZodType<Record<string, unknown>>> = {
  products: z.object({ sku: str(40).pipe(z.string().min(2, 'SKU is required')), name: str().pipe(z.string().min(2, 'Name is required')), category: str(80), brand: str(80), barcode: str(64), uom: str(20), cost_price: numOpt(), selling_price: numOpt(), reorder_level: numOpt(), reorder_qty: numOpt(), min_stock: numOpt(), max_stock: numOpt(), weight_kg: numOpt(), length_cm: numOpt(), width_cm: numOpt(), height_cm: numOpt(), units_per_pallet: numOpt(), track_batch: bool.default(false), track_expiry: bool.default(false), track_serial: bool.default(false), supplier_code: str(20) }),
  customers: z.object({ code: str(20), name: str(160).pipe(z.string().min(2, 'Name is required')), contact_name: str(120), phone: str(40), email: str(120).pipe(z.string().email('Invalid email').or(z.literal(''))), address: str(400), city: str(80), ntn: str(40), strn: str(40), credit_limit: numOpt(), payment_terms_days: numOpt(30), storage_client: bool.default(false) }),
  suppliers: z.object({ code: str(20), name: str(160).pipe(z.string().min(2, 'Name is required')), contact_name: str(120), phone: str(40), email: str(120).pipe(z.string().email('Invalid email').or(z.literal(''))), address: str(400), city: str(80), ntn: str(40), strn: str(40), payment_terms_days: numOpt(30), lead_time_days: numOpt(7) }),
  warehouses: z.object({ code: str(20).pipe(z.string().regex(/^[A-Za-z0-9-]{2,20}$/, 'Code: 2–20 letters/digits/dashes')), name: str(120).pipe(z.string().min(2)), city: str(80), address: str(300), type: str(30), capacity: numOpt(), capacity_unit: str(10) }),
  locations: z.object({ warehouse_code: str(20).pipe(z.string().min(1, 'Warehouse code required')), parent_code: str(80), type: z.enum(['zone', 'aisle', 'rack', 'shelf', 'bin', 'dock', 'staging']), segment: str(8).pipe(z.string().regex(/^[A-Za-z0-9]{1,8}$/, 'Segment: 1–8 letters/digits')), capacity_units: numOpt(), capacity_volume_m3: numOpt() }),
  opening_inventory: z.object({ warehouse_code: str(20).pipe(z.string().min(1)), location_code: str(80).pipe(z.string().min(1)), sku: str(40).pipe(z.string().min(1)), quantity: numOpt().pipe(z.number().positive('Quantity must be > 0')), unit_cost: numOpt(), batch_no: str(60), expiry_date: date.optional(), owner_customer_code: str(20) }),
  opening_balances: z.object({ party_type: z.enum(['customer', 'supplier']), code: str(20).pipe(z.string().min(1)), amount: numOpt().pipe(z.number().positive()), due_date: date, reference: str(60) }),
};

export const TEMPLATES: Record<ImportEntity, string[][]> = {
  products: [['sku', 'name', 'category', 'brand', 'barcode', 'uom', 'cost_price', 'selling_price', 'reorder_level', 'reorder_qty', 'min_stock', 'max_stock', 'weight_kg', 'length_cm', 'width_cm', 'height_cm', 'units_per_pallet', 'track_batch', 'track_expiry', 'track_serial', 'supplier_code'], ['TX-9001', 'Cotton Towel Set', 'Textiles', 'HomeLine', '8964000000017', 'pcs', '850', '1350', '20', '100', '10', '400', '0.6', '35', '25', '8', '120', 'no', 'no', 'no', 'S-1001']],
  customers: [['code', 'name', 'contact_name', 'phone', 'email', 'address', 'city', 'ntn', 'strn', 'credit_limit', 'payment_terms_days', 'storage_client'], ['', 'Rehman General Store', 'Abdul Rehman', '+92 300 1234567', 'orders@example.pk', 'Shop 12, Saddar', 'Karachi', '1234567-8', '', '500000', '30', 'no']],
  suppliers: [['code', 'name', 'contact_name', 'phone', 'email', 'address', 'city', 'ntn', 'strn', 'payment_terms_days', 'lead_time_days'], ['', 'Indus Packaging Pvt Ltd', 'Sana Malik', '+92 42 35700000', 'sales@example.pk', 'Sundar Industrial Estate', 'Lahore', '7654321-0', '', '45', '10']],
  warehouses: [['code', 'name', 'city', 'address', 'type', 'capacity', 'capacity_unit'], ['MUL-01', 'Multan Depot', 'Multan', 'Industrial Area', 'rented', '400', 'pallets']],
  locations: [['warehouse_code', 'parent_code', 'type', 'segment', 'capacity_units', 'capacity_volume_m3'], ['MUL-01', '', 'zone', 'A', '', ''], ['MUL-01', 'A', 'aisle', '01', '', ''], ['MUL-01', 'A-01', 'rack', 'R01', '', ''], ['MUL-01', 'A-01-R01', 'bin', 'B01', '100', '0.5']],
  opening_inventory: [['warehouse_code', 'location_code', 'sku', 'quantity', 'unit_cost', 'batch_no', 'expiry_date', 'owner_customer_code'], ['KHI-01', 'A-01-R01-S01-B01', 'TX-9001', '50', '850', '', '', '']],
  opening_balances: [['party_type', 'code', 'amount', 'due_date', 'reference'], ['customer', 'C-1001', '125000', '2026-11-15', 'Opening balance']],
};

const ALIASES: Record<string, string> = { 'cost': 'cost_price', 'price': 'selling_price', 'sale_price': 'selling_price', 'product_name': 'name', 'item': 'sku', 'qty': 'quantity', 'location': 'location_code', 'warehouse': 'warehouse_code', 'batch': 'batch_no', 'expiry': 'expiry_date', 'mobile': 'phone' };
const normKey = (k: string) => { const s = k.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''); return ALIASES[s] ?? s; };

export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && src[i + 1] === '\n') i++; row.push(cell); out.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); out.push(row); }
  return out.filter((r) => r.some((x) => x.trim() !== ''));
}

async function parseUpload(buffer: Buffer, fileName: string): Promise<Record<string, unknown>[]> {
  let matrix: unknown[][];
  if (/\.xlsx$/i.test(fileName)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as never);
    const ws = wb.worksheets[0];
    if (!ws) throw badRequest('The workbook has no sheets.');
    matrix = [];
    ws.eachRow({ includeEmpty: false }, (r) => { matrix.push((r.values as unknown[]).slice(1).map((v) => (v && typeof v === 'object' && 'text' in (v as object) ? (v as { text: string }).text : v && typeof v === 'object' && 'result' in (v as object) ? (v as { result: unknown }).result : v))); });
  } else {
    matrix = parseCsv(buffer.toString('utf8'));
  }
  if (matrix.length < 2) throw badRequest('The file needs a header row and at least one data row.');
  const headers = (matrix[0] as unknown[]).map((h) => normKey(String(h ?? '')));
  return matrix.slice(1).map((cells) => Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ''])));
}

/** Validates rows: schema, duplicates within the file and references to existing data. */
async function validateRows(ctx: Ctx, entity: ImportEntity, raw: Record<string, unknown>[]) {
  const schema = SCHEMAS[entity];
  const out: { row: number; data: Record<string, unknown>; errors: string[] }[] = [];
  const seen = new Set<string>();
  const existing = async (table: string, col: string, values: string[]) => {
    if (!values.length) return new Set<string>();
    const res = await q<{ v: string }>(db(), sql`SELECT upper(${sql.identifier(col)}) AS v FROM ${sql.identifier(table)} WHERE tenant_id = ${ctx.tenantId} AND upper(${sql.identifier(col)}) IN (${sql.join(values.map((v) => sql`${v.toUpperCase()}`), sql`, `)})`);
    return new Set(res.map((r) => r.v));
  };
  const parsed = raw.map((r, i) => ({ i, res: schema.safeParse(r) }));
  const vals = (k: string) => parsed.flatMap((p) => (p.res.success && p.res.data[k] ? [String(p.res.data[k])] : []));
  const existingSkus = await existing('products', 'sku', vals('sku'));
  const whCodes = await existing('warehouses', 'code', [...vals('warehouse_code'), ...(entity === 'warehouses' ? vals('code') : [])]);
  const supplierCodes = await existing('suppliers', 'code', entity === 'opening_balances' || entity === 'suppliers' ? vals('code') : vals('supplier_code'));
  const customerCodes = await existing('customers', 'code', entity === 'opening_balances' || entity === 'customers' ? vals('code') : vals('owner_customer_code'));
  const locationRows = entity === 'opening_inventory' || entity === 'locations'
    ? await q<{ wh: string; code: string }>(db(), sql`SELECT upper(w.code) AS wh, upper(l.code) AS code FROM locations l JOIN warehouses w ON w.id = l.warehouse_id WHERE l.tenant_id = ${ctx.tenantId}`)
    : [];
  const locSet = new Set(locationRows.map((l) => `${l.wh}|${l.code}`));

  for (const { i, res } of parsed) {
    const errors: string[] = [];
    if (!res.success) {
      errors.push(...res.error.issues.map((x) => `${x.path.join('.') || 'row'}: ${x.message}`));
      out.push({ row: i + 2, data: raw[i]!, errors });
      continue;
    }
    const d = res.data;
    const up = (k: string) => String(d[k] ?? '').toUpperCase();
    switch (entity) {
      case 'products':
        if (existingSkus.has(up('sku'))) errors.push(`SKU ${d.sku} already exists`);
        if (seen.has(up('sku'))) errors.push(`SKU ${d.sku} appears twice in the file`);
        seen.add(up('sku'));
        if (d.supplier_code && !supplierCodes.has(up('supplier_code'))) errors.push(`Supplier ${d.supplier_code} not found`);
        break;
      case 'customers': case 'suppliers':
        if (d.code && (entity === 'customers' ? customerCodes : supplierCodes).has(up('code'))) errors.push(`Code ${d.code} already exists`);
        if (d.code && seen.has(up('code'))) errors.push(`Code ${d.code} appears twice`);
        if (d.code) seen.add(up('code'));
        break;
      case 'warehouses':
        if (whCodes.has(up('code'))) errors.push(`Warehouse ${d.code} already exists`);
        break;
      case 'locations': {
        if (!whCodes.has(up('warehouse_code'))) errors.push(`Warehouse ${d.warehouse_code} not found`);
        const code = d.parent_code ? `${up('parent_code')}-${up('segment')}` : up('segment');
        if (locSet.has(`${up('warehouse_code')}|${code}`)) errors.push(`Location ${code} already exists`);
        if (d.parent_code && !locSet.has(`${up('warehouse_code')}|${up('parent_code')}`)) errors.push(`Parent ${d.parent_code} not found (list parents first)`);
        locSet.add(`${up('warehouse_code')}|${code}`);
        break;
      }
      case 'opening_inventory':
        if (!whCodes.has(up('warehouse_code'))) errors.push(`Warehouse ${d.warehouse_code} not found`);
        if (!locSet.has(`${up('warehouse_code')}|${up('location_code')}`)) errors.push(`Location ${d.location_code} not found in ${d.warehouse_code}`);
        if (!existingSkus.has(up('sku'))) errors.push(`SKU ${d.sku} not found`);
        if (d.owner_customer_code && !customerCodes.has(up('owner_customer_code'))) errors.push(`Customer ${d.owner_customer_code} not found`);
        break;
      case 'opening_balances':
        if (!(d.party_type === 'customer' ? customerCodes : supplierCodes).has(up('code'))) errors.push(`${d.party_type} ${d.code} not found`);
        break;
    }
    out.push({ row: i + 2, data: d, errors });
  }
  return out;
}

async function commitRow(tx: Tx, ctx: Ctx, entity: ImportEntity, d: Record<string, unknown>) {
  const s = (k: string) => String(d[k] ?? '');
  const n = (k: string) => Number(d[k] ?? 0);
  const idBy = async (table: string, col: string, value: string) => (await q<{ id: string }>(tx, sql`SELECT id FROM ${sql.identifier(table)} WHERE tenant_id = ${ctx.tenantId} AND upper(${sql.identifier(col)}) = upper(${value}) LIMIT 1`))[0]?.id ?? null;
  switch (entity) {
    case 'products': {
      let categoryId: string | null = null;
      if (s('category')) {
        const [c] = await tx.insert(t.productCategories).values({ tenantId: ctx.tenantId, name: s('category') }).onConflictDoUpdate({ target: [t.productCategories.tenantId, t.productCategories.name], set: { name: s('category') } }).returning({ id: t.productCategories.id });
        categoryId = c!.id;
      }
      await createProduct(tx, ctx, {
        sku: s('sku').toUpperCase(), name: s('name'), categoryId, brand: s('brand'), description: '', barcode: s('barcode') || null, altBarcode: null, skuType: d.track_serial ? 'serial' : d.track_expiry ? 'expirable' : d.track_batch ? 'batch' : 'simple', parentId: null, variantAttributes: {},
        uom: s('uom') || 'pcs', purchaseUom: s('uom') || 'pcs', salesUom: s('uom') || 'pcs', conversionFactor: 1, weightKg: n('weight_kg'), lengthCm: n('length_cm'), widthCm: n('width_cm'), heightCm: n('height_cm'), unitsPerPallet: n('units_per_pallet'),
        costPrice: n('cost_price'), sellingPrice: n('selling_price'), minStock: n('min_stock'), reorderLevel: n('reorder_level'), reorderQty: n('reorder_qty'), maxStock: n('max_stock'),
        defaultSupplierId: s('supplier_code') ? await idBy('suppliers', 'code', s('supplier_code')) : null, taxRateId: null, trackBatch: Boolean(d.track_batch), trackLot: false, trackSerial: Boolean(d.track_serial), trackExpiry: Boolean(d.track_expiry), temperatureClass: 'ambient', imageUrl: null, status: 'active',
      });
      return;
    }
    case 'customers':
      await createCustomer(tx, ctx, customerBody.parse({ code: s('code') || undefined, name: s('name'), contactName: s('contact_name'), phone: s('phone'), email: s('email'), address: s('address'), city: s('city'), ntn: s('ntn'), strn: s('strn'), creditLimit: n('credit_limit'), paymentTermsDays: n('payment_terms_days') || 30, isStorageClient: Boolean(d.storage_client) }));
      return;
    case 'suppliers':
      await createSupplier(tx, ctx, supplierBody.parse({ code: s('code') || undefined, name: s('name'), contactName: s('contact_name'), phone: s('phone'), email: s('email'), address: s('address'), city: s('city'), ntn: s('ntn'), strn: s('strn'), paymentTermsDays: n('payment_terms_days') || 30, leadTimeDays: n('lead_time_days') || 7 }));
      return;
    case 'warehouses':
      await createWarehouse(tx, ctx, { code: s('code').toUpperCase(), name: s('name'), type: (['owned', 'rented', 'third_party', 'cold_storage', 'bonded', 'distribution_center'].includes(s('type')) ? s('type') : 'owned') as never, address: s('address'), city: s('city'), country: 'PK', managerUserId: null, capacity: n('capacity'), capacityUnit: (['pallets', 'cbm', 'sqft', 'sqm', 'units'].includes(s('capacity_unit')) ? s('capacity_unit') : 'pallets') as never, totalAreaSqm: 0, contactName: '', contactPhone: '', contactEmail: '', operatingHours: '', status: 'active' });
      return;
    case 'locations': {
      const [w] = await q<{ id: string; code: string }>(tx, sql`SELECT id, code FROM warehouses WHERE tenant_id = ${ctx.tenantId} AND upper(code) = upper(${s('warehouse_code')})`);
      const parent = s('parent_code') ? (await q<{ id: string; code: string }>(tx, sql`SELECT id, code FROM locations WHERE tenant_id = ${ctx.tenantId} AND warehouse_id = ${w!.id} AND upper(code) = upper(${s('parent_code')})`))[0] : undefined;
      const code = parent ? `${parent.code}-${s('segment').toUpperCase()}` : s('segment').toUpperCase();
      const type = s('type');
      await tx.insert(t.locations).values({ tenantId: ctx.tenantId, warehouseId: w!.id, parentId: parent?.id ?? null, type, code, name: `${type.charAt(0).toUpperCase()}${type.slice(1)} ${s('segment').toUpperCase()}`, barcode: `LOC-${w!.code}-${code}`, capacityUnits: n('capacity_units'), capacityVolumeM3: n('capacity_volume_m3'), isPickable: type === 'bin' || type === 'shelf' });
      return;
    }
    case 'opening_inventory': {
      const [loc] = await q<{ id: string; warehouse_id: string }>(tx, sql`SELECT l.id, l.warehouse_id FROM locations l JOIN warehouses w ON w.id = l.warehouse_id WHERE l.tenant_id = ${ctx.tenantId} AND upper(w.code) = upper(${s('warehouse_code')}) AND upper(l.code) = upper(${s('location_code')})`);
      const productId = (await idBy('products', 'sku', s('sku')))!;
      const batch = s('batch_no') ? await ensureBatch(tx, ctx, { productId, batchNo: s('batch_no'), expiryDate: (d.expiry_date as string) ?? null }) : null;
      const owner = s('owner_customer_code') ? await idBy('customers', 'code', s('owner_customer_code')) : null;
      await postMovement(tx, ctx, { warehouseId: loc!.warehouse_id, locationId: loc!.id, productId, batchId: batch?.id ?? null, ownerCustomerId: owner, quantity: n('quantity'), type: 'opening_balance', unitCost: n('unit_cost') || undefined, referenceType: 'import', reason: 'Opening inventory import' });
      if (n('unit_cost') > 0 && !owner) await tx.update(t.products).set({ costPrice: n('unit_cost') }).where(and(eq(t.products.id, productId), eq(t.products.costPrice, 0)));
      return;
    }
    case 'opening_balances': {
      const due = (d.due_date as string) ?? new Date().toISOString().slice(0, 10);
      if (d.party_type === 'customer') {
        const id = (await idBy('customers', 'code', s('code')))!;
        const inv = await createInvoice(tx, ctx, { type: 'sales', customerId: id, currency: ctx.currency, notes: `Opening balance ${s('reference')}`.trim(), lines: [{ description: `Opening balance ${s('reference')}`.trim(), quantity: 1, unitPrice: n('amount'), taxRate: 0, taxAmount: 0, lineTotal: n('amount') }] });
        await tx.update(t.invoices).set({ dueDate: due }).where(eq(t.invoices.id, inv.id));
      } else {
        const id = (await idBy('suppliers', 'code', s('code')))!;
        await tx.insert(t.supplierBills).values({ tenantId: ctx.tenantId, number: await nextNumber(tx, ctx.tenantId, 'BILL'), supplierId: id, supplierInvoiceNo: s('reference'), billDate: new Date().toISOString().slice(0, 10), dueDate: due, currency: ctx.currency, subtotal: n('amount'), total: n('amount'), createdBy: ctx.userId });
      }
    }
  }
}

const PERMISSION_FOR: Record<ImportEntity, string> = { products: 'product.manage', customers: 'customer.manage', suppliers: 'supplier.manage', warehouses: 'warehouse.manage', locations: 'warehouse.manage', opening_inventory: 'inventory.adjust', opening_balances: 'billing.manage' };

export function registerImportRoutes(r: Router) {
  r.get('/templates/:entity', { summary: 'Download a CSV import template', permission: 'import.execute', params: z.object({ entity: z.enum(IMPORT_ENTITIES) }) }, async ({ params, reply }) => {
    const csv = TEMPLATES[params.entity].map((r0) => r0.map((c) => (/[",]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\r\n');
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${params.entity}_template.csv"`).send(`﻿${csv}`);
    return SENT;
  });

  r.post('/', { summary: 'Upload a CSV or XLSX file for preview and validation (multipart: file, entity). Nothing is imported yet.', permission: 'import.execute', rateLimit: { max: 20, timeWindow: '1 minute' } }, async ({ ctx, req }) => {
    const part = await req.file();
    if (!part) throw badRequest('Attach a CSV or Excel file.');
    const entity = z.enum(IMPORT_ENTITIES).parse((part.fields.entity as { value?: string } | undefined)?.value);
    if (!ctx.permissions.has(PERMISSION_FOR[entity])) throw badRequest(`You need the ${PERMISSION_FOR[entity]} permission to import ${entity.replace('_', ' ')}.`);
    if (!/\.(csv|xlsx|txt)$/i.test(part.filename)) throw badRequest('Upload a .csv or .xlsx file.');
    const raw = await parseUpload(await part.toBuffer(), part.filename);
    if (raw.length > MAX_ROWS) throw badRequest(`Files are limited to ${MAX_ROWS.toLocaleString()} rows. Split the file.`);
    const validated = await validateRows(ctx, entity, raw);
    const invalid = validated.filter((v) => v.errors.length).length;
    const [job] = await db().insert(t.importJobs).values({ tenantId: ctx.tenantId, entity, fileName: part.filename.slice(0, 200), totalRows: validated.length, validRows: validated.length - invalid, invalidRows: invalid, rows: validated, createdBy: ctx.userId }).returning();
    return { id: job!.id, entity, fileName: job!.fileName, totalRows: job!.totalRows, validRows: job!.validRows, invalidRows: job!.invalidRows, preview: validated.slice(0, 200) };
  });

  r.get('/:id', { summary: 'Import preview with row-level validation errors', permission: 'import.execute', params: idParam }, async ({ ctx, params }) => {
    const [job] = await db().select().from(t.importJobs).where(and(eq(t.importJobs.id, params.id), eq(t.importJobs.tenantId, ctx.tenantId))).limit(1);
    if (!job) throw notFound('Import');
    return job;
  });

  r.get('/', { summary: 'Import history', permission: 'import.execute' }, async ({ ctx }) =>
    db().select({ id: t.importJobs.id, entity: t.importJobs.entity, fileName: t.importJobs.fileName, status: t.importJobs.status, totalRows: t.importJobs.totalRows, validRows: t.importJobs.validRows, invalidRows: t.importJobs.invalidRows, createdAt: t.importJobs.createdAt, committedAt: t.importJobs.committedAt })
      .from(t.importJobs).where(eq(t.importJobs.tenantId, ctx.tenantId)).orderBy(sql`${t.importJobs.createdAt} DESC`).limit(50));

  r.post('/:id/commit', {
    summary: 'Import the valid rows in one transaction. Invalid rows are skipped only if you acknowledge them.',
    permission: 'import.execute',
    params: idParam,
    body: z.object({ acknowledgeInvalidRows: z.boolean().default(false) }),
  }, async ({ ctx, params, body }) => {
    const [job] = await db().select().from(t.importJobs).where(and(eq(t.importJobs.id, params.id), eq(t.importJobs.tenantId, ctx.tenantId))).limit(1);
    if (!job) throw notFound('Import');
    if (job.status !== 'preview') throw invalidState('This import was already committed.');
    if (job.invalidRows > 0 && !body.acknowledgeInvalidRows) throw badRequest(`${job.invalidRows} row(s) have errors. Fix the file, or confirm that those rows should be skipped.`);
    const entity = job.entity as ImportEntity;
    const valid = job.rows.filter((r0) => !r0.errors.length);
    await db().transaction(async (tx) => {
      for (const row of valid) {
        try { await commitRow(tx, ctx, entity, row.data); } catch (err) { throw badRequest(`Row ${row.row}: ${err instanceof Error ? err.message : 'failed'}. Nothing was imported.`); }
      }
      await tx.update(t.importJobs).set({ status: 'committed', committedAt: new Date() }).where(eq(t.importJobs.id, job.id));
      await audit(tx, ctx, { action: 'import.committed', entityType: 'import', entityId: job.id, newValue: { entity, imported: valid.length, skipped: job.invalidRows, file: job.fileName } });
    });
    return { imported: valid.length, skipped: job.invalidRows };
  });
}
