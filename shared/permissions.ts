/**
 * Permission catalogue and default role bundles.
 *
 * Permissions are stable action identifiers checked on the server for every
 * route. The web client uses the same catalogue only to hide controls the
 * user cannot use — it is never the enforcement point.
 */

export const PERMISSIONS = {
  // Command center
  'dashboard.view': 'View operational dashboard',
  'finance.view': 'View sensitive financial figures (value, margin, receivables)',

  // Inventory
  'inventory.view': 'View stock balances, ledger, batches and serials',
  'inventory.adjust': 'Request stock adjustments and status changes',
  'inventory.approve': 'Approve stock adjustments and count variances',
  'inventory.count': 'Create and perform stock counts',

  // Warehouse
  'warehouse.view': 'View warehouses, locations and capacity',
  'warehouse.manage': 'Create and edit warehouses, zones, racks and bins',

  // Catalogue
  'product.view': 'View products',
  'product.manage': 'Create and edit products, barcodes and categories',

  // Inbound
  'receiving.execute': 'Receive goods and create GRNs',
  'putaway.execute': 'Perform putaway tasks',

  // Transfers
  'transfer.request': 'Request stock transfers',
  'transfer.approve': 'Approve stock transfers',
  'transfer.execute': 'Pick, dispatch and receive transfers',

  // Purchasing
  'purchase.view': 'View purchase orders and suppliers',
  'purchase.manage': 'Create and edit purchase orders and purchase returns',
  'purchase.approve': 'Approve purchase orders',
  'supplier.manage': 'Create and edit suppliers',

  // Sales & fulfilment
  'customer.view': 'View customers',
  'customer.manage': 'Create and edit customers',
  'sales.view': 'View sales orders',
  'sales.manage': 'Create, confirm and cancel sales orders',
  'picking.execute': 'Perform picking tasks',
  'packing.execute': 'Pack orders',
  'dispatch.execute': 'Dispatch shipments and update delivery status',
  'returns.manage': 'Process customer returns',
  'task.manage': 'Assign and prioritise warehouse tasks',

  // Finance
  'billing.view': 'View invoices, bills, storage contracts and payments',
  'billing.manage': 'Manage storage contracts, invoices and payments',
  'expense.view': 'View warehouse expenses',
  'expense.manage': 'Record warehouse expenses',
  'expense.approve': 'Approve expenses over threshold',

  // Insight
  'report.view': 'View operational reports',
  'report.financial': 'View financial reports',
  'alert.view': 'View alert center',
  'ai.use': 'Use the AI Copilot and AI features',
  'audit.view': 'View the audit trail',

  // Administration
  'approval.decide': 'Decide approval requests routed to the user\'s role',
  'user.manage': 'Manage users, roles and permissions',
  'settings.manage': 'Manage company settings, tax and approval rules',
  'integration.manage': 'Manage integrations, webhooks and API settings',
  'import.execute': 'Import data from Excel/CSV',
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export type SystemRoleKey =
  | 'owner'
  | 'warehouse_manager'
  | 'inventory_controller'
  | 'operator'
  | 'receiving_clerk'
  | 'picker_packer'
  | 'dispatch_officer'
  | 'sales'
  | 'purchase'
  | 'accountant'
  | 'auditor';

export interface RoleDefinition {
  key: SystemRoleKey;
  name: string;
  description: string;
  permissions: Permission[];
}

const READ_ONLY: Permission[] = ALL_PERMISSIONS.filter(
  (p) => p.endsWith('.view') || p === 'report.financial' || p === 'audit.view',
);

export const SYSTEM_ROLES: RoleDefinition[] = [
  {
    key: 'owner',
    name: 'Business Owner',
    description: 'Full access to all company data, finance, settings and approvals.',
    permissions: [...ALL_PERMISSIONS],
  },
  {
    key: 'warehouse_manager',
    name: 'Warehouse Manager',
    description: 'Runs warehouse operations and staff. No financial data unless granted.',
    permissions: [
      'dashboard.view', 'inventory.view', 'inventory.adjust', 'inventory.approve', 'inventory.count',
      'warehouse.view', 'warehouse.manage', 'product.view', 'product.manage',
      'receiving.execute', 'putaway.execute', 'transfer.request', 'transfer.approve', 'transfer.execute',
      'purchase.view', 'customer.view', 'sales.view', 'picking.execute', 'packing.execute',
      'dispatch.execute', 'returns.manage', 'task.manage', 'report.view', 'alert.view', 'ai.use',
      'approval.decide', 'import.execute',
    ],
  },
  {
    key: 'inventory_controller',
    name: 'Inventory Controller',
    description: 'Stock accuracy: adjustments, cycle counts, transfers, batches and serials.',
    permissions: [
      'dashboard.view', 'inventory.view', 'inventory.adjust', 'inventory.count', 'warehouse.view',
      'product.view', 'transfer.request', 'transfer.execute', 'putaway.execute', 'report.view',
      'alert.view', 'ai.use',
    ],
  },
  {
    key: 'operator',
    name: 'Warehouse Operator',
    description: 'Mobile tasks: receive, putaway, pick, pack, dispatch, transfer and count.',
    permissions: [
      'inventory.view', 'warehouse.view', 'product.view', 'receiving.execute', 'putaway.execute',
      'transfer.request', 'transfer.execute', 'picking.execute', 'packing.execute', 'dispatch.execute',
      'inventory.count', 'purchase.view', 'sales.view',
    ],
  },
  {
    key: 'receiving_clerk',
    name: 'Receiving Clerk',
    description: 'Inbound dock: receive goods against POs, record batches/expiry/damage, put away.',
    permissions: ['inventory.view', 'warehouse.view', 'product.view', 'purchase.view', 'receiving.execute', 'putaway.execute'],
  },
  {
    key: 'picker_packer',
    name: 'Picker / Packer',
    description: 'Outbound floor: pick assigned tasks with scan verification and pack orders.',
    permissions: ['inventory.view', 'warehouse.view', 'product.view', 'sales.view', 'picking.execute', 'packing.execute'],
  },
  {
    key: 'dispatch_officer',
    name: 'Dispatch Officer',
    description: 'Dispatch packed orders, record vehicle/driver/carrier and update delivery status.',
    permissions: ['warehouse.view', 'product.view', 'sales.view', 'dispatch.execute', 'customer.view'],
  },
  {
    key: 'sales',
    name: 'Sales User',
    description: 'Customers, sales orders, stock availability and order status.',
    permissions: [
      'dashboard.view', 'customer.view', 'customer.manage', 'sales.view', 'sales.manage',
      'product.view', 'inventory.view', 'warehouse.view', 'returns.manage', 'report.view', 'ai.use',
    ],
  },
  {
    key: 'purchase',
    name: 'Purchase User',
    description: 'Suppliers, purchase orders, receiving and purchase reports.',
    permissions: [
      'dashboard.view', 'purchase.view', 'purchase.manage', 'supplier.manage', 'product.view',
      'inventory.view', 'warehouse.view', 'receiving.execute', 'report.view', 'ai.use',
    ],
  },
  {
    key: 'accountant',
    name: 'Accountant',
    description: 'Purchases, sales, payments, receivables, payables and valuation.',
    permissions: [
      'dashboard.view', 'finance.view', 'inventory.view', 'product.view', 'warehouse.view',
      'purchase.view', 'sales.view', 'customer.view', 'billing.view', 'billing.manage',
      'expense.view', 'expense.manage', 'report.view', 'report.financial', 'alert.view', 'ai.use',
    ],
  },
  {
    key: 'auditor',
    name: 'Auditor',
    description: 'Read-only access to all records plus the complete audit history.',
    permissions: [...READ_ONLY, 'dashboard.view', 'report.view', 'alert.view'],
  },
];

export function roleDefinition(key: string): RoleDefinition | undefined {
  return SYSTEM_ROLES.find((r) => r.key === key);
}

export function hasPermission(granted: readonly string[], required: Permission): boolean {
  return granted.includes(required);
}
