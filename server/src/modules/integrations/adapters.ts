/**
 * Integration adapters. Business logic depends only on these interfaces; each
 * external system plugs in a provider. Providers that need credentials we do
 * not have ship as clearly-labelled development mocks so the flows are testable
 * end-to-end, and real providers can be dropped in without touching domain code.
 */

export type IntegrationCategory = 'accounting' | 'ecommerce' | 'shipping' | 'messaging';

export interface ProviderInfo {
  key: string;
  name: string;
  category: IntegrationCategory;
  description: string;
  /** Credentials fields the UI asks for. */
  fields: { key: string; label: string; secret?: boolean }[];
  /** true = development mock (no external calls). */
  mock: boolean;
}

export interface ShipmentRequest {
  reference: string;
  destination: string;
  packageCount: number;
  weightKg: number;
  codAmount?: number;
}
export interface ShippingAdapter {
  createShipment(req: ShipmentRequest): Promise<{ trackingNumber: string; labelUrl?: string; service: string }>;
  track(trackingNumber: string): Promise<{ status: 'in_transit' | 'delivered' | 'failed' | 'returned' | 'dispatched'; detail: string }>;
}

export interface AccountingAdapter {
  pushInvoice(invoice: { number: string; customer: string; total: number; currency: string; issueDate: string }): Promise<{ externalId: string }>;
  pushBill(bill: { number: string; supplier: string; total: number; currency: string; billDate: string }): Promise<{ externalId: string }>;
}

export interface EcommerceAdapter {
  pullOrders(since: Date): Promise<{ externalId: string; customer: string; lines: { sku: string; quantity: number; price: number }[] }[]>;
  pushStock(levels: { sku: string; available: number }[]): Promise<{ updated: number }>;
}

export interface MessagingAdapter {
  send(to: string, text: string): Promise<{ messageId: string }>;
}

export const PROVIDERS: ProviderInfo[] = [
  { key: 'quickbooks', name: 'QuickBooks Online', category: 'accounting', description: 'Sync invoices, bills and payments.', fields: [{ key: 'realmId', label: 'Company ID' }, { key: 'accessToken', label: 'Access token', secret: true }], mock: true },
  { key: 'xero', name: 'Xero', category: 'accounting', description: 'Sync invoices, bills and payments.', fields: [{ key: 'tenantId', label: 'Xero tenant ID' }, { key: 'accessToken', label: 'Access token', secret: true }], mock: true },
  { key: 'business_central', name: 'Microsoft Business Central', category: 'accounting', description: 'Post sales and purchase documents.', fields: [{ key: 'environment', label: 'Environment' }, { key: 'clientSecret', label: 'Client secret', secret: true }], mock: true },
  { key: 'shopify', name: 'Shopify', category: 'ecommerce', description: 'Import orders and publish stock levels.', fields: [{ key: 'shopDomain', label: 'Shop domain' }, { key: 'accessToken', label: 'Admin API token', secret: true }], mock: true },
  { key: 'woocommerce', name: 'WooCommerce', category: 'ecommerce', description: 'Import orders and publish stock levels.', fields: [{ key: 'siteUrl', label: 'Site URL' }, { key: 'consumerSecret', label: 'Consumer secret', secret: true }], mock: true },
  { key: 'amazon', name: 'Amazon Seller Central', category: 'ecommerce', description: 'Import orders.', fields: [{ key: 'sellerId', label: 'Seller ID' }, { key: 'refreshToken', label: 'Refresh token', secret: true }], mock: true },
  { key: 'tcs', name: 'TCS Express', category: 'shipping', description: 'Book consignments and track deliveries (Pakistan).', fields: [{ key: 'accountNo', label: 'Account number' }, { key: 'apiKey', label: 'API key', secret: true }], mock: true },
  { key: 'leopards', name: "Leopards Courier", category: 'shipping', description: 'Book COD shipments and track (Pakistan).', fields: [{ key: 'apiKey', label: 'API key', secret: true }, { key: 'apiPassword', label: 'API password', secret: true }], mock: true },
  { key: 'mnp', name: 'M&P Express', category: 'shipping', description: 'Book and track shipments (Pakistan).', fields: [{ key: 'username', label: 'Username' }, { key: 'password', label: 'Password', secret: true }], mock: true },
  { key: 'dhl', name: 'DHL Express', category: 'shipping', description: 'International shipments.', fields: [{ key: 'accountNo', label: 'Account number' }, { key: 'apiKey', label: 'API key', secret: true }], mock: true },
  { key: 'whatsapp', name: 'WhatsApp Business (Cloud API)', category: 'messaging', description: 'Send alerts and order updates on WhatsApp.', fields: [{ key: 'phoneNumberId', label: 'Phone number ID' }, { key: 'token', label: 'Access token', secret: true }], mock: true },
];

function hashCode(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h);
}

/** Development shipping provider: deterministic tracking numbers, simulated progress. */
class MockShipping implements ShippingAdapter {
  constructor(private readonly carrier: string) {}
  async createShipment(req: ShipmentRequest) {
    const n = hashCode(`${req.reference}:${Date.now()}`) % 1_000_000_000;
    return { trackingNumber: `${this.carrier.toUpperCase().slice(0, 3)}${String(n).padStart(9, '0')}`, service: req.codAmount ? 'COD Overnight' : 'Overnight' };
  }
  async track(trackingNumber: string) {
    return { status: 'in_transit' as const, detail: `Mock tracking for ${trackingNumber}: arrived at sorting facility` };
  }
}
class MockAccounting implements AccountingAdapter {
  async pushInvoice(inv: { number: string }) { return { externalId: `MOCK-INV-${inv.number}` }; }
  async pushBill(bill: { number: string }) { return { externalId: `MOCK-BILL-${bill.number}` }; }
}
class MockEcommerce implements EcommerceAdapter {
  async pullOrders() { return []; }
  async pushStock(levels: { sku: string; available: number }[]) { return { updated: levels.length }; }
}
class MockMessaging implements MessagingAdapter {
  async send(to: string) { return { messageId: `mock-${hashCode(to + Date.now())}` }; }
}

export function shippingAdapter(provider: string): ShippingAdapter { return new MockShipping(provider || 'own'); }
export function accountingAdapter(_provider: string): AccountingAdapter { return new MockAccounting(); }
export function ecommerceAdapter(_provider: string): EcommerceAdapter { return new MockEcommerce(); }
export function messagingAdapter(_provider: string): MessagingAdapter { return new MockMessaging(); }

export function providerInfo(key: string): ProviderInfo | undefined {
  return PROVIDERS.find((p) => p.key === key);
}
