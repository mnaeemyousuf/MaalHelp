import type { FastifyInstance } from 'fastify';
import { openDatabase, type DatabaseHandle } from '../server/src/db/client';
import { setDatabase } from '../server/src/db/index';
import { ensurePlatformData } from '../server/src/db/seed';
import { buildApp } from '../server/src/app';

export interface TestEnv { app: FastifyInstance; db: DatabaseHandle }

/** Fresh in-memory PostgreSQL (PGlite) with all migrations, plus the real Fastify app. */
export async function createTestEnv(): Promise<TestEnv> {
  const handle = await openDatabase({ dataDir: 'memory://' });
  setDatabase(handle);
  await handle.migrate();
  await ensurePlatformData();
  const app = await buildApp();
  return { app, db: handle };
}

export class Client {
  cookie = '';
  constructor(private readonly app: FastifyInstance) {}

  async request(method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) {
    const res = await this.app.inject({ method: method as never, url: `/api/v1${url}`, payload: payload as never, headers: { 'x-requested-with': 'stockpilot', cookie: `sp_session=${this.cookie}`, ...headers } });
    const sc = res.cookies.find((c) => c.name === 'sp_session');
    if (sc?.value) this.cookie = sc.value;
    const body = res.body ? JSON.parse(res.body) : {};
    return { status: res.statusCode, body, data: body.data, error: body.error };
  }
  /** Returns data, throwing with the API error message on failure. */
  async ok<T = any>(method: string, url: string, payload?: unknown, headers?: Record<string, string>): Promise<T> {
    const r = await this.request(method, url, payload, headers);
    if (r.status >= 300) throw new Error(`${method} ${url} → ${r.status} ${r.error?.code}: ${r.error?.message}`);
    return r.data as T;
  }
  get<T = any>(url: string) { return this.ok<T>('GET', url); }
  post<T = any>(url: string, payload: unknown = {}, headers?: Record<string, string>) { return this.ok<T>('POST', url, payload, headers); }
}

export const PASSWORD = 'TestPassw0rd!2026';

/** Registers a company and returns an owner client. */
export async function newCompany(app: FastifyInstance, name: string): Promise<{ owner: Client; tenantId: string }> {
  const owner = new Client(app);
  const email = `owner+${name.toLowerCase().replace(/\W+/g, '')}@test.local`;
  const data = await owner.post<{ tenantId: string }>('/auth/register', { company: name, name: `${name} Owner`, email, password: PASSWORD, city: 'Karachi' });
  return { owner, tenantId: data.tenantId };
}

export async function addUser(app: FastifyInstance, owner: Client, roleKey: string, tag: string): Promise<Client> {
  const roles = await owner.get<{ id: string; key: string }[]>('/roles');
  const email = `${roleKey}.${tag}@test.local`;
  await owner.post('/users', { name: `${roleKey} ${tag}`, email, roleId: roles.find((r) => r.key === roleKey)!.id, password: PASSWORD });
  const c = new Client(app);
  await c.post('/auth/login', { email, password: PASSWORD });
  return c;
}

/** Warehouse with one zone of 2 aisles × 1 rack × 1 shelf × 2 bins (4 bins) plus docks. */
export async function setupWarehouse(owner: Client, code = 'TST-01') {
  const wh = await owner.post<{ id: string }>('/warehouses', { code, name: `Test ${code}`, city: 'Karachi', capacity: 100, capacityUnit: 'pallets' });
  await owner.post(`/warehouses/${wh.id}/locations/generate`, { zoneCode: 'A', aisles: 2, racksPerAisle: 1, shelvesPerRack: 1, binsPerShelf: 2, binCapacityUnits: 0, binVolumeM3: 10 });
  const locations = await owner.get<any[]>(`/warehouses/${wh.id}/locations?leafOnly=true`);
  const bins = locations.filter((l) => l.type === 'bin').sort((a, b) => a.code.localeCompare(b.code));
  const dock = locations.find((l) => l.isReceiving)!;
  const dispatch = locations.find((l) => l.isDispatch)!;
  return { id: wh.id, bins, dock, dispatch };
}

export async function createProduct(owner: Client, sku: string, extra: Record<string, unknown> = {}) {
  return owner.post<{ id: string; sku: string; barcode: string | null }>('/products', { sku, name: `Product ${sku}`, costPrice: 100, sellingPrice: 150, reorderLevel: 10, reorderQty: 50, barcode: `B${sku}`, volumeM3: 0.01, ...extra });
}

/** Sum of available company stock for a product (from the API). */
export async function stockOf(owner: Client, productId: string, status?: string) {
  const res = await owner.request('GET', `/inventory?productId=${productId}&pageSize=200${status ? `&status=${status}` : ''}`);
  return (res.data as any[]).reduce((s, b) => s + Number(b.quantity), 0);
}
