# Maal Help — Architecture

*Your Warehouse. Under Control.*

## Shape: a modular monolith

Maal Help is one deployable Node.js service plus a PostgreSQL database. Inside, each business domain is a module with its own routes and service code. Modules share one database transaction model and one permission catalogue. For an SME SaaS product this keeps operations simple (one service, one database) while keeping boundaries clear enough to split out later (for example AI or reporting workers).

```
 Browser / Android PWA ──HTTPS──▶  Fastify API (server/src/app.ts)
   React 19 + Tailwind 4             ├─ core/http.ts   Router: auth → tenant → RBAC → Zod validation → idempotency → handler
   TanStack Query                    ├─ modules/*      domain services (inventory ledger, inbound, sales, fulfilment, finance…)
   IndexedDB offline queue           ├─ ai/*           MistralService, read-only tools, copilot, briefing, documents
                                     ├─ jobs/*         Postgres-backed queue + scheduler (alerts, snapshots, briefings, webhooks)
                                     └─ db/*           Drizzle ORM ──▶ PostgreSQL 15+  (or embedded PGlite for local dev/tests)
                                                                     └─ object storage: local disk or S3-compatible
                         Mistral API (server-side only) ◀── ai/mistral.ts
```

## Technology

| Layer | Choice | Why |
|---|---|---|
| API | Fastify 5, TypeScript (strict) | Fast, typed, mature plugin ecosystem (helmet, rate limit, multipart, swagger) |
| Validation | Zod 4 | One schema validates input and generates the OpenAPI document |
| Database | PostgreSQL 15+ via Drizzle ORM | Transactions, row locks, CHECK constraints, triggers, JSONB, `NULLS NOT DISTINCT` |
| Local DB | PGlite (PostgreSQL compiled to WASM) | Zero-install development and fully isolated in-memory test databases using the real engine |
| Web | React 19, Vite 7, Tailwind 4, Radix UI, TanStack Query, react-router 7, Recharts | Modern, accessible, fast PWA |
| Scanning | `@zxing/browser` camera scanning, keyboard-wedge scanners, `bwip-js` for Code128/EAN/QR labels | Works with cheap Android phones and USB/Bluetooth scanners |
| Offline | Service worker (vite-plugin-pwa) + IndexedDB queue (`idb-keyval`) with idempotency keys | Floor work continues through brief connectivity loss |
| AI | Mistral API (chat with tool calling, JSON mode, OCR) | Configurable models; key stays on the server |
| Tests | Vitest + Fastify `inject` + in-memory PGlite | Real SQL, triggers and constraints in every test |

## Request pipeline (`server/src/core/http.ts`)

1. **Auth mode** per route: `public`, `user`, `tenant` (a company member) or `platform` (SaaS admin).
2. **Session**: opaque random token in an `HttpOnly`, `SameSite=Lax` cookie (`sp_session`), stored as an HMAC hash; 8 failed logins lock the account temporarily.
3. **CSRF**: state-changing requests must carry `X-Requested-With: stockpilot` (a legacy technical identifier kept for compatibility) and a matching `Origin`.
4. **RBAC**: each route declares the permissions it needs; checked against the member's role on the server.
5. **Validation**: Zod schemas for params, query and body; errors return `400 VALIDATION_ERROR` with field details.
6. **Idempotency**: clients may send `Idempotency-Key`; the first response is stored and replayed on retries (used by the offline queue).
7. **Envelope**: `{ success: true, data, meta? }` or `{ success: false, error: { code, message, details? } }`. Stack traces never leave the server.

## Inventory model — the heart of the system

- **Ledger first.** Every stock change is an `inventory_transactions` row (signed quantity, unit cost, balance after, reference, reason, user, correlation id). The table is **append-only**: a database trigger rejects `UPDATE`/`DELETE`. Corrections are new reversing rows.
- **Balances** (`inventory_balances`) are a projection keyed by tenant · warehouse · location · product · batch · owner · status, unique with `NULLS NOT DISTINCT`, with `CHECK (quantity >= 0)`. They are updated in the same transaction as the ledger row.
- **Concurrency.** Removals lock the balance row (`SELECT … FOR UPDATE`) before checking availability, so two orders cannot take the same units. Tests run three parallel 60-unit orders against 80 units: exactly one succeeds.
- **Statuses.** Stock moves between `available`, `reserved`, `quarantine`, `damaged`, `expired`, `blocked`, `in_transit` and `returned` as ledger movements, so availability is always a query over balances.
- **Ownership.** `owner_customer_id` separates company stock from customer-owned (3PL) stock, which feeds storage billing and is never sold as company stock.
- **Reservation.** Confirming a sales order allocates FEFO (first-expiry-first-out) from pickable locations and moves units to `reserved`; anything short becomes a back-order. Picking moves reserved units to the dispatch dock; dispatch consumes them.

## Workflows and approvals

The approval engine (`modules/approvals/engine.ts`) handles purchase orders, stock adjustments, count variances, transfers and expenses, using thresholds set per company in **Settings → Approval rules**. Each entity type registers a handler that runs only when the request is approved. Requesters cannot approve their own request (Business Owner excepted).

## Background jobs

`jobs/queue.ts` is a PostgreSQL-backed queue (`FOR UPDATE SKIP LOCKED`), so no extra infrastructure is needed. Recurring jobs: `alerts.scan`, `inventory.snapshot` (daily valuation history), `expire_batches`, `ai.daily_briefing`, `notifications.deliver`, `webhooks.deliver` (HMAC-signed with retries), `documents.extract`.

## Multi-tenancy

Shared database, shared schema, `tenant_id` on every business table, enforced in every query by the tenant context (`core/context.ts`). Plans limit users, warehouses, SKUs and AI calls (`modules/platform/limits.ts`). The SaaS Super Admin works through `/platform` routes only and has no tenant data access.

## Frontend

- `web/src/components/layout/AppShell.tsx` is the desktop shell: brand sidebar with permission-filtered navigation, Ctrl+K command palette, global search, notifications, offline banner.
- `/m/*` is the mobile floor app: large buttons, camera scanning, offline queue and a Sync Center for conflicts.
- `web/src/lib/api.ts` is the fetch wrapper: CSRF header, idempotency keys, offline queue and cached reads.
- Brand tokens: `shared/brand.ts` (name, tagline, colours) and `web/src/styles.css` (`brand-*` Maal Blue, `accent-*` Crate Amber).

## Integrations layer

`modules/integrations/adapters.ts` defines provider interfaces for accounting (QuickBooks, Xero, Zoho, Odoo), e-commerce (Shopify, WooCommerce, Daraz), courier (TCS, Leopards, M&P, PostEx, Trax), payments (JazzCash, Easypaisa, bank transfer), messaging (WhatsApp Business, email, SMS) and storage. **In this MVP all of them are mock adapters**: they validate configuration and simulate calls, but do not reach real provider APIs. Credentials entered in Settings are encrypted at rest with AES-256-GCM.

## Repository decision

The original prototype (`legacy/`, a single-file Node server with JSON storage) could not meet the specification's requirements for an immutable ledger, concurrency safety, multi-tenancy and RBAC. It was replaced by this architecture. The prototype is kept unchanged in `legacy/` for reference and is not used at runtime.
