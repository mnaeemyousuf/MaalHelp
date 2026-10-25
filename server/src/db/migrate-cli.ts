import { openDatabase } from './client';
import { setDatabase } from './index';
import { ensurePlatformData } from './seed';

const handle = await openDatabase();
setDatabase(handle);
await handle.migrate();
await ensurePlatformData();
console.info(`Migrations applied (${handle.driver}).`);
await handle.close();
