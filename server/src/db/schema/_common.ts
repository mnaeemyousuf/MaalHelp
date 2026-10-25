import { numeric, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Quantities support fractional units (kg, metres) with 4 decimal places. */
export const qty = (name?: string) => (name ? numeric(name, { precision: 18, scale: 4, mode: 'number' }) : numeric({ precision: 18, scale: 4, mode: 'number' }));
/** Money amounts in the document currency. */
export const money = () => numeric({ precision: 18, scale: 2, mode: 'number' });
export const rate = () => numeric({ precision: 9, scale: 4, mode: 'number' });

export const pk = () => uuid().primaryKey().defaultRandom();
export const createdAt = () => timestamp({ withTimezone: true, mode: 'date' }).notNull().defaultNow();
export const updatedAt = () => timestamp({ withTimezone: true, mode: 'date' }).notNull().defaultNow();
export const ts = () => timestamp({ withTimezone: true, mode: 'date' });
