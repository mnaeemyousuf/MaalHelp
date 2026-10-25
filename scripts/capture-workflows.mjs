// Captures in-progress workflow screenshots (dialogs, scans, task detail) for the user manuals.
// It PICKS one pending order through the real API (as the picker would) so the packing station has
// work to show; it never dispatches, puts away or posts adjustments. Run after capture-screenshots.mjs
// on a fresh demo database: BASE_URL=http://localhost:47831 node scripts/capture-workflows.mjs
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = process.env.BASE_URL || 'http://localhost:47831';
const PASSWORD = process.env.DEMO_PASSWORD || 'Demo@MaalHelp2026';
const OUT = resolve('docs/user-manuals/screenshots');
const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome'].find((p) => existsSync(p));
const browser = await chromium.launch({ executablePath: exe, headless: true });
const HEAD = { 'x-requested-with': 'stockpilot', origin: BASE };

async function session(role, phone = false) {
  const ctx = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 }, deviceScaleFactor: phone ? 2 : 1.25, isMobile: phone, hasTouch: phone, locale: 'en-PK', timezoneId: 'Asia/Karachi' });
  const res = await ctx.request.post(`${BASE}/api/v1/auth/login`, { data: { email: `${role}@example.com`, password: PASSWORD }, headers: HEAD });
  if (!res.ok()) throw new Error(`login ${role}: ${res.status()}`);
  const api = async (method, path, data) => {
    const r = await ctx.request.fetch(`${BASE}/api/v1${path}`, { method, data, headers: HEAD });
    const body = await r.json();
    if (!body.success) throw new Error(`${method} ${path}: ${JSON.stringify(body.error)}`);
    return body.data;
  };
  return { ctx, api };
}
const shot = async (page, name) => { await page.waitForTimeout(700); await page.screenshot({ path: resolve(OUT, `${name}.png`) }); console.log('ok', name); };
const open = async (ctx, path) => { const p = await ctx.newPage(); await p.goto(`${BASE}${path}`, { waitUntil: 'networkidle' }); await p.waitForTimeout(600); return p; };
const only = process.argv.slice(2);
const step = async (name, fn, always = false) => { if (!always && only.length && !only.includes(name)) return; try { await fn(); } catch (e) { console.error('FAIL', name, e.message.split('\n')[0]); process.exitCode = 1; } };

// 1. Picker on the phone: task detail
const pickerPhone = await session('picker', true);
await step('mobile-pick-task', async () => {
  const p = await open(pickerPhone.ctx, '/m/pick');
  await p.locator('main button, main a, [role="button"]').filter({ hasText: /SO-\d+/ }).first().click();
  await shot(p, 'mobile-pick-task');
});

// 2. Pick every task of one order through the API so it reaches the packing station
const picker = await session('picker');
let orderNo = '';
await step('pick-one-order', async () => {
  const queued = await picker.api('GET', '/packing/queue');
  if (queued.length) { orderNo = queued[0].number ?? queued[0].orderNumber; console.log('already in packing queue', orderNo); return; }
  const tasks = await picker.api('GET', '/picking/tasks?pageSize=200');
  const byOrder = new Map();
  for (const t of tasks) if (t.status === 'pending') byOrder.set(t.orderNumber, [...(byOrder.get(t.orderNumber) ?? []), t]);
  const [no, list] = [...byOrder.entries()].sort((a, b) => b[1].length - a[1].length).find(([, l]) => l.length >= 2 && l.length <= 4) ?? [...byOrder.entries()][0];
  orderNo = no;
  for (const t of list) await picker.api('POST', `/picking/tasks/${t.id}/confirm`, { locationCode: t.locationBarcode ?? t.locationCode, productCode: t.barcode ?? t.sku, quantity: t.quantity - t.pickedQty });
  console.log('picked', orderNo, list.length, 'tasks');
}, true);

// 3. Packing station with that order selected, after one verification scan
await step('packing-station-order', async () => {
  const p = await open(picker.ctx, '/packing');
  await p.getByText(orderNo).first().click();
  await p.waitForLoadState('networkidle');
  await shot(p, 'packing-station-order');
  const code = (await p.locator('main').innerText()).match(/\b[A-Z]{2}-\d{4}\b/)?.[0];
  const input = p.getByPlaceholder('Scan or type a code').first();
  if (code) { await input.fill(code); await input.press('Enter'); await p.waitForLoadState('networkidle'); }
  await shot(p, 'packing-scan');
});
await step('mobile-pack-queue', async () => { const p = await open(pickerPhone.ctx, '/m/pack'); await shot(p, 'mobile-pack-queue'); });

// 4. Dispatch dialog (opened, not submitted)
const dispatch = await session('dispatch');
await step('dispatch-dialog', async () => {
  const p = await open(dispatch.ctx, '/dispatch');
  await p.getByRole('button', { name: /^Dispatch$/ }).first().click();
  await shot(p, 'dispatch-dialog');
});
await step('shipments', async () => {
  const p = await open(dispatch.ctx, '/dispatch');
  await p.getByRole('tab', { name: /Shipments/ }).or(p.getByText('Shipments', { exact: true })).first().click();
  await p.waitForLoadState('networkidle');
  await shot(p, 'shipments');
});

// 5. Putaway dialog (opened, not submitted) and mobile putaway task
const receiving = await session('receiving');
await step('putaway-dialog', async () => {
  const p = await open(receiving.ctx, '/putaway');
  await p.getByRole('button', { name: /^Put away$/ }).last().click();
  await p.waitForLoadState('networkidle');
  await p.waitForTimeout(2500); // suggestions are ranked on open
  await shot(p, 'putaway-dialog');
});
const receivingPhone = await session('receiving', true);
await step('mobile-receive-po', async () => {
  const p = await open(receivingPhone.ctx, '/m/receive');
  await p.getByText(/^PO-\d+/).first().click();
  await p.waitForLoadState('networkidle');
  await shot(p, 'mobile-receive-po');
});
await step('mobile-putaway-task', async () => {
  const p = await open(receivingPhone.ctx, '/m/putaway');
  await p.getByText(/ · from /).last().click();
  await p.waitForLoadState('networkidle');
  await shot(p, 'mobile-putaway-task');
});

// 6. Receive goods against a PO on desktop (lines loaded, not confirmed)
await step('receive-goods-po', async () => {
  const p = await open(receiving.ctx, '/receiving/new');
  await p.getByText('Select an approved PO').click();
  await p.waitForTimeout(800);
  await p.getByText(/^PO-\d+ · /).first().click();
  await p.waitForLoadState('networkidle');
  await shot(p, 'receive-goods-po');
});

// 7. Operator phone: scan lookup of a product code
const operatorPhone = await session('operator', true);
await step('mobile-scan-result', async () => {
  const p = await open(operatorPhone.ctx, '/m/scan');
  const input = p.getByPlaceholder('Scan or type a code').first();
  await input.fill('FD-1001');
  await input.press('Enter');
  await p.waitForLoadState('networkidle');
  await shot(p, 'mobile-scan-result');
});

// 8. Owner: approval decision dialog (opened, not decided)
const owner = await session('owner');
await step('approval-dialog', async () => {
  const p = await open(owner.ctx, '/approvals');
  await p.getByRole('button', { name: /Review|Approve|Decide/ }).first().click();
  await shot(p, 'approval-dialog');
});

await browser.close();
