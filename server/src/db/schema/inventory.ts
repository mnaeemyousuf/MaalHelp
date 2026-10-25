import { date, index, integer, jsonb, pgTable, text, unique, uniqueIndex, uuid, boolean } from 'drizzle-orm/pg-core';
import { createdAt, money, pk, qty, ts, updatedAt } from './_common';
import { tenants } from './platform';
import { users } from './identity';
import { locations, warehouses } from './warehouse';
import { batches, customers, products, serialNumbers } from './catalog';

/**
 * Current balance per (warehouse, location, product, batch, owner, status).
 * Maintained exclusively by the inventory ledger service inside the same
 * database transaction that writes the immutable inventory_transactions row.
 * ownerCustomerId NULL = company-owned stock; set = customer-owned/consignment.
 */
export const inventoryBalances = pgTable('inventory_balances', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  warehouseId: uuid().notNull().references(() => warehouses.id),
  locationId: uuid().notNull().references(() => locations.id),
  productId: uuid().notNull().references(() => products.id),
  batchId: uuid().references(() => batches.id),
  ownerCustomerId: uuid().references(() => customers.id),
  status: text().notNull().default('available'),
  quantity: qty().notNull().default(0),
  version: integer().notNull().default(0),
  updatedAt: updatedAt(),
}, (t) => [
  unique('inventory_balances_identity_uq')
    .on(t.tenantId, t.warehouseId, t.locationId, t.productId, t.batchId, t.ownerCustomerId, t.status)
    .nullsNotDistinct(),
  index().on(t.tenantId, t.productId, t.status),
  index().on(t.tenantId, t.warehouseId),
  index().on(t.tenantId, t.locationId),
]);

/** Immutable ledger. UPDATE/DELETE are blocked by a database trigger. */
export const inventoryTransactions = pgTable('inventory_transactions', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  warehouseId: uuid().notNull().references(() => warehouses.id),
  locationId: uuid().notNull().references(() => locations.id),
  productId: uuid().notNull().references(() => products.id),
  batchId: uuid().references(() => batches.id),
  serialId: uuid().references(() => serialNumbers.id),
  ownerCustomerId: uuid().references(() => customers.id),
  transactionType: text().notNull(),
  status: text().notNull().default('available'),
  quantity: qty().notNull(), // signed
  unitCost: money().notNull().default(0),
  balanceAfter: qty().notNull(),
  referenceType: text(),
  referenceId: uuid(),
  referenceNo: text(),
  /** Groups paired movements (e.g. both legs of a transfer or status change). */
  correlationId: uuid(),
  reason: text().notNull().default(''),
  performedBy: uuid().references(() => users.id),
  createdAt: createdAt(),
}, (t) => [
  index().on(t.tenantId, t.createdAt),
  index().on(t.tenantId, t.productId, t.createdAt),
  index().on(t.tenantId, t.warehouseId, t.createdAt),
  index().on(t.tenantId, t.transactionType, t.createdAt),
  index().on(t.tenantId, t.referenceType, t.referenceId),
]);

export const stockReservations = pgTable('stock_reservations', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  salesOrderId: uuid().notNull(),
  salesOrderLineId: uuid().notNull(),
  productId: uuid().notNull().references(() => products.id),
  warehouseId: uuid().notNull().references(() => warehouses.id),
  locationId: uuid().notNull().references(() => locations.id),
  batchId: uuid().references(() => batches.id),
  ownerCustomerId: uuid().references(() => customers.id),
  quantity: qty().notNull(),
  pickedQty: qty().notNull().default(0),
  status: text().notNull().default('active'), // active | picked | released
  createdAt: createdAt(),
}, (t) => [index().on(t.tenantId, t.salesOrderId), index().on(t.tenantId, t.productId, t.status)]);

export const stockAdjustments = pgTable('stock_adjustments', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  number: text().notNull(),
  warehouseId: uuid().notNull().references(() => warehouses.id),
  locationId: uuid().notNull().references(() => locations.id),
  productId: uuid().notNull().references(() => products.id),
  batchId: uuid().references(() => batches.id),
  ownerCustomerId: uuid().references(() => customers.id),
  status: text().notNull().default('pending_approval'), // pending_approval | posted | rejected
  inventoryStatus: text().notNull().default('available'),
  quantityDelta: qty().notNull(),
  unitCost: money().notNull().default(0),
  value: money().notNull().default(0),
  reasonCode: text().notNull(),
  notes: text().notNull().default(''),
  requestedBy: uuid().references(() => users.id),
  approvedBy: uuid().references(() => users.id),
  approvalRequestId: uuid(),
  postedAt: ts(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex().on(t.tenantId, t.number), index().on(t.tenantId, t.status), index().on(t.tenantId, t.createdAt)]);

/** Daily snapshot used by storage billing and trend analytics. */
export const inventorySnapshots = pgTable('inventory_snapshots', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  snapshotDate: date({ mode: 'string' }).notNull(),
  warehouseId: uuid().notNull().references(() => warehouses.id),
  productId: uuid().notNull().references(() => products.id),
  ownerCustomerId: uuid().references(() => customers.id),
  quantity: qty().notNull(),
  value: money().notNull().default(0),
  volumeM3: qty('volume_m3').notNull().default(0),
  weightKg: qty().notNull().default(0),
  pallets: qty().notNull().default(0),
  bins: integer().notNull().default(0),
  createdAt: createdAt(),
}, (t) => [
  unique('inventory_snapshots_identity_uq').on(t.tenantId, t.snapshotDate, t.warehouseId, t.productId, t.ownerCustomerId).nullsNotDistinct(),
  index().on(t.tenantId, t.ownerCustomerId, t.snapshotDate),
]);

export const stockTransfers = pgTable('stock_transfers', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  number: text().notNull(),
  type: text().notNull().default('warehouse'), // warehouse | location
  sourceWarehouseId: uuid().notNull().references(() => warehouses.id),
  destWarehouseId: uuid().notNull().references(() => warehouses.id),
  status: text().notNull().default('draft'),
  priority: text().notNull().default('normal'),
  notes: text().notNull().default(''),
  requestedBy: uuid().references(() => users.id),
  approvedBy: uuid().references(() => users.id),
  pickedBy: uuid().references(() => users.id),
  receivedBy: uuid().references(() => users.id),
  requestedAt: ts(),
  approvedAt: ts(),
  pickedAt: ts(),
  dispatchedAt: ts(),
  receivedAt: ts(),
  completedAt: ts(),
  createdBy: uuid().references(() => users.id),
  createdAt: createdAt(),
}, (t) => [uniqueIndex().on(t.tenantId, t.number), index().on(t.tenantId, t.status)]);

export const stockTransferLines = pgTable('stock_transfer_lines', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  transferId: uuid().notNull().references(() => stockTransfers.id, { onDelete: 'cascade' }),
  productId: uuid().notNull().references(() => products.id),
  batchId: uuid().references(() => batches.id),
  ownerCustomerId: uuid().references(() => customers.id),
  serials: text().array().notNull().default([]),
  sourceLocationId: uuid().notNull().references(() => locations.id),
  destLocationId: uuid().references(() => locations.id),
  quantity: qty().notNull(),
  pickedQty: qty().notNull().default(0),
  receivedQty: qty().notNull().default(0),
}, (t) => [index().on(t.transferId)]);

export const stockCounts = pgTable('stock_counts', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  number: text().notNull(),
  warehouseId: uuid().notNull().references(() => warehouses.id),
  type: text().notNull().default('cycle'), // full | cycle | blind | location | product
  status: text().notNull().default('draft'),
  scope: jsonb().$type<{ locationIds?: string[]; productIds?: string[]; zoneId?: string }>().notNull().default({}),
  assignedTo: uuid().references(() => users.id),
  isBlind: boolean().notNull().default(false),
  notes: text().notNull().default(''),
  varianceQty: qty().notNull().default(0),
  varianceValue: money().notNull().default(0),
  createdBy: uuid().references(() => users.id),
  approvedBy: uuid().references(() => users.id),
  approvalRequestId: uuid(),
  startedAt: ts(),
  submittedAt: ts(),
  approvedAt: ts(),
  postedAt: ts(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex().on(t.tenantId, t.number), index().on(t.tenantId, t.status)]);

export const stockCountLines = pgTable('stock_count_lines', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  countId: uuid().notNull().references(() => stockCounts.id, { onDelete: 'cascade' }),
  locationId: uuid().notNull().references(() => locations.id),
  productId: uuid().notNull().references(() => products.id),
  batchId: uuid().references(() => batches.id),
  ownerCustomerId: uuid().references(() => customers.id),
  expectedQty: qty().notNull().default(0),
  countedQty: qty(),
  varianceQty: qty().notNull().default(0),
  unitCost: money().notNull().default(0),
  varianceValue: money().notNull().default(0),
  countedBy: uuid().references(() => users.id),
  countedAt: ts(),
}, (t) => [index().on(t.countId)]);
