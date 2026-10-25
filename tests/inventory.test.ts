import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, rows } from '../server/src/db/index';
import { Client, createProduct, createTestEnv, newCompany, setupWarehouse, stockOf, type TestEnv } from './helpers';

/**
 * Expected quantities (product P, single warehouse):
 *  1. Receive 100 at the dock           → on hand 100 (dock, available, not yet sellable)
 *  2. Put away 100 into bin 1           → bin 1 = 100 available
 *  3. Sales order 20, confirm           → available 80, reserved 20
 *  4. Pick 20 → pack → dispatch         → on hand 80, reserved 0, order dispatched, invoice issued
 *  5. Move 30 from bin 1 to bin 2       → bin 1 = 50, bin 2 = 30, total 80
 *  6. Return 10 to available            → total 90
 * The balance table must always equal the sum of the immutable ledger.
 */
describe('inventory lifecycle (critical scenario)', () => {
  let env: TestEnv;
  let owner: Client;
  let wh: Awaited<ReturnType<typeof setupWarehouse>>;
  let product: { id: string; sku: string; barcode: string | null };
  let orderId = '';

  beforeAll(async () => {
    env = await createTestEnv();
    ({ owner } = await newCompany(env.app, 'Lifecycle Traders'));
    wh = await setupWarehouse(owner);
    product = await createProduct(owner, 'LC-001');
  });
  afterAll(async () => { await env.app.close(); await env.db.close(); });

  const ledgerMatchesBalances = async () => {
    const [r] = await rows<{ ledger: string; balance: string }>(db(), sql`SELECT
      (SELECT COALESCE(SUM(quantity), 0) FROM inventory_transactions WHERE product_id = ${product.id}) AS ledger,
      (SELECT COALESCE(SUM(quantity), 0) FROM inventory_balances WHERE product_id = ${product.id}) AS balance`);
    expect(Number(r!.ledger)).toBeCloseTo(Number(r!.balance), 6);
  };

  it('1. receives 100 units into the receiving dock and creates a putaway task', async () => {
    const grn = await owner.post<any>('/receiving', { warehouseId: wh.id, lines: [{ productId: product.id, quantity: 100 }] }, { 'idempotency-key': 'rcv-1' });
    expect(grn.number).toMatch(/^GRN-/);
    expect(grn.putawayTaskIds).toHaveLength(1);
    expect(await stockOf(owner, product.id)).toBe(100);
    await ledgerMatchesBalances();
  });

  it('is idempotent: replaying the same receipt request does not double stock', async () => {
    const again = await owner.request('POST', '/receiving', { warehouseId: wh.id, lines: [{ productId: product.id, quantity: 100 }] }, { 'idempotency-key': 'rcv-1' });
    expect(again.status).toBe(201);
    expect(await stockOf(owner, product.id)).toBe(100);
  });

  it('2. puts away all 100 units into a bin', async () => {
    const tasks = await owner.get<any[]>(`/putaway/tasks?status=pending&warehouseId=${wh.id}`);
    expect(tasks).toHaveLength(1);
    const res = await owner.post(`/putaway/tasks/${tasks[0].id}/complete`, { locationId: tasks[0].suggestedLocationId ?? wh.bins[0].id, overrideReason: 'test' });
    expect(res.remaining).toBe(0);
    const inBins = (await owner.get<any[]>(`/inventory?productId=${product.id}`)).filter((b) => b.locationType === 'bin');
    expect(inBins.reduce((s, b) => s + b.quantity, 0)).toBe(100);
    await ledgerMatchesBalances();
  });

  it('3. reserves 20 units for a confirmed sales order (available 80, reserved 20)', async () => {
    const customer = await owner.post<any>('/customers', { name: 'Test Customer' });
    const order = await owner.post<any>('/sales-orders', { customerId: customer.id, warehouseId: wh.id, lines: [{ productId: product.id, quantity: 20 }], confirm: true });
    orderId = order.id;
    expect(order.status).toBe('reserved');
    expect(order.reservation.reservedUnits).toBe(20);
    expect(await stockOf(owner, product.id, 'available')).toBe(80);
    expect(await stockOf(owner, product.id, 'reserved')).toBe(20);
  });

  it('blocks wrong location, wrong product and excess quantity at picking', async () => {
    const [task] = await owner.get<any[]>(`/picking/tasks?salesOrderId=${orderId}`);
    const wrongLoc = await owner.request('POST', `/picking/tasks/${task.id}/confirm`, { locationCode: 'NOT-A-BIN', productCode: product.sku, quantity: 20 });
    expect(wrongLoc.status).toBe(422);
    expect(wrongLoc.error.code).toBe('WRONG_LOCATION');
    const other = await createProduct(owner, 'LC-002');
    const wrongSku = await owner.request('POST', `/picking/tasks/${task.id}/confirm`, { locationCode: task.locationBarcode, productCode: other.sku, quantity: 20 });
    expect(wrongSku.error.code).toBe('WRONG_PRODUCT');
    const excess = await owner.request('POST', `/picking/tasks/${task.id}/confirm`, { locationCode: task.locationBarcode, productCode: product.sku, quantity: 21 });
    expect(excess.error.code).toBe('EXCESS_QUANTITY');
  });

  it('4. picks, packs (scan-verified) and dispatches 20 units', async () => {
    const [task] = await owner.get<any[]>(`/picking/tasks?salesOrderId=${orderId}`);
    const pick = await owner.post<any>(`/picking/tasks/${task.id}/confirm`, { locationCode: task.locationBarcode, productCode: product.barcode, quantity: 20 });
    expect(pick.orderReadyToPack).toBe(true);
    const notVerified = await owner.request('POST', `/packing/${orderId}/complete`, { packages: [{ weightKg: 5 }] });
    expect(notVerified.error.code).toBe('PACKING_NOT_VERIFIED');
    const wrong = await owner.post<any>(`/packing/${orderId}/scan`, { code: 'LC-002' });
    expect(wrong.result).toBe('wrong_product');
    const scan = await owner.post<any>(`/packing/${orderId}/scan`, { code: product.sku, quantity: 20 });
    expect(scan.result).toBe('ok');
    await owner.post(`/packing/${orderId}/complete`, { packages: [{ weightKg: 5 }] });
    const dispatched = await owner.post<any>(`/dispatch/${orderId}`, { carrier: 'Own vehicle', vehicleNo: 'KHI-1234', driverName: 'Test' });
    expect(dispatched.invoice.number).toMatch(/^INV-/);
    const order = await owner.get<any>(`/sales-orders/${orderId}`);
    expect(order.status).toBe('dispatched');
    expect(order.lines[0].shippedQty).toBe(20);
    expect(await stockOf(owner, product.id)).toBe(80);
    expect(await stockOf(owner, product.id, 'reserved')).toBe(0);
    await ledgerMatchesBalances();
  });

  it('5. transfers 30 units between locations without creating or losing stock', async () => {
    const [bal] = (await owner.get<any[]>(`/inventory?productId=${product.id}&status=available`)).filter((b) => b.locationType === 'bin');
    const target = wh.bins.find((b) => b.id !== bal.locationId)!;
    const tr = await owner.post<any>('/transfers', { type: 'location', sourceWarehouseId: wh.id, lines: [{ productId: product.id, sourceLocationId: bal.locationId, destLocationId: target.id, quantity: 30 }] });
    // Owners may approve their own requests; others cannot (covered in security tests).
    await owner.post(`/transfers/${tr.id}/approve`);
    const done = await owner.post<any>(`/transfers/${tr.id}/dispatch`, {});
    expect(done.status).toBe('completed');
    const after = await owner.get<any[]>(`/inventory?productId=${product.id}&status=available`);
    expect(after.find((b) => b.locationId === bal.locationId)?.quantity).toBe(50);
    expect(after.find((b) => b.locationId === target.id)?.quantity).toBe(30);
    expect(await stockOf(owner, product.id)).toBe(80);
    await ledgerMatchesBalances();
  });

  it('6. a customer return of 10 to available increases stock to 90', async () => {
    const ret = await owner.post<any>('/returns', { salesOrderId: orderId, reason: 'customer_rejection', lines: [{ productId: product.id, quantity: 10, disposition: 'available' }] });
    expect(ret.number).toMatch(/^RMA-/);
    expect(await stockOf(owner, product.id)).toBe(90);
    const tooMany = await owner.request('POST', '/returns', { salesOrderId: orderId, reason: 'damaged', lines: [{ productId: product.id, quantity: 11, disposition: 'damaged' }] });
    expect(tooMany.status).toBe(400);
    await ledgerMatchesBalances();
  });

  it('dashboard and reports agree with the ledger', async () => {
    const dash = await owner.get<any>('/dashboard?range=today');
    const total = await stockOf(owner, product.id);
    expect(dash.inventory.totalUnits).toBe(total);
    expect(dash.operations.dispatches).toBe(1);
    const report = await owner.request('GET', '/reports/current_inventory?pageSize=50');
    const row = (report.data as any[]).find((r) => r.sku === 'LC-001');
    expect(row.on_hand).toBe(total);
  });

  it('prevents negative stock: removing more than available is refused', async () => {
    const [bal] = await owner.get<any[]>(`/inventory?productId=${product.id}&status=available`);
    const res = await owner.request('POST', '/inventory/adjustments', { warehouseId: wh.id, locationId: bal.locationId, productId: product.id, quantityDelta: -(bal.quantity + 1), reasonCode: 'loss', notes: 'test too many' });
    expect(res.status).toBe(409);
    expect(res.error.code).toBe('INSUFFICIENT_STOCK');
  });

  it('the ledger is append-only at the database level', async () => {
    await expect(db().execute(sql`UPDATE inventory_transactions SET quantity = 999 WHERE product_id = ${product.id}`)).rejects.toThrow();
    await expect(db().execute(sql`DELETE FROM inventory_transactions WHERE product_id = ${product.id}`)).rejects.toThrow();
    await expect(db().execute(sql`DELETE FROM audit_logs`)).rejects.toThrow();
  });

  it('audit trail records each step with the acting user', async () => {
    const audit = await owner.get<any[]>('/audit?pageSize=200');
    const actions = audit.map((a) => a.action);
    for (const a of ['goods.received', 'putaway.override', 'sales_order.confirmed', 'order.picked', 'order.packed', 'shipment.dispatched', 'transfer.completed', 'return.received']) {
      expect(actions.some((x) => x === a || (a === 'putaway.override' && x === 'putaway.completed'))).toBe(true);
    }
    expect(audit.every((a) => a.userEmail)).toBe(true);
  });
});

describe('concurrency', () => {
  let env: TestEnv;
  let owner: Client;

  beforeAll(async () => {
    env = await createTestEnv();
    ({ owner } = await newCompany(env.app, 'Concurrent Co'));
  });
  afterAll(async () => { await env.app.close(); await env.db.close(); });

  it('simultaneous orders never over-reserve stock', async () => {
    const wh = await setupWarehouse(owner, 'CC-01');
    const p = await createProduct(owner, 'CC-001');
    await owner.post('/receiving', { warehouseId: wh.id, lines: [{ productId: p.id, quantity: 80, locationId: wh.bins[0].id }] });
    const customer = await owner.post<any>('/customers', { name: 'Buyer' });
    const place = () => owner.request('POST', '/sales-orders', { customerId: customer.id, warehouseId: wh.id, lines: [{ productId: p.id, quantity: 60 }], confirm: true, allowPartial: false });
    const results = await Promise.all([place(), place(), place()]);
    const ok = results.filter((r) => r.status === 201);
    const refused = results.filter((r) => r.status === 409);
    expect(ok).toHaveLength(1);
    expect(refused.every((r) => r.error.code === 'INSUFFICIENT_STOCK')).toBe(true);
    expect(await stockOf(owner, p.id, 'reserved')).toBe(60);
    expect(await stockOf(owner, p.id, 'available')).toBe(20);
  });

  it('simultaneous adjustments cannot drive a balance negative', async () => {
    const wh = await setupWarehouse(owner, 'CC-02');
    const p = await createProduct(owner, 'CC-002', { costPrice: 1 });
    await owner.post('/receiving', { warehouseId: wh.id, lines: [{ productId: p.id, quantity: 10, locationId: wh.bins[0].id }] });
    const take = () => owner.request('POST', '/inventory/adjustments', { warehouseId: wh.id, locationId: wh.bins[0].id, productId: p.id, quantityDelta: -4, reasonCode: 'loss', notes: 'parallel' });
    const results = await Promise.all([take(), take(), take()]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    expect(await stockOf(owner, p.id)).toBe(2);
  });
});
