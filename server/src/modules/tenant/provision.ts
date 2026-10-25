import { eq } from 'drizzle-orm';
import { SYSTEM_ROLES } from '@shared/permissions';
import { localizationFor } from '@shared/localization/pk';
import { t, type DbOrTx } from '../../db';
import type { TenantSettings } from '../../db/schema';

export const DEFAULT_SETTINGS: TenantSettings = {
  inventory: { allowNegativeStock: false, defaultCountTolerancePct: 2, expiryAlertDays: 30, deadStockDays: 90, valuationMethod: 'average' },
  notifications: { email: true, whatsapp: false, push: false, dailyBriefing: true, recipients: [] },
  ai: { enabled: true, dailyBriefing: true, anomalyDetection: true, documentExtraction: true, autoReorderDrafts: false },
  barcode: { internalPrefix: 'SP', defaultSymbology: 'code128', labelSize: '50x25' },
  printing: { paperSize: 'A4', labelWidthMm: 50, labelHeightMm: 25, showLogo: true },
  billing: { invoicePrefix: 'INV', paymentTermsDays: 30, storageBillingDay: 1 },
  security: { sessionHours: 12, minPasswordLength: 10, requireStrongPasswords: true },
  units: ['pcs', 'box', 'carton', 'kg', 'g', 'litre', 'ml', 'metre', 'bag', 'roll', 'dozen', 'pallet'],
};

/** Default approval thresholds (PKR). Owners can change them in Settings → Approval rules. */
export const DEFAULT_APPROVAL_RULES = [
  { entityType: 'stock_adjustment', metric: 'value', threshold: 100_000, approverRoleKey: 'warehouse_manager', description: 'Stock adjustments above PKR 100,000 need manager approval' },
  { entityType: 'purchase_order', metric: 'value', threshold: 1_000_000, approverRoleKey: 'owner', description: 'Purchase orders above PKR 1,000,000 need owner approval' },
  { entityType: 'stock_count', metric: 'value', threshold: 50_000, approverRoleKey: 'warehouse_manager', description: 'Count variances above PKR 50,000 need manager approval' },
  { entityType: 'expense', metric: 'value', threshold: 250_000, approverRoleKey: 'owner', description: 'Expenses above PKR 250,000 need owner approval' },
] as const;

export function slugify(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'company';
  return `${base}-${Math.random().toString(36).slice(2, 7)}`;
}

export interface ProvisionInput {
  name: string;
  ownerUserId: string;
  country?: string;
  city?: string;
  currency?: string;
  phone?: string;
  email?: string;
  planCode?: string;
}

/** Creates a tenant with system roles, tax presets, approval rules and a trial subscription. */
export async function provisionTenant(tx: DbOrTx, input: ProvisionInput): Promise<{ tenantId: string; ownerRoleId: string }> {
  const pack = localizationFor(input.country);
  const [plan] = await tx.select().from(t.plans).where(eq(t.plans.code, input.planCode ?? 'professional')).limit(1);

  const [tenant] = await tx.insert(t.tenants).values({
    name: input.name,
    slug: slugify(input.name),
    legalName: input.name,
    country: pack.countryCode,
    city: input.city ?? '',
    phone: input.phone ?? '',
    email: input.email ?? '',
    baseCurrency: input.currency ?? pack.defaultCurrency,
    timezone: pack.timezone,
    settings: DEFAULT_SETTINGS,
    status: 'trial',
    planId: plan?.id ?? null,
  }).returning({ id: t.tenants.id });
  const tenantId = tenant!.id;

  const roleRows = await tx.insert(t.roles).values(SYSTEM_ROLES.map((r) => ({
    tenantId, key: r.key, name: r.name, description: r.description, permissions: r.permissions, isSystem: true,
  }))).returning({ id: t.roles.id, key: t.roles.key });
  const ownerRoleId = roleRows.find((r) => r.key === 'owner')!.id;

  await tx.insert(t.memberships).values({ tenantId, userId: input.ownerUserId, roleId: ownerRoleId });
  await tx.insert(t.taxRates).values(pack.taxPresets.map((p) => ({
    tenantId, code: p.code, name: p.name, rate: p.rate, type: p.type, appliesTo: p.appliesTo, isDefault: p.isDefault ?? false,
  })));
  await tx.insert(t.approvalRules).values(DEFAULT_APPROVAL_RULES.map((r) => ({ tenantId, ...r })));

  if (plan) {
    const start = new Date();
    const end = new Date(start.getTime() + 30 * 86400_000);
    await tx.insert(t.subscriptions).values({
      tenantId, planId: plan.id, status: 'trialing',
      currentPeriodStart: start.toISOString().slice(0, 10), currentPeriodEnd: end.toISOString().slice(0, 10),
    });
  }
  return { tenantId, ownerRoleId };
}
