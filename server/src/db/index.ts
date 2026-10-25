import type { DatabaseHandle, Db } from './client';

let handle: DatabaseHandle | null = null;

export function setDatabase(h: DatabaseHandle): void {
  handle = h;
}

export function db(): Db {
  if (!handle) throw new Error('Database not initialised');
  return handle.db;
}

export function dbHandle(): DatabaseHandle {
  if (!handle) throw new Error('Database not initialised');
  return handle;
}

export * from './client';
export * as t from './schema';
