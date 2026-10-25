import { createStore, del, entries, get as idbGet, set as idbSet } from 'idb-keyval';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export interface Envelope<T> { data: T; meta?: Record<string, any> }
export type Params = Record<string, string | number | boolean | null | undefined>;

const queueStore = createStore('stockpilot-offline', 'queue');
const cacheStore = createStore('stockpilot-cache', 'responses');
const issueStore = createStore('stockpilot-sync', 'issues');

export interface QueuedRequest { id: string; method: string; path: string; body: unknown; label: string; createdAt: number }
export interface SyncIssue extends QueuedRequest { error: string; code: string; failedAt: number }

type Listener = () => void;
const listeners = new Set<Listener>();
export function onQueueChange(fn: Listener) { listeners.add(fn); return () => listeners.delete(fn); }
const emit = () => listeners.forEach((l) => l());

export function qs(params?: Params): string {
  if (!params) return '';
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : '';
}

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

interface RequestOptions {
  /** Retries are safe: the server replays the original response for the same key. */
  idempotencyKey?: string;
  /** When offline (or the network fails), store the request and replay it later. */
  queueOffline?: { label: string };
  /** Cache successful GET responses for offline reading. */
  cache?: boolean;
  signal?: AbortSignal;
}

let unauthorizedHandler: (() => void) | null = null;
export function onUnauthorized(fn: () => void) { unauthorizedHandler = fn; }

async function raw<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<Envelope<T>> {
  const headers: Record<string, string> = { 'x-requested-with': 'stockpilot', accept: 'application/json' };
  if (body !== undefined && !(body instanceof FormData)) headers['content-type'] = 'application/json';
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
  const res = await fetch(`/api/v1${path}`, {
    method, headers, credentials: 'same-origin', signal: opts.signal,
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  let json: any = null;
  const text = await res.text();
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) {
    const err = json?.error ?? {};
    if (res.status === 401 && unauthorizedHandler && !path.startsWith('/auth/login')) unauthorizedHandler();
    throw new ApiError(res.status, err.code ?? 'HTTP_ERROR', err.message ?? (res.status >= 500 ? 'The server could not complete the request.' : 'Request failed.'), err.details);
  }
  return { data: json?.data as T, meta: json?.meta };
}

export async function request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<Envelope<T>> {
  const isWrite = method !== 'GET';
  const key = isWrite ? opts.idempotencyKey ?? (opts.queueOffline ? uuid() : undefined) : undefined;
  const cacheKey = `${path}`;
  if (isWrite && opts.queueOffline && !navigator.onLine) return enqueue(method, path, body, key!, opts.queueOffline.label) as never;
  try {
    const result = await raw<T>(method, path, body, { ...opts, idempotencyKey: key });
    if (!isWrite && opts.cache) void idbSet(cacheKey, { ...result, cachedAt: Date.now() }, cacheStore).catch(() => undefined);
    return result;
  } catch (err) {
    const network = err instanceof TypeError; // fetch failed: offline / DNS / server down
    if (network && isWrite && opts.queueOffline) return enqueue(method, path, body, key!, opts.queueOffline.label) as never;
    if (network && !isWrite && opts.cache) {
      const cached = await idbGet(cacheKey, cacheStore).catch(() => undefined);
      if (cached) return { ...(cached as Envelope<T>), meta: { ...(cached as Envelope<T>).meta, offline: true } };
    }
    if (network) throw new ApiError(0, 'NETWORK', 'No connection to the server. Check your internet and try again.');
    throw err;
  }
}

async function enqueue(method: string, path: string, body: unknown, id: string, label: string) {
  const item: QueuedRequest = { id, method, path, body, label, createdAt: Date.now() };
  await idbSet(id, item, queueStore);
  emit();
  return { data: { queued: true, id }, meta: { queued: true } };
}

export async function queuedRequests(): Promise<QueuedRequest[]> {
  return (await entries<string, QueuedRequest>(queueStore)).map(([, v]) => v).sort((a, b) => a.createdAt - b.createdAt);
}
export async function syncIssues(): Promise<SyncIssue[]> {
  return (await entries<string, SyncIssue>(issueStore)).map(([, v]) => v).sort((a, b) => a.failedAt - b.failedAt);
}
export async function dismissIssue(id: string) { await del(id, issueStore); emit(); }

let syncing = false;
/**
 * Replays queued operations in order. Each carries its idempotency key, so a
 * request that already reached the server is not applied twice. Business
 * conflicts (e.g. stock already picked by someone else) are moved to "sync
 * issues" for a person to resolve — they are never forced through.
 */
export async function syncQueue(): Promise<{ synced: number; failed: number }> {
  if (syncing || !navigator.onLine) return { synced: 0, failed: 0 };
  syncing = true;
  let synced = 0, failed = 0;
  try {
    for (const item of await queuedRequests()) {
      try {
        await raw(item.method, item.path, item.body, { idempotencyKey: item.id });
        await del(item.id, queueStore);
        synced++;
      } catch (err) {
        if (err instanceof TypeError) break; // still offline — try later
        const e = err as ApiError;
        await idbSet(item.id, { ...item, error: e.message, code: e.code, failedAt: Date.now() } satisfies SyncIssue, issueStore);
        await del(item.id, queueStore);
        failed++;
      }
    }
  } finally {
    syncing = false;
    emit();
  }
  return { synced, failed };
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => void syncQueue());
  setInterval(() => void syncQueue(), 30_000);
}

export const api = {
  get: <T>(path: string, params?: Params, opts?: RequestOptions) => request<T>('GET', `${path}${qs(params)}`, undefined, opts).then((r) => r.data),
  page: <T>(path: string, params?: Params, opts?: RequestOptions) => request<T[]>('GET', `${path}${qs(params)}`, undefined, opts),
  post: <T>(path: string, body: unknown = {}, opts?: RequestOptions) => request<T>('POST', path, body, opts).then((r) => r.data),
  put: <T>(path: string, body: unknown, opts?: RequestOptions) => request<T>('PUT', path, body, opts).then((r) => r.data),
  patch: <T>(path: string, body: unknown, opts?: RequestOptions) => request<T>('PATCH', path, body, opts).then((r) => r.data),
  del: <T>(path: string, opts?: RequestOptions) => request<T>('DELETE', path, undefined, opts).then((r) => r.data),
  upload: <T>(path: string, form: FormData) => request<T>('POST', path, form).then((r) => r.data),
  async download(path: string, params: Params | undefined, filename: string) {
    const res = await fetch(`/api/v1${path}${qs(params)}`, { credentials: 'same-origin', headers: { 'x-requested-with': 'stockpilot' } });
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      throw new ApiError(res.status, json?.error?.code ?? 'HTTP_ERROR', json?.error?.message ?? 'Download failed.');
    }
    const blob = await res.blob();
    const { downloadBlob } = await import('./utils');
    downloadBlob(blob, filename);
  },
};

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong.';
}
