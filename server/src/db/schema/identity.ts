import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, ts } from './_common';
import { tenants } from './platform';

export const users = pgTable('users', {
  id: pk(),
  email: text().notNull().unique(),
  name: text().notNull(),
  phone: text().notNull().default(''),
  passwordHash: text().notNull(),
  isPlatformAdmin: boolean().notNull().default(false),
  status: text().notNull().default('active'), // active | disabled
  failedLogins: integer().notNull().default(0),
  lockedUntil: ts(),
  lastLoginAt: ts(),
  createdAt: createdAt(),
});

export const roles = pgTable('roles', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  key: text().notNull(),
  name: text().notNull(),
  description: text().notNull().default(''),
  permissions: text().array().notNull().default([]),
  isSystem: boolean().notNull().default(false),
  createdAt: createdAt(),
}, (t) => [uniqueIndex().on(t.tenantId, t.key)]);

export const memberships = pgTable('memberships', {
  id: pk(),
  tenantId: uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  userId: uuid().notNull().references(() => users.id, { onDelete: 'cascade' }),
  roleId: uuid().notNull().references(() => roles.id),
  /** Extra grants on top of the role, e.g. finance.view for a manager. */
  extraPermissions: text().array().notNull().default([]),
  status: text().notNull().default('active'), // active | disabled
  defaultWarehouseId: uuid(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex().on(t.tenantId, t.userId), index().on(t.userId)]);

export const sessions = pgTable('sessions', {
  id: pk(),
  tokenHash: text().notNull().unique(),
  userId: uuid().notNull().references(() => users.id, { onDelete: 'cascade' }),
  tenantId: uuid().references(() => tenants.id, { onDelete: 'cascade' }),
  ip: text().notNull().default(''),
  userAgent: text().notNull().default(''),
  expiresAt: ts().notNull(),
  lastSeenAt: ts(),
  createdAt: createdAt(),
}, (t) => [index().on(t.userId)]);

export const idempotencyKeys = pgTable('idempotency_keys', {
  id: pk(),
  tenantId: uuid().notNull(),
  key: text().notNull(),
  userId: uuid().notNull(),
  method: text().notNull(),
  path: text().notNull(),
  statusCode: integer().notNull(),
  response: jsonb().notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex().on(t.tenantId, t.key)]);
