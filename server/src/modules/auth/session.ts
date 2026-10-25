import type { FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, gt } from 'drizzle-orm';
import { db, t } from '../../db';
import { env } from '../../config/env';
import { hashSessionToken, randomToken } from '../../core/crypto';
import type { Ctx } from '../../core/context';
import type { AuthMode } from '../../core/http';

export const SESSION_COOKIE = 'sp_session';
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export function clientIp(req: FastifyRequest): string {
  return req.ip ?? '';
}

export async function createSession(req: FastifyRequest, reply: FastifyReply, userId: string, tenantId: string | null): Promise<void> {
  const token = randomToken(32);
  const hours = env.SESSION_TTL_HOURS;
  await db().insert(t.sessions).values({
    tokenHash: hashSessionToken(token),
    userId,
    tenantId,
    ip: clientIp(req),
    userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300),
    expiresAt: new Date(Date.now() + hours * 3600_000),
    lastSeenAt: new Date(),
  });
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.COOKIE_SECURE,
    path: '/',
    maxAge: hours * 3600,
  });
}

export async function destroySession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = req.cookies[SESSION_COOKIE];
  if (token) await db().delete(t.sessions).where(eq(t.sessions.tokenHash, hashSessionToken(token)));
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export async function switchSessionTenant(req: FastifyRequest, tenantId: string): Promise<void> {
  const token = req.cookies[SESSION_COOKIE];
  if (token) await db().update(t.sessions).set({ tenantId }).where(eq(t.sessions.tokenHash, hashSessionToken(token)));
}

/**
 * Resolves cookie → session → user → active membership → role → permissions.
 * Returns null when unauthenticated. Tenant-mode routes require an active membership.
 */
export async function resolveSession(req: FastifyRequest, mode: AuthMode): Promise<Ctx | null> {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  const [session] = await db()
    .select({ id: t.sessions.id, userId: t.sessions.userId, tenantId: t.sessions.tenantId, lastSeenAt: t.sessions.lastSeenAt, email: t.users.email, name: t.users.name, status: t.users.status, isPlatformAdmin: t.users.isPlatformAdmin })
    .from(t.sessions)
    .innerJoin(t.users, eq(t.users.id, t.sessions.userId))
    .where(and(eq(t.sessions.tokenHash, hashSessionToken(token)), gt(t.sessions.expiresAt, new Date())))
    .limit(1);
  if (!session || session.status !== 'active') return null;

  if (!session.lastSeenAt || Date.now() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await db().update(t.sessions).set({ lastSeenAt: new Date() }).where(eq(t.sessions.id, session.id));
  }

  const base = {
    userId: session.userId,
    userEmail: session.email,
    userName: session.name,
    isPlatformAdmin: session.isPlatformAdmin,
    ip: clientIp(req),
    device: String(req.headers['user-agent'] ?? ''),
  };

  if (session.tenantId) {
    const [m] = await db()
      .select({ roleKey: t.roles.key, perms: t.roles.permissions, extra: t.memberships.extraPermissions, mStatus: t.memberships.status, tStatus: t.tenants.status, currency: t.tenants.baseCurrency })
      .from(t.memberships)
      .innerJoin(t.roles, eq(t.roles.id, t.memberships.roleId))
      .innerJoin(t.tenants, eq(t.tenants.id, t.memberships.tenantId))
      .where(and(eq(t.memberships.userId, session.userId), eq(t.memberships.tenantId, session.tenantId)))
      .limit(1);
    if (m && m.mStatus === 'active' && m.tStatus !== 'suspended') {
      return { ...base, tenantId: session.tenantId, roleKey: m.roleKey, permissions: new Set([...m.perms, ...m.extra]), currency: m.currency };
    }
  }
  if (mode === 'tenant') return null;
  return { ...base, tenantId: '', roleKey: session.isPlatformAdmin ? 'platform_admin' : 'none', permissions: new Set(), currency: 'PKR' };
}
