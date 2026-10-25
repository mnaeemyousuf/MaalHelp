import { and, eq, sql } from 'drizzle-orm';
import { db, t, type DbOrTx } from '../../db';
import { enqueue, registerJob } from '../../jobs/queue';
import { decrypt, hmacSignature } from '../../core/crypto';

/** Domain events that can be subscribed to by webhooks and integrations. */
export const DOMAIN_EVENTS = [
  'purchase_order.approved', 'goods.received', 'putaway.completed', 'sales_order.confirmed', 'sales_order.reserved',
  'order.picked', 'order.packed', 'shipment.dispatched', 'shipment.delivered', 'shipment.status_changed', 'transfer.completed',
  'return.received', 'inventory.adjusted', 'stock_count.posted', 'invoice.issued', 'payment.recorded', 'alert.created',
] as const;
export type DomainEvent = (typeof DOMAIN_EVENTS)[number];

/** Queues delivery to every active webhook subscribed to the event (inside the caller's transaction). */
export async function emitEvent(dbx: DbOrTx, tenantId: string, event: DomainEvent, data: Record<string, unknown>): Promise<void> {
  const hooks = await dbx.select({ id: t.webhooks.id }).from(t.webhooks)
    .where(and(eq(t.webhooks.tenantId, tenantId), eq(t.webhooks.active, true), sql`(${event} = ANY(${t.webhooks.events}) OR '*' = ANY(${t.webhooks.events}))`));
  for (const hook of hooks) {
    const [delivery] = await dbx.insert(t.webhookDeliveries).values({
      tenantId, webhookId: hook.id, event, payload: { event, tenantId, occurredAt: new Date().toISOString(), data },
    }).returning({ id: t.webhookDeliveries.id });
    await enqueue(dbx, 'webhooks.deliver', { deliveryId: delivery!.id }, { tenantId, maxAttempts: 5 });
  }
}

/** POSTs the payload with an HMAC-SHA256 signature header. Retries via the job queue. */
registerJob('webhooks.deliver', async (payload) => {
  const deliveryId = String(payload.deliveryId);
  const [row] = await db().select({ d: t.webhookDeliveries, w: t.webhooks }).from(t.webhookDeliveries)
    .innerJoin(t.webhooks, eq(t.webhooks.id, t.webhookDeliveries.webhookId)).where(eq(t.webhookDeliveries.id, deliveryId)).limit(1);
  if (!row || !row.w.active) return { skipped: true };
  const body = JSON.stringify(row.d.payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = hmacSignature(decrypt(row.w.secretEncrypted), `${timestamp}.${body}`);
  let status = 0;
  let error: string | null = null;
  try {
    const res = await fetch(row.w.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'MaalHelp-Webhooks/1.0', 'x-stockpilot-event': row.d.event, 'x-stockpilot-timestamp': timestamp, 'x-stockpilot-signature': `sha256=${signature}` },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    status = res.status;
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  await db().update(t.webhookDeliveries).set({
    attempts: sql`${t.webhookDeliveries.attempts} + 1`, responseCode: status || null, lastError: error,
    status: error ? 'failed' : 'delivered', deliveredAt: error ? null : new Date(),
  }).where(eq(t.webhookDeliveries.id, deliveryId));
  if (error) throw new Error(error); // let the queue retry with backoff
  return { status };
});
