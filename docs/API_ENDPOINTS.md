# Maal Help — API endpoint index

213 operations, generated from the route registry by `npx tsx scripts/gen-api-index.ts`. Full request and response schemas: `/api/docs` (OpenAPI 3).

## System

| Method | Path | Summary |
|---|---|---|
| `GET` | `/api/v1/health` | Liveness and database readiness |

## Authentication

| Method | Path | Summary |
|---|---|---|
| `POST` | `/api/v1/auth/register` | Create a company (tenant) and its owner account |
| `POST` | `/api/v1/auth/login` | Sign in with email and password |
| `POST` | `/api/v1/auth/logout` | Sign out and revoke the session |
| `GET` | `/api/v1/auth/me` | Current user, active company, role and permissions |
| `POST` | `/api/v1/auth/switch-tenant` | Switch the active company |
| `POST` | `/api/v1/auth/change-password` | Change the current user password |

## Company

| Method | Path | Summary |
|---|---|---|
| `GET` | `/api/v1/company` | Company profile and settings |
| `PATCH` | `/api/v1/company` | Update company profile |
| `PUT` | `/api/v1/company/settings/{section}` | Update one settings section (inventory, notifications, ai, barcode, printing, billing, security, units) |
| `GET` | `/api/v1/company/usage` | Plan usage and limits |

## Users

| Method | Path | Summary |
|---|---|---|
| `GET` | `/api/v1/users` | List company users |
| `POST` | `/api/v1/users` | Add a user to the company |
| `GET` | `/api/v1/users/directory` | Lightweight user list for assignment pickers |
| `PATCH` | `/api/v1/users/{id}` | Change a user role, status or extra permissions |
| `POST` | `/api/v1/users/{id}/reset-password` | Issue a temporary password for a user |

## Roles & permissions

| Method | Path | Summary |
|---|---|---|
| `GET` | `/api/v1/roles/permissions` | Permission catalogue |
| `GET` | `/api/v1/roles` | List roles |
| `POST` | `/api/v1/roles` | Create a custom role |
| `PATCH` | `/api/v1/roles/{id}` | Edit role permissions |
| `DELETE` | `/api/v1/roles/{id}` | Delete an unused custom role |

## Tax

| Method | Path | Summary |
|---|---|---|
| `GET` | `/api/v1/tax-rates` | List tax rates |
| `POST` | `/api/v1/tax-rates` | Create a tax rate |
| `PATCH` | `/api/v1/tax-rates/{id}` | Update a tax rate |

## Approvals

| Method | Path | Summary |
|---|---|---|
| `GET` | `/api/v1/approval-rules` | List approval rules |
| `POST` | `/api/v1/approval-rules` | Create an approval rule |
| `PATCH` | `/api/v1/approval-rules/{id}` | Update an approval rule threshold or approver |
| `DELETE` | `/api/v1/approval-rules/{id}` | Delete an approval rule |
| `GET` | `/api/v1/approvals` | Approval requests; "canDecide" tells the UI whether this user may act |
| `POST` | `/api/v1/approvals/{id}/decide` | Approve or reject a request (posts the underlying transaction on approval) |

## Warehouses & locations

| Method | Path | Summary |
|---|---|---|
| `GET` | `/api/v1/warehouses` | List warehouses with capacity and utilisation |
| `POST` | `/api/v1/warehouses` | Create a warehouse (adds receiving and dispatch docks) |
| `GET` | `/api/v1/warehouses/{id}` | Warehouse detail |
| `PATCH` | `/api/v1/warehouses/{id}` | Update a warehouse |
| `GET` | `/api/v1/warehouses/{id}/locations` | All locations of a warehouse with occupancy (tree-ready flat list) |
| `POST` | `/api/v1/warehouses/{id}/locations` | Create one location in the hierarchy |
| `POST` | `/api/v1/warehouses/{id}/locations/generate` | Bulk-create a zone with aisles, racks, shelves and bins |
| `PUT` | `/api/v1/warehouses/{id}/map` | Save map positions after drag-and-drop |
| `GET` | `/api/v1/warehouses/{id}/utilization` | Zone, rack and bin utilisation with empty / overloaded / underutilised lists |
| `GET` | `/api/v1/warehouses/locations/lookup` | Resolve a scanned location barcode or code |
| `PATCH` | `/api/v1/warehouses/locations/{id}` | Update a location (capacity, status, priority, map) |
| `DELETE` | `/api/v1/warehouses/locations/{id}` | Delete an empty location and its empty children |

## Products

| Method | Path | Summary |
|---|---|---|
| `GET` | `/api/v1/products` | List products with stock totals (search, filter, sort, paginate) |
| `POST` | `/api/v1/products` | Create a product |
| `GET` | `/api/v1/products/lookup` | Resolve a scanned barcode or SKU |
| `GET` | `/api/v1/products/{id}` | Product 360: details, barcodes, stock by location, batches, movements |
| `PATCH` | `/api/v1/products/{id}` | Update a product (price changes are audited) |
| `POST` | `/api/v1/products/{id}/variants` | Create a variant (size, colour…) that inherits the parent product |
| `POST` | `/api/v1/products/{id}/barcodes` | Add a barcode (pack/carton barcodes can represent several units) |
| `DELETE` | `/api/v1/products/barcodes/{id}` | Remove a barcode |
| `GET` | `/api/v1/product-categories` | Product categories |
| `POST` | `/api/v1/product-categories` | Create a category |
| `PATCH` | `/api/v1/product-categories/{id}` | Update a category (e.g. preferred putaway zone) |

## Inventory

| Method | Path | Summary |
|---|---|---|
| `GET` | `/api/v1/batches` | Batches / lots with on-hand quantity and expiry |
| `POST` | `/api/v1/batches` | Register a batch / lot |
| `GET` | `/api/v1/serials` | Serial numbers and their current status / location |
| `GET` | `/api/v1/serials/{serial}/history` | Full movement history of one serial number |
| `GET` | `/api/v1/inventory` | Stock balances by warehouse / location / product / batch / owner / status |
| `GET` | `/api/v1/inventory/summary` | Totals by status and by warehouse |
| `GET` | `/api/v1/inventory/ledger` | Immutable inventory transaction ledger |
| `GET` | `/api/v1/inventory/adjustments` | Stock adjustments |
| `POST` | `/api/v1/inventory/adjustments` | Request a stock adjustment (routed for approval above the configured value threshold) |
| `POST` | `/api/v1/inventory/status-change` | Move stock between statuses (e.g. available → damaged / quarantine / blocked, or release quarantine) |
| `POST` | `/api/v1/inventory/relocate` | Move stock from one location to another within a warehouse (mobile transfer) |
| `POST` | `/api/v1/inventory/release-to-owner` | Release customer-owned (consignment / 3PL) stock back to its owner — counted as outbound handling for billing |
| `POST` | `/api/v1/inventory/expire-batches` | Move stock of expired batches to the "expired" status |

## Transfers

| Method | Path | Summary |
|---|---|---|
| `GET` | `/api/v1/transfers` | Stock transfers |
| `POST` | `/api/v1/transfers` | Create a transfer (draft or submitted as requested) |
| `GET` | `/api/v1/transfers/{id}` | Transfer detail with lines and people |
| `POST` | `/api/v1/transfers/{id}/request` | Submit a draft transfer for approval |
| `POST` | `/api/v1/transfers/{id}/approve` | Approve a requested transfer |
| `POST` | `/api/v1/transfers/{id}/start-picking` | Start picking an approved transfer |
| `POST` | `/api/v1/transfers/{id}/dispatch` | Confirm picked quantities and dispatch (stock becomes in transit). Location transfers complete immediately. |
| `POST` | `/api/v1/transfers/{id}/receive` | Receive an in-transit transfer at the destination warehouse |
| `POST` | `/api/v1/transfers/{id}/complete` | Complete a short-received transfer: writes off the in-transit shortage |
| `POST` | `/api/v1/transfers/{id}/cancel` | Cancel a transfer that has not been dispatched |

## Suppliers

| Method | Path | Summary |
|---|---|---|
| `GET` | `/api/v1/suppliers` | List suppliers with payables and performance |
| `POST` | `/api/v1/suppliers` | Create a supplier |
| `PATCH` | `/api/v1/suppliers/{id}` | Update a supplier |
| `GET` | `/api/v1/suppliers/{id}` | Supplier 360: POs, receipts, returns, payments, outstanding, products, performance |

## Purchasing

| Method | Path | Summary |
|---|---|---|
| `GET` | `/api/v1/purchase-orders` | List purchase orders |
| `POST` | `/api/v1/purchase-orders` | Create a draft purchase order |
| `GET` | `/api/v1/purchase-orders/{id}` | Purchase order with lines and receipts |
| `PUT` | `/api/v1/purchase-orders/{id}` | Replace lines/header of a draft purchase order |
| `POST` | `/api/v1/purchase-orders/{id}/submit` | Submit for approval (auto-approves below the threshold) |
| `POST` | `/api/v1/purchase-orders/{id}/approve` | Approve a submitted purchase order (below approval-rule threshold) |
| `POST` | `/api/v1/purchase-orders/{id}/cancel` | Cancel a purchase order with nothing received |
| `POST` | `/api/v1/purchase-orders/{id}/close` | Close a (partially) received purchase order — remaining quantity will not be received |
| `GET` | `/api/v1/purchase-returns` | Purchase returns to suppliers |
| `POST` | `/api/v1/purchase-returns` | Return goods to a supplier (removes stock and reduces the payable) |

## Receiving

| Method | Path | Summary |
|---|---|---|
| `GET` | `/api/v1/receiving` | Goods receipts (GRNs) |
| `POST` | `/api/v1/receiving` | Receive goods (against a PO, blind, or customer-owned stock). Generates the GRN automatically. |
| `GET` | `/api/v1/receiving/{id}` | GRN detail (printable) |

## Putaway

| Method | Path | Summary |
|---|---|---|
| `GET` | `/api/v1/putaway/suggest` | Ranked putaway location suggestions with reasons |
| `GET` | `/api/v1/putaway/tasks` | Putaway tasks |
| `POST` | `/api/v1/putaway/tasks/{id}/assign` | Assign a putaway task |
| `POST` | `/api/v1/putaway/tasks/{id}/complete` | Confirm putaway into the scanned location. Overrides of the suggestion need a reason. |

## Customers

| Method | Path | Summary |
|---|---|---|
| `GET` | `/api/v1/customers` | Customers with outstanding balance |
| `POST` | `/api/v1/customers` | Create a customer |
| `PATCH` | `/api/v1/customers/{id}` | Update a customer |
| `GET` | `/api/v1/customers/{id}` | Customer 360: orders, purchases, payments, outstanding, returns, held inventory, profitability |

## Sales orders

| Method | Path | Summary |
|---|---|---|
| `GET` | `/api/v1/sales-orders` | Sales orders |
| `POST` | `/api/v1/sales-orders` | Create a sales order (optionally confirm + reserve in one step) |
| `GET` | `/api/v1/sales-orders/{id}` | Sales order with lines, availability, pick tasks, packages, shipment and invoice |
| `PUT` | `/api/v1/sales-orders/{id}` | Edit a draft sales order |
| `POST` | `/api/v1/sales-orders/{id}/confirm` | Confirm and reserve stock (credit and availability checks) |
| `POST` | `/api/v1/sales-orders/{id}/reserve` | Retry reservation for back-ordered quantities |
| `POST` | `/api/v1/sales-orders/{id}/priority` | Change order priority (re-prioritises its pick tasks) |
| `POST` | `/api/v1/sales-orders/{id}/cancel` | Cancel an order before dispatch (releases reservations) |
| `POST` | `/api/v1/sales-orders/{id}/complete` | Complete a delivered order |
| `POST` | `/api/v1/sales-orders/{id}/backorder` | Create a new order for quantities not shipped (partial fulfilment) |
| `GET` | `/api/v1/sales-orders/availability/check` | Real-time sellable availability for products in a warehouse |

## Picking

| Method | Path | Summary |
|---|---|---|
| `GET` | `/api/v1/picking/tasks` | Pick tasks (priority first). Supports single-order, batch (wave), zone and "my tasks" views. |
| `POST` | `/api/v1/picking/waves` | Group pick tasks into a batch or zone wave and optionally assign a picker |
| `GET` | `/api/v1/picking/waves` | Open pick waves |
| `POST` | `/api/v1/picking/tasks/assign` | Assign pick tasks to a picker |
| `POST` | `/api/v1/picking/tasks/{id}/confirm` | Confirm a pick: scanned location and product must match; quantity cannot exceed the task |
| `POST` | `/api/v1/picking/tasks/{id}/short` | Report a short pick: the unpicked remainder is blocked pending a count and re-reserved elsewhere |

## Packing

| Method | Path | Summary |
|---|---|---|
| `GET` | `/api/v1/packing/queue` | Orders ready to pack (all picks finished) |
| `POST` | `/api/v1/packing/{id}/scan` | Packing verification scan: ✓ correct product / ✗ wrong product / ✗ excess quantity |
| `POST` | `/api/v1/packing/{id}/reset` | Restart packing verification for an order |
| `POST` | `/api/v1/packing/{id}/complete` | Complete packing: creates packages (with barcodes) and a shipment ready for dispatch |

## Dispatch

| Method | Path | Summary |
|---|---|---|
| `POST` | `/api/v1/dispatch/{id}` | Dispatch a packed order: consumes stock, ships packed quantities, creates the sales invoice |
| `GET` | `/api/v1/shipments` | Shipments |
| `GET` | `/api/v1/shipments/{id}` | Shipment with packages and status history |
| `POST` | `/api/v1/shipments/{id}/status` | Update delivery status (Dispatched → In transit → Delivered / Failed / Returned) |

## Returns

| Method | Path | Summary |
|---|---|---|
| `GET` | `/api/v1/returns` | Customer returns |
| `POST` | `/api/v1/returns` | Receive a customer return. Each line goes to Available, Damaged, Quarantine, Repair (blocked) or Write-off. |
| `GET` | `/api/v1/returns/{id}` | Return detail |

## Stock counts

| Method | Path | Summary |
|---|---|---|
| `GET` | `/api/v1/stock-counts` | Stock counts |
| `POST` | `/api/v1/stock-counts` | Create a count. Lines are snapshotted from the system balance (full, cycle, blind, location or product scope). |
| `GET` | `/api/v1/stock-counts/{id}` | Count sheet. Blind counts hide expected quantities from counters until submitted. |
| `POST` | `/api/v1/stock-counts/{id}/assign` | Assign a counter |
| `POST` | `/api/v1/stock-counts/{id}/record` | Record counted quantities (scan location + product, enter quantity). Can be called repeatedly. |
| `POST` | `/api/v1/stock-counts/{id}/submit` | Submit for review. Variances within tolerance post automatically; significant variances require approval. |
| `POST` | `/api/v1/stock-counts/{id}/cancel` | Cancel an open count |

## Billing

| Method | Path | Summary |
|---|---|---|
| `GET` | `/api/v1/invoices` | Customer invoices (sales, storage, credit notes) |
| `GET` | `/api/v1/invoices/{id}` | Invoice with lines and payments (printable) |
| `POST` | `/api/v1/invoices/{id}/void` | Void an unpaid invoice (reason required) |
| `GET` | `/api/v1/supplier-bills` | Supplier bills (payables) |
| `PATCH` | `/api/v1/supplier-bills/{id}` | Record the supplier's own invoice number on a bill |
| `GET` | `/api/v1/payments` | Payments received and made |
| `POST` | `/api/v1/payments` | Record a payment against an invoice (money in) or supplier bill (money out). Over-payment is refused. |
| `GET` | `/api/v1/payments/aging` | Receivables and payables aging (current, 1–30, 31–60, 61–90, 90+ days) |

## Expenses

| Method | Path | Summary |
|---|---|---|
| `GET` | `/api/v1/expenses` | Warehouse expenses |
| `POST` | `/api/v1/expenses` | Record an expense (above the threshold it waits for approval) |

## Storage billing

| Method | Path | Summary |
|---|---|---|
| `GET` | `/api/v1/storage-billing/contracts` | Storage contracts with rates |
| `POST` | `/api/v1/storage-billing/contracts` | Create a storage contract with its rates |
| `POST` | `/api/v1/storage-billing/contracts/{id}/rates` | Add a rate to a contract |
| `DELETE` | `/api/v1/storage-billing/rates/{id}` | Remove a contract rate |
| `GET` | `/api/v1/storage-billing/contracts/{id}/preview` | Preview storage and handling charges for a period (computed from the ledger) |
| `POST` | `/api/v1/storage-billing/contracts/{id}/invoice` | Generate the storage invoice for a period |

## Profitability

| Method | Path | Summary |
|---|---|---|
| `GET` | `/api/v1/profitability` | Estimated profitability (revenue, COGS, operating cost, net) — company and per warehouse |

## Dashboard

| Method | Path | Summary |
|---|---|---|
| `GET` | `/api/v1/dashboard` | Business Command Center: inventory, warehouse, operations and financial KPIs with alerts and next actions |

## Alerts

| Method | Path | Summary |
|---|---|---|
| `GET` | `/api/v1/alerts` | Alert center (only alerts the user is permitted to see) |
| `POST` | `/api/v1/alerts/{id}/read` | Mark an alert as read |
| `POST` | `/api/v1/alerts/read-all` | Mark all visible alerts as read |
| `POST` | `/api/v1/alerts/{id}/resolve` | Resolve an alert |
| `POST` | `/api/v1/alerts/scan` | Re-evaluate alert conditions now |

## Audit

| Method | Path | Summary |
|---|---|---|
| `GET` | `/api/v1/audit` | Append-only audit trail (who, what, old/new value, IP, device, when) |

## Search

| Method | Path | Summary |
|---|---|---|
| `GET` | `/api/v1/search` | Global search: SKU, product, barcode, customer, supplier, order, PO, GRN, shipment, warehouse, location, batch, serial |

## Reports

| Method | Path | Summary |
|---|---|---|
| `GET` | `/api/v1/reports` | Report catalogue (reports the user may run) |
| `GET` | `/api/v1/reports/{key}` | Run a report with filters, search, sorting and pagination |
| `GET` | `/api/v1/reports/{key}/export` | Export a report as CSV, Excel or PDF (all matching rows, up to 50,000) |

## Import / export

| Method | Path | Summary |
|---|---|---|
| `GET` | `/api/v1/imports/templates/{entity}` | Download a CSV import template |
| `POST` | `/api/v1/imports` | Upload a CSV or XLSX file for preview and validation (multipart: file, entity). Nothing is imported yet. |
| `GET` | `/api/v1/imports` | Import history |
| `GET` | `/api/v1/imports/{id}` | Import preview with row-level validation errors |
| `POST` | `/api/v1/imports/{id}/commit` | Import the valid rows in one transaction. Invalid rows are skipped only if you acknowledge them. |

## Integrations

| Method | Path | Summary |
|---|---|---|
| `GET` | `/api/v1/integrations` | Available providers and their connection status |
| `POST` | `/api/v1/integrations/{provider}/connect` | Connect an integration (credentials are encrypted at rest) |
| `POST` | `/api/v1/integrations/{provider}/disconnect` | Disconnect an integration and delete its credentials |
| `GET` | `/api/v1/webhooks` | Webhook subscriptions |
| `POST` | `/api/v1/webhooks` | Create a webhook. The signing secret is shown once. |
| `PATCH` | `/api/v1/webhooks/{id}` | Enable/disable or change a webhook |
| `DELETE` | `/api/v1/webhooks/{id}` | Delete a webhook |
| `GET` | `/api/v1/webhooks/{id}/deliveries` | Recent delivery attempts |
| `POST` | `/api/v1/webhooks/{id}/test` | Send a test event |

## Support

| Method | Path | Summary |
|---|---|---|
| `POST` | `/api/v1/support` | Contact platform support |
| `GET` | `/api/v1/support` | My company support tickets |
| `GET` | `/api/v1/support/feature-flags` | Effective feature flags for my company |

## Platform administration

| Method | Path | Summary |
|---|---|---|
| `GET` | `/api/v1/platform/overview` | Platform analytics (aggregate counts only) |
| `GET` | `/api/v1/platform/tenants` | Tenants with plan, status and usage counts |
| `PATCH` | `/api/v1/platform/tenants/{id}` | Change a tenant status or plan |
| `GET` | `/api/v1/platform/plans` | Subscription plans and limits |
| `POST` | `/api/v1/platform/plans` | Create a plan |
| `PATCH` | `/api/v1/platform/plans/{id}` | Update plan price, limits or features |
| `GET` | `/api/v1/platform/feature-flags` | Feature flags |
| `POST` | `/api/v1/platform/feature-flags` | Create a feature flag |
| `PATCH` | `/api/v1/platform/feature-flags/{id}` | Toggle a flag globally or per tenant |
| `GET` | `/api/v1/platform/health` | System health: database, job queue, request metrics, AI configuration |
| `GET` | `/api/v1/platform/ai-usage` | AI usage by tenant and feature (month to date) |
| `GET` | `/api/v1/platform/support` | Support tickets from all tenants |
| `PATCH` | `/api/v1/platform/support/{id}` | Update a support ticket |
| `GET` | `/api/v1/platform/audit` | Platform-level audit trail |

## AI Copilot

| Method | Path | Summary |
|---|---|---|
| `GET` | `/api/v1/ai/status` | AI configuration status (never returns the key) |
| `POST` | `/api/v1/ai/chat` | Ask the Copilot. Answers come only from permission-checked, read-only data tools. |
| `GET` | `/api/v1/ai/conversations` | My Copilot conversations |
| `GET` | `/api/v1/ai/conversations/{id}` | Conversation messages |
| `POST` | `/api/v1/ai/actions/confirm` | Confirm an AI-proposed action. Creates DRAFT purchase orders only; the backend validates everything. |
| `GET` | `/api/v1/ai/briefing` | Today's Warehouse Intelligence Brief (generated if missing) |
| `POST` | `/api/v1/ai/briefing` | Regenerate today's briefing |
| `GET` | `/api/v1/ai/stock-intelligence` | Fast / slow / dead / overstock / understock classification with cover |
| `GET` | `/api/v1/ai/reorder` | Smart reorder recommendations with reasoning (no automatic ordering) |
| `GET` | `/api/v1/ai/anomalies` | Detected unusual activity awaiting review |
| `POST` | `/api/v1/ai/anomalies/{id}/review` | Record a human review of unusual activity |
| `GET` | `/api/v1/ai/space` | Smart space / slotting recommendations (rule-based) |
| `GET` | `/api/v1/ai/reports/monthly` | AI monthly warehouse performance report (JSON or PDF) |
| `POST` | `/api/v1/ai/documents` | Upload a purchase invoice, PO, delivery note, GRN, supplier invoice or packing list for AI extraction (multipart: file, docType) |
| `GET` | `/api/v1/ai/documents` | Uploaded documents |
| `GET` | `/api/v1/ai/documents/{id}` | Document with its extraction for review |
| `POST` | `/api/v1/ai/documents/{id}/approve` | Approve reviewed extraction. Creates a DRAFT purchase order (purchase docs) or returns a pre-filled receipt (delivery docs). Never posts inventory or payments. |
| `POST` | `/api/v1/ai/documents/{id}/reject` | Reject an extraction |
