import { and, eq, sql } from 'drizzle-orm';
import { db, rows, t } from '../db';
import { env } from '../config/env';
import { systemCtx } from '../core/context';
import { enqueue, registerJob, requeueStale, runDueJobs } from './queue';
import { scanAlerts } from '../modules/analytics/insights';
import { expireBatches } from '../modules/inventory/routes';
import { generateBriefing } from '../ai/briefing';
import '../ai/documents';
import '../modules/integrations/events';

// ───── Notification channels (adapter pattern; "log" providers in development) ─────
interface Channel { name: 'email' | 'whatsapp' | 'push'; send(to: string, subject: string, body: string): Promise<void> }

const logChannel = (name: Channel['name']): Channel => ({
  name,
  async send(to, subject) { if (env.NODE_ENV !== 'test') console.info(`[notify:${name}] to=${to} subject="${subject}" (log provider — configure a real provider to deliver)`); },
});

const whatsappCloud: Channel = {
  name: 'whatsapp',
  async send(to, subject, body) {
    if (!env.WHATSAPP_API_URL || !env.WHATSAPP_API_TOKEN) throw new Error('WhatsApp provider is not configured');
    const res = await fetch(env.WHATSAPP_API_URL, { method: 'POST', headers: { authorization: `Bearer ${env.WHATSAPP_API_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', to: to.replace(/\D/g, ''), type: 'text', text: { body: `${subject}\n${body}`.slice(0, 1000) } }), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`WhatsApp HTTP ${res.status}`);
  },
};

function channelsFor(settings: { email?: boolean; whatsapp?: boolean; push?: boolean }): Channel[] {
  const list: Channel[] = [];
  if (settings.email) list.push(logChannel('email')); // SMTP provider plugs in here (EMAIL_PROVIDER=smtp)
  if (settings.whatsapp) list.push(env.WHATSAPP_PROVIDER === 'cloud_api' ? whatsappCloud : logChannel('whatsapp'));
  if (settings.push) list.push(logChannel('push'));
  return list;
}

registerJob('notifications.deliver', async (payload) => {
  const tenantId = String(payload.tenantId);
  const [n] = await db().select().from(t.notifications).where(and(eq(t.notifications.id, String(payload.notificationId)), eq(t.notifications.tenantId, tenantId))).limit(1);
  if (!n || n.resolvedAt) return { skipped: true };
  const [tenant] = await db().select({ settings: t.tenants.settings }).from(t.tenants).where(eq(t.tenants.id, tenantId));
  const prefs = tenant?.settings.notifications ?? {};
  const channels = channelsFor(prefs);
  if (!channels.length) return { channels: 0 };
  // Recipients: users who hold the alert's permission, plus configured extra recipients.
  const recipients = await rows<{ email: string; phone: string }>(db(), sql`SELECT u.email, u.phone FROM memberships m JOIN users u ON u.id = m.user_id JOIN roles r ON r.id = m.role_id WHERE m.tenant_id = ${tenantId} AND m.status = 'active' AND (${n.permission} = ANY(r.permissions) OR ${n.permission} = ANY(m.extra_permissions)) AND r.key IN ('owner', 'warehouse_manager', 'accountant')`);
  let sent = 0;
  for (const ch of channels) {
    const targets = ch.name === 'whatsapp' ? recipients.map((r) => r.phone).filter(Boolean) : [...recipients.map((r) => r.email), ...(prefs.recipients ?? [])];
    for (const to of [...new Set(targets)].slice(0, 20)) {
      try {
        await ch.send(to, n.title, n.body);
        await db().insert(t.notificationDeliveries).values({ tenantId, notificationId: n.id, channel: ch.name, recipient: to, status: 'sent', sentAt: new Date() });
        sent++;
      } catch (err) {
        await db().insert(t.notificationDeliveries).values({ tenantId, notificationId: n.id, channel: ch.name, recipient: to, status: 'failed', error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return { sent };
});

// ───── Scheduled per-tenant jobs ─────
registerJob('alerts.scan', async (_p, job) => db().transaction((tx) => scanAlerts(tx, job.tenantId!)));
registerJob('inventory.expire_batches', async (_p, job) => {
  const [tenant] = await db().select({ currency: t.tenants.baseCurrency }).from(t.tenants).where(eq(t.tenants.id, job.tenantId!));
  return db().transaction((tx) => expireBatches(tx, systemCtx(job.tenantId!, tenant?.currency)));
});
registerJob('ai.daily_briefing', async (_p, job) => {
  const [tenant] = await db().select({ settings: t.tenants.settings }).from(t.tenants).where(eq(t.tenants.id, job.tenantId!));
  if (tenant?.settings.ai?.dailyBriefing === false) return { skipped: true };
  const b = await generateBriefing(job.tenantId!);
  return { id: b.id };
});
registerJob('inventory.snapshot', async (_p, job) => {
  await snapshotInventory(job.tenantId!);
  return { ok: true };
});

/** Daily snapshot of stock per warehouse/product/owner (storage billing trends, utilisation change detection). */
export async function snapshotInventory(tenantId: string, date = new Date().toISOString().slice(0, 10)): Promise<void> {
  await db().execute(sql`
    INSERT INTO inventory_snapshots (tenant_id, snapshot_date, warehouse_id, product_id, owner_customer_id, quantity, value, volume_m3, weight_kg, pallets, bins)
    SELECT b.tenant_id, ${date}::date, b.warehouse_id, b.product_id, b.owner_customer_id, SUM(b.quantity), SUM(b.quantity * p.cost_price), SUM(b.quantity * p.volume_m3), SUM(b.quantity * p.weight_kg),
      SUM(CASE WHEN p.units_per_pallet > 0 THEN b.quantity / p.units_per_pallet ELSE 0 END), COUNT(DISTINCT b.location_id)
    FROM inventory_balances b JOIN products p ON p.id = b.product_id WHERE b.tenant_id = ${tenantId} AND b.quantity > 0
    GROUP BY b.tenant_id, b.warehouse_id, b.product_id, b.owner_customer_id
    ON CONFLICT ON CONSTRAINT inventory_snapshots_identity_uq DO UPDATE SET quantity = EXCLUDED.quantity, value = EXCLUDED.value, volume_m3 = EXCLUDED.volume_m3, weight_kg = EXCLUDED.weight_kg, pallets = EXCLUDED.pallets, bins = EXCLUDED.bins`);
}

/** Enqueues recurring work for every active tenant with dedupe keys so each runs once per period. */
export async function scheduleRecurring(now = new Date()): Promise<void> {
  const tenants = await db().select({ id: t.tenants.id }).from(t.tenants).where(sql`${t.tenants.status} <> 'suspended'`);
  const day = now.toISOString().slice(0, 10);
  const hour = now.toISOString().slice(0, 13);
  for (const tenant of tenants) {
    await enqueue(db(), 'alerts.scan', {}, { tenantId: tenant.id, dedupeKey: `alerts:${tenant.id}:${hour}`, maxAttempts: 1 });
    await enqueue(db(), 'inventory.snapshot', {}, { tenantId: tenant.id, dedupeKey: `snapshot:${tenant.id}:${day}` });
    await enqueue(db(), 'inventory.expire_batches', {}, { tenantId: tenant.id, dedupeKey: `expire:${tenant.id}:${day}` });
    if (now.getHours() >= env.DAILY_BRIEFING_HOUR) await enqueue(db(), 'ai.daily_briefing', {}, { tenantId: tenant.id, dedupeKey: `briefing:${tenant.id}:${day}` });
  }
}

let timer: NodeJS.Timeout | null = null;
export function startWorker(): void {
  if (!env.JOBS_ENABLED || timer) return;
  let ticks = 0;
  const tick = async () => {
    try {
      if (ticks % 60 === 0) { await requeueStale(); await scheduleRecurring(); }
      ticks++;
      while ((await runDueJobs(10)) > 0) { /* drain */ }
    } catch (err) {
      console.error('[jobs] worker error', err instanceof Error ? err.message : err);
    }
  };
  void tick();
  timer = setInterval(tick, env.JOBS_POLL_MS);
}

export function stopWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
