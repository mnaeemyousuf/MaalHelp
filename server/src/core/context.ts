import type { Permission } from '@shared/permissions';
import { forbidden } from './errors';

/** Authenticated request context. tenantId is always derived from the session, never the payload. */
export interface Ctx {
  tenantId: string;
  userId: string;
  userEmail: string;
  userName: string;
  roleKey: string;
  permissions: ReadonlySet<string>;
  isPlatformAdmin: boolean;
  ip: string;
  device: string;
  currency: string;
}

export function can(ctx: Ctx, permission: Permission): boolean {
  return ctx.permissions.has(permission);
}

export function requirePermission(ctx: Ctx, ...anyOf: Permission[]): void {
  if (!anyOf.some((p) => ctx.permissions.has(p))) throw forbidden();
}

/** Context used by background jobs acting on behalf of the system. */
export function systemCtx(tenantId: string, currency = 'PKR'): Ctx {
  return {
    tenantId,
    userId: '',
    userEmail: 'system@maalhelp',
    userName: 'Maal Help system',
    roleKey: 'system',
    permissions: new Set<string>(),
    isPlatformAdmin: false,
    ip: '',
    device: 'background-job',
    currency,
  };
}
