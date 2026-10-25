# Stockpilot API

The local service exposes a JSON API under `/api/v1`. It is implemented in `server.mjs`; this document describes the running SQLite adapter, not the separate PostgreSQL schema proposal.

## Authentication and responses

Register or log in to receive the `stockpilot_session` cookie. It is HttpOnly, SameSite=Lax, and expires after 24 hours. Send it on tenant API requests. Tenant context comes from the authenticated membership; callers cannot select a tenant through request data.

Successful responses use `{ "data": ... }`. Failures use `{ "success": false, "error": { "code": "...", "message": "..." } }`. Collections are limited to the latest 250 records; collection pagination, per-list search/sort, and report filters are not implemented. Global search is provided separately by `/search`. Dates are stored as SQLite timestamps/date strings and money is represented as numeric PKR amounts.

## Routes

| Method | Route | Permission / behavior |
| --- | --- | --- |
| GET | `/health` | Public process health |
| POST | `/auth/register` | Public; creates company, owner and session |
| POST | `/auth/login` | Public; authenticates and creates session |
| POST | `/auth/logout` | Revokes current session |
| GET | `/auth/me` | Current user, tenant and role |
| GET | `/dashboard` | `dashboard.read`; inventory KPIs, warehouses, open orders and recent movements |
| GET | `/alerts` | `dashboard.read`; low stock, expiring/expired lots, delayed open orders, over-capacity bins and high-value adjustments |
| GET | `/search?q=…` | Read permission; tenant-scoped search across products, locations, customers, suppliers, orders, purchase orders and shipments |
| GET/POST | `/team` | `team.manage`; list members or add a member with a role and initial password |
| GET | `/roles` | `team.manage`; built-in role permission sets |
| GET/POST | `/warehouses` | `warehouse.read` / `warehouse.manage` |
| GET/POST | `/locations` | `warehouse.read` / `warehouse.manage`; location has an optional parent and barcode |
| GET/POST | `/products` | `product.read` / `product.manage` |
| GET/POST | `/customers` | `people.read` |
| GET/POST | `/suppliers` | `supplier.manage` |
| GET | `/inventory` | `inventory.read`; current balances with product, warehouse and location details |
| GET | `/lots` | `inventory.read`; lot metadata, expiry date and remaining stock |
| POST | `/lots/{id}/expire` | `inventory.adjust`; move available balances for an elapsed lot into the expired status with ledger entries |
| GET | `/putaway/suggest?warehouseId=…&productId=…` | Warehouse/receiving permission; suggests an existing product bin or a location with configured capacity remaining |
| GET | `/movements` | `inventory.read`; ledger history |
| POST | `/receipts` | `receiving.manage` or `receiving.execute`; posts goods to a location; may include `purchaseOrderId` or `ownerCustomerId` |
| POST | `/adjustments` | `inventory.adjust`; posts a non-zero correction movement |
| GET/POST | `/purchase-orders` | `purchasing.manage`; list or create a draft |
| POST | `/purchase-orders/{id}/submit` | Submit a draft for approval |
| POST | `/purchase-orders/{id}/approve` | Approve a submitted PO |
| POST | `/purchase-orders/{id}/close` | Close a received PO |
| GET/POST | `/stock-counts` | `inventory.read` / `inventory.adjust`; create a count pending approval |
| POST | `/stock-counts/{id}/approve` | `inventory.adjust`; post count variances as ledger movements |
| GET | `/transfers` | `transfer.manage`; list tenant transfers |
| POST | `/transfers/request` | `transfer.manage` or `transfer.execute`; create a requested transfer without moving stock |
| POST | `/transfers/{id}/approve` | `transfer.manage`; approve a requested transfer |
| POST | `/transfers/{id}/pick` | `transfer.manage` or `transfer.execute`; move stock into the in-transit status |
| POST | `/transfers/{id}/receive` | `transfer.manage` or `transfer.execute`; receive stock into the destination bin and complete the transfer |
| GET/POST | `/orders` | `orders.manage`; create and reserve an order, or list orders with lines |
| POST | `/orders/{id}/pick` | Verify every order line and its warehouse location |
| POST | `/orders/{id}/pack` | Record package count after picking |
| POST | `/orders/{id}/dispatch` | Consume picked quantities and create a shipment |
| GET | `/shipments` | `orders.manage` |
| POST | `/shipments/{id}/status` | Transition shipment to `in_transit`, `delivered`, `failed`, or `returned` where allowed |
| GET/POST | `/returns` | `orders.manage`; receive a dispatched order return into available, damaged, or quarantine stock |
| GET/POST | `/expenses` | `finance.read` / `finance.manage` |
| GET/POST | `/storage-rates` | `finance.read` / `finance.manage`; per-customer PKR per unit-day rate |
| GET | `/storage-invoices` | `finance.read` |
| POST | `/storage-invoices/generate` | `finance.manage`; create a unit-day invoice from customer-owned inventory history |
| GET | `/invoices` | `finance.read`; dispatch-created sales invoices and open/paid balances |
| GET | `/supplier-bills` | `finance.read`; supplier bills generated from received PO lines |
| POST | `/supplier-bills/generate` | `finance.manage`; idempotently refresh a received PO's bill total |
| GET/POST | `/payments` | `finance.read` / `finance.manage`; list or post a payment against an invoice or supplier bill; overpayment is rejected |
| GET | `/reports/profitability?from=YYYY-MM-DD&to=YYYY-MM-DD` | `finance.read`; revenue, cost of goods, recorded expenses, receivables and payables |
| POST | `/ai/chat` | `dashboard.read`; read-only, tenant-scoped business answer |
| GET | `/audit` | `audit.read`; tenant audit history |

All paths above are relative to `/api/v1`. IDs are opaque strings generated by the service. The implementation rejects invalid state transitions and insufficient stock with a 4xx error.

## Example workflow requests

Create a product:

```json
{ "sku": "SKU-001", "name": "Cotton towel", "category": "Textiles", "barcode": "890000000001", "cost": 450, "price": 750, "reorder": 12, "uom": "ea" }
```

Receive against an approved purchase order (lot and expiry are optional):

```json
{ "purchaseOrderId": "<po-id>", "warehouseId": "<warehouse-id>", "lines": [{ "productId": "<product-id>", "locationId": "<bin-id>", "qty": 25, "lot": "LOT-2026-01", "expiryDate": "2027-06-30" }] }
```

Create and reserve a sales order:

```json
{ "customerId": "<customer-id>", "warehouseId": "<warehouse-id>", "lines": [{ "productId": "<product-id>", "qty": 4 }] }
```

Pick every line using its verified location, then pack and dispatch:

```json
{ "lines": [{ "productId": "<product-id>", "locationId": "<bin-id>", "qty": 4 }] }
```

```json
{ "packageCount": 1 }
```

The browser client uses these same endpoints. Each successful inventory mutation writes a movement and an audit event. AI answers are computed from tenant-scoped facts and can use Mistral when `MISTRAL_API_KEY` is configured; AI has no write tools.

## Current adapter boundary

This API is a single-process local SQLite implementation. It does not currently provide refresh-token rotation, custom roles, collection pagination, tax calculations, payment/receivable ledgers, platform-admin endpoints, idempotency keys, carrier webhooks, or a live PostgreSQL adapter. `DEPLOYMENT.md` describes the additional production work required.
