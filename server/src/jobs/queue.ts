import { hostname } from 'node:os';
import { sql } from 'drizzle-orm';
import { db, rows, t, type DbOrTx } from '../db';

export type JobHandler = (payload: Record<string, unknown>, job: { id: string; tenantId: string | null; attempts: number }) => Promise<unknown>;
const handlers = new Map<string, JobHandler>();

export function registerJob(name: string, handler: JobHandler): void {
  handlers.set(name, handler);
}

export interface EnqueueOptions {
  tenantId?: string | null;
  runAt?: Date;
  maxAttempts?: number;
  /** Prevents duplicate scheduled jobs (e.g. one daily briefing per tenant per day). */
  dedupeKey?: string;
}

/** Adds a job inside the caller's transaction, so it only runs if the work commits. */
export async function enqueue(dbx: DbOrTx, name: string, payload: Record<string, unknown>, opts: EnqueueOptions = {}): Promise<void> {
  await dbx.insert(t.jobs).values({
    name,
    payload,
    tenantId: opts.tenantId ?? null,
    runAt: opts.runAt ?? new Date(),
    maxAttempts: opts.maxAttempts ?? 3,
    dedupeKey: opts.dedupeKey ?? null,
  }).onConflictDoNothing();
}

const WORKER_ID = `${hostname()}:${process.pid}`;

/**
 * Claims and runs due jobs. `FOR UPDATE SKIP LOCKED` lets several API instances
 * share the queue safely. Failed jobs retry with exponential backoff.
 */
export async function runDueJobs(limit = 10): Promise<number> {
  const claimed = await rows<{ id: string; name: string; payload: Record<string, unknown>; tenant_id: string | null; attempts: number; max_attempts: number }>(db(), sql`
    UPDATE jobs SET status = 'running', locked_at = now(), locked_by = ${WORKER_ID}, attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM jobs WHERE status = 'queued' AND run_at <= now()
      ORDER BY run_at LIMIT ${limit} FOR UPDATE SKIP LOCKED
    )
    RETURNING id, name, payload, tenant_id, attempts, max_attempts`);

  for (const job of claimed) {
    const handler = handlers.get(job.name);
    try {
      if (!handler) throw new Error(`No handler registered for job ${job.name}`);
      const result = await handler(job.payload, { id: job.id, tenantId: job.tenant_id, attempts: job.attempts });
      await db().execute(sql`UPDATE jobs SET status = 'completed', completed_at = now(), result = ${JSON.stringify(result ?? null)}::jsonb, last_error = NULL WHERE id = ${job.id}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retry = job.attempts < job.max_attempts;
      const backoffSeconds = 30 * 2 ** (job.attempts - 1);
      await db().execute(sql`
        UPDATE jobs SET status = ${retry ? 'queued' : 'failed'}, last_error = ${message.slice(0, 2000)},
          run_at = CASE WHEN ${retry} THEN now() + make_interval(secs => ${backoffSeconds}) ELSE run_at END
        WHERE id = ${job.id}`);
    }
  }
  return claimed.length;
}

/** Recovers jobs left "running" by a crashed worker. */
export async function requeueStale(minutes = 15): Promise<void> {
  await db().execute(sql`UPDATE jobs SET status = 'queued' WHERE status = 'running' AND locked_at < now() - make_interval(mins => ${minutes})`);
}

/** Runs all due jobs until the queue is drained (used by tests and CLI). */
export async function drainQueue(maxRounds = 20): Promise<void> {
  for (let i = 0; i < maxRounds; i++) {
    if ((await runDueJobs(50)) === 0) return;
  }
}
