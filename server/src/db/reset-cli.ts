/**
 * Resets the local demo database: drops every table and rebuilds schema + demo data.
 * Development / demo environments only.
 */
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { env, isProd } from '../config/env';
import { openDatabase } from './client';
import { setDatabase } from './index';
import { ensurePlatformData, seedDemo } from './seed';

if (isProd) {
  console.error('db:reset is disabled in production.');
  process.exit(1);
}
if (!env.DATABASE_URL) {
  rmSync(resolve(env.PGLITE_DIR), { recursive: true, force: true });
  console.info(`Removed embedded database at ${env.PGLITE_DIR}`);
}
const handle = await openDatabase();
setDatabase(handle);
if (env.DATABASE_URL) {
  if (env.DB_SCHEMA) {
    // Shared database: only ever drop Maal Help's own schema, never public or other apps' data.
    await handle.db.execute(sql.raw(`DROP SCHEMA IF EXISTS "${env.DB_SCHEMA}" CASCADE`));
  } else {
    await handle.db.execute(sql`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await handle.db.execute(sql`DROP SCHEMA IF EXISTS drizzle CASCADE`);
  }
}
await handle.migrate();
await ensurePlatformData();
await seedDemo();
await handle.close();
process.exit(0);
