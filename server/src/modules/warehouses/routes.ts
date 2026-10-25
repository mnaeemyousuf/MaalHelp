import { z } from 'zod';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { CAPACITY_UNITS, LOCATION_TYPES, TEMPERATURE_CLASSES, WAREHOUSE_TYPES } from '@shared/domain';
import { db, one, num, rows, t, type DbOrTx } from '../../db';
import { idParam, type Router } from '../../core/http';
import { badRequest, conflict, notFound } from '../../core/errors';
import { audit, diff } from '../../core/audit';
import type { Ctx } from '../../core/context';
import { assertWithinLimit } from '../platform/limits';
import { classify, locationUsage, warehouseCapacity } from './space';

const warehouseBody = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,20}$/, 'Code: 2–20 letters, digits or dashes.'),
  name: z.string().trim().min(2).max(120),
  type: z.enum(WAREHOUSE_TYPES).default('owned'),
  address: z.string().trim().max(300).default(''),
  city: z.string().trim().max(80).default(''),
  country: z.string().trim().length(2).default('PK'),
  managerUserId: z.string().uuid().nullish(),
  capacity: z.coerce.number().min(0).default(0),
  capacityUnit: z.enum(CAPACITY_UNITS).default('pallets'),
  totalAreaSqm: z.coerce.number().min(0).default(0),
  contactName: z.string().trim().max(120).default(''),
  contactPhone: z.string().trim().max(40).default(''),
  contactEmail: z.string().trim().email().or(z.literal('')).default(''),
  operatingHours: z.string().trim().max(120).default(''),
  status: z.enum(['active', 'inactive']).default('active'),
});

const locationBody = z.object({
  parentId: z.string().uuid().nullish(),
  type: z.enum(LOCATION_TYPES),
  segment: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,8}$/, 'Segment: 1–8 letters/digits (e.g. A, 03, R12, B08).'),
  name: z.string().trim().max(120).optional(),
  capacityUnits: z.coerce.number().min(0).default(0),
  capacityVolumeM3: z.coerce.number().min(0).default(0),
  capacityWeightKg: z.coerce.number().min(0).default(0),
  palletCapacity: z.coerce.number().int().min(0).default(0),
  temperatureClass: z.enum(TEMPERATURE_CLASSES).default('ambient'),
  isPickable: z.boolean().default(true),
  pickPriority: z.coerce.number().int().min(1).max(100).default(50),
  level: z.coerce.number().int().min(0).max(20).default(0),
  mapX: z.number().int().min(0).max(500).nullish(),
  mapY: z.number().int().min(0).max(500).nullish(),
  mapW: z.number().int().min(1).max(40).default(2),
  mapH: z.number().int().min(1).max(40).default(2),
});

const PARENT_OF: Record<string, string[]> = { zone: [], dock: [], staging: [], aisle: ['zone'], rack: ['aisle', 'zone'], shelf: ['rack'], bin: ['shelf', 'rack', 'zone', 'aisle'] };

export async function getWarehouse(dbx: DbOrTx, tenantId: string, id: string) {
  const [w] = await dbx.select().from(t.warehouses).where(and(eq(t.warehouses.id, id), eq(t.warehouses.tenantId, tenantId))).limit(1);
  if (!w) throw notFound('Warehouse');
  return w;
}

/** Every warehouse gets an inbound receiving dock and an outbound dispatch dock. */
async function createOperationalDocks(tx: DbOrTx, tenantId: string, warehouseId: string, code: string): Promise<void> {
  await tx.insert(t.locations).values([
    { tenantId, warehouseId, type: 'staging', code: 'RECV', name: 'Receiving dock', barcode: `LOC-${code}-RECV`, isPickable: false, isReceiving: true, pickPriority: 99, mapX: 0, mapY: 0, mapW: 4, mapH: 2 },
    { tenantId, warehouseId, type: 'dock', code: 'DISP', name: 'Dispatch dock', barcode: `LOC-${code}-DISP`, isPickable: false, isDispatch: true, pickPriority: 1, mapX: 0, mapY: 3, mapW: 4, mapH: 2 },
  ]);
}

export async function createWarehouse(tx: DbOrTx, ctx: Ctx, body: z.infer<typeof warehouseBody>) {
  await assertWithinLimit(tx, ctx.tenantId, 'warehouses');
  const [w] = await tx.insert(t.warehouses).values({ ...body, managerUserId: body.managerUserId ?? null, tenantId: ctx.tenantId }).returning();
  await createOperationalDocks(tx, ctx.tenantId, w!.id, w!.code);
  await audit(tx, ctx, { action: 'warehouse.created', entityType: 'warehouse', entityId: w!.id, newValue: body });
  return w!;
}

export function registerWarehouseRoutes(r: Router) {
  r.get('/', { summary: 'List warehouses with capacity and utilisation', permission: ['warehouse.view', 'dashboard.view', 'inventory.view'] }, async ({ ctx }) => {
    const list = await db().select().from(t.warehouses).where(eq(t.warehouses.tenantId, ctx.tenantId)).orderBy(asc(t.warehouses.code));
    const managers = await db().select({ id: t.users.id, name: t.users.name }).from(t.users).where(inArray(t.users.id, list.map((w) => w.managerUserId).filter((x): x is string => !!x).concat(['00000000-0000-0000-0000-000000000000'])));
    return Promise.all(list.map(async (w) => ({ ...w, managerName: managers.find((m) => m.id === w.managerUserId)?.name ?? null, capacityStats: await warehouseCapacity(db(), ctx.tenantId, w) })));
  });

  r.post('/', { summary: 'Create a warehouse (adds receiving and dispatch docks)', permission: 'warehouse.manage', body: warehouseBody }, async ({ ctx, body }) =>
    db().transaction((tx) => createWarehouse(tx, ctx, body)));

  r.get('/:id', { summary: 'Warehouse detail', permission: 'warehouse.view', params: idParam }, async ({ ctx, params }) => {
    const w = await getWarehouse(db(), ctx.tenantId, params.id);
    return { ...w, capacityStats: await warehouseCapacity(db(), ctx.tenantId, w) };
  });

  r.patch('/:id', { summary: 'Update a warehouse', permission: 'warehouse.manage', params: idParam, body: warehouseBody.partial() }, async ({ ctx, params, body }) => {
    const before = await getWarehouse(db(), ctx.tenantId, params.id);
    const [w] = await db().update(t.warehouses).set({ ...body, updatedAt: new Date() }).where(eq(t.warehouses.id, params.id)).returning();
    await audit(db(), ctx, { action: 'warehouse.updated', entityType: 'warehouse', entityId: params.id, ...diff(before as Record<string, unknown>, body) });
    return w;
  });

  r.get('/:id/locations', {
    summary: 'All locations of a warehouse with occupancy (tree-ready flat list)',
    permission: ['warehouse.view', 'inventory.view', 'putaway.execute', 'picking.execute', 'receiving.execute'],
    params: idParam,
    query: z.object({ type: z.enum(LOCATION_TYPES).optional(), leafOnly: z.coerce.boolean().optional() }),
  }, async ({ ctx, params, query }) => {
    await getWarehouse(db(), ctx.tenantId, params.id);
    let list = await locationUsage(db(), ctx.tenantId, params.id);
    if (query.leafOnly) list = list.filter((l) => !list.some((c) => c.parentId === l.id));
    if (query.type) list = list.filter((l) => l.type === query.type);
    return list.map((l) => ({ ...l, state: classify(l.utilization, l.usedUnits) }));
  });

  r.post('/:id/locations', { summary: 'Create one location in the hierarchy', permission: 'warehouse.manage', params: idParam, body: locationBody }, async ({ ctx, params, body }) => {
    const w = await getWarehouse(db(), ctx.tenantId, params.id);
    let parent: typeof t.locations.$inferSelect | undefined;
    if (body.parentId) {
      [parent] = await db().select().from(t.locations).where(and(eq(t.locations.id, body.parentId), eq(t.locations.tenantId, ctx.tenantId), eq(t.locations.warehouseId, w.id))).limit(1);
      if (!parent) throw notFound('Parent location');
      if (!PARENT_OF[body.type]!.includes(parent.type)) throw badRequest(`A ${body.type} cannot be placed inside a ${parent.type}.`);
    } else if (!['zone', 'dock', 'staging'].includes(body.type)) {
      throw badRequest(`A ${body.type} must be placed inside a parent location.`);
    }
    const code = parent ? `${parent.code}-${body.segment}` : body.segment;
    const [loc] = await db().insert(t.locations).values({
      ...body, tenantId: ctx.tenantId, warehouseId: w.id, parentId: parent?.id ?? null, code,
      name: body.name || defaultName(body.type, body.segment, parent?.name), barcode: `LOC-${w.code}-${code}`,
      mapX: body.mapX ?? null, mapY: body.mapY ?? null,
    }).returning();
    await audit(db(), ctx, { action: 'location.created', entityType: 'location', entityId: loc!.id, newValue: { code, type: body.type } });
    return loc;
  });

  r.post('/:id/locations/generate', {
    summary: 'Bulk-create a zone with aisles, racks, shelves and bins',
    permission: 'warehouse.manage',
    params: idParam,
    body: z.object({
      zoneCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,4}$/),
      zoneName: z.string().trim().max(80).optional(),
      aisles: z.number().int().min(1).max(30),
      racksPerAisle: z.number().int().min(1).max(40),
      shelvesPerRack: z.number().int().min(1).max(10),
      binsPerShelf: z.number().int().min(1).max(20),
      binCapacityUnits: z.number().min(0).default(100),
      binVolumeM3: z.number().min(0).default(0.5),
      binWeightKg: z.number().min(0).default(0),
      temperatureClass: z.enum(TEMPERATURE_CLASSES).default('ambient'),
      pickPriority: z.number().int().min(1).max(100).default(50),
      originX: z.number().int().min(0).max(400).default(6),
      originY: z.number().int().min(0).max(400).default(0),
    }),
  }, async ({ ctx, params, body }) => {
    const w = await getWarehouse(db(), ctx.tenantId, params.id);
    const total = body.aisles * body.racksPerAisle * body.shelvesPerRack * body.binsPerShelf;
    if (total > 5000) throw badRequest(`That would create ${total} bins; the maximum per generation is 5,000.`);
    return db().transaction(async (tx) => {
      const [existing] = await tx.select({ id: t.locations.id }).from(t.locations).where(and(eq(t.locations.tenantId, ctx.tenantId), eq(t.locations.warehouseId, w.id), eq(t.locations.code, body.zoneCode))).limit(1);
      if (existing) throw conflict('DUPLICATE', `Zone ${body.zoneCode} already exists in this warehouse.`);
      const pad = (n: number) => String(n).padStart(2, '0');
      const base = { tenantId: ctx.tenantId, warehouseId: w.id, temperatureClass: body.temperatureClass };
      const [zone] = await tx.insert(t.locations).values({ ...base, type: 'zone', code: body.zoneCode, name: body.zoneName || `Zone ${body.zoneCode}`, barcode: `LOC-${w.code}-${body.zoneCode}`, isPickable: false, pickPriority: body.pickPriority, mapX: body.originX, mapY: body.originY, mapW: body.aisles * 3, mapH: body.racksPerAisle + 1 }).returning();
      let created = 1;
      for (let a = 1; a <= body.aisles; a++) {
        const aCode = `${body.zoneCode}-${pad(a)}`;
        const [aisle] = await tx.insert(t.locations).values({ ...base, parentId: zone!.id, type: 'aisle', code: aCode, name: `Aisle ${pad(a)}`, barcode: `LOC-${w.code}-${aCode}`, isPickable: false, pickPriority: body.pickPriority + a - 1, mapX: body.originX + (a - 1) * 3, mapY: body.originY, mapW: 2, mapH: body.racksPerAisle }).returning();
        created++;
        for (let rk = 1; rk <= body.racksPerAisle; rk++) {
          const rCode = `${aCode}-R${pad(rk)}`;
          const [rack] = await tx.insert(t.locations).values({ ...base, parentId: aisle!.id, type: 'rack', code: rCode, name: `Rack R${pad(rk)}`, barcode: `LOC-${w.code}-${rCode}`, isPickable: false, pickPriority: body.pickPriority + a - 1, mapX: body.originX + (a - 1) * 3, mapY: body.originY + rk - 1, mapW: 2, mapH: 1 }).returning();
          created++;
          const bins: (typeof t.locations.$inferInsert)[] = [];
          for (let s = 1; s <= body.shelvesPerRack; s++) {
            const sCode = `${rCode}-S${pad(s)}`;
            const [shelf] = await tx.insert(t.locations).values({ ...base, parentId: rack!.id, type: 'shelf', code: sCode, name: `Shelf S${pad(s)}`, barcode: `LOC-${w.code}-${sCode}`, isPickable: false, level: s, pickPriority: body.pickPriority + a - 1 + (s - 1) * 2 }).returning();
            created++;
            for (let b = 1; b <= body.binsPerShelf; b++) {
              const bCode = `${sCode}-B${pad(b)}`;
              bins.push({ ...base, parentId: shelf!.id, type: 'bin', code: bCode, name: `Bin B${pad(b)}`, barcode: `LOC-${w.code}-${bCode}`, capacityUnits: body.binCapacityUnits, capacityVolumeM3: body.binVolumeM3, capacityWeightKg: body.binWeightKg, level: s, pickPriority: Math.min(100, body.pickPriority + a - 1 + (s - 1) * 2) });
            }
          }
          if (bins.length) await tx.insert(t.locations).values(bins);
          created += bins.length;
        }
      }
      await audit(tx, ctx, { action: 'location.bulk_created', entityType: 'warehouse', entityId: w.id, newValue: { zone: body.zoneCode, locations: created } });
      return { zoneId: zone!.id, created };
    });
  });

  r.put('/:id/map', {
    summary: 'Save map positions after drag-and-drop',
    permission: 'warehouse.manage',
    params: idParam,
    body: z.object({ items: z.array(z.object({ id: z.string().uuid(), mapX: z.number().int().min(0).max(500), mapY: z.number().int().min(0).max(500), mapW: z.number().int().min(1).max(60).optional(), mapH: z.number().int().min(1).max(60).optional() })).max(500), mapCols: z.number().int().min(8).max(200).optional(), mapRows: z.number().int().min(6).max(200).optional() }),
  }, async ({ ctx, params, body }) => {
    const w = await getWarehouse(db(), ctx.tenantId, params.id);
    await db().transaction(async (tx) => {
      for (const item of body.items) {
        await tx.update(t.locations).set({ mapX: item.mapX, mapY: item.mapY, mapW: item.mapW, mapH: item.mapH })
          .where(and(eq(t.locations.id, item.id), eq(t.locations.tenantId, ctx.tenantId), eq(t.locations.warehouseId, w.id)));
      }
      if (body.mapCols || body.mapRows) await tx.update(t.warehouses).set({ mapCols: body.mapCols, mapRows: body.mapRows }).where(eq(t.warehouses.id, w.id));
      await audit(tx, ctx, { action: 'warehouse.map_updated', entityType: 'warehouse', entityId: w.id, newValue: { moved: body.items.length } });
    });
    return { ok: true };
  });

  r.get('/:id/utilization', { summary: 'Zone, rack and bin utilisation with empty / overloaded / underutilised lists', permission: 'warehouse.view', params: idParam }, async ({ ctx, params }) => {
    const w = await getWarehouse(db(), ctx.tenantId, params.id);
    const list = await locationUsage(db(), ctx.tenantId, w.id);
    const leaves = list.filter((l) => !list.some((c) => c.parentId === l.id) && l.type !== 'dock' && l.type !== 'staging');
    const pick = (l: (typeof list)[number]) => ({ id: l.id, code: l.code, name: l.name, type: l.type, utilizationPct: Math.round(l.utilization * 1000) / 10, usedUnits: l.usedUnits, capacityUnits: l.capacityUnits, usedVolumeM3: Math.round(l.usedVolumeM3 * 1000) / 1000, capacityVolumeM3: l.capacityVolumeM3, skuCount: l.skuCount, value: Math.round(l.value), occupiedBins: l.occupiedBins, binCount: l.binCount });
    return {
      capacity: await warehouseCapacity(db(), ctx.tenantId, w),
      zones: list.filter((l) => l.type === 'zone').map(pick),
      racks: list.filter((l) => l.type === 'rack').map(pick),
      empty: leaves.filter((l) => l.usedUnits <= 0).slice(0, 200).map(pick),
      overloaded: leaves.filter((l) => classify(l.utilization, l.usedUnits) === 'overloaded').map(pick),
      underutilized: leaves.filter((l) => classify(l.utilization, l.usedUnits) === 'underutilized').slice(0, 200).map(pick),
    };
  });

  r.get('/locations/lookup', {
    summary: 'Resolve a scanned location barcode or code',
    permission: ['warehouse.view', 'inventory.view', 'putaway.execute', 'picking.execute', 'receiving.execute'],
    query: z.object({ code: z.string().trim().min(1).max(120), warehouseId: z.string().uuid().optional() }),
  }, async ({ ctx, query }) => {
    const code = query.code.toUpperCase();
    const loc = await one<Record<string, unknown>>(db(), sql`
      SELECT l.id, l.code, l.name, l.type, l.barcode, l.warehouse_id AS "warehouseId", w.code AS "warehouseCode", w.name AS "warehouseName", l.is_pickable AS "isPickable", l.status
      FROM locations l JOIN warehouses w ON w.id = l.warehouse_id
      WHERE l.tenant_id = ${ctx.tenantId} AND (upper(l.barcode) = ${code} OR upper(l.code) = ${code} OR upper(w.code || '-' || l.code) = ${code})
      ${query.warehouseId ? sql`AND l.warehouse_id = ${query.warehouseId}` : sql``}
      ORDER BY (upper(l.barcode) = ${code}) DESC LIMIT 1`);
    if (!loc) throw notFound(`Location "${query.code}"`);
    const stock = await rows(db(), sql`
      SELECT p.id AS "productId", p.sku, p.name, b.status, b.quantity::float AS quantity, b.batch_id AS "batchId", bt.batch_no AS "batchNo", b.owner_customer_id AS "ownerCustomerId"
      FROM inventory_balances b JOIN products p ON p.id = b.product_id LEFT JOIN batches bt ON bt.id = b.batch_id
      WHERE b.tenant_id = ${ctx.tenantId} AND b.location_id = ${loc.id as string} AND b.quantity > 0 ORDER BY p.sku`);
    return { ...loc, stock };
  });

  r.patch('/locations/:id', {
    summary: 'Update a location (capacity, status, priority, map)',
    permission: 'warehouse.manage',
    params: idParam,
    body: locationBody.omit({ parentId: true, type: true, segment: true }).partial().extend({ status: z.enum(['active', 'blocked']).optional() }),
  }, async ({ ctx, params, body }) => {
    const [before] = await db().select().from(t.locations).where(and(eq(t.locations.id, params.id), eq(t.locations.tenantId, ctx.tenantId))).limit(1);
    if (!before) throw notFound('Location');
    const [loc] = await db().update(t.locations).set(body).where(eq(t.locations.id, params.id)).returning();
    await audit(db(), ctx, { action: 'location.updated', entityType: 'location', entityId: params.id, ...diff(before as Record<string, unknown>, body) });
    return loc;
  });

  r.delete('/locations/:id', { summary: 'Delete an empty location and its empty children', permission: 'warehouse.manage', params: idParam }, async ({ ctx, params }) => {
    const [loc] = await db().select().from(t.locations).where(and(eq(t.locations.id, params.id), eq(t.locations.tenantId, ctx.tenantId))).limit(1);
    if (!loc) throw notFound('Location');
    if (loc.isReceiving || loc.isDispatch) throw badRequest('Receiving and dispatch docks are required and cannot be deleted.');
    const used = await one<{ n: string; tx: string }>(db(), sql`
      WITH RECURSIVE tree AS (SELECT id FROM locations WHERE id = ${loc.id} UNION ALL SELECT l.id FROM locations l JOIN tree ON l.parent_id = tree.id)
      SELECT (SELECT COALESCE(SUM(quantity), 0) FROM inventory_balances WHERE location_id IN (SELECT id FROM tree)) AS n,
             (SELECT COUNT(*) FROM inventory_transactions WHERE location_id IN (SELECT id FROM tree)) AS tx`);
    if (num(used?.n) > 0) throw conflict('LOCATION_NOT_EMPTY', 'Move the stock out of this location before deleting it.');
    if (num(used?.tx) > 0) throw conflict('LOCATION_HAS_HISTORY', 'This location has stock history. Block it instead of deleting so the ledger stays intact.');
    await db().delete(t.locations).where(eq(t.locations.id, loc.id));
    await audit(db(), ctx, { action: 'location.deleted', entityType: 'location', entityId: loc.id, oldValue: { code: loc.code } });
    return { ok: true };
  });
}

function defaultName(type: string, segment: string, parentName?: string): string {
  const label = type.charAt(0).toUpperCase() + type.slice(1);
  return parentName && type !== 'zone' ? `${label} ${segment}` : `${label} ${segment}`;
}
