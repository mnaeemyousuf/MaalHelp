import { z } from 'zod';
import { asc, desc, eq, sql } from 'drizzle-orm';
import { db, dbHandle, num, one, rows, t } from '../../db';
import { idParam, type Router } from '../../core/http';
import { notFound } from '../../core/errors';
import { audit } from '../../core/audit';
import { metrics } from '../../core/metrics';
import { mistral } from '../../ai/mistral';
import type { Ctx } from '../../core/context';

const limitsSchema = z.object({ users: z.number().int(), warehouses: z.number().int(), skus: z.number().int(), monthlyTransactions: z.number().int(), monthlyAiRequests: z.number().int(), storageMb: z.number().int(), integrations: z.number().int() });

/** Platform actions are audited without a tenant id. */
const platformAudit = (ctx: Ctx, action: string, entityType: string, entityId: string, newValue?: unknown, oldValue?: unknown) =>
  audit(db(), { ...ctx, tenantId: '' }, { action, entityType, entityId, newValue, oldValue });

export function registerPlatformRoutes(r: Router) {
  r.get('/overview', { summary: 'Platform analytics (aggregate counts only)', auth: 'platform' }, async () => {
    const row = await one<Record<string, string>>(db(), sql`SELECT
      (SELECT COUNT(*) FROM tenants) AS tenants, (SELECT COUNT(*) FROM tenants WHERE status = 'active') AS active, (SELECT COUNT(*) FROM tenants WHERE status = 'trial') AS trial, (SELECT COUNT(*) FROM tenants WHERE status = 'suspended') AS suspended,
      (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM sessions WHERE expires_at > now() AND last_seen_at > now() - interval '1 day') AS active_sessions,
      (SELECT COUNT(*) FROM inventory_transactions WHERE created_at >= date_trunc('month', now())) AS transactions_mtd,
      (SELECT COUNT(*) FROM ai_usage WHERE created_at >= date_trunc('month', now())) AS ai_requests_mtd, (SELECT COALESCE(SUM(cost_usd), 0) FROM ai_usage WHERE created_at >= date_trunc('month', now())) AS ai_cost_mtd,
      (SELECT COALESCE(SUM(p.price_monthly), 0) FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.status = 'active') AS mrr,
      (SELECT COUNT(*) FROM support_tickets WHERE status <> 'resolved') AS open_tickets`);
    const signups = await rows(db(), sql`SELECT to_char(date_trunc('month', created_at), 'Mon YY') AS label, COUNT(*)::int AS tenants FROM tenants WHERE created_at >= now() - interval '6 months' GROUP BY date_trunc('month', created_at) ORDER BY date_trunc('month', created_at)`);
    return { ...Object.fromEntries(Object.entries(row ?? {}).map(([k, v]) => [k, num(v)])), signups };
  });

  r.get('/tenants', { summary: 'Tenants with plan, status and usage counts', auth: 'platform', query: z.object({ q: z.string().max(100).optional() }) }, async ({ query }) => {
    const like = query.q ? `%${query.q.toLowerCase()}%` : null;
    return rows(db(), sql`SELECT t.id, t.name, t.slug, t.city, t.country, t.status, t.base_currency AS "baseCurrency", t.created_at AS "createdAt", p.code AS "planCode", p.name AS "planName", t.plan_id AS "planId",
      (SELECT COUNT(*)::int FROM memberships m WHERE m.tenant_id = t.id) AS users, (SELECT COUNT(*)::int FROM warehouses w WHERE w.tenant_id = t.id) AS warehouses,
      (SELECT COUNT(*)::int FROM products pr WHERE pr.tenant_id = t.id) AS skus, (SELECT COUNT(*)::int FROM inventory_transactions it WHERE it.tenant_id = t.id AND it.created_at >= date_trunc('month', now())) AS "transactionsMtd",
      (SELECT COUNT(*)::int FROM ai_usage a WHERE a.tenant_id = t.id AND a.created_at >= date_trunc('month', now())) AS "aiRequestsMtd",
      (SELECT s.status FROM subscriptions s WHERE s.tenant_id = t.id ORDER BY s.created_at DESC LIMIT 1) AS "subscriptionStatus",
      (SELECT s.current_period_end FROM subscriptions s WHERE s.tenant_id = t.id ORDER BY s.created_at DESC LIMIT 1) AS "periodEnd"
      FROM tenants t LEFT JOIN plans p ON p.id = t.plan_id ${like ? sql`WHERE lower(t.name) LIKE ${like} OR lower(t.slug) LIKE ${like}` : sql``} ORDER BY t.created_at DESC LIMIT 500`);
  });

  r.patch('/tenants/:id', { summary: 'Change a tenant status or plan', auth: 'platform', params: idParam, body: z.object({ status: z.enum(['active', 'trial', 'suspended']).optional(), planId: z.string().uuid().optional() }) }, async ({ ctx, params, body }) => {
    const [before] = await db().select({ status: t.tenants.status, planId: t.tenants.planId }).from(t.tenants).where(eq(t.tenants.id, params.id)).limit(1);
    if (!before) throw notFound('Tenant');
    await db().transaction(async (tx) => {
      await tx.update(t.tenants).set({ ...body, updatedAt: new Date() }).where(eq(t.tenants.id, params.id));
      if (body.planId && body.planId !== before.planId) {
        const start = new Date();
        await tx.insert(t.subscriptions).values({ tenantId: params.id, planId: body.planId, status: body.status === 'trial' ? 'trialing' : 'active', currentPeriodStart: start.toISOString().slice(0, 10), currentPeriodEnd: new Date(start.getTime() + 30 * 86400_000).toISOString().slice(0, 10) });
      }
      if (body.status === 'suspended') await tx.delete(t.sessions).where(eq(t.sessions.tenantId, params.id));
    });
    await platformAudit(ctx, 'platform.tenant_updated', 'tenant', params.id, body, before);
    return { ok: true };
  });

  r.get('/plans', { summary: 'Subscription plans and limits', auth: 'platform' }, async () => db().select().from(t.plans).orderBy(asc(t.plans.sortOrder)));
  const planBody = z.object({ code: z.string().regex(/^[a-z0-9_]{2,30}$/), name: z.string().min(2).max(60), description: z.string().max(300).default(''), priceMonthly: z.number().min(0), currency: z.string().length(3).default('PKR'), limits: limitsSchema, features: z.array(z.string()).default([]), sortOrder: z.number().int().default(0), active: z.boolean().default(true) });
  r.post('/plans', { summary: 'Create a plan', auth: 'platform', body: planBody }, async ({ ctx, body }) => {
    const [p] = await db().insert(t.plans).values(body).returning();
    await platformAudit(ctx, 'platform.plan_created', 'plan', p!.id, body);
    return p;
  });
  r.patch('/plans/:id', { summary: 'Update plan price, limits or features', auth: 'platform', params: idParam, body: planBody.partial() }, async ({ ctx, params, body }) => {
    const [p] = await db().update(t.plans).set(body).where(eq(t.plans.id, params.id)).returning();
    if (!p) throw notFound('Plan');
    await platformAudit(ctx, 'platform.plan_updated', 'plan', p.id, body);
    return p;
  });

  r.get('/feature-flags', { summary: 'Feature flags', auth: 'platform' }, async () => db().select().from(t.featureFlags).orderBy(asc(t.featureFlags.key)));
  const flagBody = z.object({ key: z.string().regex(/^[a-z0-9_.]{2,60}$/), description: z.string().max(300).default(''), enabled: z.boolean().default(false), tenantOverrides: z.record(z.string(), z.boolean()).default({}) });
  r.post('/feature-flags', { summary: 'Create a feature flag', auth: 'platform', body: flagBody }, async ({ ctx, body }) => {
    const [f] = await db().insert(t.featureFlags).values(body).returning();
    await platformAudit(ctx, 'platform.flag_created', 'feature_flag', f!.id, body);
    return f;
  });
  r.patch('/feature-flags/:id', { summary: 'Toggle a flag globally or per tenant', auth: 'platform', params: idParam, body: flagBody.partial() }, async ({ ctx, params, body }) => {
    const [f] = await db().update(t.featureFlags).set(body).where(eq(t.featureFlags.id, params.id)).returning();
    if (!f) throw notFound('Feature flag');
    await platformAudit(ctx, 'platform.flag_updated', 'feature_flag', f.id, body);
    return f;
  });

  r.get('/health', { summary: 'System health: database, job queue, request metrics, AI configuration', auth: 'platform' }, async () => {
    const started = Date.now();
    let dbOk = true;
    try { await db().execute(sql`SELECT 1`); } catch { dbOk = false; }
    const jobs = await rows<Record<string, string>>(db(), sql`SELECT name, status, COUNT(*) AS n, MAX(last_error) AS last_error FROM jobs WHERE created_at >= now() - interval '7 days' GROUP BY name, status ORDER BY name`);
    const [size] = await rows<{ bytes: string }>(db(), sql`SELECT pg_database_size(current_database()) AS bytes`);
    return {
      database: { ok: dbOk, driver: dbHandle().driver, latencyMs: Date.now() - started, sizeMb: Math.round(num(size?.bytes) / 1048576) },
      jobs: jobs.map((j) => ({ name: j.name, status: j.status, count: num(j.n), lastError: j.last_error })),
      requests: metrics.snapshot(),
      ai: { configured: mistral.configured },
      node: process.version,
    };
  });

  r.get('/ai-usage', { summary: 'AI usage by tenant and feature (month to date)', auth: 'platform' }, async () =>
    rows(db(), sql`SELECT COALESCE(t.name, 'Platform') AS tenant, a.feature, a.model, a.status, COUNT(*)::int AS requests, SUM(a.total_tokens)::int AS tokens, SUM(a.cost_usd)::float AS "costUsd", ROUND(AVG(a.latency_ms))::int AS "avgLatencyMs"
      FROM ai_usage a LEFT JOIN tenants t ON t.id = a.tenant_id WHERE a.created_at >= date_trunc('month', now()) GROUP BY 1, 2, 3, 4 ORDER BY requests DESC`));

  r.get('/support', { summary: 'Support tickets from all tenants', auth: 'platform' }, async () =>
    rows(db(), sql`SELECT s.*, t.name AS tenant_name, u.email AS created_by_email FROM support_tickets s JOIN tenants t ON t.id = s.tenant_id LEFT JOIN users u ON u.id = s.created_by ORDER BY (s.status = 'resolved'), s.created_at DESC LIMIT 200`));
  r.patch('/support/:id', { summary: 'Update a support ticket', auth: 'platform', params: idParam, body: z.object({ status: z.enum(['open', 'in_progress', 'resolved']) }) }, async ({ ctx, params, body }) => {
    const [s] = await db().update(t.supportTickets).set({ status: body.status, resolvedAt: body.status === 'resolved' ? new Date() : null }).where(eq(t.supportTickets.id, params.id)).returning();
    if (!s) throw notFound('Ticket');
    await platformAudit(ctx, 'platform.ticket_updated', 'support_ticket', s.id, body);
    return s;
  });

  r.get('/audit', { summary: 'Platform-level audit trail', auth: 'platform' }, async () =>
    db().select().from(t.auditLogs).where(sql`${t.auditLogs.tenantId} IS NULL`).orderBy(desc(t.auditLogs.createdAt)).limit(200));
}

/** Tenant-side support and effective feature flags. */
export function registerSupportRoutes(r: Router) {
  r.post('/', { summary: 'Contact platform support', body: z.object({ subject: z.string().trim().min(3).max(160), body: z.string().trim().min(5).max(4000), priority: z.enum(['low', 'normal', 'high']).default('normal') }) }, async ({ ctx, body }) => {
    const [s] = await db().insert(t.supportTickets).values({ tenantId: ctx.tenantId, ...body, createdBy: ctx.userId }).returning();
    await audit(db(), ctx, { action: 'support.ticket_created', entityType: 'support_ticket', entityId: s!.id, newValue: { subject: body.subject } });
    return s;
  });
  r.get('/', { summary: 'My company support tickets' }, async ({ ctx }) =>
    db().select().from(t.supportTickets).where(eq(t.supportTickets.tenantId, ctx.tenantId)).orderBy(desc(t.supportTickets.createdAt)).limit(50));
  r.get('/feature-flags', { summary: 'Effective feature flags for my company' }, async ({ ctx }) => {
    const flags = await db().select().from(t.featureFlags);
    return Object.fromEntries(flags.map((f) => [f.key, f.tenantOverrides[ctx.tenantId] ?? f.enabled]));
  });
}
