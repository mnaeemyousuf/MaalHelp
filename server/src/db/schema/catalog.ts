import { type AnyPgColumn, boolean, date, index, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, money, pk, qty, rate, updatedAt } from './_common';
import { tenants } from './platform';
import { locations, warehouses } from './warehouse';

export const taxRates = pgTable('tax_rates', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  code: text().notNull(),
  name: text().notNull(),
  rate: rate().notNull().default(0),
  type: text().notNull().default('sales_tax'), // sales_tax | gst | vat | withholding | none
  appliesTo: text().notNull().default('both'), // sales | purchase | both
  isDefault: boolean().notNull().default(false),
  active: boolean().notNull().default(true),
  createdAt: createdAt(),
}, (t) => [uniqueIndex().on(t.tenantId, t.code)]);

export const productCategories = pgTable('product_categories', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  parentId: uuid().references((): AnyPgColumn => productCategories.id),
  /** Putaway rule: preferred zone for this category. */
  preferredZoneId: uuid().references(() => locations.id, { onDelete: 'set null' }),
  temperatureClass: text().notNull().default('ambient'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex().on(t.tenantId, t.name)]);

export const suppliers = pgTable('suppliers', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  code: text().notNull(),
  name: text().notNull(),
  contactName: text().notNull().default(''),
  phone: text().notNull().default(''),
  email: text().notNull().default(''),
  address: text().notNull().default(''),
  city: text().notNull().default(''),
  country: text().notNull().default('PK'),
  ntn: text().notNull().default(''),
  strn: text().notNull().default(''),
  paymentTermsDays: qty().notNull().default(30),
  leadTimeDays: qty().notNull().default(7),
  currency: text().notNull().default('PKR'),
  status: text().notNull().default('active'),
  notes: text().notNull().default(''),
  createdAt: createdAt(),
}, (t) => [uniqueIndex().on(t.tenantId, t.code), index().on(t.tenantId, t.name)]);

export const customers = pgTable('customers', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  code: text().notNull(),
  name: text().notNull(),
  contactName: text().notNull().default(''),
  phone: text().notNull().default(''),
  email: text().notNull().default(''),
  address: text().notNull().default(''),
  city: text().notNull().default(''),
  country: text().notNull().default('PK'),
  ntn: text().notNull().default(''),
  strn: text().notNull().default(''),
  creditLimit: money().notNull().default(0),
  paymentTermsDays: qty().notNull().default(30),
  taxExempt: boolean().notNull().default(false),
  /** Customer stores its own goods in our warehouse (3PL / consignment). */
  isStorageClient: boolean().notNull().default(false),
  status: text().notNull().default('active'),
  notes: text().notNull().default(''),
  createdAt: createdAt(),
}, (t) => [uniqueIndex().on(t.tenantId, t.code), index().on(t.tenantId, t.name)]);

export const products = pgTable('products', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  sku: text().notNull(),
  name: text().notNull(),
  categoryId: uuid().references(() => productCategories.id, { onDelete: 'set null' }),
  brand: text().notNull().default(''),
  description: text().notNull().default(''),
  barcode: text(),
  altBarcode: text(),
  skuType: text().notNull().default('simple'), // simple | variant | batch | serial | expirable | kit
  parentId: uuid().references((): AnyPgColumn => products.id, { onDelete: 'set null' }),
  variantAttributes: jsonb().$type<Record<string, string>>().notNull().default({}),
  uom: text().notNull().default('pcs'),
  purchaseUom: text().notNull().default('pcs'),
  salesUom: text().notNull().default('pcs'),
  /** Base units per purchase unit (e.g. 12 pcs per carton). */
  conversionFactor: qty().notNull().default(1),
  weightKg: qty().notNull().default(0),
  lengthCm: qty().notNull().default(0),
  widthCm: qty().notNull().default(0),
  heightCm: qty().notNull().default(0),
  volumeM3: qty('volume_m3').notNull().default(0),
  unitsPerPallet: qty().notNull().default(0),
  costPrice: money().notNull().default(0),
  sellingPrice: money().notNull().default(0),
  minStock: qty().notNull().default(0),
  reorderLevel: qty().notNull().default(0),
  reorderQty: qty().notNull().default(0),
  maxStock: qty().notNull().default(0),
  defaultSupplierId: uuid().references(() => suppliers.id, { onDelete: 'set null' }),
  taxRateId: uuid().references(() => taxRates.id, { onDelete: 'set null' }),
  trackBatch: boolean().notNull().default(false),
  trackLot: boolean().notNull().default(false),
  trackSerial: boolean().notNull().default(false),
  trackExpiry: boolean().notNull().default(false),
  temperatureClass: text().notNull().default('ambient'),
  imageUrl: text(),
  status: text().notNull().default('active'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex().on(t.tenantId, t.sku),
  index().on(t.tenantId, t.barcode),
  index().on(t.tenantId, t.categoryId),
  index().on(t.tenantId, t.status),
]);

export const productBarcodes = pgTable('product_barcodes', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  productId: uuid().notNull().references(() => products.id, { onDelete: 'cascade' }),
  barcode: text().notNull(),
  symbology: text().notNull().default('code128'),
  /** Units represented by one scan of this barcode (pack/carton barcodes). */
  unitQty: qty().notNull().default(1),
  isPrimary: boolean().notNull().default(false),
  createdAt: createdAt(),
}, (t) => [uniqueIndex().on(t.tenantId, t.barcode), index().on(t.productId)]);

export const batches = pgTable('batches', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  productId: uuid().notNull().references(() => products.id, { onDelete: 'cascade' }),
  batchNo: text().notNull(),
  lotNo: text().notNull().default(''),
  mfgDate: date({ mode: 'string' }),
  expiryDate: date({ mode: 'string' }),
  supplierId: uuid().references(() => suppliers.id, { onDelete: 'set null' }),
  status: text().notNull().default('active'), // active | expired | recalled
  createdAt: createdAt(),
}, (t) => [uniqueIndex().on(t.tenantId, t.productId, t.batchNo), index().on(t.tenantId, t.expiryDate)]);

export const serialNumbers = pgTable('serial_numbers', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  productId: uuid().notNull().references(() => products.id, { onDelete: 'cascade' }),
  serial: text().notNull(),
  batchId: uuid().references(() => batches.id),
  status: text().notNull().default('in_stock'), // in_stock | reserved | dispatched | returned | scrapped
  warehouseId: uuid().references(() => warehouses.id),
  locationId: uuid().references(() => locations.id),
  ownerCustomerId: uuid().references(() => customers.id),
  referenceType: text(),
  referenceId: uuid(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex().on(t.tenantId, t.productId, t.serial), index().on(t.tenantId, t.serial)]);
