// Captures real screenshots of the running Maal Help app for the user manuals.
// Usage: BASE_URL=http://localhost:47831 node scripts/capture-screenshots.mjs
// Requires a running server with demo data (npm run db:reset) and a local Chrome or Edge.
// Uses the development-only demo password; never point this at a production system.
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = process.env.BASE_URL || 'http://localhost:47831';
const PASSWORD = process.env.DEMO_PASSWORD || 'Demo@MaalHelp2026';
const OUT = resolve('docs/user-manuals/screenshots');
const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
];

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

// [file, role email prefix, path or async resolver, options]
const SHOTS = [
  ['login', null, '/login'],
  ['register', null, '/register'],
  // Business owner
  ['owner-dashboard', 'owner', '/'],
  ['owner-dashboard-full', 'owner', '/', { fullPage: true }],
  ['command-palette', 'owner', '/', { palette: true }],
  ['ai-copilot', 'owner', '/ai', { ai: 'How much inventory do I have?' }],
  ['alerts', 'owner', '/alerts'],
  ['approvals', 'owner', '/approvals'],
  ['profitability', 'owner', '/profitability'],
  ['reports', 'owner', '/reports'],
  ['report-inventory-valuation', 'owner', '/reports/inventory_valuation'],
  ['report-low-stock', 'owner', '/reports/low_stock'],
  ['settings-company', 'owner', '/settings/company'],
  ['settings-users', 'owner', '/settings/users'],
  ['settings-roles', 'owner', '/settings/roles'],
  ['settings-tax', 'owner', '/settings/tax'],
  ['settings-approvals', 'owner', '/settings/approvals'],
  ['settings-preferences', 'owner', '/settings/preferences'],
  ['settings-import', 'owner', '/settings/import'],
  ['settings-integrations', 'owner', '/settings/integrations'],
  ['settings-barcode', 'owner', '/settings/barcode'],
  ['settings-plan', 'owner', '/settings/plan'],
  ['owner-mobile-dashboard', 'owner', '/', { phone: true }],
  // Warehouse manager
  ['manager-dashboard', 'manager', '/'],
  ['warehouses', 'manager', '/warehouses'],
  ['warehouse-detail', 'manager', async (api) => `/warehouses/${(await api('/warehouses')).find((w) => w.code === 'KHI-01')?.id ?? (await api('/warehouses'))[0].id}`],
  ['transfers', 'manager', '/transfers'],
  ['transfer-detail', 'manager', async (api) => `/transfers/${(await api('/transfers?pageSize=5'))[0].id}`],
  ['picking-manager', 'manager', '/picking'],
  // Inventory controller
  ['controller-dashboard', 'controller', '/'],
  ['inventory', 'controller', '/inventory'],
  ['products', 'controller', '/products'],
  ['product-detail', 'controller', async (api) => `/products/${(await api('/products?pageSize=5'))[0].id}`],
  ['stock-counts', 'controller', '/stock-counts'],
  ['count-detail', 'controller', async (api) => `/stock-counts/${(await api('/stock-counts?pageSize=5'))[0].id}`],
  // Operator / floor roles
  ['operator-mobile-home', 'operator', '/m', { phone: true }],
  ['mobile-scan', 'operator', '/m/scan', { phone: true }],
  ['mobile-transfer', 'operator', '/m/transfer', { phone: true }],
  ['mobile-count', 'operator', '/m/count', { phone: true }],
  ['mobile-sync', 'operator', '/m/sync', { phone: true }],
  ['operator-desktop', 'operator', '/inventory'],
  ['receiving-mobile-home', 'receiving', '/m', { phone: true }],
  ['mobile-receive', 'receiving', '/m/receive', { phone: true }],
  ['mobile-putaway', 'receiving', '/m/putaway', { phone: true }],
  ['receiving', 'receiving', '/receiving'],
  ['receive-goods', 'receiving', '/receiving/new'],
  ['receipt-detail', 'receiving', async (api) => `/receiving/${(await api('/receiving?pageSize=5'))[0].id}`],
  ['putaway', 'receiving', '/putaway'],
  ['picker-mobile-home', 'picker', '/m', { phone: true }],
  ['mobile-pick', 'picker', '/m/pick', { phone: true }],
  ['mobile-pack', 'picker', '/m/pack', { phone: true }],
  ['picking', 'picker', '/picking'],
  ['packing', 'picker', '/packing'],
  ['dispatch-mobile-home', 'dispatch', '/m', { phone: true }],
  ['mobile-dispatch', 'dispatch', '/m/dispatch', { phone: true }],
  ['dispatch', 'dispatch', '/dispatch'],
  // Sales
  ['sales-dashboard', 'sales', '/'],
  ['orders', 'sales', '/orders'],
  ['order-new', 'sales', '/orders/new'],
  ['order-detail', 'sales', async (api) => `/orders/${(await api('/sales-orders?status=picking&limit=5'))[0]?.id ?? (await api('/sales-orders?pageSize=5'))[0].id}`],
  ['customers', 'sales', '/customers'],
  ['customer-detail', 'sales', async (api) => `/customers/${(await api('/customers?pageSize=5'))[0].id}`],
  ['returns', 'sales', '/returns'],
  // Purchase
  ['purchase-dashboard', 'purchase', '/'],
  ['purchasing', 'purchase', '/purchasing'],
  ['po-new', 'purchase', '/purchasing/new'],
  ['po-detail', 'purchase', async (api) => `/purchasing/${(await api('/purchase-orders?pageSize=5'))[0].id}`],
  ['suppliers', 'purchase', '/suppliers'],
  ['supplier-detail', 'purchase', async (api) => `/suppliers/${(await api('/suppliers?pageSize=5'))[0].id}`],
  // Accountant
  ['accountant-dashboard', 'accountant', '/'],
  ['billing', 'accountant', '/billing'],
  ['invoice-detail', 'accountant', async (api) => `/billing/invoices/${(await api('/invoices?pageSize=5'))[0].id}`],
  ['invoice-print', 'accountant', async (api) => `/print/invoice/${(await api('/invoices?pageSize=5'))[0].id}`],
  ['storage-billing', 'accountant', '/storage-billing'],
  ['expenses', 'accountant', '/expenses'],
  ['report-receivables', 'accountant', '/reports/receivables'],
  // Auditor
  ['auditor-dashboard', 'auditor', '/'],
  ['audit-trail', 'auditor', '/audit'],
  ['auditor-ledger', 'auditor', '/reports/stock_movement'],
  // Platform super admin
  ['platform-overview', 'admin', '/platform/overview'],
  ['platform-tenants', 'admin', '/platform/tenants'],
  ['platform-plans', 'admin', '/platform/plans'],
  ['platform-flags', 'admin', '/platform/flags'],
  ['platform-health', 'admin', '/platform/health'],
  ['platform-ai', 'admin', '/platform/ai'],
  ['platform-support', 'admin', '/platform/support'],
];

const only = process.argv.slice(2);
const exe = BROWSERS.find((p) => existsSync(p));
if (!exe) throw new Error('No Chrome/Edge found');
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: exe, headless: true });

const sessions = new Map();
async function contextFor(role, phone) {
  const key = `${role}:${phone ? 'p' : 'd'}`;
  if (sessions.has(key)) return sessions.get(key);
  const ctx = await browser.newContext({ viewport: phone ? PHONE : DESKTOP, deviceScaleFactor: phone ? 2 : 1.25, isMobile: !!phone, hasTouch: !!phone, locale: 'en-PK', timezoneId: 'Asia/Karachi' });
  if (role) {
    const res = await ctx.request.post(`${BASE}/api/v1/auth/login`, {
      data: { email: `${role}@example.com`, password: PASSWORD },
      headers: { 'x-requested-with': 'stockpilot', origin: BASE },
    });
    if (!res.ok()) throw new Error(`login ${role} failed: ${res.status()} ${await res.text()}`);
  }
  sessions.set(key, ctx);
  return ctx;
}

const failures = [];
const issues = [];
for (const [file, role, target, opts = {}] of SHOTS) {
  if (only.length && !only.includes(file)) continue;
  try {
    const ctx = await contextFor(role, opts.phone);
    const api = async (p) => {
      const r = await ctx.request.get(`${BASE}/api/v1${p}`);
      const body = await r.json();
      if (!body.success) throw new Error(`${p}: ${JSON.stringify(body.error)}`);
      return body.data;
    };
    const path = typeof target === 'function' ? await target(api) : target;
    const page = await ctx.newPage();
    const problems = [];
    page.on('pageerror', (e) => problems.push(`JS error: ${e.message.slice(0, 200)}`));
    page.on('response', (r) => { if (r.status() >= 400 && r.url().includes('/api/')) problems.push(`HTTP ${r.status()} ${r.url().replace(BASE, '')}`); });
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    if (opts.palette) { await page.keyboard.press('Control+k'); await page.keyboard.type('rice'); await page.waitForTimeout(1200); }
    if (opts.ai) {
      const box = page.locator('input[placeholder^="Ask about"]').first();
      await box.fill(opts.ai);
      await box.press('Enter');
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(2500);
    }
    await page.screenshot({ path: resolve(OUT, `${file}.png`), fullPage: !!opts.fullPage });
    await page.close();
    if (problems.length) issues.push({ file, role, path, problems });
    console.log('ok', file, path, problems.length ? `(${problems.length} issue(s))` : '');
  } catch (e) {
    failures.push(file);
    console.error('FAIL', file, e.message);
  }
}
await browser.close();
writeFileSync(resolve(OUT, '..', 'capture-report.json'), JSON.stringify({ capturedAt: new Date().toISOString(), failures, issues }, null, 2));
if (issues.length) console.error(`${issues.length} screen(s) logged API/JS problems — see docs/user-manuals/capture-report.json`);
if (failures.length) { console.error('failed:', failures.join(', ')); process.exitCode = 1; }
