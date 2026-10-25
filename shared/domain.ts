/** Domain vocabularies shared by server validation and the web client. */

export const INVENTORY_STATUSES = ['available', 'reserved', 'damaged', 'quarantine', 'expired', 'in_transit', 'blocked'] as const;
export type InventoryStatus = (typeof INVENTORY_STATUSES)[number];

export const TRANSACTION_TYPES = [
  'opening_balance', 'receipt', 'putaway', 'pick', 'dispatch', 'transfer_out', 'transfer_in',
  'adjustment', 'damage', 'return', 'stock_count', 'write_off', 'consumption', 'status_change',
  'reservation', 'reservation_release', 'purchase_return',
] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const LOCATION_TYPES = ['zone', 'aisle', 'rack', 'shelf', 'bin', 'dock', 'staging'] as const;
export type LocationType = (typeof LOCATION_TYPES)[number];
export const LOCATION_CHILD: Record<LocationType, LocationType | null> = {
  zone: 'aisle', aisle: 'rack', rack: 'shelf', shelf: 'bin', bin: null, dock: null, staging: null,
};

export const WAREHOUSE_TYPES = ['owned', 'rented', 'third_party', 'cold_storage', 'bonded', 'distribution_center'] as const;
export const CAPACITY_UNITS = ['pallets', 'cbm', 'sqft', 'sqm', 'units'] as const;
export const TEMPERATURE_CLASSES = ['ambient', 'chilled', 'frozen'] as const;

export const PO_STATUSES = ['draft', 'submitted', 'approved', 'partially_received', 'fully_received', 'closed', 'cancelled'] as const;
export const SO_STATUSES = ['draft', 'confirmed', 'reserved', 'picking', 'packed', 'dispatched', 'delivered', 'completed', 'cancelled'] as const;
export const TRANSFER_STATUSES = ['draft', 'requested', 'approved', 'picking', 'in_transit', 'received', 'completed', 'cancelled'] as const;
export const SHIPMENT_STATUSES = ['ready', 'dispatched', 'in_transit', 'delivered', 'failed', 'returned'] as const;
export const COUNT_TYPES = ['full', 'cycle', 'blind', 'location', 'product'] as const;
export const COUNT_STATUSES = ['draft', 'assigned', 'counting', 'review', 'pending_approval', 'approved', 'posted', 'rejected', 'cancelled'] as const;
export const RETURN_REASONS = ['damaged', 'wrong_item', 'customer_rejection', 'expired', 'defective', 'excess_quantity', 'other'] as const;
export const RETURN_DISPOSITIONS = ['available', 'damaged', 'quarantine', 'repair', 'write_off'] as const;
export const ADJUSTMENT_REASONS = ['damage', 'loss', 'found', 'correction', 'expired', 'write_off', 'consumption', 'theft_suspected', 'other'] as const;
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

export const EXPENSE_CATEGORIES = [
  'rent', 'electricity', 'generator', 'salaries', 'security', 'maintenance', 'fuel', 'equipment',
  'internet', 'repairs', 'transportation', 'labor', 'miscellaneous',
] as const;

export const STORAGE_CHARGE_TYPES = [
  'storage', 'inbound_handling', 'outbound_handling', 'picking', 'packing', 'loading', 'unloading',
  'additional_handling', 'special_storage',
] as const;
export const STORAGE_BASES = [
  'pallet_day', 'box_day', 'cbm_day', 'sqm_month', 'sqft_month', 'bin_day', 'kg_day', 'unit_day',
  'per_transaction', 'per_unit', 'per_order', 'fixed_month',
] as const;
export type StorageBasis = (typeof STORAGE_BASES)[number];

export const PAYMENT_METHODS = ['cash', 'bank_transfer', 'cheque', 'raast', 'jazzcash', 'easypaisa', 'card', 'other'] as const;

export const BARCODE_SYMBOLOGIES = ['ean13', 'ean8', 'upca', 'code128', 'qrcode', 'internal'] as const;

export const CURRENCIES = {
  PKR: { symbol: 'Rs', name: 'Pakistani Rupee', decimals: 0, locale: 'en-PK' },
  USD: { symbol: '$', name: 'US Dollar', decimals: 2, locale: 'en-US' },
  AED: { symbol: 'AED', name: 'UAE Dirham', decimals: 2, locale: 'en-AE' },
  SAR: { symbol: 'SAR', name: 'Saudi Riyal', decimals: 2, locale: 'en-SA' },
  GBP: { symbol: '£', name: 'British Pound', decimals: 2, locale: 'en-GB' },
  EUR: { symbol: '€', name: 'Euro', decimals: 2, locale: 'en-IE' },
} as const;
export type CurrencyCode = keyof typeof CURRENCIES;

export const ALERT_SEVERITIES = ['critical', 'warning', 'info'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const APPROVAL_ENTITY_TYPES = ['stock_adjustment', 'purchase_order', 'stock_count', 'expense', 'transfer'] as const;
export type ApprovalEntityType = (typeof APPROVAL_ENTITY_TYPES)[number];

export const DOCUMENT_TYPES = ['purchase_invoice', 'purchase_order', 'delivery_note', 'grn', 'supplier_invoice', 'packing_list'] as const;

export const IMPORT_ENTITIES = ['products', 'customers', 'suppliers', 'opening_inventory', 'warehouses', 'locations', 'opening_balances'] as const;
export type ImportEntity = (typeof IMPORT_ENTITIES)[number];

/** Standard API envelope. */
export interface ApiError {
  success: false;
  error: { code: string; message: string; details?: unknown };
}
export interface Paginated<T> {
  data: T[];
  meta: { page: number; pageSize: number; total: number; pageCount: number };
}

export function humanize(value: string | null | undefined): string {
  if (!value) return '';
  return value.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}
