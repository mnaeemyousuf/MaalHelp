import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { db, t } from '../../db';
import type { Router } from '../../core/http';
import { AppError, badRequest, conflict, forbidden } from '../../core/errors';
import { hashPassword, verifyPassword } from '../../core/crypto';
import { audit } from '../../core/audit';
import { createSession, destroySession, switchSessionTenant, clientIp } from './session';
import { provisionTenant } from '../tenant/provision';

const MAX_FAILED_LOGINS = 8;
const LOCKOUT_MINUTES = 15;

export const passwordSchema = z.string()
  .min(10, 'Password must be at least 10 characters.')
  .max(200)
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), 'Password must contain letters and numbers.');

const email = () => z.string().trim().toLowerCase().email('Enter a valid email address.');

export function registerAuthRoutes(r: Router) {
  r.post('/register', {
    auth: 'public',
    summary: 'Create a company (tenant) and its owner account',
    rateLimit: { max: 10, timeWindow: '1 minute' },
    body: z.object({
      company: z.string().trim().min(2).max(120),
      name: z.string().trim().min(2).max(120),
      email: email(),
      password: passwordSchema,
      phone: z.string().trim().max(40).optional(),
      city: z.string().trim().max(80).optional(),
      country: z.string().trim().length(2).optional(),
      currency: z.enum(['PKR', 'USD', 'AED', 'SAR', 'GBP', 'EUR']).optional(),
    }),
  }, async ({ body, req, reply }) => {
    const [existing] = await db().select({ id: t.users.id }).from(t.users).where(eq(t.users.email, body.email)).limit(1);
    if (existing) throw conflict('EMAIL_EXISTS', 'An account already exists for this email. Sign in instead.');
    const passwordHash = await hashPassword(body.password);
    const result = await db().transaction(async (tx) => {
      const [user] = await tx.insert(t.users).values({ email: body.email, name: body.name, phone: body.phone ?? '', passwordHash }).returning();
      const { tenantId } = await provisionTenant(tx, { name: body.company, ownerUserId: user!.id, city: body.city, country: body.country, currency: body.currency, phone: body.phone, email: body.email });
      await audit(tx, { tenantId, userId: user!.id, userEmail: body.email, userName: body.name, roleKey: 'owner', permissions: new Set(), isPlatformAdmin: false, ip: clientIp(req), device: String(req.headers['user-agent'] ?? ''), currency: 'PKR' }, {
        action: 'company.created', entityType: 'tenant', entityId: tenantId, newValue: { company: body.company, owner: body.email },
      });
      return { userId: user!.id, tenantId };
    });
    await createSession(req, reply, result.userId, result.tenantId);
    return { userId: result.userId, tenantId: result.tenantId };
  });

  r.post('/login', {
    auth: 'public',
    summary: 'Sign in with email and password',
    rateLimit: { max: 20, timeWindow: '1 minute' },
    body: z.object({ email: email(), password: z.string().min(1).max(200) }),
  }, async ({ body, req, reply }) => {
    const [user] = await db().select().from(t.users).where(eq(t.users.email, body.email)).limit(1);
    const invalid = new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    if (!user) {
      await hashPassword(body.password); // equalise timing for unknown accounts
      throw invalid;
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new AppError(423, 'ACCOUNT_LOCKED', `Too many failed attempts. Try again after ${user.lockedUntil.toLocaleTimeString('en-GB')}.`);
    }
    if (user.status !== 'active') throw new AppError(403, 'ACCOUNT_DISABLED', 'This account has been disabled. Contact your administrator.');
    if (!(await verifyPassword(body.password, user.passwordHash))) {
      const failed = user.failedLogins + 1;
      await db().update(t.users).set({
        failedLogins: failed >= MAX_FAILED_LOGINS ? 0 : failed,
        lockedUntil: failed >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : null,
      }).where(eq(t.users.id, user.id));
      throw invalid;
    }
    const [membership] = await db().select({ tenantId: t.memberships.tenantId }).from(t.memberships)
      .where(and(eq(t.memberships.userId, user.id), eq(t.memberships.status, 'active'))).orderBy(t.memberships.createdAt).limit(1);
    if (!membership && !user.isPlatformAdmin) throw forbidden('Your account is not a member of any active company.');
    await db().update(t.users).set({ failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() }).where(eq(t.users.id, user.id));
    await createSession(req, reply, user.id, membership?.tenantId ?? null);
    if (membership) {
      await db().insert(t.auditLogs).values({ tenantId: membership.tenantId, userId: user.id, userEmail: user.email, action: 'user.login', entityType: 'user', entityId: user.id, ip: clientIp(req), device: String(req.headers['user-agent'] ?? '').slice(0, 300) });
    }
    return { userId: user.id, tenantId: membership?.tenantId ?? null };
  });

  r.post('/logout', { auth: 'user', summary: 'Sign out and revoke the session' }, async ({ req, reply }) => {
    await destroySession(req, reply);
    return { ok: true };
  });

  r.get('/me', { auth: 'user', summary: 'Current user, active company, role and permissions' }, async ({ ctx }) => {
    const memberships = await db().select({ tenantId: t.tenants.id, name: t.tenants.name, role: t.roles.name, roleKey: t.roles.key })
      .from(t.memberships)
      .innerJoin(t.tenants, eq(t.tenants.id, t.memberships.tenantId))
      .innerJoin(t.roles, eq(t.roles.id, t.memberships.roleId))
      .where(and(eq(t.memberships.userId, ctx.userId), eq(t.memberships.status, 'active')));
    const [tenant] = ctx.tenantId
      ? await db().select({ id: t.tenants.id, name: t.tenants.name, baseCurrency: t.tenants.baseCurrency, city: t.tenants.city, country: t.tenants.country, logoUrl: t.tenants.logoUrl, status: t.tenants.status, timezone: t.tenants.timezone, settings: t.tenants.settings })
        .from(t.tenants).where(eq(t.tenants.id, ctx.tenantId)).limit(1)
      : [];
    const [role] = ctx.tenantId ? await db().select({ name: t.roles.name }).from(t.roles).where(and(eq(t.roles.tenantId, ctx.tenantId), eq(t.roles.key, ctx.roleKey))).limit(1) : [];
    const [{ warehouses } = { warehouses: 0 }] = ctx.tenantId
      ? await db().select({ warehouses: sql<number>`count(*)::int` }).from(t.warehouses).where(eq(t.warehouses.tenantId, ctx.tenantId))
      : [];
    return {
      user: { id: ctx.userId, email: ctx.userEmail, name: ctx.userName, isPlatformAdmin: ctx.isPlatformAdmin },
      tenant: tenant ?? null,
      role: { key: ctx.roleKey, name: role?.name ?? ctx.roleKey },
      permissions: [...ctx.permissions].sort(),
      memberships,
      onboarding: { needsWarehouse: Boolean(ctx.tenantId) && warehouses === 0 },
    };
  });

  r.post('/switch-tenant', { auth: 'user', summary: 'Switch the active company', body: z.object({ tenantId: z.string().uuid() }) }, async ({ ctx, body, req }) => {
    const [m] = await db().select({ id: t.memberships.id }).from(t.memberships)
      .where(and(eq(t.memberships.userId, ctx.userId), eq(t.memberships.tenantId, body.tenantId), eq(t.memberships.status, 'active'))).limit(1);
    if (!m) throw forbidden('You are not a member of that company.');
    await switchSessionTenant(req, body.tenantId);
    return { tenantId: body.tenantId };
  });

  r.post('/change-password', {
    auth: 'user',
    summary: 'Change the current user password',
    rateLimit: { max: 10, timeWindow: '1 minute' },
    body: z.object({ currentPassword: z.string().min(1), newPassword: passwordSchema }),
  }, async ({ ctx, body }) => {
    const [user] = await db().select().from(t.users).where(eq(t.users.id, ctx.userId)).limit(1);
    if (!user || !(await verifyPassword(body.currentPassword, user.passwordHash))) throw badRequest('Current password is incorrect.');
    await db().update(t.users).set({ passwordHash: await hashPassword(body.newPassword) }).where(eq(t.users.id, ctx.userId));
    if (ctx.tenantId) await audit(db(), ctx, { action: 'user.password_changed', entityType: 'user', entityId: ctx.userId });
    return { ok: true };
  });
}
