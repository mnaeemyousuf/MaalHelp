import { routeRegistry } from './http';

/** Builds an OpenAPI 3.1 document from the routes registered through Router. */
export function buildOpenApi(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routeRegistry) {
    const path = r.url.replace(/:(\w+)/g, '{$1}');
    const params = [...r.url.matchAll(/:(\w+)/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    const query = r.query as { properties?: Record<string, unknown>; required?: string[] } | undefined;
    const queryParams = query?.properties
      ? Object.entries(query.properties).map(([name, schema]) => ({ name, in: 'query', required: query.required?.includes(name) ?? false, schema }))
      : [];
    paths[path] ??= {};
    paths[path]![r.method.toLowerCase()] = {
      tags: [r.tag],
      summary: r.summary,
      description: [r.description, r.permission ? `Requires one of: \`${r.permission.join('`, `')}\`` : '', r.auth === 'public' ? 'Public endpoint.' : ''].filter(Boolean).join('\n\n') || undefined,
      security: r.auth === 'public' ? [] : [{ session: [] }],
      parameters: [...params, ...queryParams],
      ...(r.body ? { requestBody: { required: true, content: { 'application/json': { schema: r.body } } } } : {}),
      responses: {
        200: { description: 'Success', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
        400: { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        401: { description: 'Not signed in' },
        403: { description: 'Forbidden' },
        409: { description: 'Business rule conflict (e.g. INSUFFICIENT_STOCK)' },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Maal Help API',
      version: '1.0.0',
      description: 'Maal Help — Your Warehouse. Under Control. REST API. All tenant data is scoped by the authenticated session. State-changing requests require the `X-Requested-With: stockpilot` header. Send `Idempotency-Key` on operational POSTs to make retries safe.',
    },
    servers: [{ url: '/' }],
    components: {
      securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: 'sp_session' } },
      schemas: {
        Success: { type: 'object', properties: { success: { const: true }, data: {}, meta: { type: 'object' } } },
        Error: {
          type: 'object',
          properties: { success: { const: false }, error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, details: {} } } },
        },
      },
    },
    paths,
  };
}
