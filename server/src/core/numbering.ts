import { sql } from 'drizzle-orm';
import { one, type DbOrTx } from '../db';

/** Document prefixes and starting numbers. */
export const SEQUENCES = {
  PO: { prefix: 'PO', start: 10001 },
  SO: { prefix: 'SO', start: 10001 },
  GRN: { prefix: 'GRN', start: 10001 },
  PUT: { prefix: 'PUT', start: 10001 },
  PICK: { prefix: 'PK', start: 10001 },
  WAVE: { prefix: 'WV', start: 1001 },
  SHP: { prefix: 'SHP', start: 10001 },
  TRF: { prefix: 'TRF', start: 1001 },
  ADJ: { prefix: 'ADJ', start: 1001 },
  CNT: { prefix: 'CNT', start: 1001 },
  RMA: { prefix: 'RMA', start: 1001 },
  PRT: { prefix: 'PRT', start: 1001 },
  INV: { prefix: 'INV', start: 10001 },
  BILL: { prefix: 'BILL', start: 10001 },
  PAY: { prefix: 'PAY', start: 10001 },
  EXP: { prefix: 'EXP', start: 1001 },
  CON: { prefix: 'SC', start: 101 },
  CUS: { prefix: 'C', start: 1001 },
  SUP: { prefix: 'S', start: 1001 },
  PKG: { prefix: 'PKG', start: 100001 },
} as const;
export type SequenceKey = keyof typeof SEQUENCES;

/** Allocates the next raw integer of an arbitrary per-tenant sequence. */
export async function nextValue(dbx: DbOrTx, tenantId: string, key: string, start = 1): Promise<number> {
  const row = await one<{ value: number }>(dbx, sql`
    INSERT INTO number_sequences (tenant_id, key, next_value) VALUES (${tenantId}, ${key}, ${start + 1})
    ON CONFLICT (tenant_id, key) DO UPDATE SET next_value = number_sequences.next_value + 1
    RETURNING next_value - 1 AS value`);
  return row!.value;
}

/** EAN-13 check digit for a 12-digit body. */
export function ean13CheckDigit(body12: string): number {
  const sum = body12.split('').reduce((s, d, i) => s + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10;
}

/** Internal EAN-13 in the 2xx "in-store" range so it never collides with GS1 retail codes. */
export async function nextInternalBarcode(dbx: DbOrTx, tenantId: string): Promise<string> {
  const n = await nextValue(dbx, tenantId, 'BARCODE', 1);
  const body = `29${String(n).padStart(10, '0')}`;
  return `${body}${ean13CheckDigit(body)}`;
}

/**
 * Allocates the next document number atomically. The upsert takes a row lock,
 * so concurrent transactions serialise and numbers are never duplicated.
 */
export async function nextNumber(dbx: DbOrTx, tenantId: string, key: SequenceKey): Promise<string> {
  const { prefix, start } = SEQUENCES[key];
  const row = await one<{ value: number }>(dbx, sql`
    INSERT INTO number_sequences (tenant_id, key, next_value) VALUES (${tenantId}, ${key}, ${start + 1})
    ON CONFLICT (tenant_id, key) DO UPDATE SET next_value = number_sequences.next_value + 1
    RETURNING next_value - 1 AS value`);
  return `${prefix}-${row!.value}`;
}
