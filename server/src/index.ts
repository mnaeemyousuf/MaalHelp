import { env, isProd } from './config/env';
import { openDatabase } from './db/client';
import { setDatabase } from './db';
import { buildApp } from './app';
import { startWorker, stopWorker } from './jobs/handlers';
import { sql } from 'drizzle-orm';
import { demoState, ensurePlatformData, seedDemo } from './db/seed';

async function main() {
  const handle = await openDatabase();
  setDatabase(handle);
  await handle.migrate();
  const hostedDemo = env.SEED_DEMO && isProd && env.ALLOW_DEMO_SEED_IN_PRODUCTION;
  if (hostedDemo && env.DB_SCHEMA && (await demoState()) === 'partial') {
    // A previous hosted demo seed stopped midway (restart/sleep). Rebuild only our own schema.
    console.warn(`Incomplete demo data found; rebuilding schema "${env.DB_SCHEMA}".`);
    await handle.db.execute(sql.raw(`DROP SCHEMA IF EXISTS "${env.DB_SCHEMA}" CASCADE`));
    await handle.migrate();
  }
  await ensurePlatformData();

  const app = await buildApp();
  if (env.SEED_DEMO && !isProd) await seedDemo({ ifEmpty: true, app });
  await app.listen({ port: env.PORT, host: env.HOST });
  if (hostedDemo) {
    // Hosted demo: open the port first so the platform sees a healthy service, then build the demo company.
    void seedDemo({ ifEmpty: true, app }).catch((err) => app.log.error({ err }, 'Demo seed failed'));
  }
  startWorker();
  app.log.info(`Maal Help API ready on http://localhost:${env.PORT} (database: ${handle.driver})`);

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, shutting down`);
    stopWorker();
    await app.close();
    await handle.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Failed to start Maal Help:', err);
  process.exit(1);
});
