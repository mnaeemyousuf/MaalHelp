import { t, type DbOrTx } from '../db';
import type { Ctx } from './context';

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
}

/** Writes an append-only audit row inside the caller's transaction. */
export async function audit(dbx: DbOrTx, ctx: Ctx, entry: AuditEntry): Promise<void> {
  await dbx.insert(t.auditLogs).values({
    tenantId: ctx.tenantId || null,
    userId: ctx.userId || null,
    userEmail: ctx.userEmail,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? '',
    oldValue: entry.oldValue === undefined ? null : sanitize(entry.oldValue),
    newValue: entry.newValue === undefined ? null : sanitize(entry.newValue),
    ip: ctx.ip,
    device: ctx.device.slice(0, 300),
  });
}

const SECRET_KEYS = /password|secret|token|credential|apikey|api_key/i;

/** Strips secrets and returns only changed fields when diffing. */
function sanitize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sanitize);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.test(k) ? '[redacted]' : v instanceof Date ? v.toISOString() : sanitize(v);
  }
  return out;
}

/** Returns {old, new} objects containing only keys whose values changed. */
export function diff<T extends Record<string, unknown>>(before: T, after: Partial<T>): { oldValue: Partial<T>; newValue: Partial<T> } {
  const oldValue: Partial<T> = {};
  const newValue: Partial<T> = {};
  for (const key of Object.keys(after) as (keyof T)[]) {
    const a = before[key];
    const b = after[key];
    if (b !== undefined && JSON.stringify(a) !== JSON.stringify(b)) {
      oldValue[key] = a;
      newValue[key] = b as T[keyof T];
    }
  }
  return { oldValue, newValue };
}
