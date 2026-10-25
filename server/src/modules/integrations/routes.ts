import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { db, t } from '../../db';
import { idParam, type Router } from '../../core/http';
import { badRequest, notFound } from '../../core/errors';
import { audit } from '../../core/audit';
import { encrypt, randomToken } from '../../core/crypto';
import { assertWithinLimit } from '../platform/limits';
import { DOMAIN_EVENTS } from './events';
import { enqueue } from '../../jobs/queue';
import { PROVIDERS, providerInfo } from './adapters';

export function registerIntegrationRoutes(r: Router) {
  r.get('/', { summary: 'Available providers and their connection status', permission: 'integration.manage' }, async ({ ctx }) => {
    const connected = await db().select().from(t.integrations).where(eq(t.integrations.tenantId, ctx.tenantId));
    return PROVIDERS.map((p) => {
      const c = connected.find((x) => x.provider === p.key);
      return { ...p, status: c?.status ?? 'disconnected', config: c?.config ?? {}, lastSyncAt: c?.lastSyncAt ?? null, lastError: c?.lastError ?? null, hasCredentials: Boolean(c?.credentialsEncrypted) };
    });
  });

  r.post('/:provider/connect', {
    summary: 'Connect an integration (credentials are encrypted at rest)',
    permission: 'integration.manage',
    params: z.object({ provider: z.string() }),
    body: z.object({ config: z.record(z.string(), z.string().max(500)).default({}), credentials: z.record(z.string(), z.string().max(2000)).default({}) }),
  }, async ({ ctx, params, body }) => {
    const info = providerInfo(params.provider);
    if (!info) throw notFound('Integration provider');
    for (const f of info.fields) {
      const v = f.secret ? body.credentials[f.key] : body.config[f.key];
      if (!v) throw badRequest(`${f.label} is required.`);
    }
    await assertWithinLimit(db(), ctx.tenantId, 'integrations');
    const values = { tenantId: ctx.tenantId, provider: info.key, category: info.category, status: 'connected', config: body.config, credentialsEncrypted: encrypt(JSON.stringify(body.credentials)), lastError: null };
    await db().insert(t.integrations).values(values).onConflictDoUpdate({ target: [t.integrations.tenantId, t.integrations.provider], set: values });
    await audit(db(), ctx, { action: 'integration.connected', entityType: 'integration', entityId: info.key, newValue: { config: body.config } });
    return { provider: info.key, status: 'connected', mock: info.mock };
  });

  r.post('/:provider/disconnect', { summary: 'Disconnect an integration and delete its credentials', permission: 'integration.manage', params: z.object({ provider: z.string() }) }, async ({ ctx, params }) => {
    await db().update(t.integrations).set({ status: 'disconnected', credentialsEncrypted: null }).where(and(eq(t.integrations.tenantId, ctx.tenantId), eq(t.integrations.provider, params.provider)));
    await audit(db(), ctx, { action: 'integration.disconnected', entityType: 'integration', entityId: params.provider });
    return { ok: true };
  });
}

export function registerWebhookRoutes(r: Router) {
  r.get('/', { summary: 'Webhook subscriptions', permission: 'integration.manage' }, async ({ ctx }) => {
    const hooks = await db().select({ id: t.webhooks.id, url: t.webhooks.url, events: t.webhooks.events, description: t.webhooks.description, active: t.webhooks.active, createdAt: t.webhooks.createdAt })
      .from(t.webhooks).where(eq(t.webhooks.tenantId, ctx.tenantId)).orderBy(desc(t.webhooks.createdAt));
    return { hooks, events: DOMAIN_EVENTS };
  });

  r.post('/', {
    summary: 'Create a webhook. The signing secret is shown once.',
    permission: 'integration.manage',
    body: z.object({ url: z.string().url().refine((u) => u.startsWith('https://') || process.env.NODE_ENV !== 'production', 'Webhook URLs must use HTTPS.'), events: z.array(z.enum([...DOMAIN_EVENTS, '*'] as [string, ...string[]])).min(1), description: z.string().max(200).default('') }),
  }, async ({ ctx, body }) => {
    const secret = `whsec_${randomToken(24)}`;
    const [hook] = await db().insert(t.webhooks).values({ tenantId: ctx.tenantId, url: body.url, events: body.events, description: body.description, secretEncrypted: encrypt(secret) }).returning({ id: t.webhooks.id });
    await audit(db(), ctx, { action: 'webhook.created', entityType: 'webhook', entityId: hook!.id, newValue: { url: body.url, events: body.events } });
    return { id: hook!.id, secret };
  });

  r.patch('/:id', { summary: 'Enable/disable or change a webhook', permission: 'integration.manage', params: idParam, body: z.object({ active: z.boolean().optional(), events: z.array(z.string()).min(1).optional() }) }, async ({ ctx, params, body }) => {
    const [hook] = await db().update(t.webhooks).set(body).where(and(eq(t.webhooks.id, params.id), eq(t.webhooks.tenantId, ctx.tenantId))).returning({ id: t.webhooks.id });
    if (!hook) throw notFound('Webhook');
    await audit(db(), ctx, { action: 'webhook.updated', entityType: 'webhook', entityId: params.id, newValue: body });
    return { ok: true };
  });

  r.delete('/:id', { summary: 'Delete a webhook', permission: 'integration.manage', params: idParam }, async ({ ctx, params }) => {
    const [hook] = await db().delete(t.webhooks).where(and(eq(t.webhooks.id, params.id), eq(t.webhooks.tenantId, ctx.tenantId))).returning({ id: t.webhooks.id });
    if (!hook) throw notFound('Webhook');
    await audit(db(), ctx, { action: 'webhook.deleted', entityType: 'webhook', entityId: params.id });
    return { ok: true };
  });

  r.get('/:id/deliveries', { summary: 'Recent delivery attempts', permission: 'integration.manage', params: idParam }, async ({ ctx, params }) =>
    db().select().from(t.webhookDeliveries).where(and(eq(t.webhookDeliveries.webhookId, params.id), eq(t.webhookDeliveries.tenantId, ctx.tenantId))).orderBy(desc(t.webhookDeliveries.createdAt)).limit(50));

  r.post('/:id/test', { summary: 'Send a test event', permission: 'integration.manage', params: idParam }, async ({ ctx, params }) => {
    const [hook] = await db().select({ id: t.webhooks.id, events: t.webhooks.events }).from(t.webhooks).where(and(eq(t.webhooks.id, params.id), eq(t.webhooks.tenantId, ctx.tenantId))).limit(1);
    if (!hook) throw notFound('Webhook');
    const event = hook.events.find((e) => e !== '*') ?? 'alert.created';
    const [delivery] = await db().insert(t.webhookDeliveries).values({
      tenantId: ctx.tenantId, webhookId: hook.id, event, payload: { event, tenantId: ctx.tenantId, occurredAt: new Date().toISOString(), data: { test: true, message: 'Maal Help webhook test' } },
    }).returning({ id: t.webhookDeliveries.id });
    await enqueue(db(), 'webhooks.deliver', { deliveryId: delivery!.id }, { tenantId: ctx.tenantId, maxAttempts: 1 });
    return { queued: true };
  });
}
