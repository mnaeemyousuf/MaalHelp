import { boolean, date, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, qty, ts } from './_common';
import { tenants } from './platform';
import { users } from './identity';

/** Append-only. UPDATE/DELETE blocked by trigger. */
export const auditLogs = pgTable('audit_logs', {
  id: pk(),
  tenantId: uuid().references(() => tenants.id, { onDelete: 'cascade' }),
  userId: uuid().references(() => users.id, { onDelete: 'set null' }),
  userEmail: text().notNull().default(''),
  action: text().notNull(),
  entityType: text().notNull(),
  entityId: text().notNull().default(''),
  oldValue: jsonb(),
  newValue: jsonb(),
  ip: text().notNull().default(''),
  device: text().notNull().default(''),
  createdAt: createdAt(),
}, (t) => [
  index().on(t.tenantId, t.createdAt),
  index().on(t.tenantId, t.entityType, t.entityId),
  index().on(t.tenantId, t.userId),
  index().on(t.tenantId, t.action),
]);

export const notifications = pgTable('notifications', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  userId: uuid().references(() => users.id, { onDelete: 'cascade' }), // null = all permitted users
  severity: text().notNull().default('info'), // critical | warning | info
  category: text().notNull(), // low_stock | expiry | capacity | ...
  title: text().notNull(),
  body: text().notNull().default(''),
  entityType: text(),
  entityId: text(),
  actionUrl: text(),
  /** Permission required to see this alert (e.g. finance.view for overdue payments). */
  permission: text().notNull().default('alert.view'),
  dedupeKey: text(),
  resolvedAt: ts(),
  createdAt: createdAt(),
}, (t) => [
  index().on(t.tenantId, t.createdAt),
  index().on(t.tenantId, t.severity),
  uniqueIndex().on(t.tenantId, t.dedupeKey),
]);

export const notificationReads = pgTable('notification_reads', {
  id: pk(),
  notificationId: uuid().notNull().references(() => notifications.id, { onDelete: 'cascade' }),
  userId: uuid().notNull().references(() => users.id, { onDelete: 'cascade' }),
  readAt: createdAt(),
}, (t) => [uniqueIndex().on(t.notificationId, t.userId)]);

export const notificationDeliveries = pgTable('notification_deliveries', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  notificationId: uuid().references(() => notifications.id, { onDelete: 'cascade' }),
  channel: text().notNull(), // email | whatsapp | push
  recipient: text().notNull(),
  status: text().notNull().default('queued'), // queued | sent | failed
  error: text(),
  sentAt: ts(),
  createdAt: createdAt(),
}, (t) => [index().on(t.tenantId, t.createdAt)]);

export const aiConversations = pgTable('ai_conversations', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  userId: uuid().notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text().notNull().default('New conversation'),
  createdAt: createdAt(),
  updatedAt: createdAt(),
}, (t) => [index().on(t.tenantId, t.userId, t.updatedAt)]);

export const aiMessages = pgTable('ai_messages', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  conversationId: uuid().notNull().references(() => aiConversations.id, { onDelete: 'cascade' }),
  role: text().notNull(), // user | assistant
  content: text().notNull(),
  toolCalls: jsonb().$type<{ name: string; args: unknown }[]>().notNull().default([]),
  data: jsonb(), // structured tool results backing the answer
  proposedActions: jsonb().$type<unknown[]>().notNull().default([]),
  mode: text().notNull().default('grounded'), // mistral | grounded
  createdAt: createdAt(),
}, (t) => [index().on(t.conversationId, t.createdAt)]);

export const aiUsage = pgTable('ai_usage', {
  id: pk(),
  tenantId: uuid().references(() => tenants.id, { onDelete: 'cascade' }),
  userId: uuid().references(() => users.id, { onDelete: 'set null' }),
  feature: text().notNull(), // copilot | briefing | document | report | anomaly
  model: text().notNull().default(''),
  promptTokens: integer().notNull().default(0),
  completionTokens: integer().notNull().default(0),
  totalTokens: integer().notNull().default(0),
  costUsd: qty().notNull().default(0),
  latencyMs: integer().notNull().default(0),
  status: text().notNull().default('ok'), // ok | error | fallback
  error: text(),
  createdAt: createdAt(),
}, (t) => [index().on(t.tenantId, t.createdAt), index().on(t.feature)]);

export const aiBriefings = pgTable('ai_briefings', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  briefingDate: date({ mode: 'string' }).notNull(),
  headline: text().notNull(),
  content: text().notNull(),
  items: jsonb().$type<unknown[]>().notNull().default([]),
  facts: jsonb().notNull().default({}),
  generatedBy: text().notNull().default('rules'), // mistral | rules
  createdAt: createdAt(),
}, (t) => [uniqueIndex().on(t.tenantId, t.briefingDate)]);

export const anomalies = pgTable('anomalies', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  type: text().notNull(),
  severity: text().notNull().default('warning'),
  title: text().notNull(),
  description: text().notNull(),
  entityType: text(),
  entityId: text(),
  metrics: jsonb().notNull().default({}),
  status: text().notNull().default('open'), // open | reviewed | dismissed
  reviewedBy: uuid().references(() => users.id),
  reviewNote: text(),
  reviewedAt: ts(),
  dedupeKey: text().notNull(),
  detectedAt: createdAt(),
}, (t) => [uniqueIndex().on(t.tenantId, t.dedupeKey), index().on(t.tenantId, t.status)]);

export const documents = pgTable('documents', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  fileName: text().notNull(),
  mimeType: text().notNull(),
  sizeBytes: integer().notNull(),
  storageKey: text().notNull(),
  sha256: text().notNull(),
  docType: text().notNull().default('purchase_invoice'),
  status: text().notNull().default('uploaded'), // uploaded | processing | extracted | failed | confirmed | rejected
  error: text(),
  uploadedBy: uuid().references(() => users.id),
  createdAt: createdAt(),
}, (t) => [index().on(t.tenantId, t.createdAt)]);

export interface ExtractedDocument {
  supplierName?: string | null;
  invoiceNumber?: string | null;
  date?: string | null;
  currency?: string | null;
  lines: { sku?: string | null; description?: string | null; quantity?: number | null; unitPrice?: number | null; tax?: number | null; total?: number | null; batch?: string | null; expiry?: string | null; matchedProductId?: string | null }[];
  subtotal?: number | null;
  tax?: number | null;
  total?: number | null;
}

export const documentExtractions = pgTable('document_extractions', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  documentId: uuid().notNull().references(() => documents.id, { onDelete: 'cascade' }),
  model: text().notNull().default(''),
  rawText: text().notNull().default(''),
  extracted: jsonb().$type<ExtractedDocument>().notNull(),
  matchedSupplierId: uuid(),
  status: text().notNull().default('pending_review'), // pending_review | approved | rejected
  reviewedBy: uuid().references(() => users.id),
  reviewedAt: ts(),
  createdEntityType: text(),
  createdEntityId: uuid(),
  createdAt: createdAt(),
}, (t) => [index().on(t.documentId)]);

export const integrations = pgTable('integrations', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  provider: text().notNull(),
  category: text().notNull(), // accounting | ecommerce | shipping | messaging
  status: text().notNull().default('disconnected'), // connected | disconnected | error
  config: jsonb().notNull().default({}),
  credentialsEncrypted: text(),
  lastSyncAt: ts(),
  lastError: text(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex().on(t.tenantId, t.provider)]);

export const webhooks = pgTable('webhooks', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  url: text().notNull(),
  events: text().array().notNull().default([]),
  secretEncrypted: text().notNull(),
  description: text().notNull().default(''),
  active: boolean().notNull().default(true),
  createdAt: createdAt(),
}, (t) => [index().on(t.tenantId)]);

export const webhookDeliveries = pgTable('webhook_deliveries', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  webhookId: uuid().notNull().references(() => webhooks.id, { onDelete: 'cascade' }),
  event: text().notNull(),
  payload: jsonb().notNull(),
  status: text().notNull().default('pending'), // pending | delivered | failed
  responseCode: integer(),
  attempts: integer().notNull().default(0),
  lastError: text(),
  deliveredAt: ts(),
  createdAt: createdAt(),
}, (t) => [index().on(t.webhookId, t.createdAt)]);

/** Postgres-backed job queue (FOR UPDATE SKIP LOCKED). */
export const jobs = pgTable('jobs', {
  id: pk(),
  tenantId: uuid().references(() => tenants.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  payload: jsonb().notNull().default({}),
  status: text().notNull().default('queued'), // queued | running | completed | failed
  attempts: integer().notNull().default(0),
  maxAttempts: integer().notNull().default(3),
  runAt: ts().notNull().defaultNow(),
  lockedAt: ts(),
  lockedBy: text(),
  lastError: text(),
  result: jsonb(),
  completedAt: ts(),
  dedupeKey: text().unique(),
  createdAt: createdAt(),
}, (t) => [index().on(t.status, t.runAt), index().on(t.name)]);

export const importJobs = pgTable('import_jobs', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  entity: text().notNull(),
  fileName: text().notNull(),
  status: text().notNull().default('preview'), // preview | committed | failed
  totalRows: integer().notNull().default(0),
  validRows: integer().notNull().default(0),
  invalidRows: integer().notNull().default(0),
  rows: jsonb().$type<{ row: number; data: Record<string, unknown>; errors: string[] }[]>().notNull().default([]),
  createdBy: uuid().references(() => users.id),
  committedAt: ts(),
  createdAt: createdAt(),
}, (t) => [index().on(t.tenantId, t.createdAt)]);
