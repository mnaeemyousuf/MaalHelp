import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { env, isProd, isTest } from './config/env';
import { AppError, translateDbError } from './core/errors';
import { Router } from './core/http';
import { buildOpenApi } from './core/openapi';
import { metrics } from './core/metrics';
import { registerModules } from './modules';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: isTest ? false : {
      level: env.LOG_LEVEL,
      redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
      ...(isProd ? {} : { transport: undefined }),
    },
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
    genReqId: () => crypto.randomUUID(),
  });

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'img-src': ["'self'", 'data:', 'blob:'],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
        'connect-src': ["'self'"],
        'worker-src': ["'self'", 'blob:'],
        'media-src': ["'self'", 'blob:'],
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: isProd,
  });
  await app.register(rateLimit, {
    global: true,
    max: isTest ? 100_000 : 900,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip,
    errorResponseBuilder: () => ({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down and try again shortly.' } }),
  });
  await app.register(multipart, { limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1 } });

  app.addHook('onResponse', async (req, reply) => {
    metrics.record(req.routeOptions?.url ?? req.url, reply.statusCode, reply.elapsedTime);
  });

  app.setErrorHandler((err, req, reply) => {
    const appError = err instanceof AppError ? err : translateDbError(err);
    if (appError) {
      return reply.status(appError.status).send({ success: false, error: { code: appError.code, message: appError.message, details: appError.details } });
    }
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e.statusCode === 429) return reply.status(429).send({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down and try again shortly.' } });
    if (e.code === 'FST_REQ_FILE_TOO_LARGE') return reply.status(413).send({ success: false, error: { code: 'FILE_TOO_LARGE', message: `Files must be smaller than ${env.MAX_UPLOAD_MB} MB.` } });
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ success: false, error: { code: 'BAD_REQUEST', message: e.message ?? 'Invalid request.' } });
    }
    metrics.recordError();
    req.log.error({ err }, 'Unhandled error');
    // Never leak stack traces or internals to clients.
    return reply.status(500).send({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our side. The error has been logged.' } });
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Route not found.' } });
    // SPA fallback for client-side routes
    if (webRoot) return reply.type('text/html').sendFile('index.html');
    return reply.status(404).send('Not found');
  });

  registerModules((prefix, tag) => new Router(app, `/api/v1${prefix}`, tag));

  await app.register(swagger, { mode: 'static', specification: { document: buildOpenApi() as never } });
  await app.register(swaggerUi, { routePrefix: '/api/docs', staticCSP: false });

  const webRoot = [resolve(process.cwd(), 'dist/web')].find((p) => existsSync(resolve(p, 'index.html')));
  if (webRoot) {
    // Production indexes files once at start; development serves new builds without a restart.
    await app.register(fastifyStatic, { root: webRoot, prefix: '/', wildcard: !isProd, maxAge: isProd ? '1h' : 0 });
  }

  return app;
}
