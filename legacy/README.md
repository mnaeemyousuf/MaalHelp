> **Archived.** This is the original prototype, kept unchanged for reference. It is not used at runtime. The product is now **Maal Help** (*Your Warehouse. Under Control.*). See the [project README](../README.md).

# Stockpilot — Warehouse Operating System

An SME-first, Pakistan-oriented warehouse and inventory command center. The local system now connects tenant accounts, catalog, purchasing, receiving, inventory movements, putaway, staged transfers, sales reservations, pick/pack/dispatch, shipment tracking, returns, stock counts, customer storage billing, dispatch invoices, supplier bills, payments, finance reporting, alerts, audit records, and grounded business answers.

## Run locally

Requirements: Node.js 24 or later. No package installation is needed for the local server.

```sh
npm start
```

Then open http://localhost:4173. The first launch creates a local SQLite database in `data/` and demo records. Development login:

- Email: `owner@example.com`
- Password: `StockpilotDemo2026!`

This credential is development-only. Do not use it in a deployed environment. To use a fresh local dataset, stop the server and move or remove the generated `data/stockpilot.sqlite` file.

## Implemented services

- `server.mjs`: Node HTTP API, password hashing, session cookies, RBAC, transactional stock mutations, audit trail and local database setup.
- `src/app.js`: browser client connected to live API data.
- `src/ui/styles.css`: responsive desktop and mobile styles.
- `db/migrations/0001_foundation.sql`: PostgreSQL foundation schema proposal for the hosted deployment path.
- `tests/e2e.test.mjs`: isolated API workflow checks.

The local adapter uses Node's built-in SQLite module so the app runs without downloading packages. The PostgreSQL migration is the intended managed production database schema; the current API adapter does not yet run against PostgreSQL. New company registration creates a separate tenant and owner login; the E2E test checks that a new company sees no demo-company catalog or stock.

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | HTTP port | `4173` |
| `STOCKPILOT_DATA_DIR` | Local SQLite directory | `./data` |
| `MISTRAL_API_KEY` | Server-side Mistral credential | unset; grounded local answers remain available |
| `MISTRAL_API_URL` | Compatible chat completions endpoint | Mistral API |
| `MISTRAL_MODEL` | Mistral model name | `mistral-small-latest` |

Never use a `VITE_` prefix for secrets or commit credentials. Use HTTPS, a secret manager, managed PostgreSQL, rate limiting, backups and hardened cookie settings before any production deployment.

## API

All routes use `/api/v1`. Health and login are `/health` and `/auth/login`. Tenant routes include `/dashboard`, `/alerts`, `/putaway/suggest`, `/team`, `/roles`, `/warehouses`, `/locations`, `/products`, `/inventory`, `/lots`, `/movements`, `/adjustments`, `/receipts`, `/transfers`, `/purchase-orders`, `/stock-counts`, `/returns`, `/expenses`, `/storage-rates`, `/storage-invoices`, `/invoices`, `/supplier-bills`, `/payments`, `/reports/profitability`, `/customers`, `/suppliers`, `/orders`, `/shipments`, `/audit`, and `/ai/chat`. Login sets a same-site HttpOnly cookie. Business changes are tenant-scoped and audited. See [API.md](API.md) for the route contract.

## Inventory and fulfillment behavior

Receipt posts increase available balances and ledger entries in one SQLite transaction. Order creation validates available quantities and moves stock into reserved balances. Picking verifies order products, quantities and warehouse locations; packing is state-gated; dispatch consumes picked balances. A stock adjustment cannot reduce a balance below zero. Corrections must be recorded as new movements.

## Scope and deployment status

This is a functional single-node local implementation, not a production-ready commercial SaaS deployment. The local adapter runs on SQLite and the PostgreSQL migration remains a schema proposal. It currently includes end-to-end purchase/receive/putaway, reserve/pick/pack/dispatch/ship, transfer approval/handoff/receipt, stock-count approval, returns, customer-owned stock and storage billing, dispatch-created sales invoices, received-goods supplier bills, payment posting, receivables/payables, expenses and an estimated profitability view. The tested core also covers tenant isolation and server-side role authorization.

The broader brief still calls for work not present here: managed PostgreSQL execution and migrations, platform administration and subscription limits, tax and full accounting, complete warehouse hierarchy and dimensions, serial/recall controls, configurable expiry/write-off policies, configurable approval policies, partial fulfillment/backorders, camera scanning and printable labels, offline synchronization, carrier integrations, comprehensive report filters/exports, document extraction, richer AI recommendations and anomaly detection, notification delivery, and production observability/security operations. Lot expiry dates can be captured at receipt, lots expiring within 30 days are alerted, and elapsed lots can be moved to an explicit expired status; recall and automatic write-off policies remain absent. Profitability is an estimate from recorded dispatch costs and expenses; it is not a statutory financial statement. The UI CSV export remains limited to currently loaded records (maximum 250).

## Roles

Business roles are `owner`, `manager`, `controller`, `operator`, `sales`, `purchase`, `accountant`, and `auditor`. Role permissions are checked on the server. Team creation requires owner permission and a password supplied by the owner. Platform super-admin access is not enabled in the local service.

## Data and privacy

The SQLite database and sample/demo records are local development data. Back up only if needed and do not use this single-node adapter as a multi-process production database. API keys stay on the server. The AI route computes tenant-scoped facts itself and sends only structured results and the question to Mistral when configured; it does not expose inventory mutation tools.

## Documentation

- [Architecture and permissions](ARCHITECTURE.md)
- [Database design](DATABASE.md)
- [API contract](API.md)
- [AI design](AI.md)
- [Deployment notes](DEPLOYMENT.md)
