import { sql } from 'drizzle-orm';
import type { AlertSeverity } from '@shared/domain';
import { one, t, type DbOrTx } from '../../db';
import { enqueue } from '../../jobs/queue';

export interface NotifyInput {
  severity: AlertSeverity;
  category: string;
  title: string;
  body?: string;
  entityType?: string;
  entityId?: string;
  actionUrl?: string;
  permission?: string;
  userId?: string;
  /** Same key = same alert; an open alert with this key is refreshed instead of duplicated. */
  dedupeKey?: string;
}

/**
 * Creates (or refreshes) an in-app notification and queues external delivery
 * (email / WhatsApp / push) for critical and warning alerts.
 */
export async function notify(dbx: DbOrTx, tenantId: string, input: NotifyInput): Promise<string | null> {
  const values = {
    tenantId,
    userId: input.userId ?? null,
    severity: input.severity,
    category: input.category,
    title: input.title,
    body: input.body ?? '',
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    actionUrl: input.actionUrl ?? null,
    permission: input.permission ?? 'alert.view',
    dedupeKey: input.dedupeKey ?? null,
  };
  if (!input.dedupeKey) {
    const [row] = await dbx.insert(t.notifications).values(values).returning({ id: t.notifications.id });
    if (input.severity !== 'info') await enqueue(dbx, 'notifications.deliver', { tenantId, notificationId: row!.id }, { tenantId });
    return row!.id;
  }
  const row = await one<{ id: string; inserted: boolean }>(dbx, sql`
    INSERT INTO notifications (tenant_id, user_id, severity, category, title, body, entity_type, entity_id, action_url, permission, dedupe_key)
    VALUES (${tenantId}, ${values.userId}, ${values.severity}, ${values.category}, ${values.title}, ${values.body}, ${values.entityType}, ${values.entityId}, ${values.actionUrl}, ${values.permission}, ${values.dedupeKey})
    ON CONFLICT (tenant_id, dedupe_key) DO UPDATE SET
      title = EXCLUDED.title, body = EXCLUDED.body, severity = EXCLUDED.severity,
      -- a resolved alert whose condition recurs is re-opened as a fresh alert
      created_at = CASE WHEN notifications.resolved_at IS NOT NULL THEN now() ELSE notifications.created_at END,
      resolved_at = NULL
    RETURNING id, (xmax = 0) AS inserted`);
  if (row?.inserted && input.severity !== 'info') {
    await enqueue(dbx, 'notifications.deliver', { tenantId, notificationId: row.id }, { tenantId });
  }
  return row?.id ?? null;
}

/** Marks open alerts with the given dedupe key prefix as resolved. */
export async function resolveAlerts(dbx: DbOrTx, tenantId: string, dedupeKeys: string[]): Promise<void> {
  if (!dedupeKeys.length) return;
  await dbx.execute(sql`UPDATE notifications SET resolved_at = now() WHERE tenant_id = ${tenantId} AND resolved_at IS NULL AND dedupe_key IN (${sql.join(dedupeKeys.map((k) => sql`${k}`), sql`, `)})`);
}
