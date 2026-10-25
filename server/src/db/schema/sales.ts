import { date, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, money, pk, qty, rate, ts } from './_common';
import { tenants } from './platform';
import { users } from './identity';
import { locations, warehouses } from './warehouse';
import { batches, customers, products } from './catalog';
import { stockReservations } from './inventory';

export const salesOrders = pgTable('sales_orders', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  number: text().notNull(),
  customerId: uuid().notNull().references(() => customers.id),
  warehouseId: uuid().notNull().references(() => warehouses.id),
  status: text().notNull().default('draft'),
  priority: text().notNull().default('normal'),
  orderDate: date({ mode: 'string' }).notNull(),
  requiredDate: date({ mode: 'string' }),
  currency: text().notNull().default('PKR'),
  subtotal: money().notNull().default(0),
  discountTotal: money().notNull().default(0),
  taxTotal: money().notNull().default(0),
  total: money().notNull().default(0),
  costTotal: money().notNull().default(0),
  shippingAddress: text().notNull().default(''),
  notes: text().notNull().default(''),
  allowPartial: integer().notNull().default(1),
  packageCount: integer().notNull().default(0),
  totalWeightKg: qty().notNull().default(0),
  createdBy: uuid().references(() => users.id),
  confirmedAt: ts(),
  reservedAt: ts(),
  packedAt: ts(),
  dispatchedAt: ts(),
  deliveredAt: ts(),
  completedAt: ts(),
  cancelledAt: ts(),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex().on(t.tenantId, t.number),
  index().on(t.tenantId, t.status),
  index().on(t.tenantId, t.customerId),
  index().on(t.tenantId, t.createdAt),
]);

export const salesOrderLines = pgTable('sales_order_lines', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  salesOrderId: uuid().notNull().references(() => salesOrders.id, { onDelete: 'cascade' }),
  productId: uuid().notNull().references(() => products.id),
  quantity: qty().notNull(),
  unitPrice: money().notNull(),
  discountPct: rate().notNull().default(0),
  taxRate: rate().notNull().default(0),
  taxAmount: money().notNull().default(0),
  lineTotal: money().notNull().default(0),
  reservedQty: qty().notNull().default(0),
  pickedQty: qty().notNull().default(0),
  packedQty: qty().notNull().default(0),
  shippedQty: qty().notNull().default(0),
  unitCost: money().notNull().default(0),
}, (t) => [index().on(t.salesOrderId)]);

export const pickWaves = pgTable('pick_waves', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  number: text().notNull(),
  warehouseId: uuid().notNull().references(() => warehouses.id),
  type: text().notNull().default('batch'), // batch | zone
  status: text().notNull().default('open'), // open | completed
  assignedTo: uuid().references(() => users.id),
  createdBy: uuid().references(() => users.id),
  createdAt: createdAt(),
}, (t) => [uniqueIndex().on(t.tenantId, t.number)]);

export const pickTasks = pgTable('pick_tasks', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  number: text().notNull(),
  salesOrderId: uuid().notNull().references(() => salesOrders.id, { onDelete: 'cascade' }),
  salesOrderLineId: uuid().notNull().references(() => salesOrderLines.id, { onDelete: 'cascade' }),
  reservationId: uuid().references(() => stockReservations.id),
  warehouseId: uuid().notNull().references(() => warehouses.id),
  zoneId: uuid().references(() => locations.id),
  locationId: uuid().notNull().references(() => locations.id),
  productId: uuid().notNull().references(() => products.id),
  batchId: uuid().references(() => batches.id),
  quantity: qty().notNull(),
  pickedQty: qty().notNull().default(0),
  status: text().notNull().default('pending'), // pending | in_progress | completed | short | cancelled
  priority: text().notNull().default('normal'),
  waveId: uuid().references(() => pickWaves.id),
  assignedTo: uuid().references(() => users.id),
  pickedBy: uuid().references(() => users.id),
  pickedAt: ts(),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex().on(t.tenantId, t.number),
  index().on(t.tenantId, t.status),
  index().on(t.tenantId, t.salesOrderId),
  index().on(t.tenantId, t.assignedTo),
]);

export const packages = pgTable('packages', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  salesOrderId: uuid().notNull().references(() => salesOrders.id, { onDelete: 'cascade' }),
  shipmentId: uuid(),
  packageNo: integer().notNull(),
  barcode: text().notNull(),
  weightKg: qty().notNull().default(0),
  lengthCm: qty().notNull().default(0),
  widthCm: qty().notNull().default(0),
  heightCm: qty().notNull().default(0),
  items: jsonb().$type<{ productId: string; quantity: number }[]>().notNull().default([]),
  packedBy: uuid().references(() => users.id),
  createdAt: createdAt(),
}, (t) => [index().on(t.salesOrderId), uniqueIndex().on(t.tenantId, t.barcode)]);

export const shipments = pgTable('shipments', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  number: text().notNull(),
  salesOrderId: uuid().notNull().references(() => salesOrders.id),
  warehouseId: uuid().notNull().references(() => warehouses.id),
  carrier: text().notNull().default(''),
  service: text().notNull().default(''),
  trackingNumber: text().notNull().default(''),
  vehicleNo: text().notNull().default(''),
  driverName: text().notNull().default(''),
  driverPhone: text().notNull().default(''),
  destination: text().notNull().default(''),
  packageCount: integer().notNull().default(1),
  totalWeightKg: qty().notNull().default(0),
  freightCost: money().notNull().default(0),
  status: text().notNull().default('ready'),
  dispatchedAt: ts(),
  deliveredAt: ts(),
  createdBy: uuid().references(() => users.id),
  createdAt: createdAt(),
}, (t) => [uniqueIndex().on(t.tenantId, t.number), index().on(t.tenantId, t.status), index().on(t.tenantId, t.trackingNumber)]);

export const shipmentEvents = pgTable('shipment_events', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  shipmentId: uuid().notNull().references(() => shipments.id, { onDelete: 'cascade' }),
  status: text().notNull(),
  note: text().notNull().default(''),
  location: text().notNull().default(''),
  createdBy: uuid().references(() => users.id),
  createdAt: createdAt(),
}, (t) => [index().on(t.shipmentId)]);

export const customerReturns = pgTable('customer_returns', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  number: text().notNull(),
  salesOrderId: uuid().references(() => salesOrders.id),
  customerId: uuid().notNull().references(() => customers.id),
  warehouseId: uuid().notNull().references(() => warehouses.id),
  status: text().notNull().default('completed'), // pending | completed
  reason: text().notNull(),
  notes: text().notNull().default(''),
  creditTotal: money().notNull().default(0),
  createdBy: uuid().references(() => users.id),
  receivedAt: ts(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex().on(t.tenantId, t.number), index().on(t.tenantId, t.customerId)]);

export const customerReturnLines = pgTable('customer_return_lines', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  returnId: uuid().notNull().references(() => customerReturns.id, { onDelete: 'cascade' }),
  productId: uuid().notNull().references(() => products.id),
  batchId: uuid().references(() => batches.id),
  locationId: uuid().notNull().references(() => locations.id),
  quantity: qty().notNull(),
  reason: text().notNull(),
  disposition: text().notNull(), // available | damaged | quarantine | repair | write_off
  unitPrice: money().notNull().default(0),
  notes: text().notNull().default(''),
}, (t) => [index().on(t.returnId)]);
