# Maal Help — REST API

Base path: `/api/v1`. **213 operations.** The full, always-current OpenAPI 3 document (with request and response schemas) is served at **`/api/docs`** (Swagger UI) and `/api/docs/json`, generated from the same Zod schemas that validate requests. A grouped endpoint list is in [docs/API_ENDPOINTS.md](docs/API_ENDPOINTS.md).

## Authentication

Maal Help uses **cookie sessions**:

```http
POST /api/v1/auth/login
Content-Type: application/json
X-Requested-With: stockpilot

{"email":"you@company.com","password":"…"}
```

The response sets `sp_session` (HttpOnly, SameSite=Lax, Secure in production). Send it on later requests. `GET /api/v1/auth/me` returns the user, active company, role and permissions. A user who belongs to several companies switches with `POST /auth/switch-tenant`.

**Anti-CSRF:** every `POST`/`PUT`/`PATCH`/`DELETE` must include `X-Requested-With: stockpilot` and, when it comes from a browser, an `Origin` matching `APP_ORIGIN`. Missing headers return `403`. (`stockpilot` is a legacy technical identifier kept for compatibility with existing clients.)

> **Limitation:** there are no API keys or OAuth client credentials for server-to-server integrations in this MVP. Integrations use a service user's session. Adding scoped API tokens is on the roadmap ([docs/MVP_GAP_ANALYSIS.md](docs/MVP_GAP_ANALYSIS.md)).

## Conventions

| Topic | Rule |
|---|---|
| Success | `{ "success": true, "data": … }`; lists add `"meta": { "page", "pageSize", "total", "pageCount" }` |
| Error | `{ "success": false, "error": { "code", "message", "details"? } }`. No stack traces |
| Paging | `?page=1&pageSize=25` (max 200), `q` for search, `sort`, `dir=asc|desc` |
| Dates | `YYYY-MM-DD` for business dates; ISO-8601 UTC timestamps |
| Money / quantities | JSON numbers; currency from the company settings (default PKR) |
| IDs | UUID v4 |
| Idempotency | Send `Idempotency-Key: <uuid>` on POSTs that must not repeat (receiving, picking, dispatch…). Retries with the same key replay the first response |
| Rate limit | 900 requests/min per IP (`429 RATE_LIMITED`); AI endpoints are also limited per company |

### Error codes

| HTTP | Code | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Field errors in `details` |
| 401 | `UNAUTHENTICATED`, `INVALID_CREDENTIALS` | Not signed in / wrong email or password |
| 402 | `PLAN_LIMIT_REACHED` | The company plan quota (users, warehouses, SKUs, AI calls…) is used up |
| 403 | `FORBIDDEN`, `ACCOUNT_DISABLED`, `IMMUTABLE_RECORD` | Role lacks the permission or the anti-CSRF header is missing; disabled user; attempt to change posted history |
| 404 | `NOT_FOUND` | Missing, or belongs to another company |
| 409 | `DUPLICATE`, `INVALID_STATE`, `INSUFFICIENT_STOCK`, `OVER_RECEIPT`, `CREDIT_LIMIT_EXCEEDED` | Duplicate value, wrong status for the action, not enough available stock, receipt >10% over the PO line (resend with `confirmOverReceipt: true`), customer credit limit |
| 422 | `WRONG_LOCATION`, `WRONG_PRODUCT`, `EXCESS_QUANTITY`, `PACKING_NOT_VERIFIED` | Scan validation failed during picking or packing |
| 423 | `ACCOUNT_LOCKED` | Too many failed sign-ins; wait and retry |
| 429 | `RATE_LIMITED`, `AI_RATE_LIMITED` | Too many requests |

## Example: receive, put away, sell, ship

```http
POST /api/v1/receiving                         # GRN against a PO (or ad hoc)
{"warehouseId":"…","purchaseOrderId":"…","lines":[{"productId":"…","quantity":100,"batchNo":"B-24","expiryDate":"2027-06-30"}]}

GET  /api/v1/putaway/tasks?status=pending      # suggested bin per line
POST /api/v1/putaway/tasks/{id}/complete       {"locationId":"…","quantity":100,"overrideReason":"only if not the suggested bin"}

POST /api/v1/sales-orders                      {"customerId":"…","warehouseId":"…","lines":[{"productId":"…","quantity":20}]}
POST /api/v1/sales-orders/{id}/confirm         # FEFO reservation; shortfall becomes back-order

POST /api/v1/picking/tasks/{id}/confirm        {"locationCode":"A-01-02-1","productCode":"8964000123456","quantity":20}
POST /api/v1/packing/{orderId}/scan            {"code":"8964000123456"}
POST /api/v1/packing/{orderId}/complete        {"packages":[{"weightKg":12}]}
POST /api/v1/dispatch/{orderId}                {"carrier":"Own vehicle","vehicleNo":"KHI-1234","driverName":"…"}
```
*(Bodies are abridged. See `/api/docs` for every field.)*

## Webhooks

Configure in **Settings → Webhooks**. Deliveries are `POST` JSON with headers:

- `x-stockpilot-event`: event name, e.g. `sales_order.dispatched`, `inventory.low_stock`
- `x-stockpilot-timestamp`: Unix seconds
- `x-stockpilot-signature`: `sha256=` HMAC of `timestamp + "." + body` with the webhook's signing secret (shown once when created)
- `User-Agent: MaalHelp-Webhooks/1.0`

Failed deliveries are retried with backoff and logged in `webhook_deliveries`. The `x-stockpilot-*` header names are kept unchanged so existing receivers keep working.

## Exports and imports

- `GET /api/v1/reports/{key}/export?format=csv|xlsx|pdf` with the same filters as the report view.
- `GET /api/v1/imports/templates/{entity}` gives a CSV template. `POST /api/v1/imports` with a multipart file validates every row and returns errors before anything is committed.
