import { env, isProd } from './config/env';
import { openDatabase } from './db/client';
import { setDatabase } from './db';
import { buildApp } from './app';
import { startWorker, stopWorker } from './jobs/handlers';
import { ensurePlatformData, seedDemo } from './db/seed';

async function main() {
  const handle = await openDatabase();
  setDatabase(handle);
  await handle.migrate();
  await ensurePlatformData();

  const app = await buildApp();
  if (env.SEED_DEMO && !isProd) await seedDemo({ ifEmpty: true, app });
  await app.listen({ port: env.PORT, host: env.HOST });
  if (env.SEED_DEMO && isProd && env.ALLOW_DEMO_SEED_IN_PRODUCTION) {
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
