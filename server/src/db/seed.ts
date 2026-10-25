/**
 * Demo data for ABC Trading & Warehousing (fictional).
 *
 * The demo is created by driving the real REST API (via in-process injection)
 * with role-appropriate users, so every movement, approval, invoice and audit
 * row is produced by the same business logic customers use. To build realistic
 * history, each simulated day is executed "now" and its timestamps are then
 * shifted back to that day. That shift is the ONLY place the ledger/audit
 * immutability triggers are disabled, and only while seeding fictional data.
 */
import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { db, rows, t } from './index';
import { hashPassword } from '../core/crypto';
import { env } from '../config/env';
import { ean13CheckDigit } from '../core/numbering';

export const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'Demo@MaalHelp2026';
export const DEMO_COMPANY = 'ABC Trading & Warehousing';
export const DEMO_USERS = [
  { key: 'owner', email: 'owner@example.com', name: 'Ahmed Khan', role: 'owner' },
  { key: 'manager', email: 'manager@example.com', name: 'Sara Malik', role: 'warehouse_manager' },
  { key: 'controller', email: 'controller@example.com', name: 'Bilal Hussain', role: 'inventory_controller' },
  { key: 'operator', email: 'operator@example.com', name: 'Imran Ali', role: 'operator' },
  { key: 'receiver', email: 'receiving@example.com', name: 'Faisal Shah', role: 'receiving_clerk' },
  { key: 'picker', email: 'picker@example.com', name: 'Usman Tariq', role: 'picker_packer' },
  { key: 'dispatcher', email: 'dispatch@example.com', name: 'Kamran Javed', role: 'dispatch_officer' },
  { key: 'sales', email: 'sales@example.com', name: 'Ayesha Siddiqui', role: 'sales' },
  { key: 'purchase', email: 'purchase@example.com', name: 'Hamza Qureshi', role: 'purchase' },
  { key: 'accountant', email: 'accountant@example.com', name: 'Nadia Farooq', role: 'accountant' },
  { key: 'auditor', email: 'auditor@example.com', name: 'Zainab Raza', role: 'auditor' },
] as const;
export const PLATFORM_ADMIN = { email: 'admin@example.com', name: 'Platform Administrator' };

// ───────────────────────── Platform data (always) ─────────────────────────

export async function ensurePlatformData(): Promise<void> {
  const plans = [
    { code: 'starter', name: 'Starter', description: 'Single warehouse SMEs', priceMonthly: 9_900, sortOrder: 1, limits: { users: 5, warehouses: 1, skus: 1_000, monthlyTransactions: 10_000, monthlyAiRequests: 200, storageMb: 500, integrations: 1 }, features: ['inventory', 'receiving', 'orders', 'reports'] },
    { code: 'professional', name: 'Professional', description: 'Growing traders with several warehouses', priceMonthly: 24_900, sortOrder: 2, limits: { users: 25, warehouses: 5, skus: 10_000, monthlyTransactions: 100_000, monthlyAiRequests: 2_000, storageMb: 5_000, integrations: 5 }, features: ['inventory', 'receiving', 'orders', 'reports', 'ai', 'storage_billing', 'approvals'] },
    { code: 'business', name: 'Business', description: 'Distributors and 3PL operators', priceMonthly: 59_900, sortOrder: 3, limits: { users: 100, warehouses: 20, skus: 100_000, monthlyTransactions: 1_000_000, monthlyAiRequests: 10_000, storageMb: 50_000, integrations: 20 }, features: ['everything'] },
    { code: 'enterprise', name: 'Enterprise', description: 'Custom limits, SLA and onboarding', priceMonthly: 0, sortOrder: 4, limits: { users: -1, warehouses: -1, skus: -1, monthlyTransactions: -1, monthlyAiRequests: -1, storageMb: -1, integrations: -1 }, features: ['everything', 'sla', 'dedicated_support'] },
  ];
  for (const p of plans) await db().insert(t.plans).values({ ...p, currency: 'PKR' }).onConflictDoNothing();
  const flags = [
    { key: 'ai.copilot', description: 'AI Copilot chat', enabled: true },
    { key: 'ai.document_extraction', description: 'AI document extraction', enabled: true },
    { key: 'billing.storage', description: 'Storage rental billing', enabled: true },
    { key: 'mobile.offline', description: 'Offline task queue on the mobile app', enabled: true },
    { key: 'integrations.ecommerce', description: 'E-commerce connectors (preview)', enabled: false },
  ];
  for (const f of flags) await db().insert(t.featureFlags).values(f).onConflictDoNothing();
  if (env.NODE_ENV !== 'production') {
    const [admin] = await db().select({ id: t.users.id }).from(t.users).where(eq(t.users.email, PLATFORM_ADMIN.email)).limit(1);
    if (!admin) await db().insert(t.users).values({ email: PLATFORM_ADMIN.email, name: PLATFORM_ADMIN.name, passwordHash: await hashPassword(DEMO_PASSWORD), isPlatformAdmin: true });
  }
}

// ───────────────────────── API client over app.inject ─────────────────────────

class Api {
  private cookie = '';
  constructor(private readonly app: FastifyInstance, readonly label: string) {}
  async login(email: string, password = DEMO_PASSWORD) {
    const res = await this.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
    if (res.statusCode >= 300) throw new Error(`login ${email} failed: ${res.body}`);
    this.cookie = String(res.cookies.find((c) => c.name === 'sp_session')?.value ?? '');
    return this;
  }
  setCookie(c: string) { this.cookie = c; return this; }
  async call<T = any>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown): Promise<T> {
    const res = await this.app.inject({ method, url: `/api/v1${url}`, payload: payload as never, headers: { 'x-requested-with': 'stockpilot', cookie: `sp_session=${this.cookie}` } });
    const body = res.body ? JSON.parse(res.body) : {};
    if (res.statusCode >= 300) throw new Error(`${this.label} ${method} ${url} → ${res.statusCode} ${body?.error?.code}: ${body?.error?.message}`);
    return body.data as T;
  }
  get<T = any>(url: string) { return this.call<T>('GET', url); }
  post<T = any>(url: string, payload: unknown = {}) { return this.call<T>('POST', url, payload); }
}

// ───────────────────────── Helpers ─────────────────────────

function rng(seed: number) {
  let a = seed;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let x = Math.imul(a ^ (a >>> 15), 1 | a); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
}
const rand = rng(20261018);
const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)]!;
const between = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1));
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86400_000).toISOString().slice(0, 10);
let barcodeSeq = 1000;
const ean = () => { const body = `896${String(barcodeSeq++).padStart(9, '0')}`; return `${body}${ean13CheckDigit(body)}`; };

let timeColumns: { table: string; ts: string[]; dates: string[]; hasCreated: boolean }[] | null = null;
const SHIFT_EXCLUDE = new Set(['sessions', 'users', 'jobs', 'idempotency_keys', 'plans', 'feature_flags', 'number_sequences', '__drizzle_migrations']);

/** Moves everything written since `marker` to `days` days ago (see file header). */
async function shiftSince(marker: string, days: number) {
  if (days === 0) return;
  if (!timeColumns) {
    const cols = await rows<{ table_name: string; column_name: string; data_type: string }>(db(), sql`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND data_type IN ('timestamp with time zone', 'date')`);
    const map = new Map<string, { ts: string[]; dates: string[]; hasCreated: boolean }>();
    for (const c of cols) {
      if (SHIFT_EXCLUDE.has(c.table_name)) continue;
      const e = map.get(c.table_name) ?? { ts: [], dates: [], hasCreated: false };
      if (c.data_type === 'date') e.dates.push(c.column_name); else e.ts.push(c.column_name);
      if (c.column_name === 'created_at') e.hasCreated = true;
      map.set(c.table_name, e);
    }
    timeColumns = [...map.entries()].map(([table, v]) => ({ table, ...v }));
  }
  for (const tc of timeColumns) {
    const sets: string[] = [];
    for (const c of tc.ts) sets.push(`"${c}" = CASE WHEN "${c}" >= '${marker}'::timestamptz THEN "${c}" + interval '${days} days' ELSE "${c}" END`);
    if (tc.hasCreated) for (const c of tc.dates) sets.push(`"${c}" = CASE WHEN created_at >= '${marker}'::timestamptz THEN "${c}" + ${days} ELSE "${c}" END`);
    if (!sets.length) continue;
    const where = tc.ts.map((c) => `"${c}" >= '${marker}'::timestamptz`).join(' OR ');
    if (!where) continue;
    await db().execute(sql.raw(`UPDATE "${tc.table}" SET ${sets.join(', ')} WHERE ${where}`));
  }
}

async function clock(): Promise<string> {
  const [r] = await rows<{ now: string }>(db(), sql`SELECT clock_timestamp()::text AS now`);
  return r!.now;
}

// ───────────────────────── Catalogue ─────────────────────────

interface ProductSeed { sku: string; name: string; category: string; brand: string; cost: number; price: number; uom: string; weight: number; dims: [number, number, number]; perPallet: number; reorder: number; reorderQty: number; maxStock: number; batch?: boolean; expiry?: boolean; serial?: boolean; temp?: 'ambient' | 'chilled'; demand: number; supplier: string }

function catalogue(): ProductSeed[] {
  const out: ProductSeed[] = [];
  const add = (category: string, prefix: string, supplier: string, items: [string, string, number, number, number, [number, number, number], number, number][], extra: Partial<ProductSeed> = {}) => {
    items.forEach(([name, brand, cost, price, weight, dims, perPallet, demand], i) => {
      const reorder = Math.max(5, Math.round(demand * 12));
      out.push({ sku: `${prefix}-${String(1001 + i)}`, name, category, brand, cost, price, uom: extra.uom ?? 'pcs', weight, dims, perPallet, reorder, reorderQty: reorder * 2, maxStock: reorder * 8, demand, supplier, ...extra });
    });
  };
  add('Electronics', 'EL', 'S-1001', [
    ['LED Bulb 12W (pack of 3)', 'Brightlite', 520, 850, 0.3, [20, 12, 8], 400, 2.5], ['Ceiling Fan 56"', 'AirMax', 7800, 10_900, 6.5, [60, 30, 20], 40, 0.9],
    ['Pedestal Fan 18"', 'AirMax', 6200, 8_900, 7, [55, 45, 25], 35, 0.6], ['Extension Board 6-way', 'PowerLink', 950, 1_550, 0.6, [35, 10, 6], 300, 1.8],
    ['UPS Battery 100Ah', 'VoltPro', 21_000, 27_500, 28, [33, 17, 23], 24, 0.4], ['Electric Kettle 1.8L', 'HomeChef', 2600, 3_900, 1.2, [25, 20, 25], 100, 0.8],
    ['Steam Iron', 'HomeChef', 3100, 4_600, 1.4, [30, 15, 15], 120, 0.7], ['Smartphone Charger 20W', 'PowerLink', 680, 1_200, 0.2, [12, 8, 5], 800, 2.2],
    ['Bluetooth Speaker Mini', 'SoundBox', 2400, 3_800, 0.5, [15, 10, 10], 250, 0.6], ['Wireless Mouse', 'ClickPro', 780, 1_350, 0.15, [15, 10, 6], 600, 1.1],
    ['USB Flash Drive 32GB', 'DataGo', 650, 1_100, 0.05, [10, 6, 2], 2000, 1.4], ['Solar Panel 180W', 'SunVolt', 14_500, 19_800, 12, [150, 68, 4], 30, 0.3],
    ['Inverter 1.5kVA', 'VoltPro', 32_000, 41_000, 15, [45, 35, 25], 20, 0.15], ['Water Dispenser', 'CoolPure', 18_500, 24_900, 16, [35, 35, 100], 12, 0.1],
    ['Room Heater 2000W', 'WarmUp', 4800, 6_900, 3, [40, 25, 20], 60, 0.05], ['Air Cooler 40L', 'CoolPure', 16_500, 22_000, 11, [45, 40, 90], 16, 0.05],
  ]);
  add('Electronics', 'EL', 'S-1001', [
    ['Smartphone 128GB', 'Nova', 38_000, 46_500, 0.4, [18, 10, 6], 300, 0.5], ['Smartwatch Fit', 'Nova', 7_500, 10_500, 0.2, [12, 9, 8], 500, 0.3],
  ].map((x, i) => x as never), { serial: true });
  out.slice(-2).forEach((p, i) => { p.sku = `EL-${2001 + i}`; });
  add('Textiles', 'TX', 'S-1002', [
    ['Cotton Bedsheet Set (King)', 'Gul Textiles', 2_400, 3_900, 1.1, [40, 30, 8], 150, 2], ['Cotton Bedsheet Set (Single)', 'Gul Textiles', 1_500, 2_500, 0.7, [35, 28, 6], 200, 1.6],
    ['Bath Towel 70x140', 'SoftTouch', 750, 1_250, 0.5, [30, 20, 6], 300, 3], ['Hand Towel Pack of 4', 'SoftTouch', 600, 990, 0.4, [25, 20, 6], 350, 2.1],
    ['Lawn Fabric 3-pc Unstitched', 'Bahar', 2_100, 3_400, 0.6, [35, 25, 4], 400, 2.8], ['Khaddar Fabric 3-pc', 'Bahar', 2_600, 4_100, 0.9, [35, 25, 5], 300, 0.4],
    ['Men Shalwar Kameez Wash&Wear', 'Darzi', 1_900, 3_200, 0.6, [35, 25, 4], 350, 1.5], ['Blanket Double Fleece', 'WarmNest', 3_200, 4_900, 2.4, [50, 40, 15], 60, 0.1],
    ['Quilt Razai Double', 'WarmNest', 4_100, 6_200, 3.5, [55, 45, 20], 40, 0.05], ['Cushion Cover Set of 5', 'HomeDecor', 900, 1_600, 0.4, [30, 30, 5], 400, 0.9],
    ['Prayer Mat Velvet', 'Noor', 850, 1_450, 0.6, [40, 25, 4], 300, 1.2], ['Curtain Panel Blackout', 'HomeDecor', 1_800, 2_900, 1, [40, 30, 6], 200, 0.6],
    ['Kids T-Shirt Pack of 3', 'LittleOnes', 950, 1_650, 0.4, [30, 25, 5], 400, 1.4], ['Socks Cotton 6 pairs', 'Darzi', 420, 750, 0.3, [20, 15, 6], 800, 2.4],
    ['Table Cloth Printed', 'HomeDecor', 700, 1_150, 0.5, [30, 25, 4], 350, 0.2], ['Mattress Protector Queen', 'SleepWell', 1_600, 2_600, 1, [40, 30, 8], 120, 0.5],
    ['Polyester Fabric Roll 50m', 'Bahar', 9_800, 13_500, 18, [150, 25, 25], 20, 0.15], ['Denim Fabric Roll 50m', 'Bahar', 14_500, 19_000, 25, [150, 30, 30], 16, 0.1],
    ['Embroidered Dupatta', 'Bahar', 650, 1_150, 0.2, [30, 20, 2], 600, 0],
    ['Silk Saree Premium', 'Bahar', 8_500, 12_900, 0.5, [35, 25, 4], 200, 0],
  ]);
  add('Food & Grocery', 'FD', 'S-1003', [
    ['Basmati Rice 5kg', 'Kissan Fields', 1_650, 2_150, 5.1, [40, 25, 10], 120, 4], ['Basmati Rice 25kg', 'Kissan Fields', 7_900, 9_800, 25.2, [70, 45, 15], 40, 1.2],
    ['Cooking Oil 5L', 'GoldenDrop', 2_550, 3_050, 4.7, [25, 15, 32], 120, 3.2], ['Ghee Tin 2.5kg', 'GoldenDrop', 1_900, 2_350, 2.6, [16, 16, 20], 200, 1.5],
    ['Sugar 10kg', 'SweetCane', 1_350, 1_620, 10.1, [45, 30, 10], 90, 2.6], ['Wheat Flour Atta 10kg', 'ChakkiFresh', 1_150, 1_420, 10.1, [45, 30, 10], 90, 3],
    ['Black Tea 900g', 'ChaiTime', 1_250, 1_680, 0.95, [20, 10, 25], 400, 2.5], ['Red Chilli Powder 400g', 'Masala House', 380, 560, 0.42, [15, 8, 20], 900, 1.6],
    ['Salt Iodized 800g', 'PureSalt', 55, 95, 0.81, [15, 8, 18], 1500, 3], ['Lentils Daal Chana 1kg', 'Kissan Fields', 290, 390, 1.01, [20, 12, 6], 700, 2.2],
    ['Dates Premium 500g', 'Oasis', 650, 950, 0.52, [18, 12, 6], 700, 0.8], ['Milk Powder 900g', 'DairyBest', 1_450, 1_850, 0.95, [14, 14, 20], 400, 1.4],
    ['Biscuits Family Pack', 'CrunchCo', 180, 260, 0.3, [25, 8, 6], 1500, 3.2], ['Instant Noodles 12-pack', 'QuickBite', 720, 960, 0.9, [35, 25, 12], 300, 1.6],
    ['Mineral Water 1.5L x6', 'AquaPure', 360, 480, 9.2, [30, 20, 32], 80, 2.5], ['Ketchup 800g', 'Tomazo', 330, 450, 0.86, [10, 7, 22], 900, 1],
    ['Honey 500g', 'Oasis', 900, 1_350, 0.6, [10, 8, 15], 700, 0.5], ['Basin Gram Flour 1kg', 'ChakkiFresh', 270, 360, 1.01, [20, 12, 6], 700, 0.9],
    ['Vermicelli Seviyan 400g', 'Masala House', 110, 170, 0.42, [20, 10, 5], 1200, 0.3], ['Frozen Paratha 20pcs', 'DairyBest', 650, 890, 1.6, [30, 22, 10], 200, 0],
  ], { batch: true, expiry: true });
  out.filter((p) => p.sku === 'FD-1020').forEach((p) => { p.temp = 'chilled'; });
  add('Packaging', 'PK', 'S-1004', [
    ['Carton Box 18x12x12 (25)', 'BoxCraft', 1_200, 1_700, 6, [50, 35, 15], 60, 2.4], ['Carton Box 24x18x18 (25)', 'BoxCraft', 1_900, 2_600, 9, [65, 50, 18], 40, 1.4],
    ['Packing Tape 2" (36 rolls)', 'SealIt', 2_300, 3_100, 7, [40, 30, 20], 60, 1.8], ['Stretch Film 18" Roll', 'WrapPro', 1_650, 2_250, 2.6, [50, 12, 12], 120, 1.6],
    ['Bubble Wrap Roll 1m x 50m', 'WrapPro', 2_800, 3_700, 3.2, [100, 30, 30], 30, 0.8], ['Polybag 12x16 (1000)', 'PolyPak', 1_400, 1_950, 4.5, [40, 30, 15], 80, 1.2],
    ['Courier Flyer Bag (500)', 'PolyPak', 1_550, 2_150, 3, [40, 30, 10], 100, 2.2], ['Pallet Wooden Standard', 'WoodWorks', 2_200, 2_900, 18, [120, 100, 15], 20, 0.3],
    ['Shipping Labels A6 (1000)', 'LabelMate', 1_100, 1_550, 2.2, [20, 15, 15], 200, 1.1], ['Corner Edge Protector (100)', 'WrapPro', 950, 1_350, 3, [80, 10, 10], 60, 0.4],
  ]);
  add('General Merchandise', 'GN', 'S-1005', [
    ['Stainless Steel Flask 1L', 'SteelCraft', 1_100, 1_750, 0.6, [10, 10, 30], 300, 1.4], ['Non-stick Fry Pan 28cm', 'HomeChef', 1_800, 2_750, 1.1, [50, 30, 6], 150, 0.9],
    ['Plastic Storage Box 40L', 'BoxCraft', 1_250, 1_890, 1.6, [55, 40, 30], 50, 0.8], ['Dinner Set 32pcs', 'TableArt', 6_200, 8_900, 7.5, [55, 35, 30], 30, 0.3],
    ['Detergent Powder 4kg', 'CleanMax', 1_350, 1_750, 4.1, [35, 25, 15], 120, 3], ['Dishwash Liquid 1L', 'CleanMax', 290, 420, 1.1, [10, 7, 25], 600, 2.6],
    ['Floor Cleaner 2L', 'CleanMax', 520, 760, 2.2, [15, 10, 30], 300, 1.8], ['Hand Wash 500ml', 'CleanMax', 230, 340, 0.55, [8, 6, 20], 900, 2.4],
    ['Tissue Box (pack of 5)', 'SoftTouch', 520, 750, 0.9, [35, 25, 12], 300, 2.2], ['School Bag Kids', 'LittleOnes', 1_450, 2_300, 0.8, [40, 30, 15], 120, 0.7],
    ['Water Cooler Jug 12L', 'SteelCraft', 1_650, 2_400, 1.4, [30, 30, 40], 60, 0.5], ['Garden Hose 30m', 'GreenYard', 1_900, 2_800, 2.8, [40, 40, 15], 60, 0.1],
    ['Plastic Chair Monobloc', 'SeatWell', 1_600, 2_250, 2.6, [55, 55, 80], 30, 0.6], ['Broom & Dustpan Set', 'CleanMax', 450, 690, 0.8, [100, 25, 10], 120, 0.9],
    ['Mosquito Repellent Coil (box)', 'NightGuard', 260, 380, 0.4, [20, 12, 8], 900, 1.2], ['Bathroom Mirror Cabinet', 'HomeDecor', 5_400, 7_900, 6, [60, 45, 12], 25, 0],
    ['Pressure Cooker 7L', 'HomeChef', 4_200, 5_900, 3.2, [35, 30, 25], 60, 0.5], ['Glass Water Set 7pcs', 'TableArt', 1_100, 1_650, 2.4, [35, 25, 25], 80, 0.6],
    ['Laundry Basket', 'BoxCraft', 650, 990, 0.7, [45, 35, 50], 60, 0.4], ['Ironing Board', 'HomeChef', 2_900, 4_200, 5, [120, 35, 6], 50, 0.2],
    ['Toothpaste Family 200g', 'CleanMax', 240, 340, 0.25, [20, 5, 4], 1800, 2.6], ['Shampoo 650ml', 'CleanMax', 720, 980, 0.72, [9, 6, 24], 700, 1.7],
    ['Toilet Roll 10-pack', 'SoftTouch', 650, 890, 1.1, [40, 22, 12], 200, 2.3], ['LED Torch Rechargeable', 'Brightlite', 850, 1_350, 0.4, [20, 8, 8], 600, 0.9],
    ['Thermos Lunch Box', 'SteelCraft', 1_250, 1_850, 0.9, [22, 16, 14], 200, 0.5], ['Wall Clock Classic', 'HomeDecor', 1_150, 1_790, 0.7, [32, 32, 5], 200, 0],
  ]);
  add('General Merchandise', 'HW', 'S-1012', [
    ['Steel Cooking Pot Set 5pcs', 'SteelCraft', 3_900, 5_600, 4.2, [40, 40, 30], 40, 0.6], ['Knife Set 6pcs', 'SteelCraft', 1_350, 2_100, 0.9, [35, 15, 6], 200, 0.7],
    ['Tool Kit 40pcs', 'SteelCraft', 2_800, 4_100, 2.5, [40, 25, 8], 80, 0.4], ['Padlock Brass 50mm', 'SteelCraft', 420, 690, 0.35, [10, 6, 4], 900, 1.1],
    ['Steel Water Bottle 750ml', 'SteelCraft', 650, 1_050, 0.35, [8, 8, 26], 500, 1.3], ['Kitchen Rack 3-tier', 'SteelCraft', 2_400, 3_500, 3.8, [60, 35, 10], 50, 0.3],
    ['Cutlery Set 24pcs', 'SteelCraft', 1_600, 2_450, 1.5, [35, 25, 6], 150, 0.5], ['Tiffin Carrier 3-tier', 'SteelCraft', 1_150, 1_750, 0.9, [18, 18, 25], 200, 0.6],
  ]);
  return out;
}

const SUPPLIERS = [
  ['S-1001', 'Al-Faisal Electronics Pvt Ltd', 'Karachi', 'Muhammad Faisal', '+92 21 32410000', 10], ['S-1002', 'Gul Textile Mills Ltd', 'Faisalabad', 'Tariq Gul', '+92 41 8710000', 12],
  ['S-1003', 'Kissan Fields Foods', 'Lahore', 'Rana Shahid', '+92 42 35710000', 5], ['S-1004', 'BoxCraft Packaging Industries', 'Karachi', 'Sana Mirza', '+92 21 35060000', 6],
  ['S-1005', 'HomeChef Consumer Products', 'Lahore', 'Asad Mehmood', '+92 42 35860000', 8], ['S-1006', 'GoldenDrop Edible Oils', 'Karachi', 'Hina Shaikh', '+92 21 34530000', 7],
  ['S-1007', 'SunVolt Energy Solutions', 'Islamabad', 'Omar Niazi', '+92 51 2870000', 14], ['S-1008', 'CleanMax Chemicals', 'Hyderabad', 'Raza Memon', '+92 22 2780000', 7],
  ['S-1009', 'PolyPak Plastics', 'Lahore', 'Nida Butt', '+92 42 37450000', 6], ['S-1010', 'Noor Carpets & Mats', 'Gujranwala', 'Waqas Noor', '+92 55 3820000', 9],
  ['S-1011', 'Oasis Dry Fruits Traders', 'Quetta', 'Abdul Wahid', '+92 81 2830000', 12], ['S-1012', 'SteelCraft Kitchenware', 'Gujrat', 'Kashif Iqbal', '+92 53 3530000', 9],
] as const;

const CUSTOMERS = [
  ['C-1001', 'Metropolitan Wholesale Club', 'Karachi', 6_000_000, 30], ['C-1002', 'Al-Noor Super Store', 'Karachi', 2_500_000, 15], ['C-1003', 'City Mart Gulberg', 'Lahore', 3_000_000, 30],
  ['C-1004', 'Faisal Traders', 'Faisalabad', 1_500_000, 15], ['C-1005', 'United General Store', 'Hyderabad', 1_000_000, 15], ['C-1006', 'Capital Wholesale Mart', 'Islamabad', 4_000_000, 30],
  ['C-1007', 'Shaheen Distributors', 'Rawalpindi', 3_500_000, 45], ['C-1008', 'Madina Cash & Carry', 'Multan', 2_000_000, 30], ['C-1009', 'Green Valley Grocers', 'Peshawar', 1_200_000, 15],
  ['C-1010', 'Royal Electronics Mall', 'Karachi', 5_000_000, 30], ['C-1011', 'Bismillah Cloth House', 'Sialkot', 1_000_000, 30], ['C-1012', 'Pak Online Retail (e-commerce)', 'Lahore', 2_500_000, 7],
] as const;

// ───────────────────────── Seed ─────────────────────────

export async function demoExists(): Promise<boolean> {
  const [u] = await db().select({ id: t.users.id }).from(t.users).where(eq(t.users.email, DEMO_USERS[0].email)).limit(1);
  return Boolean(u);
}

export async function seedDemo(opts: { ifEmpty?: boolean; app?: FastifyInstance; days?: number; log?: (m: string) => void } = {}): Promise<void> {
  if (opts.ifEmpty && (await demoExists())) return;
  const log = opts.log ?? ((m: string) => console.info(`[seed] ${m}`));
  const app = opts.app ?? (await (await import('../app')).buildApp());
  const days = opts.days ?? 120;
  log(`Creating demo company "${DEMO_COMPANY}" with ${days} days of history (this takes a minute)…`);
  await db().execute(sql`ALTER TABLE inventory_transactions DISABLE TRIGGER inventory_transactions_immutable`);
  await db().execute(sql`ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_immutable`);
  try {
    await runSimulation(app, days, log);
  } finally {
    await db().execute(sql`ALTER TABLE inventory_transactions ENABLE TRIGGER inventory_transactions_immutable`);
    await db().execute(sql`ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_immutable`);
  }
  log('Demo data ready.');
}

async function runSimulation(app: FastifyInstance, totalDays: number, log: (m: string) => void) {
  const start = -totalDays;
  let marker = await clock();

  // Day 0 of the simulation: company, team, warehouses, catalogue.
  const reg = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { company: DEMO_COMPANY, name: DEMO_USERS[0].name, email: DEMO_USERS[0].email, password: DEMO_PASSWORD, phone: '+92 300 1112233', city: 'Karachi' } });
  if (reg.statusCode >= 300) throw new Error(`register failed: ${reg.body}`);
  const owner = new Api(app, 'owner').setCookie(String(reg.cookies.find((c) => c.name === 'sp_session')?.value));
  const tenantId = JSON.parse(reg.body).data.tenantId as string;
  await owner.call('PATCH', '/company', { legalName: 'ABC Trading & Warehousing (Pvt.) Ltd.', address: 'Plot 14, Sector 23, Korangi Industrial Area', city: 'Karachi', ntn: '4512376-9', strn: '32-77-8761-234-56', email: 'info@abc-trading.example' });
  await db().update(t.tenants).set({ status: 'active' }).where(eq(t.tenants.id, tenantId));

  const roles = await owner.get<{ id: string; key: string }[]>('/roles');
  const api: Record<string, Api> = { owner };
  for (const u of DEMO_USERS.slice(1)) {
    await owner.post('/users', { name: u.name, email: u.email, phone: `+92 3${between(0, 4)}${between(0, 9)} ${between(1000000, 9999999)}`, roleId: roles.find((r) => r.key === u.role)!.id, password: DEMO_PASSWORD });
    api[u.key] = await new Api(app, u.key).login(u.email);
  }
  const userIds = Object.fromEntries((await rows<{ email: string; id: string }>(db(), sql`SELECT email, id FROM users`)).map((u) => [u.email, u.id]));

  const whDefs = [
    { code: 'KHI-01', name: 'Karachi Main Warehouse', city: 'Karachi', address: 'Korangi Industrial Area, Sector 23', type: 'owned', manager: 'manager@example.com', zones: [['A', 'Zone A · Fast movers', 4, 6, 3, 4, 15], ['B', 'Zone B · Bulk', 3, 6, 4, 3, 40], ['C', 'Zone C · Food', 2, 5, 3, 4, 30]] },
    { code: 'LHE-01', name: 'Lahore Warehouse', city: 'Lahore', address: 'Sundar Industrial Estate, Raiwind Road', type: 'rented', manager: 'manager@example.com', zones: [['A', 'Zone A', 2, 5, 3, 4, 15], ['B', 'Zone B', 2, 4, 3, 3, 40]] },
    { code: 'ISB-01', name: 'Islamabad Warehouse', city: 'Islamabad', address: 'I-9/2 Industrial Area', type: 'rented', manager: 'manager@example.com', zones: [['A', 'Zone A', 2, 4, 3, 4, 20]] },
  ] as const;
  const warehouses: Record<string, string> = {};
  for (const w of whDefs) {
    const created = await owner.post<{ id: string }>('/warehouses', { code: w.code, name: w.name, city: w.city, address: w.address, type: w.type, capacity: 1000, capacityUnit: 'pallets', managerUserId: userIds[w.manager], contactName: 'Sara Malik', contactPhone: '+92 21 35000000', operatingHours: 'Mon–Sat 08:00–20:00' });
    warehouses[w.code] = created.id;
    let x = 6;
    for (const [code, name, aisles, racks, shelves, bins, prio] of w.zones) {
      await api.manager!.post(`/warehouses/${created.id}/locations/generate`, { zoneCode: code, zoneName: name, aisles, racksPerAisle: racks, shelvesPerRack: shelves, binsPerShelf: bins, binCapacityUnits: 0, binVolumeM3: 1.6, temperatureClass: 'ambient', pickPriority: prio, originX: x, originY: 0 });
      x += aisles * 3 + 2;
    }
    if (w.code === 'KHI-01') {
      await api.manager!.post(`/warehouses/${created.id}/locations/generate`, { zoneCode: 'CS', zoneName: 'Cold store', aisles: 1, racksPerAisle: 2, shelvesPerRack: 2, binsPerShelf: 2, binCapacityUnits: 0, binVolumeM3: 1, temperatureClass: 'chilled', pickPriority: 20, originX: x, originY: 0 });
    }
  }
  const zoneIdOf = async (wh: string, code: string) => (await rows<{ id: string }>(db(), sql`SELECT id FROM locations WHERE warehouse_id = ${warehouses[wh]} AND code = ${code}`))[0]!.id;

  const categories: Record<string, string> = {};
  for (const [name, zone, temp] of [['Electronics', 'A', 'ambient'], ['Textiles', 'B', 'ambient'], ['Food & Grocery', 'C', 'ambient'], ['Packaging', 'B', 'ambient'], ['General Merchandise', 'A', 'ambient']] as const) {
    categories[name] = (await api.manager!.post<{ id: string }>('/product-categories', { name, preferredZoneId: await zoneIdOf('KHI-01', zone), temperatureClass: temp })).id;
  }
  const suppliers: Record<string, string> = {};
  for (const [code, name, city, contact, phone, lead] of SUPPLIERS) {
    suppliers[code] = (await api.purchase!.post<{ id: string }>('/suppliers', { code, name, city, contactName: contact, phone, email: `orders@${name.toLowerCase().replace(/[^a-z]+/g, '-').slice(0, 20)}.example`, paymentTermsDays: 30, leadTimeDays: lead, ntn: `${between(1000000, 9999999)}-${between(0, 9)}` })).id;
  }
  const customers: Record<string, string> = {};
  for (const [code, name, city, limit, terms] of CUSTOMERS) {
    customers[code] = (await api.sales!.post<{ id: string }>('/customers', { code, name, city, contactName: 'Purchasing Desk', phone: `+92 3${between(0, 4)}${between(0, 9)} ${between(1000000, 9999999)}`, email: `buying@${code.toLowerCase()}.example`, address: `${between(1, 99)} Main Boulevard, ${city}`, creditLimit: limit, paymentTermsDays: terms, ntn: `${between(1000000, 9999999)}-${between(0, 9)}` })).id;
  }
  // Two 3PL storage clients whose goods we hold.
  const storageClients: string[] = [];
  for (const [code, name] of [['C-2001', 'Zeta Pharma Distribution (3PL client)'], ['C-2002', 'Orbit Home Appliances (3PL client)']]) {
    storageClients.push((await owner.post<{ id: string }>('/customers', { code, name, city: 'Karachi', creditLimit: 0, paymentTermsDays: 15, isStorageClient: true, phone: '+92 21 34000000' })).id);
  }

  const products: (ProductSeed & { id: string })[] = [];
  const supplierFor = (p: ProductSeed) => (p.sku.startsWith('FD-100') && ['FD-1003', 'FD-1004'].includes(p.sku) ? 'S-1006' : p.sku === 'EL-1012' || p.sku === 'EL-1013' ? 'S-1007' : p.brand === 'CleanMax' ? 'S-1008' : p.brand === 'PolyPak' ? 'S-1009' : p.brand === 'Noor' ? 'S-1010' : p.brand === 'Oasis' ? 'S-1011' : p.brand === 'SteelCraft' ? 'S-1012' : p.supplier);
  for (const p of catalogue()) {
    const created = await api.manager!.post<{ id: string }>('/products', {
      sku: p.sku, name: p.name, categoryId: categories[p.category], brand: p.brand, description: `${p.name} — ${p.brand}`, barcode: ean(), uom: p.uom,
      weightKg: p.weight, lengthCm: p.dims[0], widthCm: p.dims[1], heightCm: p.dims[2], unitsPerPallet: p.perPallet, costPrice: p.cost, sellingPrice: p.price,
      minStock: Math.round(p.reorder / 2), reorderLevel: p.reorder, reorderQty: p.reorderQty, maxStock: p.maxStock, defaultSupplierId: suppliers[supplierFor(p)],
      trackBatch: Boolean(p.batch), trackExpiry: Boolean(p.expiry), trackSerial: Boolean(p.serial), temperatureClass: p.temp ?? 'ambient',
      skuType: p.serial ? 'serial' : p.expiry ? 'expirable' : 'simple',
    });
    products.push({ ...p, supplier: supplierFor(p), id: created.id });
  }
  // Carton barcode (12 units per scan) for a fast mover, to demonstrate pack barcodes.
  await api.manager!.post(`/products/${products.find((p) => p.sku === 'FD-1013')!.id}/barcodes`, { generate: true, unitQty: 12 });
  // A size variant family.
  const sheet = products.find((p) => p.sku === 'TX-1001')!;
  await api.manager!.post(`/products/${sheet.id}/variants`, { skuSuffix: 'WHT', attributes: { colour: 'White' } });
  log(`Catalogue: ${products.length} products, ${SUPPLIERS.length} suppliers, ${CUSTOMERS.length + 2} customers, 3 warehouses.`);

  const sellable = products.filter((p) => p.demand > 0);
  const serialSeq = { n: 100000 };

  // ── Operational helpers ──
  const pendingReceipts: { day: number; poId: string; short: boolean; damaged: boolean; qcHold?: boolean }[] = [];

  async function createPo(day: number, supplierCode: string, wh: string, lines: { p: ProductSeed & { id: string }; qty: number }[]) {
    const po = await api.purchase!.post<{ id: string; number: string }>('/purchase-orders', { supplierId: suppliers[supplierCode], warehouseId: warehouses[wh], lines: lines.map((l) => ({ productId: l.p.id, quantity: l.qty, unitCost: Math.round(l.p.cost * (0.97 + rand() * 0.06)) })) });
    const sub = await api.purchase!.post<{ status: string; approvalRequired: boolean }>(`/purchase-orders/${po.id}/submit`);
    if (sub.approvalRequired) {
      const pending = await owner.get<{ id: string; entityId: string }[]>('/approvals?status=pending&pageSize=200');
      const req = pending.find((a) => a.entityId === po.id);
      if (req) await owner.post(`/approvals/${req.id}/decide`, { decision: 'approved', comment: 'Approved — required for stock cover' });
    } else if (sub.status === 'submitted') {
      await api.manager!.post(`/purchase-orders/${po.id}/approve`).catch(() => owner.post(`/purchase-orders/${po.id}/approve`));
    }
    void day;
    return po;
  }

  async function receivePo(poId: string, day: number, opts: { short?: boolean; damaged?: boolean; qcHold?: boolean } = {}) {
    const po = await api.receiver!.get<{ warehouseId: string; number: string; lines: { id: string; productId: string; sku: string; remainingQty: number; trackBatch: boolean; trackExpiry: boolean; trackSerial: boolean }[] }>(`/purchase-orders/${poId}`);
    const lines = po.lines.filter((l) => l.remainingQty > 0).map((l, i) => {
      const qty = opts.short && i === 0 ? Math.max(1, Math.floor(l.remainingQty * 0.85)) : l.remainingQty;
      const p = products.find((x) => x.id === l.productId)!;
      const serials = l.trackSerial ? Array.from({ length: qty }, () => `SN${p.sku.replace('-', '')}${serialSeq.n++}`) : [];
      // Days from the real 'now' to pass; the day is shifted afterwards so the final expiry = simulated day + passDays.
      const passDays = p.sku === 'FD-1011' && day > -70 ? 12 - day : p.sku === 'FD-1019' && day > -70 ? -3 - day : between(200, 420);
      return {
        purchaseOrderLineId: l.id, productId: l.productId, quantity: qty,
        damagedQty: opts.damaged && i === 1 ? Math.min(2, qty - 1) : 0,
        quarantineQty: 0, qcStatus: opts.qcHold && i === 0 ? 'pending' : 'passed',
        batchNo: l.trackBatch ? `B${String(Math.abs(day)).padStart(3, '0')}${p.sku.slice(-2)}` : undefined,
                expiryDate: l.trackExpiry ? iso(passDays) : undefined,
        serials,
      };
    });
    if (!lines.length) return null;
    return api.receiver!.post<{ id: string }>('/receiving', { purchaseOrderId: poId, warehouseId: po.warehouseId, deliveryNoteNo: `DN-${between(10000, 99999)}`, vehicleNo: `K${pick(['HI', 'LE', 'RI'])}-${between(1000, 9999)}`, lines, confirmOverReceipt: true });
  }

  async function putawayAll(wh: string, leave = 0) {
    const tasks = await api.receiver!.get<{ id: string; suggestedLocationId: string | null; productId: string; quantity: number }[]>(`/putaway/tasks?status=pending&warehouseId=${warehouses[wh]}&pageSize=200`);
    for (const task of tasks.slice(0, Math.max(0, tasks.length - leave))) {
      let loc = task.suggestedLocationId;
      if (!loc) {
        const sug = await api.receiver!.get<{ candidates: { locationId: string }[] }>(`/putaway/suggest?warehouseId=${warehouses[wh]}&productId=${task.productId}&quantity=${task.quantity}`);
        loc = sug.candidates[0]?.locationId ?? null;
      }
      if (!loc) {
        const bins = await rows<{ id: string }>(db(), sql`SELECT l.id FROM locations l JOIN products p ON p.id = ${task.productId} WHERE l.warehouse_id = ${warehouses[wh]} AND l.type = 'bin' AND l.temperature_class = p.temperature_class ORDER BY random() LIMIT 1`);
        await api.manager!.post(`/putaway/tasks/${task.id}/complete`, { locationId: bins[0]!.id, overrideReason: 'Suggested bins full — placed in overflow bin' });
        continue;
      }
      await api.receiver!.post(`/putaway/tasks/${task.id}/complete`, { locationId: loc });
    }
  }

  async function fulfil(orderId: string, stage: 'pick' | 'pack' | 'dispatch' | 'all' = 'all', partialPick = false) {
    const tasks = await api.picker!.get<{ id: string; quantity: number; pickedQty: number; locationBarcode: string; barcode: string | null; sku: string; productId: string; locationCode: string }[]>(`/picking/tasks?salesOrderId=${orderId}&pageSize=200`);
    for (const [i, task] of tasks.entries()) {
      if (partialPick && i > 0) break;
      const p = products.find((x) => x.id === task.productId);
      let serials: string[] = [];
      if (p?.serial) {
        const list = await api.controller!.get<{ serial: string; locationCode: string }[]>(`/serials?productId=${task.productId}&status=in_stock&pageSize=200`);
        serials = list.filter((s) => s.locationCode === task.locationCode).slice(0, task.quantity - task.pickedQty).map((s) => s.serial);
        if (serials.length < task.quantity - task.pickedQty) { await api.picker!.post(`/picking/tasks/${task.id}/short`, { reason: 'Serial units not found in bin' }); continue; }
      }
      await api.picker!.post(`/picking/tasks/${task.id}/confirm`, { locationCode: task.locationBarcode, productCode: task.barcode ?? task.sku, quantity: task.quantity - task.pickedQty, serials });
    }
    if (stage === 'pick') return;
    const order = await api.picker!.get<{ lines: { sku: string; barcode: string | null; pickedQty: number; weightKg: number }[]; status: string }>(`/sales-orders/${orderId}`);
    if (!['picking', 'reserved'].includes(order.status) || !order.lines.some((l) => l.pickedQty > 0)) return;
    for (const l of order.lines.filter((x) => x.pickedQty > 0)) await api.picker!.post(`/packing/${orderId}/scan`, { code: l.barcode ?? l.sku, quantity: l.pickedQty });
    const weight = order.lines.reduce((s, l) => s + l.pickedQty * l.weightKg, 0);
    const cartons = Math.max(1, Math.ceil(weight / 25));
    await api.picker!.post(`/packing/${orderId}/complete`, { packages: Array.from({ length: Math.min(cartons, 12) }, () => ({ weightKg: Math.round((weight / Math.min(cartons, 12)) * 10) / 10 })) });
    if (stage === 'pack') return;
    const own = rand() < 0.5;
    await api.dispatcher!.post(`/dispatch/${orderId}`, own
      ? { carrier: 'Own vehicle', vehicleNo: `KHI-${between(1000, 9999)}`, driverName: pick(['Rashid', 'Akram', 'Shafiq', 'Nadeem']), driverPhone: '+92 300 5550000', freightCost: between(1500, 6000) }
      : { carrier: pick(['TCS', 'Leopards', 'M&P']), bookWithCarrier: pick(['tcs', 'leopards', 'mnp']), freightCost: between(800, 3500) });
  }

  async function createOrder(day: number, wh: string, customerCode: string, lineCount: number, opts: { requiredIn?: number; priority?: string; confirm?: boolean } = {}) {
    const chosen = new Set<ProductSeed & { id: string }>();
    while (chosen.size < lineCount) {
      const weighted = sellable.filter((p) => rand() < p.demand / 4);
      chosen.add(pick(weighted.length ? weighted : sellable));
    }
    const lines = [...chosen].map((p) => ({ productId: p.id, quantity: Math.max(1, Math.round(p.demand * between(2, 6))) }));
    try {
      return await api.sales!.post<{ id: string; number: string; status: string }>('/sales-orders', {
        customerId: customers[customerCode], warehouseId: warehouses[wh], priority: opts.priority ?? pick(['normal', 'normal', 'normal', 'high', 'low', 'urgent']),
        requiredDate: opts.requiredIn !== undefined ? iso(opts.requiredIn) : undefined, lines, confirm: opts.confirm ?? true, allowPartial: true,
      });
    } catch (err) {
      if (String(err).includes('CREDIT_LIMIT')) return null;
      throw err;
    }
    void day;
  }

  async function payDueInvoices() {
    const invoices = await api.accountant!.get<{ id: string; balance: number; issueDate: string; type: string }[]>('/invoices?status=issued,partially_paid&pageSize=200');
    for (const inv of invoices) {
      if (inv.type === 'credit_note' || inv.balance <= 0) continue;
      const age = (Date.now() - new Date(inv.issueDate).getTime()) / 86400_000;
      if (age > 18 && rand() < 0.75) {
        const partial = rand() < 0.2;
        await api.accountant!.post('/payments', { invoiceId: inv.id, amount: partial ? Math.round(inv.balance / 2) : inv.balance, method: pick(['bank_transfer', 'bank_transfer', 'cheque', 'raast', 'cash']), bank: pick(['HBL', 'Meezan Bank', 'MCB Bank', 'Bank Alfalah']), reference: `TRX${between(100000, 999999)}` });
      }
    }
    const bills = await api.accountant!.get<{ id: string; balance: number; billDate: string }[]>('/supplier-bills?status=open&pageSize=200');
    for (const b of bills) {
      const age = (Date.now() - new Date(b.billDate).getTime()) / 86400_000;
      if (age > 25 && rand() < 0.7) await api.accountant!.post('/payments', { billId: b.id, amount: b.balance, method: 'bank_transfer', bank: 'HBL', reference: `PAY${between(100000, 999999)}` });
    }
  }

  async function step(day: number, fn: () => Promise<void>) {
    marker = await clock();
    await fn();
    await shiftSince(marker, day);
  }

  // ── Opening stock (first simulated day) ──
  await shiftSince(marker, start);
  await step(start, async () => {
    const bySupplier = new Map<string, { p: ProductSeed & { id: string }; qty: number }[]>();
    for (const p of products) {
      const qty = p.demand === 0 ? between(20, 80) : Math.round(p.reorder * (3 + rand() * 3));
      bySupplier.set(p.supplier, [...(bySupplier.get(p.supplier) ?? []), { p, qty }]);
    }
    for (const [sup, lines] of bySupplier) {
      for (let i = 0; i < lines.length; i += 10) {
        const po = await createPo(start, sup, 'KHI-01', lines.slice(i, i + 10));
        await receivePo(po.id, start);
      }
    }
    const lahore = products.filter((p) => p.demand > 1).slice(0, 18);
    const po = await createPo(start, 'S-1002', 'LHE-01', lahore.filter((p) => p.supplier === 'S-1002').map((p) => ({ p, qty: Math.round(p.reorder * 2) })));
    await receivePo(po.id, start);
    const isb = products.filter((p) => p.supplier === 'S-1003').slice(0, 8);
    const po2 = await createPo(start, 'S-1003', 'ISB-01', isb.map((p) => ({ p, qty: Math.round(p.reorder * 2) })));
    await receivePo(po2.id, start);
  });
  await step(start + 1, async () => { await putawayAll('KHI-01'); await putawayAll('LHE-01'); await putawayAll('ISB-01'); });

  // Storage client contract + first inbound of customer-owned goods.
  const zetaProducts = products.filter((p) => p.category === 'General Merchandise').slice(0, 3);
  await step(start + 2, async () => {
    await owner.post('/storage-billing/contracts', { customerId: storageClients[0], warehouseId: warehouses['KHI-01'], startDate: iso(0), minimumMonthlyCharge: 50_000, rates: [
      { chargeType: 'storage', basis: 'pallet_day', rate: 50, description: 'Pallet storage' }, { chargeType: 'inbound_handling', basis: 'per_unit', rate: 15, description: 'Inbound handling' },
      { chargeType: 'outbound_handling', basis: 'per_unit', rate: 15, description: 'Outbound handling' }, { chargeType: 'unloading', basis: 'per_transaction', rate: 2500, description: 'Truck unloading' },
    ] });
    const bins = await rows<{ id: string }>(db(), sql`SELECT id FROM locations WHERE warehouse_id = ${warehouses['KHI-01']} AND type = 'bin' AND code LIKE 'B-03%' ORDER BY code LIMIT 3`);
    await api.receiver!.post('/receiving', { warehouseId: warehouses['KHI-01'], ownerCustomerId: storageClients[0], deliveryNoteNo: 'ZP-INB-001', lines: zetaProducts.map((p, i) => ({ productId: p.id, quantity: 240, locationId: bins[i]!.id })) });
  });

  // ── Daily operations ──
  const replenishEvery = 9;
  for (let day = start + 3; day <= -1; day++) {
    await step(day, async () => {
      // Receipts due today
      for (const r of pendingReceipts.filter((x) => x.day === day)) {
        await receivePo(r.poId, day, r);
        const [po] = await rows<{ warehouse_id: string }>(db(), sql`SELECT warehouse_id FROM purchase_orders WHERE id = ${r.poId}`);
        const code = Object.entries(warehouses).find(([, id]) => id === po!.warehouse_id)![0];
        await putawayAll(code);
      }
      // Sales
      const orderCount = 1 + (Math.abs(day) % 3 === 0 ? 1 : 0) + (rand() < 0.3 ? 1 : 0);
      for (let i = 0; i < orderCount; i++) {
        const o = await createOrder(day, 'KHI-01', pick(CUSTOMERS.filter((c) => !['C-1003', 'C-1006', 'C-1011'].includes(c[0]))).at(0) as string, between(1, 4));
        if (o && o.status !== 'draft' && day < -1) await fulfil(o.id);
      }
      if (Math.abs(day) % 4 === 0) {
        const o = await createOrder(day, 'LHE-01', pick(['C-1003', 'C-1011', 'C-1012']), between(1, 3));
        if (o && day < -1) await fulfil(o.id);
      }
      if (Math.abs(day) % 6 === 0) {
        const o = await createOrder(day, 'ISB-01', 'C-1006', between(1, 2));
        if (o && day < -1) await fulfil(o.id);
      }
      // Deliveries: shipments dispatched 2+ days ago
      if (day < -1) {
        const shipments = await api.dispatcher!.get<{ id: string; status: string; dispatchedAt: string }[]>('/shipments?status=dispatched,in_transit&pageSize=200');
        for (const s of shipments) {
          const age = (Date.now() - new Date(s.dispatchedAt).getTime()) / 86400_000;
          if (s.status === 'dispatched' && age >= 0.9) await api.dispatcher!.post(`/shipments/${s.id}/status`, { status: 'in_transit', note: 'Left the city hub' });
          else if (s.status === 'in_transit' && age >= 1.9) await api.dispatcher!.post(`/shipments/${s.id}/status`, rand() < 0.04 ? { status: 'failed', note: 'Customer shop closed — reattempt tomorrow' } : { status: 'delivered', note: 'Received by store manager' });
        }
      }
      // Replenishment
      if ((day - start) % replenishEvery === 0) {
        const low = await api.purchase!.get<{ id: string; available: number; incoming: number; reorderLevel: number; reorderQty: number; supplierId: string }[]>('/products?stock=low&pageSize=200&warehouseId=' + warehouses['KHI-01']);
        const bySup = new Map<string, { p: ProductSeed & { id: string }; qty: number }[]>();
        for (const l of low) {
          const p = products.find((x) => x.id === l.id);
          if (!p || p.sku === 'EL-1015' || p.sku === 'FD-1002') continue; // left low on purpose
          bySup.set(p.supplier, [...(bySup.get(p.supplier) ?? []), { p, qty: p.reorderQty }]);
        }
        for (const [sup, lines] of bySup) {
          const po = await createPo(day, sup, 'KHI-01', lines.slice(0, 12));
          const lead = SUPPLIERS.find((s) => s[0] === sup)![5];
          pendingReceipts.push({ day: Math.min(-1, day + Math.max(2, Math.round(lead / 2))), poId: po.id, short: rand() < 0.2, damaged: rand() < 0.15 });
        }
      }
      // Inter-warehouse transfer every two weeks
      if ((day - start) % 14 === 5) {
        const stock = await api.manager!.get<{ productId: string; locationId: string; quantity: number; batchId: string | null }[]>(`/inventory?warehouseId=${warehouses['KHI-01']}&status=available&owner=company&pageSize=60&sort=quantity`);
        const lines = stock.filter((s) => s.quantity >= 40 && !products.find((p) => p.id === s.productId)?.serial).slice(0, 3).map((s) => ({ productId: s.productId, sourceLocationId: s.locationId, batchId: s.batchId, quantity: Math.floor(s.quantity / 4) }));
        if (lines.length) {
          const tr = await api.controller!.post<{ id: string }>('/transfers', { type: 'warehouse', sourceWarehouseId: warehouses['KHI-01'], destWarehouseId: warehouses[pick(['LHE-01', 'ISB-01'])], lines, notes: 'Rebalance stock for upcountry demand' });
          await api.manager!.post(`/transfers/${tr.id}/approve`);
          await api.operator!.post(`/transfers/${tr.id}/start-picking`);
          await api.operator!.post(`/transfers/${tr.id}/dispatch`, {});
          if (day < -3) await api.operator!.post(`/transfers/${tr.id}/receive`, {});
        }
      }
      // Weekly cycle count
      if ((day - start) % 7 === 3) {
        const count = await api.controller!.post<{ id: string }>('/stock-counts', { warehouseId: warehouses['KHI-01'], type: 'cycle', cycleSample: 8, assignedTo: userIds['controller@example.com'] });
        const sheet = await api.controller!.get<{ lines: { id: string; expectedQty: number }[] }>(`/stock-counts/${count.id}`);
        await api.controller!.post(`/stock-counts/${count.id}/record`, { lines: sheet.lines.map((l, i) => ({ lineId: l.id, countedQty: i === 0 && rand() < 0.5 ? Math.max(0, l.expectedQty - 1) : l.expectedQty })) });
        const res = await api.controller!.post<{ status: string }>(`/stock-counts/${count.id}/submit`);
        if (res.status === 'pending_approval') {
          const pending = await api.manager!.get<{ id: string; entityId: string; canDecide: boolean }[]>('/approvals?status=pending&pageSize=200');
          const req = pending.find((a) => a.entityId === count.id);
          if (req) await (req.canDecide ? api.manager! : owner).post(`/approvals/${req.id}/decide`, { decision: 'approved', comment: 'Variance verified by recount' });
        }
      }
      // Monthly expenses & storage billing
      if ((day - start) % 30 === 4) {
        for (const [code, rent] of [['KHI-01', 450_000], ['LHE-01', 220_000], ['ISB-01', 180_000]] as const) {
          for (const [category, amount, vendor] of [['rent', rent, 'Landlord'], ['electricity', Math.round(rent * 0.35), 'K-Electric / LESCO'], ['salaries', Math.round(rent * 1.1), 'Payroll'], ['generator', Math.round(rent * 0.08), 'Diesel supplier'], ['security', 60_000, 'SafeGuard Services'], ['internet', 12_000, 'Nayatel / PTCL']] as const) {
            const exp = await api.accountant!.post<{ id: string; status: string; approvalRequestId?: string }>('/expenses', { warehouseId: warehouses[code], category, amount, expenseDate: iso(0), vendor, paymentMethod: 'bank_transfer', costCenter: code });
            if (exp.status === 'pending_approval') {
              const pending = await owner.get<{ id: string; entityId: string }[]>('/approvals?status=pending&pageSize=200');
              const req = pending.find((a) => a.entityId === exp.id);
              if (req) await owner.post(`/approvals/${req.id}/decide`, { decision: 'approved', comment: 'Monthly fixed cost' });
            }
          }
        }
      }
      // 3PL client inbound / outbound
      if (day === start + 50 || day === start + 95) {
        const bins = await rows<{ id: string }>(db(), sql`SELECT id FROM locations WHERE warehouse_id = ${warehouses['KHI-01']} AND type = 'bin' AND code LIKE 'B-03%' ORDER BY code LIMIT 3`);
        await api.receiver!.post('/receiving', { warehouseId: warehouses['KHI-01'], ownerCustomerId: storageClients[0], deliveryNoteNo: `ZP-INB-00${day === start + 50 ? 2 : 3}`, lines: zetaProducts.map((p, i) => ({ productId: p.id, quantity: 120, locationId: bins[i]!.id })) });
      }
      if (day === start + 70) {
        const held = await api.manager!.get<{ productId: string; locationId: string; quantity: number }[]>(`/inventory?ownerCustomerId=${storageClients[0]}&pageSize=10`);
        await api.dispatcher!.post('/inventory/release-to-owner', { ownerCustomerId: storageClients[0], warehouseId: warehouses['KHI-01'], reference: 'ZP-OUT-001', lines: held.slice(0, 2).map((h) => ({ productId: h.productId, locationId: h.locationId, quantity: Math.floor(h.quantity / 3) })) });
      }
      // Near-expiry and expired food batches for the expiry demo
      if (day === -50) {
        const items = products.filter((p) => ['FD-1011', 'FD-1019'].includes(p.sku));
        const po = await createPo(day, 'S-1003', 'KHI-01', items.map((p) => ({ p, qty: 60 })));
        await receivePo(po.id, day);
        await putawayAll('KHI-01');
      }
      // Returns
      if (day === -40 || day === -16 || day === -6) {
        const shipped = await api.sales!.get<{ id: string }[]>('/sales-orders?status=delivered&pageSize=20');
        const o = shipped[between(0, Math.max(0, shipped.length - 1))];
        if (o) {
          const detail = await api.sales!.get<{ lines: { productId: string; shippedQty: number }[] }>(`/sales-orders/${o.id}`);
          const l = detail.lines.find((x) => x.shippedQty >= 2);
          if (l) await api.sales!.post('/returns', { salesOrderId: o.id, reason: day === -16 ? 'wrong_item' : 'damaged', lines: [{ productId: l.productId, quantity: Math.min(3, Math.floor(l.shippedQty / 2)), disposition: day === -16 ? 'available' : day === -6 ? 'quarantine' : 'damaged' }], notes: 'Customer complaint logged by phone' });
        }
      }
      // Occasional damage found in the warehouse
      if ((day - start) % 23 === 11) {
        const stock = await api.controller!.get<{ productId: string; locationId: string; warehouseId: string; quantity: number; batchId: string | null }[]>(`/inventory?warehouseId=${warehouses['KHI-01']}&status=available&owner=company&pageSize=30&sort=quantity`);
        const s = stock.find((x) => x.quantity > 10 && !products.find((p) => p.id === x.productId)?.serial);
        if (s) await api.controller!.post('/inventory/adjustments', { warehouseId: s.warehouseId, locationId: s.locationId, productId: s.productId, batchId: s.batchId, quantityDelta: -2, reasonCode: 'damage', notes: 'Cartons crushed during forklift handling' });
      }
      // Payments
      if (Math.abs(day) % 3 === 0) await payDueInvoices();
    });
  }

  // ── Today: leave a realistic mix of open work ──
  marker = await clock();
  const khi = 'KHI-01';
  // Orders awaiting picking, partially picked, packed (ready to dispatch), backordered and delayed.
  for (let i = 0; i < 3; i++) await createOrder(0, khi, pick(['C-1001', 'C-1002', 'C-1010']), between(2, 3), { requiredIn: 2 });
  const partial = await createOrder(0, khi, 'C-1007', 3, { priority: 'urgent', requiredIn: 1 });
  if (partial) await fulfil(partial.id, 'pick', true);
  for (let i = 0; i < 2; i++) { const o = await createOrder(0, khi, pick(['C-1005', 'C-1008']), 2); if (o) await fulfil(o.id, 'pack'); }
  await createOrder(0, khi, 'C-1004', 2, { confirm: false });
  await createOrder(0, khi, 'C-1009', 1, { confirm: false });
  // Back-ordered: a product deliberately left out of stock.
  const outOfStock = products.find((p) => p.sku === 'FD-1002')!;
  await api.sales!.post('/sales-orders', { customerId: customers['C-1006'], warehouseId: warehouses[khi], lines: [{ productId: outOfStock.id, quantity: 500 }], confirm: true, allowPartial: true }).catch(() => undefined);
  // A delayed order: required date already passed, still waiting for picking (shifted back 5 days).
  const delayedMarker = await clock();
  await createOrder(-5, khi, 'C-1001', 2, { requiredIn: 2, priority: 'high' });
  await shiftSince(delayedMarker, -5);
  // Inbound: a delivery at the dock awaiting putaway, with one line held for QC.
  const lowNow = products.filter((p) => p.category === 'Packaging').slice(0, 3);
  const todayPo = await createPo(0, 'S-1004', khi, lowNow.map((p) => ({ p, qty: p.reorderQty })));
  await receivePo(todayPo.id, 0, { qcHold: true });
  // A PO awaiting owner approval (above PKR 1,000,000).
  const bigLines = products.filter((p) => p.supplier === 'S-1007' || p.sku === 'EL-1005').map((p) => ({ productId: p.id, quantity: 40, unitCost: p.cost }));
  const bigPo = await api.purchase!.post<{ id: string }>('/purchase-orders', { supplierId: suppliers['S-1007'], warehouseId: warehouses[khi], lines: bigLines, notes: 'Solar season stock-up' });
  await api.purchase!.post(`/purchase-orders/${bigPo.id}/submit`);
  // A large adjustment pending approval (unusual write-off for review).
  const big = await api.controller!.get<{ productId: string; locationId: string; warehouseId: string; quantity: number; batchId: string | null; productName: string }[]>(`/inventory?warehouseId=${warehouses[khi]}&status=available&owner=company&q=EL-1005&pageSize=5`);
  if (big[0]) await api.controller!.post('/inventory/adjustments', { warehouseId: big[0].warehouseId, locationId: big[0].locationId, productId: big[0].productId, quantityDelta: -Math.min(6, big[0].quantity), reasonCode: 'loss', notes: 'Units missing during cycle count — under investigation' });
  // A transfer awaiting approval.
  const st = await api.manager!.get<{ productId: string; locationId: string; quantity: number; batchId: string | null }[]>(`/inventory?warehouseId=${warehouses[khi]}&status=available&owner=company&pageSize=40&sort=quantity`);
  const trLine = st.find((s) => s.quantity > 30 && !products.find((p) => p.id === s.productId)?.serial);
  if (trLine) await api.operator!.post('/transfers', { type: 'warehouse', sourceWarehouseId: warehouses[khi], destWarehouseId: warehouses['ISB-01'], lines: [{ productId: trLine.productId, sourceLocationId: trLine.locationId, batchId: trLine.batchId, quantity: 12 }], notes: 'Islamabad branch request' });

  // Calibrate configured capacities to realistic occupancy (Karachi near full) and expire elapsed batches.
  const usage = await rows<{ warehouse_id: string; pallets: string; cbm: string }>(db(), sql`SELECT b.warehouse_id, SUM(CASE WHEN p.units_per_pallet > 0 THEN b.quantity / p.units_per_pallet ELSE 0 END) AS pallets, SUM(b.quantity * p.volume_m3) AS cbm FROM inventory_balances b JOIN products p ON p.id = b.product_id WHERE b.tenant_id = ${tenantId} GROUP BY b.warehouse_id`);
  for (const [code, target] of [['KHI-01', 0.89], ['LHE-01', 0.62], ['ISB-01', 0.41]] as const) {
    const u = usage.find((x) => x.warehouse_id === warehouses[code]);
    const pallets = Math.max(50, Math.ceil(Number(u?.pallets ?? 0) / target));
    await db().update(t.warehouses).set({ capacity: pallets, totalAreaSqm: pallets * 1.6 }).where(eq(t.warehouses.id, warehouses[code]!));
  }
  // Monthly storage invoices for the 3PL client, computed from the (already historical) ledger.
  const contracts = await api.accountant!.get<{ id: string }[]>('/storage-billing/contracts');
  for (const [from, to] of [[-90, -61], [-60, -31], [-30, -1]] as const) {
    if (!contracts[0] || from < start + 2) continue;
    const res = await api.accountant!.post<{ invoice: { id: string } }>(`/storage-billing/contracts/${contracts[0].id}/invoice`, { periodStart: iso(from), periodEnd: iso(to) });
    await db().execute(sql`UPDATE invoices SET issue_date = ${iso(to + 1)}::date, due_date = ${iso(to + 16)}::date, created_at = ${iso(to + 1)}::date + time '10:00' WHERE id = ${res.invoice.id}`);
  }
  await owner.post('/inventory/expire-batches');
  await db().delete(t.jobs);
  await db().delete(t.notifications);
  await db().delete(t.anomalies);
  const { snapshotInventory } = await import('../jobs/handlers');
  await snapshotInventory(tenantId);
  await owner.post('/alerts/scan');
  await owner.post('/ai/briefing');
  await db().delete(t.jobs);
  const [count] = await rows<{ n: string }>(db(), sql`SELECT COUNT(*) AS n FROM inventory_transactions WHERE tenant_id = ${tenantId}`);
  const [orders] = await rows<{ so: string; po: string }>(db(), sql`SELECT (SELECT COUNT(*) FROM sales_orders WHERE tenant_id = ${tenantId}) AS so, (SELECT COUNT(*) FROM purchase_orders WHERE tenant_id = ${tenantId}) AS po`);
  log(`History: ${orders?.so} sales orders, ${orders?.po} purchase orders, ${count?.n} inventory transactions.`);
}
