import { sql } from 'drizzle-orm';
import { num, rows, type DbOrTx } from '../../db';

export interface LocationUsage {
  id: string;
  parentId: string | null;
  type: string;
  code: string;
  name: string;
  barcode: string;
  status: string;
  temperatureClass: string;
  isPickable: boolean;
  isReceiving: boolean;
  isDispatch: boolean;
  pickPriority: number;
  level: number;
  mapX: number | null;
  mapY: number | null;
  mapW: number;
  mapH: number;
  capacityUnits: number;
  capacityVolumeM3: number;
  capacityWeightKg: number;
  palletCapacity: number;
  usedUnits: number;
  usedVolumeM3: number;
  usedWeightKg: number;
  usedPallets: number;
  skuCount: number;
  value: number;
  /** 0..n; >1 = overloaded. Based on the most constrained configured dimension. */
  utilization: number;
  binCount: number;
  occupiedBins: number;
}

const UNDERUTILIZED = 0.2;
const OVERLOADED = 1.0;

/** Loads every location of a warehouse with occupancy, then rolls usage up the hierarchy. */
export async function locationUsage(dbx: DbOrTx, tenantId: string, warehouseId: string): Promise<LocationUsage[]> {
  const data = await rows<Record<string, string | number | boolean | null>>(dbx, sql`
    SELECT l.id, l.parent_id, l.type, l.code, l.name, l.barcode, l.status, l.temperature_class, l.is_pickable, l.is_receiving, l.is_dispatch,
      l.pick_priority, l.level, l.map_x, l.map_y, l.map_w, l.map_h,
      l.capacity_units, l.capacity_volume_m3, l.capacity_weight_kg, l.pallet_capacity,
      COALESCE(s.units, 0) AS used_units, COALESCE(s.volume, 0) AS used_volume, COALESCE(s.weight, 0) AS used_weight,
      COALESCE(s.pallets, 0) AS used_pallets, COALESCE(s.skus, 0) AS sku_count, COALESCE(s.value, 0) AS value
    FROM locations l
    LEFT JOIN (
      SELECT b.location_id, SUM(b.quantity) AS units, SUM(b.quantity * p.volume_m3) AS volume, SUM(b.quantity * p.weight_kg) AS weight,
        SUM(CASE WHEN p.units_per_pallet > 0 THEN b.quantity / p.units_per_pallet ELSE 0 END) AS pallets,
        COUNT(DISTINCT b.product_id) AS skus, SUM(b.quantity * p.cost_price) AS value
      FROM inventory_balances b JOIN products p ON p.id = b.product_id
      WHERE b.tenant_id = ${tenantId} AND b.warehouse_id = ${warehouseId} AND b.quantity > 0
      GROUP BY b.location_id
    ) s ON s.location_id = l.id
    WHERE l.tenant_id = ${tenantId} AND l.warehouse_id = ${warehouseId}
    ORDER BY l.code`);

  const list: LocationUsage[] = data.map((r) => ({
    id: String(r.id), parentId: (r.parent_id as string) ?? null, type: String(r.type), code: String(r.code), name: String(r.name), barcode: String(r.barcode),
    status: String(r.status), temperatureClass: String(r.temperature_class), isPickable: Boolean(r.is_pickable), isReceiving: Boolean(r.is_receiving), isDispatch: Boolean(r.is_dispatch),
    pickPriority: num(r.pick_priority), level: num(r.level), mapX: r.map_x === null ? null : num(r.map_x), mapY: r.map_y === null ? null : num(r.map_y), mapW: num(r.map_w), mapH: num(r.map_h),
    capacityUnits: num(r.capacity_units), capacityVolumeM3: num(r.capacity_volume_m3), capacityWeightKg: num(r.capacity_weight_kg), palletCapacity: num(r.pallet_capacity),
    usedUnits: num(r.used_units), usedVolumeM3: num(r.used_volume), usedWeightKg: num(r.used_weight), usedPallets: num(r.used_pallets), skuCount: num(r.sku_count), value: num(r.value),
    utilization: 0, binCount: 0, occupiedBins: 0,
  }));

  const byId = new Map(list.map((l) => [l.id, l]));
  const children = new Map<string, LocationUsage[]>();
  for (const l of list) if (l.parentId) children.set(l.parentId, [...(children.get(l.parentId) ?? []), l]);

  // Post-order rollup: parents aggregate children capacity and usage.
  const visit = (l: LocationUsage): void => {
    const kids = children.get(l.id) ?? [];
    if (!kids.length) {
      // Any leaf is a storable slot (bins, floor zones, docks).
      l.binCount = 1;
      l.occupiedBins = l.usedUnits > 0 ? 1 : 0;
    }
    for (const k of kids) {
      visit(k);
      l.usedUnits += k.usedUnits; l.usedVolumeM3 += k.usedVolumeM3; l.usedWeightKg += k.usedWeightKg; l.usedPallets += k.usedPallets; l.value += k.value;
      l.skuCount += k.skuCount; // SKU-location slots (a SKU in two bins counts twice)
      l.binCount += k.binCount; l.occupiedBins += k.occupiedBins;
    }
    if (kids.length) {
      // A container's capacity is the sum of its children unless set explicitly.
      const sum = (f: (x: LocationUsage) => number) => kids.reduce((s, k) => s + f(k), 0);
      if (!l.capacityUnits) l.capacityUnits = sum((k) => k.capacityUnits);
      if (!l.capacityVolumeM3) l.capacityVolumeM3 = sum((k) => k.capacityVolumeM3);
      if (!l.capacityWeightKg) l.capacityWeightKg = sum((k) => k.capacityWeightKg);
      if (!l.palletCapacity) l.palletCapacity = sum((k) => k.palletCapacity);
    }
    l.utilization = utilizationOf(l);
  };
  for (const l of list) if (!l.parentId || !byId.has(l.parentId)) visit(l);
  return list;
}

export function utilizationOf(l: Pick<LocationUsage, 'usedUnits' | 'capacityUnits' | 'usedVolumeM3' | 'capacityVolumeM3' | 'usedWeightKg' | 'capacityWeightKg' | 'usedPallets' | 'palletCapacity'>): number {
  const ratios = [
    l.capacityVolumeM3 > 0 ? l.usedVolumeM3 / l.capacityVolumeM3 : null,
    l.capacityUnits > 0 ? l.usedUnits / l.capacityUnits : null,
    l.capacityWeightKg > 0 ? l.usedWeightKg / l.capacityWeightKg : null,
    l.palletCapacity > 0 ? l.usedPallets / l.palletCapacity : null,
  ].filter((x): x is number => x !== null);
  return ratios.length ? Math.max(...ratios) : 0;
}

export function classify(u: number, used: number): 'empty' | 'underutilized' | 'normal' | 'full' | 'overloaded' {
  if (used <= 0) return 'empty';
  if (u > OVERLOADED + 1e-9) return 'overloaded';
  if (u >= 0.9) return 'full';
  if (u < UNDERUTILIZED) return 'underutilized';
  return 'normal';
}

export interface WarehouseCapacity {
  warehouseId: string;
  capacity: number;
  capacityUnit: string;
  used: number;
  free: number;
  utilizationPct: number;
  totalLocations: number;
  occupiedLocations: number;
  emptyLocations: number;
  overloadedLocations: number;
  underutilizedLocations: number;
  usedVolumeM3: number;
  capacityVolumeM3: number;
  stockValue: number;
}

/**
 * Warehouse-level capacity in the warehouse's chosen unit. Cubic and pallet
 * units use product dimensions; area units fall back to bin occupancy share.
 */
export async function warehouseCapacity(dbx: DbOrTx, tenantId: string, w: { id: string; capacity: number; capacityUnit: string }): Promise<WarehouseCapacity> {
  const locs = await locationUsage(dbx, tenantId, w.id);
  const leaves = locs.filter((l) => !locs.some((c) => c.parentId === l.id));
  const storage = leaves.filter((l) => l.type !== 'dock' && l.type !== 'staging');
  const totals = leaves.reduce((s, l) => ({ units: s.units + l.usedUnits, volume: s.volume + l.usedVolumeM3, pallets: s.pallets + l.usedPallets, value: s.value + l.value, capVol: s.capVol + l.capacityVolumeM3 }), { units: 0, volume: 0, pallets: 0, value: 0, capVol: 0 });
  const occupied = storage.filter((l) => l.usedUnits > 0).length;

  let used: number;
  switch (w.capacityUnit) {
    case 'cbm': used = totals.volume; break;
    case 'pallets': used = totals.pallets; break;
    case 'units': used = totals.units; break;
    default: used = storage.length ? (occupied / storage.length) * w.capacity : 0; // sqft / sqm
  }
  const capacity = w.capacity || (w.capacityUnit === 'cbm' ? totals.capVol : 0);
  const pct = capacity > 0 ? (used / capacity) * 100 : 0;
  return {
    warehouseId: w.id,
    capacity,
    capacityUnit: w.capacityUnit,
    used: Math.round(used * 100) / 100,
    free: Math.max(0, Math.round((capacity - used) * 100) / 100),
    utilizationPct: Math.round(pct * 10) / 10,
    totalLocations: storage.length,
    occupiedLocations: occupied,
    emptyLocations: storage.length - occupied,
    overloadedLocations: storage.filter((l) => classify(l.utilization, l.usedUnits) === 'overloaded').length,
    underutilizedLocations: storage.filter((l) => classify(l.utilization, l.usedUnits) === 'underutilized').length,
    usedVolumeM3: Math.round(totals.volume * 100) / 100,
    capacityVolumeM3: Math.round(totals.capVol * 100) / 100,
    stockValue: Math.round(totals.value),
  };
}
