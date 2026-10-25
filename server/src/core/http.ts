import type { FastifyInstance, FastifyReply, FastifyRequest, HTTPMethods } from 'fastify';
import { z, type ZodType } from 'zod';
import { and, eq } from 'drizzle-orm';
import type { Permission } from '@shared/permissions';
import { badRequest, forbidden, unauthorized } from './errors';
import type { Ctx } from './context';
import { resolveSession } from '../modules/auth/session';
import { db, t } from '../db';

export type AuthMode = 'public' | 'user' | 'tenant' | 'platform';

export interface RouteOptions<B extends ZodType | undefined, Q extends ZodType | undefined, P extends ZodType | undefined> {
  summary: string;
  auth?: AuthMode;
  /** Caller needs at least one of these permissions. */
  permission?: Permission | Permission[];
  body?: B;
  query?: Q;
  params?: P;
  /** Honour an Idempotency-Key header (offline sync / retries). */
  idempotent?: boolean;
  rateLimit?: { max: number; timeWindow: string };
  description?: string;
}

type Infer<S> = S extends ZodType ? z.output<S> : undefined;

export interface HandlerArgs<B, Q, P> {
  ctx: Ctx;
  body: B;
  query: Q;
  params: P;
  req: FastifyRequest;
  reply: FastifyReply;
}

/** Wrap list results to include pagination metadata in the envelope. */
export class Paged<T> {
  constructor(public readonly data: T[], public readonly meta: { page: number; pageSize: number; total: number; pageCount: number }) {}
}
export function paged<T>(data: T[], total: number, page: number, pageSize: number): Paged<T> {
  return new Paged(data, { page, pageSize, total, pageCount: Math.max(1, Math.ceil(total / pageSize)) });
}
/** Returned by handlers that already wrote the response (files, streams). */
export const SENT = Symbol('sent');

export interface RegisteredRoute {
  method: string;
  url: string;
  tag: string;
  summary: string;
  description?: string;
  auth: AuthMode;
  permission?: Permission[];
  body?: unknown;
  query?: unknown;
}
export const routeRegistry: RegisteredRoute[] = [];

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function toJsonSchema(schema: ZodType | undefined): unknown {
  if (!schema) return undefined;
  try {
    return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  } catch {
    return undefined;
  }
}

function parse<S extends ZodType | undefined>(schema: S, value: unknown, where: string): Infer<S> {
  if (!schema) return undefined as Infer<S>;
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    const first = issues[0];
    throw badRequest(first ? `${first.path ? `${first.path}: ` : ''}${first.message}` : `Invalid ${where}.`, issues);
  }
  return result.data as Infer<S>;
}

export class Router {
  constructor(private readonly app: FastifyInstance, private readonly prefix: string, private readonly tag: string) {}

  get<Q extends ZodType | undefined = undefined, P extends ZodType | undefined = undefined>(url: string, opts: RouteOptions<undefined, Q, P>, handler: (a: HandlerArgs<undefined, Infer<Q>, Infer<P>>) => Promise<unknown>) {
    this.add('GET', url, opts, handler);
  }
  post<B extends ZodType | undefined = undefined, Q extends ZodType | undefined = undefined, P extends ZodType | undefined = undefined>(url: string, opts: RouteOptions<B, Q, P>, handler: (a: HandlerArgs<Infer<B>, Infer<Q>, Infer<P>>) => Promise<unknown>) {
    this.add('POST', url, opts, handler);
  }
  put<B extends ZodType | undefined = undefined, Q extends ZodType | undefined = undefined, P extends ZodType | undefined = undefined>(url: string, opts: RouteOptions<B, Q, P>, handler: (a: HandlerArgs<Infer<B>, Infer<Q>, Infer<P>>) => Promise<unknown>) {
    this.add('PUT', url, opts, handler);
  }
  patch<B extends ZodType | undefined = undefined, Q extends ZodType | undefined = undefined, P extends ZodType | undefined = undefined>(url: string, opts: RouteOptions<B, Q, P>, handler: (a: HandlerArgs<Infer<B>, Infer<Q>, Infer<P>>) => Promise<unknown>) {
    this.add('PATCH', url, opts, handler);
  }
  delete<Q extends ZodType | undefined = undefined, P extends ZodType | undefined = undefined>(url: string, opts: RouteOptions<undefined, Q, P>, handler: (a: HandlerArgs<undefined, Infer<Q>, Infer<P>>) => Promise<unknown>) {
    this.add('DELETE', url, opts, handler);
  }

  private add(method: HTTPMethods, url: string, opts: RouteOptions<ZodType | undefined, ZodType | undefined, ZodType | undefined>, handler: (a: HandlerArgs<any, any, any>) => Promise<unknown>) {
    const fullUrl = `${this.prefix}${url}`.replace(/\/$/, '') || '/';
    const auth = opts.auth ?? 'tenant';
    const perms = opts.permission ? (Array.isArray(opts.permission) ? opts.permission : [opts.permission]) : undefined;
    routeRegistry.push({ method, url: fullUrl, tag: this.tag, summary: opts.summary, description: opts.description, auth, permission: perms, body: toJsonSchema(opts.body), query: toJsonSchema(opts.query) });

    this.app.route({
      method,
      url: fullUrl,
      config: opts.rateLimit ? { rateLimit: opts.rateLimit } : {},
      handler: async (req, reply) => {
        let ctx: Ctx | null = null;
        if (auth !== 'public') {
          ctx = await resolveSession(req, auth);
          if (!ctx) throw unauthorized();
          if (STATE_CHANGING.has(method)) assertCsrfSafe(req);
          if (auth === 'platform' && !ctx.isPlatformAdmin) throw forbidden('Platform administrator access is required.');
          if (perms && !perms.some((p) => ctx!.permissions.has(p))) throw forbidden();
        }
        const body = parse(opts.body, req.body, 'body');
        const query = parse(opts.query, req.query, 'query');
        const params = parse(opts.params, req.params, 'parameters');

        const idemKey = opts.idempotent && ctx ? String(req.headers['idempotency-key'] ?? '').slice(0, 200) : '';
        if (idemKey && ctx) {
          const [cached] = await db().select().from(t.idempotencyKeys)
            .where(and(eq(t.idempotencyKeys.tenantId, ctx.tenantId), eq(t.idempotencyKeys.key, idemKey))).limit(1);
          if (cached) {
            reply.header('idempotent-replay', 'true');
            return reply.status(cached.statusCode).send(cached.response);
          }
        }

        const result = await handler({ ctx: ctx as Ctx, body, query, params, req, reply });
        if (result === SENT) return reply;
        const status = method === 'POST' ? 201 : 200;
        const payload = result instanceof Paged
          ? { success: true, data: result.data, meta: result.meta }
          : { success: true, data: result ?? null };

        if (idemKey && ctx) {
          await db().insert(t.idempotencyKeys).values({
            tenantId: ctx.tenantId, key: idemKey, userId: ctx.userId, method, path: fullUrl, statusCode: status, response: payload,
          }).onConflictDoNothing();
        }
        return reply.status(status).send(payload);
      },
    });
  }
}

/**
 * CSRF defence for cookie-authenticated, state-changing requests:
 *  1. Session cookie is SameSite=Lax.
 *  2. A custom header is required — browsers cannot add it cross-site without a CORS
 *     preflight, which this API never grants.
 *  3. If an Origin header is present it must match this host or APP_ORIGIN.
 */
function assertCsrfSafe(req: FastifyRequest): void {
  if (req.headers['x-requested-with'] !== 'stockpilot') {
    throw forbidden('Missing anti-forgery header.');
  }
  const origin = req.headers.origin;
  if (origin) {
    let host = '';
    try { host = new URL(origin).host; } catch { throw forbidden('Invalid request origin.'); }
    const allowed = new Set([req.headers.host, safeHost(process.env.APP_ORIGIN)]);
    if (!allowed.has(host)) throw forbidden('Request origin is not allowed.');
  }
}

function safeHost(url: string | undefined): string | undefined {
  try { return url ? new URL(url).host : undefined; } catch { return undefined; }
}

/** Common query schemas. */
export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  q: z.string().trim().max(120).optional(),
  sort: z.string().max(60).optional(),
  dir: z.enum(['asc', 'desc']).default('desc'),
});
export type PageQuery = z.infer<typeof pageQuery>;

export const idParam = z.object({ id: z.string().uuid('Invalid id.') });
export const uuid = () => z.string().uuid();
export const optionalUuid = () => z.string().uuid().nullish().transform((v) => v ?? null);
export const positive = () => z.coerce.number().positive();
export const nonNegative = () => z.coerce.number().min(0);
export const isoDate = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
