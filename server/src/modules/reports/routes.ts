import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { db, num, rows, t } from '../../db';
import { isoDate, paged, SENT, type Router } from '../../core/http';
import { badRequest, forbidden, notFound } from '../../core/errors';
import { audit } from '../../core/audit';
import type { Ctx } from '../../core/context';
import { REPORTS, reportByKey, type ReportDefinition, type ReportFilters } from './definitions';
import { toCsv, toPdf, toXlsx } from './export';
import { BRAND } from '@shared/brand';

const EXPORT_LIMIT = 50_000;

const filterQuery = z.object({
  from: isoDate().optional(),
  to: isoDate().optional(),
  warehouseId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
  supplierId: z.string().uuid().optional(),
  productId: z.string().uuid().optional(),
  days: z.coerce.number().int().min(1).max(3650).optional(),
  q: z.string().trim().max(100).optional(),
  sort: z.string().max(60).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});
type FilterQuery = z.infer<typeof filterQuery>;

function filtersFor(ctx: Ctx, q: FilterQuery, def: ReportDefinition): ReportFilters {
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 29 * 86400_000).toISOString().slice(0, 10);
  const defaultDays = def.key === 'expiry' ? 90 : 90;
  return { tenantId: ctx.tenantId, from: q.from ?? monthAgo, to: q.to ?? today, warehouseId: q.warehouseId, categoryId: q.categoryId, customerId: q.customerId, supplierId: q.supplierId, productId: q.productId, days: q.days ?? defaultDays };
}

/** Wraps a report query with search, whitelisted sort, totals and pagination. */
async function runReport(ctx: Ctx, def: ReportDefinition, q: FilterQuery, limit: number, offset: number) {
  if (!ctx.permissions.has(def.permission)) throw forbidden();
  const f = filtersFor(ctx, q, def);
  const sortKey = def.columns.some((c) => c.key === q.sort) ? q.sort! : def.defaultSort;
  const dir = q.dir ?? (def.columns.find((c) => c.key === sortKey)?.type === 'text' ? 'asc' : 'desc');
  const search = q.q ? sql`WHERE lower(r::text) LIKE ${`%${q.q.toLowerCase()}%`}` : sql``;
  const totalsSelect = def.totals?.length ? sql.raw(def.totals.map((k) => `SUM(r."${k}")::float AS "${k}"`).join(', ')) : sql.raw('NULL AS none');
  const base = def.query(f);
  const [data, agg] = await Promise.all([
    rows<Record<string, unknown>>(db(), sql`SELECT r.* FROM (${base}) r ${search} ORDER BY r."${sql.raw(sortKey)}" ${sql.raw(dir === 'asc' ? 'ASC' : 'DESC')} NULLS LAST LIMIT ${limit} OFFSET ${offset}`),
    rows<Record<string, unknown>>(db(), sql`SELECT COUNT(*) AS total_count, ${totalsSelect} FROM (${base}) r ${search}`),
  ]);
  const totals = def.totals?.length ? Object.fromEntries(def.totals.map((k) => [k, num(agg[0]?.[k])])) : null;
  const numericKeys = def.columns.filter((c) => ['money', 'number', 'percent'].includes(c.type)).map((c) => c.key);
  const normalised = data.map((r) => { const o: Record<string, unknown> = { ...r }; for (const k of numericKeys) if (o[k] !== null && o[k] !== undefined) o[k] = num(o[k]); return o; });
  return { rows: normalised, total: num(agg[0]?.total_count), totals, filters: f, sort: { key: sortKey, dir } };
}

function subtitleFor(def: ReportDefinition, f: ReportFilters, extra: string[]): string {
  const parts: string[] = [];
  if (def.filters.includes('from')) parts.push(`Period ${f.from} to ${f.to}`);
  if (def.filters.includes('days')) parts.push(`${f.days} days`);
  return [...parts, ...extra].join(' · ') || 'All records';
}

export function registerReportRoutes(r: Router) {
  r.get('/', { summary: 'Report catalogue (reports the user may run)', permission: ['report.view', 'inventory.view', 'billing.view', 'report.financial'] }, async ({ ctx }) =>
    REPORTS.filter((d) => ctx.permissions.has(d.permission)).map(({ query: _q, ...d }) => d));

  r.get('/:key', { summary: 'Run a report with filters, search, sorting and pagination', params: z.object({ key: z.string() }), query: filterQuery }, async ({ ctx, params, query }) => {
    const def = reportByKey(params.key);
    if (!def) throw notFound('Report');
    const res = await runReport(ctx, def, query, query.pageSize, (query.page - 1) * query.pageSize);
    const result = paged(res.rows, res.total, query.page, query.pageSize);
    const { query: _q, ...meta } = def;
    return Object.assign(result, { meta: { ...result.meta, report: meta, totals: res.totals, filters: res.filters, sort: res.sort, totalsScope: 'All rows matching the filters, not only this page.' } });
  });

  r.get('/:key/export', {
    summary: 'Export a report as CSV, Excel or PDF (all matching rows, up to 50,000)',
    params: z.object({ key: z.string() }),
    query: filterQuery.extend({ format: z.enum(['csv', 'xlsx', 'pdf']).default('csv') }),
  }, async ({ ctx, params, query, reply }) => {
    const def = reportByKey(params.key);
    if (!def) throw notFound('Report');
    const res = await runReport(ctx, def, query, EXPORT_LIMIT, 0);
    if (res.total > EXPORT_LIMIT) throw badRequest(`This export has ${res.total.toLocaleString()} rows. Narrow the filters to under ${EXPORT_LIMIT.toLocaleString()}.`);
    const [tenant] = await db().select({ name: t.tenants.name }).from(t.tenants).where(eq(t.tenants.id, ctx.tenantId));
    const subtitle = subtitleFor(def, res.filters, [query.q ? `Search "${query.q}"` : '', `${res.total} rows`].filter(Boolean));
    const fileBase = `${def.key}_${new Date().toISOString().slice(0, 10)}`;
    await audit(db(), ctx, { action: 'report.exported', entityType: 'report', entityId: def.key, newValue: { format: query.format, rows: res.total } });
    if (query.format === 'csv') {
      reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${fileBase}.csv"`).send(toCsv(def.columns, res.rows));
    } else if (query.format === 'xlsx') {
      reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('content-disposition', `attachment; filename="${fileBase}.xlsx"`).send(await toXlsx(def.name, subtitle, def.columns, res.rows, res.totals));
    } else {
      reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="${fileBase}.pdf"`).send(await toPdf(tenant?.name ?? BRAND.name, def.name, subtitle, def.columns, res.rows, res.totals));
    }
    return SENT;
  });
}
