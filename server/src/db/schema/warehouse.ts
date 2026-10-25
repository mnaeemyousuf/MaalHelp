import { type AnyPgColumn, boolean, index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, qty, pk, updatedAt } from './_common';
import { tenants } from './platform';
import { users } from './identity';

export const warehouses = pgTable('warehouses', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  code: text().notNull(),
  name: text().notNull(),
  type: text().notNull().default('owned'),
  address: text().notNull().default(''),
  city: text().notNull().default(''),
  country: text().notNull().default('PK'),
  managerUserId: uuid().references(() => users.id),
  capacity: qty().notNull().default(0),
  capacityUnit: text().notNull().default('pallets'),
  totalAreaSqm: qty().notNull().default(0),
  contactName: text().notNull().default(''),
  contactPhone: text().notNull().default(''),
  contactEmail: text().notNull().default(''),
  operatingHours: text().notNull().default(''),
  /** Map grid size for the visual layout editor. */
  mapCols: integer().notNull().default(24),
  mapRows: integer().notNull().default(16),
  status: text().notNull().default('active'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex().on(t.tenantId, t.code), index().on(t.tenantId, t.status)]);

/**
 * Physical location hierarchy: zone → aisle → rack → shelf → bin, plus
 * operational docks and staging areas. Stock is held at any leaf location.
 */
export const locations = pgTable('locations', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  warehouseId: uuid().notNull().references(() => warehouses.id, { onDelete: 'cascade' }),
  parentId: uuid().references((): AnyPgColumn => locations.id, { onDelete: 'cascade' }),
  type: text().notNull(), // zone | aisle | rack | shelf | bin | dock | staging
  code: text().notNull(), // full path code, e.g. A-03-R12-S04-B08
  name: text().notNull(),
  barcode: text().notNull(),
  capacityUnits: qty().notNull().default(0),
  capacityVolumeM3: qty('capacity_volume_m3').notNull().default(0),
  capacityWeightKg: qty().notNull().default(0),
  palletCapacity: integer().notNull().default(0),
  temperatureClass: text().notNull().default('ambient'),
  isPickable: boolean().notNull().default(true),
  isReceiving: boolean().notNull().default(false),
  isDispatch: boolean().notNull().default(false),
  /** Lower = closer to dispatch. Used by putaway velocity rules. */
  pickPriority: integer().notNull().default(50),
  level: integer().notNull().default(0), // rack level height; higher = less accessible
  mapX: integer(),
  mapY: integer(),
  mapW: integer().notNull().default(2),
  mapH: integer().notNull().default(2),
  status: text().notNull().default('active'), // active | blocked
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex().on(t.tenantId, t.warehouseId, t.code),
  uniqueIndex().on(t.tenantId, t.barcode),
  index().on(t.tenantId, t.warehouseId, t.type),
  index().on(t.parentId),
]);
