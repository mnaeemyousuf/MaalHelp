import { date, index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, money, pk, qty, rate, ts } from './_common';
import { tenants } from './platform';
import { users } from './identity';
import { locations, warehouses } from './warehouse';
import { batches, customers, products, suppliers } from './catalog';

export const purchaseOrders = pgTable('purchase_orders', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  number: text().notNull(),
  supplierId: uuid().notNull().references(() => suppliers.id),
  warehouseId: uuid().notNull().references(() => warehouses.id),
  status: text().notNull().default('draft'),
  orderDate: date({ mode: 'string' }).notNull(),
  expectedDate: date({ mode: 'string' }),
  currency: text().notNull().default('PKR'),
  subtotal: money().notNull().default(0),
  discountTotal: money().notNull().default(0),
  taxTotal: money().notNull().default(0),
  total: money().notNull().default(0),
  notes: text().notNull().default(''),
  source: text().notNull().default('manual'), // manual | ai_reorder | document | import
  createdBy: uuid().references(() => users.id),
  approvedBy: uuid().references(() => users.id),
  approvalRequestId: uuid(),
  submittedAt: ts(),
  approvedAt: ts(),
  closedAt: ts(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex().on(t.tenantId, t.number), index().on(t.tenantId, t.status), index().on(t.tenantId, t.supplierId), index().on(t.tenantId, t.createdAt)]);

export const purchaseOrderLines = pgTable('purchase_order_lines', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  purchaseOrderId: uuid().notNull().references(() => purchaseOrders.id, { onDelete: 'cascade' }),
  productId: uuid().notNull().references(() => products.id),
  quantity: qty().notNull(),
  unitCost: money().notNull(),
  discountPct: rate().notNull().default(0),
  taxRate: rate().notNull().default(0),
  taxAmount: money().notNull().default(0),
  lineTotal: money().notNull().default(0),
  receivedQty: qty().notNull().default(0),
  damagedQty: qty().notNull().default(0),
}, (t) => [index().on(t.purchaseOrderId)]);

export const goodsReceipts = pgTable('goods_receipts', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  number: text().notNull(),
  purchaseOrderId: uuid().references(() => purchaseOrders.id),
  supplierId: uuid().references(() => suppliers.id),
  warehouseId: uuid().notNull().references(() => warehouses.id),
  ownerCustomerId: uuid().references(() => customers.id),
  status: text().notNull().default('completed'),
  deliveryNoteNo: text().notNull().default(''),
  vehicleNo: text().notNull().default(''),
  notes: text().notNull().default(''),
  totalValue: money().notNull().default(0),
  receivedBy: uuid().references(() => users.id),
  receivedAt: ts().notNull().defaultNow(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex().on(t.tenantId, t.number), index().on(t.tenantId, t.purchaseOrderId), index().on(t.tenantId, t.createdAt)]);

export const goodsReceiptLines = pgTable('goods_receipt_lines', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  receiptId: uuid().notNull().references(() => goodsReceipts.id, { onDelete: 'cascade' }),
  purchaseOrderLineId: uuid().references(() => purchaseOrderLines.id),
  productId: uuid().notNull().references(() => products.id),
  batchId: uuid().references(() => batches.id),
  locationId: uuid().notNull().references(() => locations.id),
  expectedQty: qty().notNull().default(0),
  receivedQty: qty().notNull(),
  acceptedQty: qty().notNull(),
  damagedQty: qty().notNull().default(0),
  quarantineQty: qty().notNull().default(0),
  unitCost: money().notNull().default(0),
  varianceType: text().notNull().default('exact'), // exact | short | over | unplanned
  qcStatus: text().notNull().default('passed'), // passed | failed | pending
  serials: text().array().notNull().default([]),
  notes: text().notNull().default(''),
}, (t) => [index().on(t.receiptId)]);

export const putawayTasks = pgTable('putaway_tasks', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  number: text().notNull(),
  receiptId: uuid().references(() => goodsReceipts.id),
  receiptLineId: uuid().references(() => goodsReceiptLines.id),
  warehouseId: uuid().notNull().references(() => warehouses.id),
  productId: uuid().notNull().references(() => products.id),
  batchId: uuid().references(() => batches.id),
  ownerCustomerId: uuid().references(() => customers.id),
  inventoryStatus: text().notNull().default('available'),
  fromLocationId: uuid().notNull().references(() => locations.id),
  suggestedLocationId: uuid().references(() => locations.id),
  actualLocationId: uuid().references(() => locations.id),
  quantity: qty().notNull(),
  status: text().notNull().default('pending'), // pending | completed | cancelled
  suggestionReason: text().notNull().default(''),
  overrideReason: text(),
  assignedTo: uuid().references(() => users.id),
  completedBy: uuid().references(() => users.id),
  completedAt: ts(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex().on(t.tenantId, t.number), index().on(t.tenantId, t.status), index().on(t.tenantId, t.warehouseId)]);

export const purchaseReturns = pgTable('purchase_returns', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  number: text().notNull(),
  supplierId: uuid().notNull().references(() => suppliers.id),
  purchaseOrderId: uuid().references(() => purchaseOrders.id),
  warehouseId: uuid().notNull().references(() => warehouses.id),
  status: text().notNull().default('completed'),
  reason: text().notNull(),
  total: money().notNull().default(0),
  createdBy: uuid().references(() => users.id),
  createdAt: createdAt(),
}, (t) => [uniqueIndex().on(t.tenantId, t.number)]);

export const purchaseReturnLines = pgTable('purchase_return_lines', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  purchaseReturnId: uuid().notNull().references(() => purchaseReturns.id, { onDelete: 'cascade' }),
  productId: uuid().notNull().references(() => products.id),
  batchId: uuid().references(() => batches.id),
  locationId: uuid().notNull().references(() => locations.id),
  quantity: qty().notNull(),
  unitCost: money().notNull().default(0),
}, (t) => [index().on(t.purchaseReturnId)]);
