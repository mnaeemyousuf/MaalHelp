import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { InventoryStatus, TransactionType } from '@shared/domain';
import { one, num, rows, t, type DbOrTx } from '../../db';
import type { Ctx } from '../../core/context';
import { badRequest, insufficientStock, notFound } from '../../core/errors';

export interface StockKey {
  warehouseId: string;
  locationId: string;
  productId: string;
  batchId?: string | null;
  /** null/undefined = company-owned stock */
  ownerCustomerId?: string | null;
  status?: InventoryStatus;
}

export interface MovementInput extends StockKey {
  /** Signed quantity: positive adds stock, negative removes it. */
  quantity: number;
  type: TransactionType;
  unitCost?: number;
  serialId?: string | null;
  referenceType?: string;
  referenceId?: string | null;
  referenceNo?: string;
  reason?: string;
  correlationId?: string;
}

export interface MovementResult {
  transactionId: string;
  balanceAfter: number;
}

const EPSILON = 1e-6;

async function assertKeyBelongsToTenant(dbx: DbOrTx, tenantId: string, key: StockKey): Promise<{ costPrice: number }> {
  const row = await one<{ cost_price: string; location_ok: boolean; batch_ok: boolean; owner_ok: boolean }>(dbx, sql`
    SELECT p.cost_price,
      EXISTS (SELECT 1 FROM locations l WHERE l.id = ${key.locationId} AND l.tenant_id = ${tenantId} AND l.warehouse_id = ${key.warehouseId}) AS location_ok,
      (${key.batchId ?? null}::uuid IS NULL OR EXISTS (SELECT 1 FROM batches b WHERE b.id = ${key.batchId ?? null}::uuid AND b.tenant_id = ${tenantId} AND b.product_id = p.id)) AS batch_ok,
      (${key.ownerCustomerId ?? null}::uuid IS NULL OR EXISTS (SELECT 1 FROM customers c WHERE c.id = ${key.ownerCustomerId ?? null}::uuid AND c.tenant_id = ${tenantId})) AS owner_ok
    FROM products p WHERE p.id = ${key.productId} AND p.tenant_id = ${tenantId}`);
  if (!row) throw notFound('Product');
  if (!row.location_ok) throw badRequest('Location does not belong to the selected warehouse.');
  if (!row.batch_ok) throw badRequest('Batch does not belong to this product.');
  if (!row.owner_ok) throw notFound('Stock owner');
  return { costPrice: num(row.cost_price) };
}

/**
 * Posts one inventory movement. MUST be called inside a transaction.
 *
 * Removals lock the balance row (SELECT … FOR UPDATE) and verify sufficient
 * quantity before decrementing; additions use an atomic upsert. Either way the
 * immutable ledger row is written in the same transaction, so the balance table
 * always equals the sum of the ledger. A CHECK constraint (quantity >= 0) is the
 * last line of defence against concurrent oversell.
 */
export async function postMovement(tx: DbOrTx, ctx: Ctx, input: MovementInput): Promise<MovementResult> {
  if (!Number.isFinite(input.quantity) || Math.abs(input.quantity) < EPSILON) throw badRequest('Quantity must be non-zero.');
  const status = input.status ?? 'available';
  const batchId = input.batchId ?? null;
  const owner = input.ownerCustomerId ?? null;
  const { costPrice } = await assertKeyBelongsToTenant(tx, ctx.tenantId, input);
  const unitCost = input.unitCost ?? costPrice;

  let balanceAfter: number;
  if (input.quantity < 0) {
    const current = await one<{ id: string; quantity: string }>(tx, sql`
      SELECT id, quantity FROM inventory_balances
      WHERE tenant_id = ${ctx.tenantId} AND warehouse_id = ${input.warehouseId} AND location_id = ${input.locationId}
        AND product_id = ${input.productId} AND status = ${status}
        AND batch_id IS NOT DISTINCT FROM ${batchId}::uuid AND owner_customer_id IS NOT DISTINCT FROM ${owner}::uuid
      FOR UPDATE`);
    const available = num(current?.quantity);
    if (!current || available + input.quantity < -EPSILON) {
      throw insufficientStock(`Insufficient ${status.replace('_', ' ')} stock at this location. Available: ${round(available)}, requested: ${round(-input.quantity)}.`, {
        available: round(available), requested: round(-input.quantity), productId: input.productId, locationId: input.locationId,
      });
    }
    const updated = await one<{ quantity: string }>(tx, sql`
      UPDATE inventory_balances SET quantity = GREATEST(quantity + ${input.quantity}, 0), version = version + 1, updated_at = now()
      WHERE id = ${current.id} RETURNING quantity`);
    balanceAfter = num(updated?.quantity);
  } else {
    const upserted = await one<{ quantity: string }>(tx, sql`
      INSERT INTO inventory_balances (tenant_id, warehouse_id, location_id, product_id, batch_id, owner_customer_id, status, quantity)
      VALUES (${ctx.tenantId}, ${input.warehouseId}, ${input.locationId}, ${input.productId}, ${batchId}::uuid, ${owner}::uuid, ${status}, ${input.quantity})
      ON CONFLICT ON CONSTRAINT inventory_balances_identity_uq
      DO UPDATE SET quantity = inventory_balances.quantity + EXCLUDED.quantity, version = inventory_balances.version + 1, updated_at = now()
      RETURNING quantity`);
    balanceAfter = num(upserted?.quantity);
  }

  const [txn] = await tx.insert(t.inventoryTransactions).values({
    tenantId: ctx.tenantId,
    warehouseId: input.warehouseId,
    locationId: input.locationId,
    productId: input.productId,
    batchId,
    serialId: input.serialId ?? null,
    ownerCustomerId: owner,
    transactionType: input.type,
    status,
    quantity: input.quantity,
    unitCost,
    balanceAfter,
    referenceType: input.referenceType ?? null,
    referenceId: input.referenceId ?? null,
    referenceNo: input.referenceNo ?? null,
    correlationId: input.correlationId ?? null,
    reason: input.reason ?? '',
    performedBy: ctx.userId || null,
  }).returning({ id: t.inventoryTransactions.id });

  return { transactionId: txn!.id, balanceAfter };
}

export interface MoveInput {
  from: StockKey;
  to: StockKey;
  quantity: number;
  outType: TransactionType;
  inType: TransactionType;
  unitCost?: number;
  referenceType?: string;
  referenceId?: string | null;
  referenceNo?: string;
  reason?: string;
}

/** Moves stock between two keys (location, status, warehouse or owner) as a correlated pair. */
export async function moveStock(tx: DbOrTx, ctx: Ctx, input: MoveInput): Promise<{ correlationId: string }> {
  if (!(input.quantity > 0)) throw badRequest('Quantity must be greater than zero.');
  const correlationId = randomUUID();
  const common = { unitCost: input.unitCost, referenceType: input.referenceType, referenceId: input.referenceId, referenceNo: input.referenceNo, reason: input.reason, correlationId };
  await postMovement(tx, ctx, { ...input.from, quantity: -input.quantity, type: input.outType, ...common });
  await postMovement(tx, ctx, { ...input.to, quantity: input.quantity, type: input.inType, ...common });
  return { correlationId };
}

export interface AvailabilityRow {
  locationId: string;
  locationCode: string;
  batchId: string | null;
  expiryDate: string | null;
  quantity: number;
  pickPriority: number;
}

/**
 * Available company-owned (or given owner's) stock for a product in a warehouse,
 * ordered FEFO (first-expiry-first-out) then by pick priority.
 */
export async function availableLocations(dbx: DbOrTx, tenantId: string, productId: string, warehouseId: string, ownerCustomerId: string | null = null, lock = false): Promise<AvailabilityRow[]> {
  const result = await rows<{ location_id: string; code: string; batch_id: string | null; expiry_date: string | null; quantity: string; pick_priority: number }>(dbx, sql`
    SELECT b.location_id, l.code, b.batch_id, bt.expiry_date, b.quantity, l.pick_priority
    FROM inventory_balances b
    JOIN locations l ON l.id = b.location_id
    LEFT JOIN batches bt ON bt.id = b.batch_id
    WHERE b.tenant_id = ${tenantId} AND b.product_id = ${productId} AND b.warehouse_id = ${warehouseId}
      AND b.status = 'available' AND b.quantity > 0 AND l.status = 'active' AND l.is_pickable
      AND b.owner_customer_id IS NOT DISTINCT FROM ${ownerCustomerId}::uuid
      AND (bt.expiry_date IS NULL OR bt.expiry_date >= CURRENT_DATE)
    ORDER BY bt.expiry_date ASC NULLS LAST, l.pick_priority ASC, b.quantity DESC
    ${lock ? sql`FOR UPDATE OF b` : sql``}`);
  return result.map((r) => ({ locationId: r.location_id, locationCode: r.code, batchId: r.batch_id, expiryDate: r.expiry_date, quantity: num(r.quantity), pickPriority: r.pick_priority }));
}

export async function totalAvailable(dbx: DbOrTx, tenantId: string, productId: string, warehouseId?: string | null): Promise<number> {
  const row = await one<{ qty: string }>(dbx, sql`
    SELECT COALESCE(SUM(quantity), 0) AS qty FROM inventory_balances
    WHERE tenant_id = ${tenantId} AND product_id = ${productId} AND status = 'available' AND owner_customer_id IS NULL
    ${warehouseId ? sql`AND warehouse_id = ${warehouseId}` : sql``}`);
  return num(row?.qty);
}

export function round(n: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
