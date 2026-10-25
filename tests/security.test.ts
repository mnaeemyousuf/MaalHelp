import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addUser, Client, createProduct, createTestEnv, newCompany, setupWarehouse, type TestEnv } from './helpers';

describe('authentication, RBAC and tenant isolation', () => {
  let env: TestEnv;
  let a: Client;
  let b: Client;
  let productA: { id: string };
  let warehouseA: Awaited<ReturnType<typeof setupWarehouse>>;

  beforeAll(async () => {
    env = await createTestEnv();
    ({ owner: a } = await newCompany(env.app, 'Alpha Traders'));
    ({ owner: b } = await newCompany(env.app, 'Beta Distributors'));
    warehouseA = await setupWarehouse(a, 'ALP-01');
    productA = await createProduct(a, 'ALP-001', { costPrice: 500 });
    await a.post('/receiving', { warehouseId: warehouseA.id, lines: [{ productId: productA.id, quantity: 50, locationId: warehouseA.bins[0].id }] });
  });
  afterAll(async () => { await env.app.close(); await env.db.close(); });

  it('rejects unauthenticated requests', async () => {
    const anon = new Client(env.app);
    const r = await anon.request('GET', '/products');
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ success: false, error: { code: 'UNAUTHENTICATED', message: expect.any(String) } });
  });

  it('rejects wrong passwords with a generic message', async () => {
    const c = new Client(env.app);
    const r = await c.request('POST', '/auth/login', { email: 'owner+alphatraders@test.local', password: 'wrong-password-1' });
    expect(r.status).toBe(401);
    expect(r.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('requires the anti-CSRF header on state-changing requests', async () => {
    const r = await env.app.inject({ method: 'POST', url: '/api/v1/products', payload: { sku: 'X-1', name: 'x' }, headers: { cookie: `sp_session=${a.cookie}` } });
    expect(r.statusCode).toBe(403);
  });

  it('isolates tenants: B cannot see or touch A’s data, even by id', async () => {
    expect((await b.get<any[]>('/products')).length).toBe(0);
    expect((await b.get<any[]>('/inventory')).length).toBe(0);
    expect((await b.request('GET', `/products/${productA.id}`)).status).toBe(404);
    expect((await b.request('PATCH', `/products/${productA.id}`, { name: 'hijack' })).status).toBe(404);
    expect((await b.request('GET', `/warehouses/${warehouseA.id}`)).status).toBe(404);
    // B cannot receive into A's warehouse or move A's stock
    const bWh = await setupWarehouse(b, 'BET-01');
    expect((await b.request('POST', '/receiving', { warehouseId: warehouseA.id, lines: [{ productId: productA.id, quantity: 1 }] })).status).toBe(404);
    expect((await b.request('POST', '/inventory/relocate', { warehouseId: warehouseA.id, fromLocationId: warehouseA.bins[0].id, toLocationId: bWh.bins[0].id, productId: productA.id, quantity: 1 })).status).toBeGreaterThanOrEqual(400);
    expect((await b.get<any[]>('/search?q=ALP')).length).toBe(0);
    expect((await a.get<any>(`/products/${productA.id}`)).name).toBe('Product ALP-001');
  });

  it('enforces permissions on the API, not only in the menu', async () => {
    const operator = await addUser(env.app, a, 'operator', 'rbac');
    const sales = await addUser(env.app, a, 'sales', 'rbac');
    const auditor = await addUser(env.app, a, 'auditor', 'rbac');
    expect((await operator.request('POST', '/inventory/adjustments', { warehouseId: warehouseA.id, locationId: warehouseA.bins[0].id, productId: productA.id, quantityDelta: -1, reasonCode: 'loss', notes: 'nope' })).status).toBe(403);
    expect((await operator.request('GET', '/invoices')).status).toBe(403);
    expect((await operator.request('POST', '/users', { name: 'x', email: 'x@test.local', roleId: '00000000-0000-0000-0000-000000000000' })).status).toBe(403);
    expect((await sales.request('POST', '/purchase-orders', { supplierId: '00000000-0000-0000-0000-000000000000', warehouseId: warehouseA.id, lines: [] })).status).toBe(403);
    expect((await auditor.request('POST', '/products', { sku: 'AUD-1', name: 'Auditor cannot create' })).status).toBe(403);
    expect((await auditor.request('GET', '/audit')).status).toBe(200);
    expect((await auditor.request('DELETE', '/approval-rules/00000000-0000-0000-0000-000000000000')).status).toBe(403);
    expect((await operator.request('GET', '/platform/tenants')).status).toBe(403);
  });

  it('hides cost and valuation from roles without finance access', async () => {
    const manager = await addUser(env.app, a, 'warehouse_manager', 'fin');
    const product = await manager.get<any>(`/products/${productA.id}`);
    expect(product.costPrice).toBeUndefined();
    const inv = await manager.get<any[]>('/inventory');
    expect(inv[0].value).toBeUndefined();
    const dash = await manager.get<any>('/dashboard');
    expect(dash.financial).toBeNull();
    expect(dash.inventory.inventoryValue).toBeUndefined();
    const ownerView = await a.get<any>(`/products/${productA.id}`);
    expect(ownerView.costPrice).toBe(500);
  });

  it('routes large adjustments for approval and blocks self-approval', async () => {
    const controller = await addUser(env.app, a, 'inventory_controller', 'appr');
    const manager = await addUser(env.app, a, 'warehouse_manager', 'appr');
    // 30 units × 500 = 15,000 — set a low threshold so it needs approval
    const rules = await a.get<any[]>('/approval-rules');
    await a.ok('PATCH', `/approval-rules/${rules.find((r) => r.entityType === 'stock_adjustment').id}`, { threshold: 10_000 });
    const adj = await controller.post<any>('/inventory/adjustments', { warehouseId: warehouseA.id, locationId: warehouseA.bins[0].id, productId: productA.id, quantityDelta: -30, reasonCode: 'damage', notes: 'water damage' });
    expect(adj.status).toBe('pending_approval');
    const before = (await a.get<any[]>(`/inventory?productId=${productA.id}`)).reduce((s, x) => s + x.quantity, 0);
    expect(before).toBe(50); // nothing posted yet
    const [req] = await manager.get<any[]>('/approvals');
    expect(req.canDecide).toBe(true);
    await manager.post(`/approvals/${req.id}/decide`, { decision: 'approved', comment: 'checked photos' });
    const after = (await a.get<any[]>(`/inventory?productId=${productA.id}`)).reduce((s, x) => s + x.quantity, 0);
    expect(after).toBe(20);
    // A manager cannot approve their own transfer request
    const tr = await manager.post<any>('/transfers', { type: 'location', sourceWarehouseId: warehouseA.id, lines: [{ productId: productA.id, sourceLocationId: warehouseA.bins[0].id, destLocationId: warehouseA.bins[1].id, quantity: 1 }] });
    expect((await manager.request('POST', `/transfers/${tr.id}/approve`)).status).toBe(403);
  });

  it('platform admin sees aggregates but has no tenant operational access', async () => {
    const admin = new Client(env.app);
    await admin.post('/auth/login', { email: 'admin@example.com', password: process.env.DEMO_PASSWORD || 'Demo@MaalHelp2026' });
    const tenants = await admin.get<any[]>('/platform/tenants');
    expect(tenants.length).toBeGreaterThanOrEqual(2);
    expect((await admin.request('GET', '/products')).status).toBe(401);
  });

  it('returns standard error envelopes and never leaks internals', async () => {
    const r = await a.request('POST', '/products', { sku: '!', name: '' });
    expect(r.status).toBe(400);
    expect(r.body.success).toBe(false);
    expect(r.error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(r.body)).not.toMatch(/at .*\.ts:\d+/);
  });
});
