import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { sql, type SQL } from 'drizzle-orm';
import * as schema from './schema';
import { env } from '../config/env';

export type Schema = typeof schema;
export type Db = PgDatabase<PgQueryResultHKT, Schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Anything that can run a query: the root database or an open transaction. */
export type DbOrTx = Db | Tx;

export interface DatabaseHandle {
  db: Db;
  driver: 'pglite' | 'postgres';
  migrate: () => Promise<void>;
  close: () => Promise<void>;
}

export const MIGRATIONS_FOLDER = resolve(process.cwd(), 'server/drizzle');

/**
 * Opens the database.
 *  - DATABASE_URL set  → node-postgres pool against managed PostgreSQL (production).
 *  - otherwise         → PGlite: the real PostgreSQL engine compiled to WASM, running
 *                        in-process. Same SQL, same migrations, zero install.
 *    `dataDir` of "memory://" gives an ephemeral database (tests).
 */
export async function openDatabase(opts: { url?: string; dataDir?: string } = {}): Promise<DatabaseHandle> {
  const url = opts.url ?? env.DATABASE_URL;
  if (url) {
    const { Pool } = (await import('pg')).default;
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    const dbSchema = env.DB_SCHEMA;
    if (dbSchema && !/^[a-z_][a-z0-9_]*$/.test(dbSchema)) throw new Error('DB_SCHEMA must be a lowercase identifier.');
    // With DB_SCHEMA every connection sees only that schema, so tables never mix with other apps' tables.
    const pool = new Pool({ connectionString: url, max: env.DB_POOL_MAX, ...(dbSchema ? { options: `-c search_path=${dbSchema}` } : {}) });
    const db = drizzle(pool, { schema, casing: 'snake_case' }) as unknown as Db;
    return {
      db,
      driver: 'postgres',
      migrate: async () => {
        if (dbSchema) await pool.query(`CREATE SCHEMA IF NOT EXISTS "${dbSchema}"`);
        await migrate(db as never, { migrationsFolder: MIGRATIONS_FOLDER, ...(dbSchema ? { migrationsSchema: dbSchema } : {}) });
      },
      close: () => pool.end(),
    };
  }

  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const { migrate } = await import('drizzle-orm/pglite/migrator');
  const dataDir = opts.dataDir ?? env.PGLITE_DIR;
  if (!dataDir.startsWith('memory://')) mkdirSync(resolve(dataDir), { recursive: true });
  const client = new PGlite(dataDir.startsWith('memory://') ? dataDir : resolve(dataDir));
  await client.waitReady;
  const db = drizzle(client, { schema, casing: 'snake_case' }) as unknown as Db;
  return {
    db,
    driver: 'pglite',
    migrate: () => migrate(db as never, { migrationsFolder: MIGRATIONS_FOLDER }),
    close: () => client.close(),
  };
}

/** Runs a raw SQL query and returns typed rows (works for both drivers). */
export async function rows<T = Record<string, unknown>>(dbx: DbOrTx, query: SQL): Promise<T[]> {
  const result = (await dbx.execute(query)) as unknown as { rows: T[] };
  return result.rows;
}

export async function one<T = Record<string, unknown>>(dbx: DbOrTx, query: SQL): Promise<T | undefined> {
  return (await rows<T>(dbx, query))[0];
}

/** Coerces numeric strings returned by raw SQL aggregates into numbers. */
export function num(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export { sql };
