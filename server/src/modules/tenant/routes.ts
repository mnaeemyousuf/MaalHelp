import { z } from 'zod';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { ALL_PERMISSIONS, PERMISSIONS, type Permission } from '@shared/permissions';
import { localizationFor } from '@shared/localization/pk';
import { APPROVAL_ENTITY_TYPES, CURRENCIES } from '@shared/domain';
import { db, one, t } from '../../db';
import { idParam, type Router } from '../../core/http';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors';
import { audit, diff } from '../../core/audit';
import { hashPassword, randomToken } from '../../core/crypto';
import { passwordSchema } from '../auth/routes';
import { assertWithinLimit, usageSummary } from '../platform/limits';
import type { TenantSettings } from '../../db/schema';

const permissionEnum = z.enum(ALL_PERMISSIONS as [Permission, ...Permission[]]);

export function registerCompanyRoutes(r: Router) {
  r.get('/', { summary: 'Company profile and settings' }, async ({ ctx }) => {
    const [tenant] = await db().select().from(t.tenants).where(eq(t.tenants.id, ctx.tenantId)).limit(1);
    const [plan] = tenant?.planId ? await db().select().from(t.plans).where(eq(t.plans.id, tenant.planId)).limit(1) : [];
    return { ...tenant, plan: plan ?? null, localization: localizationFor(tenant?.country), currencies: CURRENCIES };
  });

  r.patch('/', {
    summary: 'Update company profile',
    permission: 'settings.manage',
    body: z.object({
      name: z.string().trim().min(2).max(120).optional(),
      legalName: z.string().trim().max(200).optional(),
      email: z.string().trim().email().or(z.literal('')).optional(),
      phone: z.string().trim().max(40).optional(),
      address: z.string().trim().max(400).optional(),
      city: z.string().trim().max(80).optional(),
      country: z.string().trim().length(2).optional(),
      ntn: z.string().trim().max(40).optional(),
      strn: z.string().trim().max(40).optional(),
      baseCurrency: z.enum(Object.keys(CURRENCIES) as [string, ...string[]]).optional(),
      timezone: z.string().max(60).optional(),
      taxInclusivePricing: z.boolean().optional(),
    }),
  }, async ({ ctx, body }) => {
    const pack = body.country ? localizationFor(body.country) : null;
    if (body.ntn && pack && body.country === 'PK' && !pack.taxIdentifiers[0]!.pattern.test(body.ntn)) throw badRequest(`NTN format looks invalid. Example: ${pack.taxIdentifiers[0]!.example}`);
    const [before] = await db().select().from(t.tenants).where(eq(t.tenants.id, ctx.tenantId)).limit(1);
    const [after] = await db().update(t.tenants).set({ ...body, updatedAt: new Date() }).where(eq(t.tenants.id, ctx.tenantId)).returning();
    await audit(db(), ctx, { action: 'company.updated', entityType: 'tenant', entityId: ctx.tenantId, ...diff(before as Record<string, unknown>, body) });
    return after;
  });

  r.put('/settings/:section', {
    summary: 'Update one settings section (inventory, notifications, ai, barcode, printing, billing, security, units)',
    permission: 'settings.manage',
    params: z.object({ section: z.enum(['inventory', 'notifications', 'ai', 'barcode', 'printing', 'billing', 'security', 'units']) }),
    body: z.object({ value: z.unknown() }),
  }, async ({ ctx, params, body }) => {
    const validators: Record<string, z.ZodType> = {
      inventory: z.object({ allowNegativeStock: z.literal(false).optional(), defaultCountTolerancePct: z.number().min(0).max(100).optional(), expiryAlertDays: z.number().int().min(1).max(365).optional(), deadStockDays: z.number().int().min(15).max(730).optional(), valuationMethod: z.enum(['average', 'fifo']).optional() }),
      notifications: z.object({ email: z.boolean().optional(), whatsapp: z.boolean().optional(), push: z.boolean().optional(), dailyBriefing: z.boolean().optional(), recipients: z.array(z.string().max(120)).max(20).optional() }),
      ai: z.object({ enabled: z.boolean().optional(), dailyBriefing: z.boolean().optional(), anomalyDetection: z.boolean().optional(), documentExtraction: z.boolean().optional(), autoReorderDrafts: z.boolean().optional() }),
      barcode: z.object({ internalPrefix: z.string().regex(/^[A-Z0-9]{1,6}$/).optional(), defaultSymbology: z.enum(['code128', 'qrcode', 'ean13']).optional(), labelSize: z.string().max(20).optional() }),
      printing: z.object({ paperSize: z.enum(['A4', 'Letter']).optional(), labelWidthMm: z.number().min(20).max(150).optional(), labelHeightMm: z.number().min(10).max(150).optional(), showLogo: z.boolean().optional() }),
      billing: z.object({ invoicePrefix: z.string().max(10).optional(), paymentTermsDays: z.number().int().min(0).max(365).optional(), storageBillingDay: z.number().int().min(1).max(28).optional() }),
      security: z.object({ sessionHours: z.number().int().min(1).max(168).optional(), minPasswordLength: z.number().int().min(10).max(64).optional(), requireStrongPasswords: z.boolean().optional() }),
      units: z.array(z.string().trim().min(1).max(20)).min(1).max(60),
    };
    const parsed = validators[params.section]!.safeParse(body.value);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid settings.');
    const [tenant] = await db().select({ settings: t.tenants.settings }).from(t.tenants).where(eq(t.tenants.id, ctx.tenantId)).limit(1);
    const current = (tenant?.settings ?? {}) as TenantSettings & Record<string, unknown>;
    const next = { ...current, [params.section]: Array.isArray(parsed.data) ? parsed.data : { ...(current[params.section] as object), ...(parsed.data as object) } };
    await db().update(t.tenants).set({ settings: next, updatedAt: new Date() }).where(eq(t.tenants.id, ctx.tenantId));
    await audit(db(), ctx, { action: 'settings.updated', entityType: 'settings', entityId: params.section, oldValue: current[params.section], newValue: next[params.section as keyof typeof next] });
    return next;
  });

  r.get('/usage', { summary: 'Plan usage and limits' }, async ({ ctx }) => usageSummary(db(), ctx.tenantId));
}

export function registerUserRoutes(r: Router) {
  r.get('/', { summary: 'List company users', permission: 'user.manage' }, async ({ ctx }) => {
    return db().select({
      id: t.users.id, membershipId: t.memberships.id, name: t.users.name, email: t.users.email, phone: t.users.phone,
      status: t.memberships.status, roleId: t.roles.id, roleKey: t.roles.key, roleName: t.roles.name,
      extraPermissions: t.memberships.extraPermissions, lastLoginAt: t.users.lastLoginAt, createdAt: t.memberships.createdAt,
    }).from(t.memberships)
      .innerJoin(t.users, eq(t.users.id, t.memberships.userId))
      .innerJoin(t.roles, eq(t.roles.id, t.memberships.roleId))
      .where(eq(t.memberships.tenantId, ctx.tenantId))
      .orderBy(asc(t.users.name));
  });

  r.get('/directory', { summary: 'Lightweight user list for assignment pickers', permission: ['task.manage', 'user.manage', 'inventory.count', 'sales.view'] }, async ({ ctx }) => {
    return db().select({ id: t.users.id, name: t.users.name, roleKey: t.roles.key, roleName: t.roles.name })
      .from(t.memberships).innerJoin(t.users, eq(t.users.id, t.memberships.userId)).innerJoin(t.roles, eq(t.roles.id, t.memberships.roleId))
      .where(and(eq(t.memberships.tenantId, ctx.tenantId), eq(t.memberships.status, 'active'))).orderBy(asc(t.users.name));
  });

  r.post('/', {
    summary: 'Add a user to the company',
    permission: 'user.manage',
    body: z.object({
      name: z.string().trim().min(2).max(120),
      email: z.string().trim().toLowerCase().email(),
      phone: z.string().trim().max(40).optional(),
      roleId: z.string().uuid(),
      password: passwordSchema.optional(),
      extraPermissions: z.array(permissionEnum).max(40).default([]),
    }),
  }, async ({ ctx, body }) => {
    const [role] = await db().select().from(t.roles).where(and(eq(t.roles.id, body.roleId), eq(t.roles.tenantId, ctx.tenantId))).limit(1);
    if (!role) throw notFound('Role');
    if (role.key === 'owner' && ctx.roleKey !== 'owner') throw forbidden('Only an owner can add another owner.');
    await assertWithinLimit(db(), ctx.tenantId, 'users');
    const temporaryPassword = body.password ? null : `${randomToken(9)}9a`;
    return db().transaction(async (tx) => {
      let [user] = await tx.select().from(t.users).where(eq(t.users.email, body.email)).limit(1);
      if (user) {
        const [existing] = await tx.select({ id: t.memberships.id }).from(t.memberships).where(and(eq(t.memberships.userId, user.id), eq(t.memberships.tenantId, ctx.tenantId))).limit(1);
        if (existing) throw conflict('ALREADY_MEMBER', 'This user is already a member of your company.');
      } else {
        [user] = await tx.insert(t.users).values({ name: body.name, email: body.email, phone: body.phone ?? '', passwordHash: await hashPassword(body.password ?? temporaryPassword!) }).returning();
      }
      const [membership] = await tx.insert(t.memberships).values({ tenantId: ctx.tenantId, userId: user!.id, roleId: role.id, extraPermissions: body.extraPermissions }).returning();
      await audit(tx, ctx, { action: 'user.created', entityType: 'user', entityId: user!.id, newValue: { email: body.email, role: role.key, extraPermissions: body.extraPermissions } });
      return { id: user!.id, membershipId: membership!.id, email: body.email, temporaryPassword };
    });
  });

  r.patch('/:id', {
    summary: 'Change a user role, status or extra permissions',
    permission: 'user.manage',
    params: idParam,
    body: z.object({ roleId: z.string().uuid().optional(), status: z.enum(['active', 'disabled']).optional(), extraPermissions: z.array(permissionEnum).max(40).optional(), name: z.string().trim().min(2).max(120).optional() }),
  }, async ({ ctx, params, body }) => {
    const [m] = await db().select({ id: t.memberships.id, roleId: t.memberships.roleId, status: t.memberships.status, extra: t.memberships.extraPermissions, roleKey: t.roles.key })
      .from(t.memberships).innerJoin(t.roles, eq(t.roles.id, t.memberships.roleId))
      .where(and(eq(t.memberships.userId, params.id), eq(t.memberships.tenantId, ctx.tenantId))).limit(1);
    if (!m) throw notFound('User');
    if (params.id === ctx.userId && (body.status === 'disabled' || body.roleId)) throw badRequest('You cannot change your own role or disable yourself.');
    if (m.roleKey === 'owner' && ctx.roleKey !== 'owner') throw forbidden('Only an owner can change another owner.');
    if (body.roleId) {
      const [role] = await db().select().from(t.roles).where(and(eq(t.roles.id, body.roleId), eq(t.roles.tenantId, ctx.tenantId))).limit(1);
      if (!role) throw notFound('Role');
      if (role.key === 'owner' && ctx.roleKey !== 'owner') throw forbidden('Only an owner can grant the owner role.');
    }
    if (m.roleKey === 'owner' && (body.status === 'disabled' || body.roleId)) {
      const row = await one<{ owners: number }>(db(), sql`SELECT COUNT(*)::int AS owners FROM memberships m JOIN roles r ON r.id = m.role_id WHERE m.tenant_id = ${ctx.tenantId} AND r.key = 'owner' AND m.status = 'active'`);
      if ((row?.owners ?? 0) <= 1) throw badRequest('A company must keep at least one active owner.');
    }
    await db().transaction(async (tx) => {
      await tx.update(t.memberships).set({ roleId: body.roleId, status: body.status, extraPermissions: body.extraPermissions }).where(eq(t.memberships.id, m.id));
      if (body.name) await tx.update(t.users).set({ name: body.name }).where(eq(t.users.id, params.id));
      if (body.status === 'disabled') await tx.delete(t.sessions).where(and(eq(t.sessions.userId, params.id), eq(t.sessions.tenantId, ctx.tenantId)));
      await audit(tx, ctx, {
        action: body.roleId || body.extraPermissions ? 'user.permissions_changed' : 'user.updated', entityType: 'user', entityId: params.id,
        oldValue: { roleId: m.roleId, status: m.status, extraPermissions: m.extra }, newValue: body,
      });
    });
    return { ok: true };
  });

  r.post('/:id/reset-password', { summary: 'Issue a temporary password for a user', permission: 'user.manage', params: idParam }, async ({ ctx, params }) => {
    const [m] = await db().select({ id: t.memberships.id }).from(t.memberships).where(and(eq(t.memberships.userId, params.id), eq(t.memberships.tenantId, ctx.tenantId))).limit(1);
    if (!m) throw notFound('User');
    const temporaryPassword = `${randomToken(9)}9a`;
    await db().update(t.users).set({ passwordHash: await hashPassword(temporaryPassword), failedLogins: 0, lockedUntil: null }).where(eq(t.users.id, params.id));
    await db().delete(t.sessions).where(eq(t.sessions.userId, params.id));
    await audit(db(), ctx, { action: 'user.password_reset', entityType: 'user', entityId: params.id });
    return { temporaryPassword };
  });
}

export function registerRoleRoutes(r: Router) {
  r.get('/permissions', { summary: 'Permission catalogue', permission: 'user.manage' }, async () =>
    Object.entries(PERMISSIONS).map(([key, description]) => ({ key, description, group: key.split('.')[0] })));

  r.get('/', { summary: 'List roles', permission: ['user.manage', 'settings.manage'] }, async ({ ctx }) => {
    return db().select({
      id: t.roles.id, key: t.roles.key, name: t.roles.name, description: t.roles.description, permissions: t.roles.permissions, isSystem: t.roles.isSystem,
      members: sql<number>`(SELECT COUNT(*)::int FROM memberships m WHERE m.role_id = ${t.roles.id})`,
    }).from(t.roles).where(eq(t.roles.tenantId, ctx.tenantId)).orderBy(asc(t.roles.createdAt));
  });

  const roleBody = z.object({
    name: z.string().trim().min(2).max(60),
    description: z.string().trim().max(300).default(''),
    permissions: z.array(permissionEnum).min(1),
  });

  r.post('/', { summary: 'Create a custom role', permission: 'user.manage', body: roleBody }, async ({ ctx, body }) => {
    const key = `custom_${body.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30)}`;
    const [role] = await db().insert(t.roles).values({ tenantId: ctx.tenantId, key, name: body.name, description: body.description, permissions: body.permissions, isSystem: false }).returning();
    await audit(db(), ctx, { action: 'role.created', entityType: 'role', entityId: role!.id, newValue: body });
    return role;
  });

  r.patch('/:id', { summary: 'Edit role permissions', permission: 'user.manage', params: idParam, body: roleBody.partial() }, async ({ ctx, params, body }) => {
    const [role] = await db().select().from(t.roles).where(and(eq(t.roles.id, params.id), eq(t.roles.tenantId, ctx.tenantId))).limit(1);
    if (!role) throw notFound('Role');
    if (role.key === 'owner') throw badRequest('The owner role always has full access and cannot be edited.');
    const [updated] = await db().update(t.roles).set(body).where(eq(t.roles.id, role.id)).returning();
    await audit(db(), ctx, { action: 'role.permissions_changed', entityType: 'role', entityId: role.id, oldValue: { permissions: role.permissions, name: role.name }, newValue: body });
    return updated;
  });

  r.delete('/:id', { summary: 'Delete an unused custom role', permission: 'user.manage', params: idParam }, async ({ ctx, params }) => {
    const [role] = await db().select().from(t.roles).where(and(eq(t.roles.id, params.id), eq(t.roles.tenantId, ctx.tenantId))).limit(1);
    if (!role) throw notFound('Role');
    if (role.isSystem) throw badRequest('System roles cannot be deleted.');
    const [inUse] = await db().select({ id: t.memberships.id }).from(t.memberships).where(eq(t.memberships.roleId, role.id)).limit(1);
    if (inUse) throw conflict('ROLE_IN_USE', 'Move users to another role before deleting this one.');
    await db().delete(t.roles).where(eq(t.roles.id, role.id));
    await audit(db(), ctx, { action: 'role.deleted', entityType: 'role', entityId: role.id, oldValue: { name: role.name } });
    return { ok: true };
  });
}

export function registerTaxRoutes(r: Router) {
  r.get('/', { summary: 'List tax rates' }, async ({ ctx }) =>
    db().select().from(t.taxRates).where(eq(t.taxRates.tenantId, ctx.tenantId)).orderBy(asc(t.taxRates.rate)));

  const body = z.object({
    code: z.string().trim().min(1).max(20),
    name: z.string().trim().min(2).max(80),
    rate: z.number().min(0).max(100),
    type: z.enum(['sales_tax', 'gst', 'vat', 'withholding', 'none']),
    appliesTo: z.enum(['sales', 'purchase', 'both']),
    isDefault: z.boolean().default(false),
    active: z.boolean().default(true),
  });
  r.post('/', { summary: 'Create a tax rate', permission: 'settings.manage', body }, async ({ ctx, body: b }) => {
    return db().transaction(async (tx) => {
      if (b.isDefault) await tx.update(t.taxRates).set({ isDefault: false }).where(eq(t.taxRates.tenantId, ctx.tenantId));
      const [row] = await tx.insert(t.taxRates).values({ ...b, tenantId: ctx.tenantId }).returning();
      await audit(tx, ctx, { action: 'tax_rate.created', entityType: 'tax_rate', entityId: row!.id, newValue: b });
      return row;
    });
  });
  r.patch('/:id', { summary: 'Update a tax rate', permission: 'settings.manage', params: idParam, body: body.partial() }, async ({ ctx, params, body: b }) => {
    return db().transaction(async (tx) => {
      const [before] = await tx.select().from(t.taxRates).where(and(eq(t.taxRates.id, params.id), eq(t.taxRates.tenantId, ctx.tenantId))).limit(1);
      if (!before) throw notFound('Tax rate');
      if (b.isDefault) await tx.update(t.taxRates).set({ isDefault: false }).where(and(eq(t.taxRates.tenantId, ctx.tenantId), ne(t.taxRates.id, params.id)));
      const [row] = await tx.update(t.taxRates).set(b).where(eq(t.taxRates.id, params.id)).returning();
      await audit(tx, ctx, { action: 'tax_rate.updated', entityType: 'tax_rate', entityId: params.id, ...diff(before as Record<string, unknown>, b) });
      return row;
    });
  });
}

export function registerApprovalRuleRoutes(r: Router) {
  r.get('/', { summary: 'List approval rules', permission: ['settings.manage', 'approval.decide'] }, async ({ ctx }) =>
    db().select().from(t.approvalRules).where(eq(t.approvalRules.tenantId, ctx.tenantId)).orderBy(asc(t.approvalRules.entityType), asc(t.approvalRules.threshold)));

  const body = z.object({
    entityType: z.enum(APPROVAL_ENTITY_TYPES),
    metric: z.enum(['value', 'quantity']).default('value'),
    threshold: z.number().min(0),
    approverRoleKey: z.string().min(2).max(60),
    description: z.string().max(300).default(''),
    active: z.boolean().default(true),
  });
  r.post('/', { summary: 'Create an approval rule', permission: 'settings.manage', body }, async ({ ctx, body: b }) => {
    const [row] = await db().insert(t.approvalRules).values({ ...b, active: String(b.active), tenantId: ctx.tenantId }).returning();
    await audit(db(), ctx, { action: 'approval_rule.created', entityType: 'approval_rule', entityId: row!.id, newValue: b });
    return row;
  });
  r.patch('/:id', { summary: 'Update an approval rule threshold or approver', permission: 'settings.manage', params: idParam, body: body.partial() }, async ({ ctx, params, body: b }) => {
    const [before] = await db().select().from(t.approvalRules).where(and(eq(t.approvalRules.id, params.id), eq(t.approvalRules.tenantId, ctx.tenantId))).limit(1);
    if (!before) throw notFound('Approval rule');
    const [row] = await db().update(t.approvalRules).set({ ...b, active: b.active === undefined ? undefined : String(b.active) }).where(eq(t.approvalRules.id, params.id)).returning();
    await audit(db(), ctx, { action: 'approval_rule.updated', entityType: 'approval_rule', entityId: params.id, oldValue: before, newValue: b });
    return row;
  });
  r.delete('/:id', { summary: 'Delete an approval rule', permission: 'settings.manage', params: idParam }, async ({ ctx, params }) => {
    const [before] = await db().delete(t.approvalRules).where(and(eq(t.approvalRules.id, params.id), eq(t.approvalRules.tenantId, ctx.tenantId))).returning();
    if (!before) throw notFound('Approval rule');
    await audit(db(), ctx, { action: 'approval_rule.deleted', entityType: 'approval_rule', entityId: params.id, oldValue: before });
    return { ok: true };
  });
}
