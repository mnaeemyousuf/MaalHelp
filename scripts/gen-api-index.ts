// Writes docs/API_ENDPOINTS.md from the live route registry (the same source as /api/docs).
// Usage: npx tsx scripts/gen-api-index.ts
import { writeFileSync } from 'node:fs';
import { buildApp } from '../server/src/app';
import { buildOpenApi } from '../server/src/core/openapi';

const app = await buildApp();
const doc = buildOpenApi() as { paths: Record<string, Record<string, { summary?: string; tags?: string[] }>> };
const byTag = new Map<string, string[]>();
let count = 0;
for (const [path, ops] of Object.entries(doc.paths)) {
  for (const [method, op] of Object.entries(ops)) {
    const tag = op.tags?.[0] ?? 'Other';
    if (!byTag.has(tag)) byTag.set(tag, []);
    byTag.get(tag)!.push(`| \`${method.toUpperCase()}\` | \`${path}\` | ${op.summary ?? ''} |`);
    count++;
  }
}
const out = ['# Maal Help — API endpoint index', '', `${count} operations, generated from the route registry by \`npx tsx scripts/gen-api-index.ts\`. Full request and response schemas: \`/api/docs\` (OpenAPI 3).`, ''];
for (const [tag, rows] of byTag) out.push(`## ${tag}`, '', '| Method | Path | Summary |', '|---|---|---|', ...rows, '');
writeFileSync('docs/API_ENDPOINTS.md', out.join('\n'));
console.log(`wrote docs/API_ENDPOINTS.md (${count} operations)`);
await app.close();
process.exit(0);
