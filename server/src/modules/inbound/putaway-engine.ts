import { sql } from 'drizzle-orm';
import { num, one, rows, type DbOrTx } from '../../db';

export interface PutawayCandidate {
  locationId: string;
  code: string;
  name: string;
  zoneCode: string | null;
  path: string;
  score: number;
  reasons: string[];
  freeUnits: number | null;
  freeVolumeM3: number | null;
}

/** Velocity class from the last 30 days of dispatches across the tenant's catalogue. */
export async function velocityClass(dbx: DbOrTx, tenantId: string, productId: string): Promise<'fast' | 'medium' | 'slow'> {
  const ranked = await one<{ pct: string | null }>(dbx, sql`
    WITH d AS (
      SELECT product_id, -SUM(quantity) AS out FROM inventory_transactions
      WHERE tenant_id = ${tenantId} AND transaction_type = 'dispatch' AND created_at >= now() - interval '30 days'
      GROUP BY product_id
    ), r AS (SELECT product_id, percent_rank() OVER (ORDER BY out) AS pct FROM d)
    SELECT pct FROM r WHERE product_id = ${productId}`);
  if (!ranked || ranked.pct === null) return 'slow';
  const pct = num(ranked.pct);
  return pct >= 0.8 ? 'fast' : pct >= 0.4 ? 'medium' : 'slow';
}

/**
 * Rule-based putaway suggestion. Considers: temperature class, available
 * capacity (units, volume, weight), consolidation with existing stock of the
 * same product/batch, the category's preferred zone, product velocity versus
 * distance to dispatch and rack level, and empty-bin preference.
 */
export async function suggestPutaway(dbx: DbOrTx, tenantId: string, warehouseId: string, productId: string, quantity: number, batchId: string | null = null, limit = 5): Promise<{ velocity: string; candidates: PutawayCandidate[] }> {
  const product = await one<{ volume_m3: string; weight_kg: string; temperature_class: string; preferred_zone_id: string | null; category_name: string | null }>(dbx, sql`
    SELECT p.volume_m3, p.weight_kg, p.temperature_class, c.preferred_zone_id, c.name AS category_name
    FROM products p LEFT JOIN product_categories c ON c.id = p.category_id WHERE p.id = ${productId} AND p.tenant_id = ${tenantId}`);
  if (!product) return { velocity: 'slow', candidates: [] };
  const velocity = await velocityClass(dbx, tenantId, productId);
  const needVolume = num(product.volume_m3) * quantity;
  const needWeight = num(product.weight_kg) * quantity;

  const list = await rows<Record<string, string | number | null>>(dbx, sql`
    WITH usage AS (
      SELECT b.location_id, SUM(b.quantity) AS units, SUM(b.quantity * p.volume_m3) AS volume, SUM(b.quantity * p.weight_kg) AS weight,
        SUM(CASE WHEN b.product_id = ${productId} THEN b.quantity ELSE 0 END) AS same_product,
        SUM(CASE WHEN b.product_id = ${productId} AND b.batch_id IS NOT DISTINCT FROM ${batchId}::uuid THEN b.quantity ELSE 0 END) AS same_batch,
        COUNT(DISTINCT b.product_id) AS skus
      FROM inventory_balances b JOIN products p ON p.id = b.product_id
      WHERE b.tenant_id = ${tenantId} AND b.warehouse_id = ${warehouseId} AND b.quantity > 0 GROUP BY b.location_id
    )
    SELECT l.id, l.code, l.name, l.pick_priority, l.level, l.capacity_units, l.capacity_volume_m3, l.capacity_weight_kg, l.temperature_class,
      z.id::text AS zone_id, z.code AS zone_code, COALESCE(u.units, 0) AS units, COALESCE(u.volume, 0) AS volume, COALESCE(u.weight, 0) AS weight,
      COALESCE(u.same_product, 0) AS same_product, COALESCE(u.same_batch, 0) AS same_batch, COALESCE(u.skus, 0) AS skus
    FROM locations l
    -- Location codes are hierarchical (zone-aisle-rack-shelf-bin), so the zone is the first code segment.
    LEFT JOIN locations z ON z.tenant_id = l.tenant_id AND z.warehouse_id = l.warehouse_id AND z.type = 'zone' AND z.code = split_part(l.code, '-', 1)
    LEFT JOIN usage u ON u.location_id = l.id
    WHERE l.tenant_id = ${tenantId} AND l.warehouse_id = ${warehouseId} AND l.status = 'active' AND l.is_pickable
      AND l.type NOT IN ('dock', 'staging')
      AND NOT EXISTS (SELECT 1 FROM locations c WHERE c.parent_id = l.id)`);

  const candidates: PutawayCandidate[] = [];
  for (const l of list) {
    const reasons: string[] = [];
    if (String(l.temperature_class) !== product.temperature_class) continue;
    const capUnits = num(l.capacity_units), capVol = num(l.capacity_volume_m3), capW = num(l.capacity_weight_kg);
    const freeUnits = capUnits > 0 ? capUnits - num(l.units) : null;
    const freeVol = capVol > 0 ? capVol - num(l.volume) : null;
    const freeW = capW > 0 ? capW - num(l.weight) : null;
    if (freeUnits !== null && freeUnits < quantity) continue;
    if (freeVol !== null && needVolume > 0 && freeVol < needVolume) continue;
    if (freeW !== null && needWeight > 0 && freeW < needWeight) continue;

    let score = 50;
    if (num(l.same_batch) > 0) { score += 40; reasons.push('Consolidates with the same product and batch'); }
    else if (num(l.same_product) > 0) { score += 30; reasons.push('Keeps this product together with existing stock'); }
    else if (num(l.units) === 0) { score += 10; reasons.push('Empty location'); }
    else if (num(l.skus) > 0) { score -= 10; reasons.push('Shared with other products'); }

    if (product.preferred_zone_id && l.zone_id === product.preferred_zone_id) { score += 25; reasons.push(`Preferred zone for ${product.category_name ?? 'this category'}`); }

    const priority = num(l.pick_priority), level = num(l.level);
    if (velocity === 'fast') {
      score += Math.max(0, 30 - priority / 2) - level * 3;
      if (priority <= 20) reasons.push('Fast mover: close to dispatch');
      if (level <= 2) reasons.push('Fast mover: easy-reach level');
    } else if (velocity === 'slow') {
      score += Math.min(20, priority / 4) + level * 2;
      if (level >= 3) reasons.push('Slow mover: upper level keeps prime slots free');
    }

    const fill = capUnits > 0 ? (num(l.units) + quantity) / capUnits : capVol > 0 && needVolume > 0 ? (num(l.volume) + needVolume) / capVol : null;
    if (fill !== null && fill > 0.6 && fill <= 1) { score += 8; reasons.push(`Good fit: ${Math.round(fill * 100)}% full after putaway`); }
    if (!reasons.length) reasons.push('Has enough free capacity');

    candidates.push({
      locationId: String(l.id), code: String(l.code), name: String(l.name), zoneCode: (l.zone_code as string) ?? null, path: String(l.code),
      score: Math.round(score), reasons, freeUnits, freeVolumeM3: freeVol === null ? null : Math.round(freeVol * 1000) / 1000,
    });
  }
  candidates.sort((a, b) => b.score - a.score || a.code.localeCompare(b.code));
  return { velocity, candidates: candidates.slice(0, limit) };
}
