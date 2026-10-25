# Maal Help — Role & Permission Matrix

> Generated from `shared/permissions.ts` (the catalogue the API enforces on every route) by `npx tsx scripts/gen-role-matrix.ts`. Do not edit by hand.

Permissions are checked **on the server** for every request; the web menu only hides what a role cannot use. Business Owners can create custom roles in **Settings → Roles** from the same catalogue. The SaaS **Super Admin** is a platform account outside any company: it sees tenants, plans, feature flags, health, AI usage and support tickets, and has **no access** to a company's operational data (verified by an automated test).

## Roles

| Role | Key | Purpose | Permissions |
|---|---|---|---|
| Business Owner | `owner` | Full access to all company data, finance, settings and approvals. | 43 |
| Warehouse Manager | `warehouse_manager` | Runs warehouse operations and staff. No financial data unless granted. | 27 |
| Inventory Controller | `inventory_controller` | Stock accuracy: adjustments, cycle counts, transfers, batches and serials. | 12 |
| Warehouse Operator | `operator` | Mobile tasks: receive, putaway, pick, pack, dispatch, transfer and count. | 13 |
| Receiving Clerk | `receiving_clerk` | Inbound dock: receive goods against POs, record batches/expiry/damage, put away. | 6 |
| Picker / Packer | `picker_packer` | Outbound floor: pick assigned tasks with scan verification and pack orders. | 6 |
| Dispatch Officer | `dispatch_officer` | Dispatch packed orders, record vehicle/driver/carrier and update delivery status. | 5 |
| Sales User | `sales` | Customers, sales orders, stock availability and order status. | 11 |
| Purchase User | `purchase` | Suppliers, purchase orders, receiving and purchase reports. | 10 |
| Accountant | `accountant` | Purchases, sales, payments, receivables, payables and valuation. | 16 |
| Auditor | `auditor` | Read-only access to all records plus the complete audit history. | 17 |
| SaaS Super Admin | platform admin | Tenants, plans, flags, health, AI usage, support. No tenant data. | platform only |

## Matrix

| Permission | Meaning | Owner | WH Mgr | Inv Ctrl | Operator | Receiving | Pick/Pack | Dispatch | Sales | Purchase | Accountant | Auditor |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `dashboard.view` | View operational dashboard | ✔ | ✔ | ✔ | · | · | · | · | ✔ | ✔ | ✔ | ✔ |
| `finance.view` | View sensitive financial figures (value, margin, receivables) | ✔ | · | · | · | · | · | · | · | · | ✔ | ✔ |
| `inventory.view` | View stock balances, ledger, batches and serials | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | · | ✔ | ✔ | ✔ | ✔ |
| `inventory.adjust` | Request stock adjustments and status changes | ✔ | ✔ | ✔ | · | · | · | · | · | · | · | · |
| `inventory.approve` | Approve stock adjustments and count variances | ✔ | ✔ | · | · | · | · | · | · | · | · | · |
| `inventory.count` | Create and perform stock counts | ✔ | ✔ | ✔ | ✔ | · | · | · | · | · | · | · |
| `warehouse.view` | View warehouses, locations and capacity | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `warehouse.manage` | Create and edit warehouses, zones, racks and bins | ✔ | ✔ | · | · | · | · | · | · | · | · | · |
| `product.view` | View products | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `product.manage` | Create and edit products, barcodes and categories | ✔ | ✔ | · | · | · | · | · | · | · | · | · |
| `receiving.execute` | Receive goods and create GRNs | ✔ | ✔ | · | ✔ | ✔ | · | · | · | ✔ | · | · |
| `putaway.execute` | Perform putaway tasks | ✔ | ✔ | ✔ | ✔ | ✔ | · | · | · | · | · | · |
| `transfer.request` | Request stock transfers | ✔ | ✔ | ✔ | ✔ | · | · | · | · | · | · | · |
| `transfer.approve` | Approve stock transfers | ✔ | ✔ | · | · | · | · | · | · | · | · | · |
| `transfer.execute` | Pick, dispatch and receive transfers | ✔ | ✔ | ✔ | ✔ | · | · | · | · | · | · | · |
| `purchase.view` | View purchase orders and suppliers | ✔ | ✔ | · | ✔ | ✔ | · | · | · | ✔ | ✔ | ✔ |
| `purchase.manage` | Create and edit purchase orders and purchase returns | ✔ | · | · | · | · | · | · | · | ✔ | · | · |
| `purchase.approve` | Approve purchase orders | ✔ | · | · | · | · | · | · | · | · | · | · |
| `supplier.manage` | Create and edit suppliers | ✔ | · | · | · | · | · | · | · | ✔ | · | · |
| `customer.view` | View customers | ✔ | ✔ | · | · | · | · | ✔ | ✔ | · | ✔ | ✔ |
| `customer.manage` | Create and edit customers | ✔ | · | · | · | · | · | · | ✔ | · | · | · |
| `sales.view` | View sales orders | ✔ | ✔ | · | ✔ | · | ✔ | ✔ | ✔ | · | ✔ | ✔ |
| `sales.manage` | Create, confirm and cancel sales orders | ✔ | · | · | · | · | · | · | ✔ | · | · | · |
| `picking.execute` | Perform picking tasks | ✔ | ✔ | · | ✔ | · | ✔ | · | · | · | · | · |
| `packing.execute` | Pack orders | ✔ | ✔ | · | ✔ | · | ✔ | · | · | · | · | · |
| `dispatch.execute` | Dispatch shipments and update delivery status | ✔ | ✔ | · | ✔ | · | · | ✔ | · | · | · | · |
| `returns.manage` | Process customer returns | ✔ | ✔ | · | · | · | · | · | ✔ | · | · | · |
| `task.manage` | Assign and prioritise warehouse tasks | ✔ | ✔ | · | · | · | · | · | · | · | · | · |
| `billing.view` | View invoices, bills, storage contracts and payments | ✔ | · | · | · | · | · | · | · | · | ✔ | ✔ |
| `billing.manage` | Manage storage contracts, invoices and payments | ✔ | · | · | · | · | · | · | · | · | ✔ | · |
| `expense.view` | View warehouse expenses | ✔ | · | · | · | · | · | · | · | · | ✔ | ✔ |
| `expense.manage` | Record warehouse expenses | ✔ | · | · | · | · | · | · | · | · | ✔ | · |
| `expense.approve` | Approve expenses over threshold | ✔ | · | · | · | · | · | · | · | · | · | · |
| `report.view` | View operational reports | ✔ | ✔ | ✔ | · | · | · | · | ✔ | ✔ | ✔ | ✔ |
| `report.financial` | View financial reports | ✔ | · | · | · | · | · | · | · | · | ✔ | ✔ |
| `alert.view` | View alert center | ✔ | ✔ | ✔ | · | · | · | · | · | · | ✔ | ✔ |
| `ai.use` | Use the AI Copilot and AI features | ✔ | ✔ | ✔ | · | · | · | · | ✔ | ✔ | ✔ | · |
| `audit.view` | View the audit trail | ✔ | · | · | · | · | · | · | · | · | · | ✔ |
| `approval.decide` | Decide approval requests routed to the user's role | ✔ | ✔ | · | · | · | · | · | · | · | · | · |
| `user.manage` | Manage users, roles and permissions | ✔ | · | · | · | · | · | · | · | · | · | · |
| `settings.manage` | Manage company settings, tax and approval rules | ✔ | · | · | · | · | · | · | · | · | · | · |
| `integration.manage` | Manage integrations, webhooks and API settings | ✔ | · | · | · | · | · | · | · | · | · | · |
| `import.execute` | Import data from Excel/CSV | ✔ | ✔ | · | · | · | · | · | · | · | · | · |

## Important rules enforced in code

- **Financial visibility:** without `finance.view`, cost price, inventory value, margins and receivables are removed from API responses (not just hidden in the UI). The AI Copilot applies the same redaction to its tools.
- **Approvals:** a requester cannot approve their own request (Business Owner excepted). Thresholds are configured in Settings → Approval rules.
- **Posted stock is immutable:** the inventory ledger and audit log reject UPDATE/DELETE at database level; corrections are new, reversing transactions.
- **AI is read-only:** Copilot tools only read data within the caller's permissions; suggested purchase orders open as drafts that a user with `purchase.manage` must save.
- **Tenant isolation:** every query is scoped to the signed-in company; IDs from another company return 404.
