import { date, index, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, money, pk, qty, rate, ts } from './_common';
import { tenants } from './platform';
import { users } from './identity';
import { warehouses } from './warehouse';
import { customers, productCategories, products, suppliers } from './catalog';
import { goodsReceipts, purchaseOrders } from './purchasing';
import { salesOrders } from './sales';

export const invoices = pgTable('invoices', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  number: text().notNull(),
  type: text().notNull().default('sales'), // sales | storage | credit_note
  customerId: uuid().notNull().references(() => customers.id),
  salesOrderId: uuid().references(() => salesOrders.id),
  warehouseId: uuid().references(() => warehouses.id),
  periodStart: date({ mode: 'string' }),
  periodEnd: date({ mode: 'string' }),
  issueDate: date({ mode: 'string' }).notNull(),
  dueDate: date({ mode: 'string' }).notNull(),
  currency: text().notNull().default('PKR'),
  subtotal: money().notNull().default(0),
  taxTotal: money().notNull().default(0),
  total: money().notNull().default(0),
  amountPaid: money().notNull().default(0),
  status: text().notNull().default('issued'), // draft | issued | partially_paid | paid | void
  notes: text().notNull().default(''),
  createdBy: uuid().references(() => users.id),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex().on(t.tenantId, t.number),
  index().on(t.tenantId, t.customerId),
  index().on(t.tenantId, t.status),
  index().on(t.tenantId, t.issueDate),
]);

export const invoiceLines = pgTable('invoice_lines', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  invoiceId: uuid().notNull().references(() => invoices.id, { onDelete: 'cascade' }),
  productId: uuid().references(() => products.id),
  description: text().notNull(),
  quantity: qty().notNull(),
  unitPrice: money().notNull(),
  taxRate: rate().notNull().default(0),
  taxAmount: money().notNull().default(0),
  lineTotal: money().notNull(),
}, (t) => [index().on(t.invoiceId)]);

export const supplierBills = pgTable('supplier_bills', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  number: text().notNull(),
  supplierId: uuid().notNull().references(() => suppliers.id),
  purchaseOrderId: uuid().references(() => purchaseOrders.id),
  receiptId: uuid().references(() => goodsReceipts.id),
  warehouseId: uuid().references(() => warehouses.id),
  supplierInvoiceNo: text().notNull().default(''),
  billDate: date({ mode: 'string' }).notNull(),
  dueDate: date({ mode: 'string' }).notNull(),
  currency: text().notNull().default('PKR'),
  subtotal: money().notNull().default(0),
  taxTotal: money().notNull().default(0),
  total: money().notNull().default(0),
  amountPaid: money().notNull().default(0),
  status: text().notNull().default('open'), // open | partially_paid | paid | void
  createdBy: uuid().references(() => users.id),
  createdAt: createdAt(),
}, (t) => [uniqueIndex().on(t.tenantId, t.number), index().on(t.tenantId, t.supplierId), index().on(t.tenantId, t.status)]);

export const payments = pgTable('payments', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  number: text().notNull(),
  direction: text().notNull(), // in | out
  partyType: text().notNull(), // customer | supplier
  customerId: uuid().references(() => customers.id),
  supplierId: uuid().references(() => suppliers.id),
  invoiceId: uuid().references(() => invoices.id),
  billId: uuid().references(() => supplierBills.id),
  amount: money().notNull(),
  currency: text().notNull().default('PKR'),
  method: text().notNull().default('bank_transfer'),
  bank: text().notNull().default(''),
  reference: text().notNull().default(''),
  paidAt: date({ mode: 'string' }).notNull(),
  notes: text().notNull().default(''),
  createdBy: uuid().references(() => users.id),
  createdAt: createdAt(),
}, (t) => [uniqueIndex().on(t.tenantId, t.number), index().on(t.tenantId, t.paidAt)]);

export const expenses = pgTable('expenses', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  number: text().notNull(),
  warehouseId: uuid().references(() => warehouses.id),
  category: text().notNull(),
  department: text().notNull().default(''),
  costCenter: text().notNull().default(''),
  vendor: text().notNull().default(''),
  amount: money().notNull(),
  taxAmount: money().notNull().default(0),
  currency: text().notNull().default('PKR'),
  expenseDate: date({ mode: 'string' }).notNull(),
  paymentMethod: text().notNull().default('cash'),
  reference: text().notNull().default(''),
  notes: text().notNull().default(''),
  status: text().notNull().default('approved'), // pending_approval | approved | rejected
  approvalRequestId: uuid(),
  approvedBy: uuid().references(() => users.id),
  createdBy: uuid().references(() => users.id),
  createdAt: createdAt(),
}, (t) => [uniqueIndex().on(t.tenantId, t.number), index().on(t.tenantId, t.expenseDate), index().on(t.tenantId, t.warehouseId)]);

export const storageContracts = pgTable('storage_contracts', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  number: text().notNull(),
  customerId: uuid().notNull().references(() => customers.id),
  warehouseId: uuid().references(() => warehouses.id),
  startDate: date({ mode: 'string' }).notNull(),
  endDate: date({ mode: 'string' }),
  billingCycle: text().notNull().default('monthly'),
  currency: text().notNull().default('PKR'),
  minimumMonthlyCharge: money().notNull().default(0),
  status: text().notNull().default('active'),
  notes: text().notNull().default(''),
  createdAt: createdAt(),
}, (t) => [uniqueIndex().on(t.tenantId, t.number), index().on(t.tenantId, t.customerId)]);

export const storageRates = pgTable('storage_rates', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  contractId: uuid().notNull().references(() => storageContracts.id, { onDelete: 'cascade' }),
  chargeType: text().notNull(), // storage | inbound_handling | outbound_handling | picking | ...
  basis: text().notNull(), // pallet_day | cbm_day | per_transaction | ...
  rate: money().notNull(),
  /** For area / fixed bases (sqm_month, sqft_month, fixed_month): the contracted quantity. */
  contractedQty: qty().notNull().default(0),
  productCategoryId: uuid().references(() => productCategories.id),
  description: text().notNull().default(''),
  createdAt: createdAt(),
}, (t) => [index().on(t.contractId)]);

export const storageCharges = pgTable('storage_charges', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  contractId: uuid().notNull().references(() => storageContracts.id),
  customerId: uuid().notNull().references(() => customers.id),
  rateId: uuid().references(() => storageRates.id),
  periodStart: date({ mode: 'string' }).notNull(),
  periodEnd: date({ mode: 'string' }).notNull(),
  chargeType: text().notNull(),
  basis: text().notNull(),
  quantity: qty().notNull(),
  days: qty().notNull().default(0),
  rate: money().notNull(),
  amount: money().notNull(),
  description: text().notNull().default(''),
  invoiceId: uuid().references(() => invoices.id),
  source: jsonb().notNull().default({}),
  createdAt: createdAt(),
}, (t) => [index().on(t.tenantId, t.customerId, t.periodStart)]);

export const exchangeRates = pgTable('exchange_rates', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  currency: text().notNull(),
  rateToBase: rate().notNull(),
  effectiveDate: date({ mode: 'string' }).notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex().on(t.tenantId, t.currency, t.effectiveDate)]);

export const approvalRules = pgTable('approval_rules', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  entityType: text().notNull(), // stock_adjustment | purchase_order | stock_count | expense | transfer
  metric: text().notNull().default('value'), // value | quantity
  threshold: money().notNull(),
  approverRoleKey: text().notNull(),
  description: text().notNull().default(''),
  active: text().notNull().default('true'),
  createdAt: createdAt(),
}, (t) => [index().on(t.tenantId, t.entityType)]);

export const approvalRequests = pgTable('approval_requests', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  entityType: text().notNull(),
  entityId: uuid().notNull(),
  entityNumber: text().notNull().default(''),
  ruleId: uuid().references(() => approvalRules.id),
  approverRoleKey: text().notNull(),
  amount: money().notNull().default(0),
  summary: text().notNull().default(''),
  status: text().notNull().default('pending'), // pending | approved | rejected | cancelled
  requestedBy: uuid().references(() => users.id),
  decidedBy: uuid().references(() => users.id),
  decidedAt: ts(),
  comment: text().notNull().default(''),
  createdAt: createdAt(),
}, (t) => [index().on(t.tenantId, t.status), index().on(t.tenantId, t.entityType, t.entityId)]);
