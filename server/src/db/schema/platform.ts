import { boolean, index, integer, jsonb, pgTable, text, unique, uniqueIndex, uuid, date } from 'drizzle-orm/pg-core';
import { createdAt, money, pk, ts, updatedAt } from './_common';

export interface PlanLimits {
  users: number;
  warehouses: number;
  skus: number;
  monthlyTransactions: number;
  monthlyAiRequests: number;
  storageMb: number;
  integrations: number;
}

export const plans = pgTable('plans', {
  id: pk(),
  code: text().notNull().unique(),
  name: text().notNull(),
  description: text().notNull().default(''),
  priceMonthly: money().notNull().default(0),
  currency: text().notNull().default('PKR'),
  limits: jsonb().$type<PlanLimits>().notNull(),
  features: jsonb().$type<string[]>().notNull().default([]),
  sortOrder: integer().notNull().default(0),
  active: boolean().notNull().default(true),
  createdAt: createdAt(),
});

export interface TenantSettings {
  inventory?: { allowNegativeStock?: boolean; defaultCountTolerancePct?: number; expiryAlertDays?: number; deadStockDays?: number; valuationMethod?: 'average' | 'fifo' };
  notifications?: { email?: boolean; whatsapp?: boolean; push?: boolean; dailyBriefing?: boolean; recipients?: string[] };
  ai?: { enabled?: boolean; dailyBriefing?: boolean; anomalyDetection?: boolean; documentExtraction?: boolean; autoReorderDrafts?: boolean };
  barcode?: { internalPrefix?: string; defaultSymbology?: string; labelSize?: string };
  printing?: { paperSize?: 'A4' | 'Letter'; labelWidthMm?: number; labelHeightMm?: number; showLogo?: boolean };
  billing?: { invoicePrefix?: string; paymentTermsDays?: number; storageBillingDay?: number };
  security?: { sessionHours?: number; minPasswordLength?: number; requireStrongPasswords?: boolean };
  units?: string[];
}

export const tenants = pgTable('tenants', {
  id: pk(),
  name: text().notNull(),
  slug: text().notNull().unique(),
  legalName: text().notNull().default(''),
  email: text().notNull().default(''),
  phone: text().notNull().default(''),
  address: text().notNull().default(''),
  city: text().notNull().default(''),
  country: text().notNull().default('PK'),
  ntn: text().notNull().default(''),
  strn: text().notNull().default(''),
  baseCurrency: text().notNull().default('PKR'),
  timezone: text().notNull().default('Asia/Karachi'),
  taxInclusivePricing: boolean().notNull().default(false),
  logoUrl: text(),
  settings: jsonb().$type<TenantSettings>().notNull().default({}),
  status: text().notNull().default('active'), // active | trial | suspended
  planId: uuid().references(() => plans.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const subscriptions = pgTable('subscriptions', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  planId: uuid().notNull().references(() => plans.id),
  status: text().notNull().default('trialing'), // trialing | active | past_due | cancelled
  currentPeriodStart: date({ mode: 'string' }).notNull(),
  currentPeriodEnd: date({ mode: 'string' }).notNull(),
  provider: text().notNull().default('manual'),
  providerRef: text(),
  createdAt: createdAt(),
}, (t) => [index().on(t.tenantId)]);

export const featureFlags = pgTable('feature_flags', {
  id: pk(),
  key: text().notNull().unique(),
  description: text().notNull().default(''),
  enabled: boolean().notNull().default(false),
  tenantOverrides: jsonb().$type<Record<string, boolean>>().notNull().default({}),
  createdAt: createdAt(),
});

export const systemSettings = pgTable('system_settings', {
  id: pk(),
  key: text().notNull(),
  tenantId: uuid().references(() => tenants.id, { onDelete: 'cascade' }),
  value: jsonb().notNull(),
  updatedAt: updatedAt(),
}, (t) => [unique('system_settings_tenant_key_uq').on(t.tenantId, t.key).nullsNotDistinct()]);

export const supportTickets = pgTable('support_tickets', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  subject: text().notNull(),
  body: text().notNull(),
  status: text().notNull().default('open'), // open | in_progress | resolved
  priority: text().notNull().default('normal'),
  createdBy: uuid(),
  resolvedAt: ts(),
  createdAt: createdAt(),
}, (t) => [index().on(t.tenantId), index().on(t.status)]);

export const numberSequences = pgTable('number_sequences', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  key: text().notNull(),
  nextValue: integer().notNull().default(1),
}, (t) => [uniqueIndex().on(t.tenantId, t.key)]);
