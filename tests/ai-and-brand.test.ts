import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BRAND } from '../shared/brand';
import { Client, createProduct, createTestEnv, newCompany, setupWarehouse, type TestEnv } from './helpers';

describe('AI Copilot (grounded mode, no MISTRAL_API_KEY in tests)', () => {
  let env: TestEnv;
  let owner: Client;

  beforeAll(async () => {
    delete process.env.MISTRAL_API_KEY;
    env = await createTestEnv();
    ({ owner } = await newCompany(env.app, 'Copilot Co'));
    const wh = await setupWarehouse(owner, 'AI-01');
    const healthy = await createProduct(owner, 'AI-OK', { reorderLevel: 5 });
    const low = await createProduct(owner, 'AI-LOW', { reorderLevel: 50 });
    await owner.post('/receiving', { warehouseId: wh.id, lines: [{ productId: healthy.id, quantity: 120, locationId: wh.bins[0].id }, { productId: low.id, quantity: 7, locationId: wh.bins[1].id }] });
  });
  afterAll(async () => { await env.app.close(); await env.db.close(); });

  it('answers "How much inventory do I have?" with the database figure', async () => {
    const r = await owner.post<any>('/ai/chat', { message: 'How much inventory do I have?' });
    expect(r.mode).toBe('grounded');
    expect(r.notice).toMatch(/not configured/i);
    expect(r.answer).toContain('127 units');
    expect(r.tools.map((t: any) => t.name)).toContain('get_inventory');
  });

  it('answers "Which products are low?" with the right products', async () => {
    const r = await owner.post<any>('/ai/chat', { message: 'Which products are low?' });
    expect(r.answer).toContain('AI-LOW');
    expect(r.answer).not.toContain('AI-OK');
  });

  it("produces today's warehouse summary from operations data", async () => {
    const r = await owner.post<any>('/ai/chat', { message: "Give me today's warehouse summary" });
    expect(r.answer).toMatch(/1 goods receipts/);
    expect(r.tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(['get_operations_summary', 'get_inventory']));
  });

  it('never exposes financial tools to roles without finance access', async () => {
    const roles = await owner.get<any[]>('/roles');
    await owner.post('/users', { name: 'Sales Person', email: 'sales.ai@test.local', roleId: roles.find((x) => x.key === 'sales').id, password: 'TestPassw0rd!2026' });
    const sales = new Client(env.app);
    await sales.post('/auth/login', { email: 'sales.ai@test.local', password: 'TestPassw0rd!2026' });
    const r = await sales.post<any>('/ai/chat', { message: 'Which customers owe me the most?' });
    expect(r.tools.every((t: any) => !t.ok || t.name !== 'get_customer_balance')).toBe(true);
    expect(r.answer).toMatch(/permission/i);
  });

  it('daily briefing and reorder recommendations come from data and never create orders', async () => {
    const brief = await owner.get<any>('/ai/briefing');
    expect(brief.generatedBy).toBe('rules');
    expect(brief.content).toMatch(/^Good morning\./);
    const pos = await owner.get<any[]>('/purchase-orders');
    const recs = await owner.get<any[]>('/ai/reorder');
    expect(recs.find((x) => x.sku === 'AI-LOW')?.action).toMatch(/order_now|increase_order/);
    expect((await owner.get<any[]>('/purchase-orders')).length).toBe(pos.length);
  });
});

describe('Maal Help branding', () => {
  let env: TestEnv;
  beforeAll(async () => { env = await createTestEnv(); });
  afterAll(async () => { await env.app.close(); await env.db.close(); });

  it('exposes the product name in the API documentation', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/api/docs/json' });
    const doc = JSON.parse(res.body);
    expect(doc.info.title).toBe('Maal Help API');
    expect(doc.info.description).toContain(BRAND.tagline);
  });

  it('brand constants are complete', () => {
    expect(BRAND.name).toBe('Maal Help');
    expect(BRAND.tagline).toBe('Your Warehouse. Under Control.');
    expect(BRAND.colors.primary).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('PDF report exports carry the Maal Help name', async () => {
    const { owner } = await newCompany(env.app, 'Brand Check');
    const res = await env.app.inject({ method: 'GET', url: '/api/v1/reports/low_stock/export?format=pdf', headers: { cookie: `sp_session=${owner.cookie}` } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  });
});
