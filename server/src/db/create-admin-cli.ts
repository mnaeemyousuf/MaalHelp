/**
 * Creates (or resets the password of) a SaaS platform administrator.
 * Credentials come from the environment so they never appear in shell history or source:
 *   PLATFORM_ADMIN_EMAIL=ops@yourcompany.com PLATFORM_ADMIN_PASSWORD=... npm run admin:create
 */
import { eq } from 'drizzle-orm';
import { hashPassword } from '../core/crypto';
import { openDatabase } from './client';
import { db, setDatabase, t } from './index';

const email = process.env.PLATFORM_ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.PLATFORM_ADMIN_PASSWORD ?? '';
if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error('Set PLATFORM_ADMIN_EMAIL to a valid email address.');
  process.exit(1);
}
if (password.length < 12 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
  console.error('PLATFORM_ADMIN_PASSWORD must be at least 12 characters and contain letters and digits.');
  process.exit(1);
}

const handle = await openDatabase();
setDatabase(handle);
await handle.migrate();
const passwordHash = await hashPassword(password);
const [existing] = await db().select({ id: t.users.id }).from(t.users).where(eq(t.users.email, email)).limit(1);
if (existing) {
  await db().update(t.users).set({ passwordHash, isPlatformAdmin: true }).where(eq(t.users.id, existing.id));
  console.info(`Updated platform admin ${email}.`);
} else {
  await db().insert(t.users).values({ email, name: 'Platform Administrator', passwordHash, isPlatformAdmin: true });
  console.info(`Created platform admin ${email}.`);
}
await handle.close();
process.exit(0);
