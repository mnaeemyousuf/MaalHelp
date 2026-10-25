import { openDatabase } from './client';
import { setDatabase } from './index';
import { demoExists, ensurePlatformData, seedDemo } from './seed';
import { isProd } from '../config/env';

if (isProd && !process.argv.includes('--force-demo')) {
  console.error('Refusing to seed demo data in production. Pass --force-demo to a dedicated demo environment only.');
  process.exit(1);
}
const handle = await openDatabase();
setDatabase(handle);
await handle.migrate();
await ensurePlatformData();
if (await demoExists()) {
  console.info('Demo company already exists. Run "npm run db:reset" to rebuild it from scratch.');
} else {
  await seedDemo();
}
await handle.close();
process.exit(0);
