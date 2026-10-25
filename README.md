<p align="center"><img src="web/public/brand/logo.png" alt="Maal Help — Your Warehouse. Under Control." width="420"></p>

# Maal Help

**Your Warehouse. Under Control.**

Maal Help is a warehouse operating system for warehouse owners, traders, wholesalers, distributors and SMEs — built for Pakistan and South Asia first. It combines warehouse management, inventory, purchasing, sales and fulfilment, customer-owned (3PL) storage billing, expenses, profitability, reporting and an AI Copilot that answers only from your own data.

| | |
|---|---|
| **Inventory** | Balances by warehouse → location → product → batch → serial → owner → status, on an append-only ledger |
| **Warehouse** | Zones, aisles, racks, shelves, bins with barcodes; capacity (units, m³, kg, pallets); drag-and-drop space map |
| **Inbound** | Purchase orders with approvals, scan-based receiving (GRN), batches/expiry/serials, QC quarantine, rule-based putaway |
| **Outbound** | Sales orders with FEFO reservation (no overselling), scan-verified picking & packing, dispatch, delivery tracking, returns |
| **Control** | Transfers with approval, cycle/blind counts with variance approval, adjustments, approval engine, full audit trail |
| **Money** | Invoices, supplier bills, payments, aging, expenses, storage contracts & billing, estimated profitability |
| **Insight** | Command-center dashboard, 35 reports with Excel/CSV/PDF export, alert center |
| **AI** | Copilot (Mistral, tool-based), daily briefing, anomaly detection, smart reorder, slotting, document extraction, monthly report |
| **Floor** | Mobile PWA for operators: big buttons, phone-camera scanning, offline queue with conflict review |

## Quick start (local)

Requirements: **Node.js 20.11+** (tested on Node 24). No database installation is needed for development — Maal Help runs the real PostgreSQL engine in-process (PGlite).

```bash
npm install
```

```bash
npm run db:reset
```

```bash
npm run dev
```

- Web app: http://localhost:5173 (Vite dev server, proxies `/api` to the API)
- API: http://localhost:4000 · API docs (OpenAPI): http://localhost:4000/api/docs

`npm run db:reset` builds the fictional demo company **ABC Trading & Warehousing** with 120 days of history (3 warehouses, ~100 products, 247 sales orders, 39 purchase orders, 3,100+ ledger transactions) by driving the real API. It takes a few minutes.

### Demo accounts (development only)

All demo users share the development password **`Demo@MaalHelp2026`** (override with `DEMO_PASSWORD`). Never use it outside a local demo.

| Email | Role |
|---|---|
| owner@example.com | Business Owner |
| manager@example.com | Warehouse Manager |
| controller@example.com | Inventory Controller |
| operator@example.com | Warehouse Operator |
| receiving@example.com | Receiving Clerk |
| picker@example.com | Picker / Packer |
| dispatch@example.com | Dispatch Officer |
| sales@example.com | Sales User |
| purchase@example.com | Purchase User |
| accountant@example.com | Accountant |
| auditor@example.com | Auditor |
| admin@example.com | SaaS Super Admin (platform) |

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | API (watch mode) + web dev server |
| `npm run build` | Production build: `dist/web` (PWA) and `dist/server` |
| `npm start` | Run the production build (serves the web app and API on `PORT`) |
| `npm run db:migrate` | Apply database migrations |
| `npm run db:seed` | Create the demo company if it does not exist |
| `npm run db:reset` | Drop and rebuild the local database with fresh demo data |
| `npm run admin:create` | Create or reset a platform admin from `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD` |
| `npm run db:generate` | Generate a migration after changing `server/src/db/schema` |
| `npm test` | Automated tests (fresh in-memory PostgreSQL per file) |
| `npm run typecheck` | TypeScript strict checks for server and web |
| `node scripts/render-brand.mjs` | Re-render PNG icons/logos from the SVG brand files |

## Configuration

Copy `.env.example` to `.env`. Key variables:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Managed PostgreSQL (15+). Empty = embedded PGlite in `PGLITE_DIR` |
| `SESSION_SECRET`, `ENCRYPTION_KEY` | Required in production (the server refuses to start without them) |
| `COOKIE_SECURE` | `true` behind HTTPS (required in production) |
| `MISTRAL_API_KEY` | Enables the Mistral-powered Copilot, briefing narrative, OCR. Server-side only |
| `STORAGE_DRIVER` | `local` or `s3` (any S3-compatible service) for uploaded documents |
| `EMAIL_PROVIDER`, `WHATSAPP_PROVIDER` | Notification channels (`log` in development) |

Without `MISTRAL_API_KEY` the AI features still work in a clearly labelled **grounded mode**: answers are assembled directly from database facts with no language model, and PDF/image document extraction is unavailable (CSV/TXT still works).

## Project structure

```
shared/            brand, permissions (RBAC), domain vocabularies, localisation (Pakistan pack)
server/src/
  app.ts           Fastify app: security headers, rate limits, error envelope, OpenAPI
  core/            http router (auth + RBAC + validation + idempotency), audit, crypto, numbering, storage
  db/              Drizzle schema, PGlite/Postgres client, seed
  modules/         one folder per domain (inventory ledger, inbound, sales, fulfilment, finance, …)
  ai/              MistralService, read-only tools, copilot, briefing, documents
  jobs/            Postgres-backed job queue + scheduler
server/drizzle/    SQL migrations
web/src/           React + TypeScript + Tailwind PWA (pages, components, offline API client)
web/public/brand/  logo files (SVG + PNG)
tests/             Vitest API/integration tests
docs/              audit, traceability, test results, demo script, role matrix, user manuals
legacy/            the previous single-file prototype, kept for reference only
```

## Documentation

- [Architecture](ARCHITECTURE.md) · [Database](DATABASE.md) · [API](API.md) · [AI](AI.md) · [Deployment](DEPLOYMENT.md)
- [Final product audit](docs/FINAL_PRODUCT_AUDIT.md) · [Requirements traceability](docs/REQUIREMENTS_TRACEABILITY_MATRIX.md) · [Test results](docs/TEST_RESULTS.md)
- [Demo script](docs/DEMO_SCRIPT.md) · [Role & permission matrix](docs/ROLE_PERMISSION_MATRIX.md) · [User manuals](docs/user-manuals/README.md)

## Troubleshooting

| Problem | Fix |
|---|---|
| `EADDRINUSE` on start | Another app uses the port. Set `PORT=4100` (and `APP_ORIGIN`) or stop the other process |
| Login fails for demo users | Run `npm run db:reset` — older databases used a different demo password |
| "Missing anti-forgery header" (403) from scripts | Send `X-Requested-With: stockpilot` on POST/PUT/PATCH/DELETE (technical identifier, kept for compatibility) |
| AI answers say "AI model not configured" | Expected without `MISTRAL_API_KEY`; set it on the server to enable Mistral |
| Server will not start after a forced kill ("RuntimeError: Aborted") | The embedded dev database was damaged. Stop servers with Ctrl+C next time; run `npm run db:reset` |
| Reset is slow | The demo seed replays 120 days of operations through the API; allow a few minutes |

## Brand

Name, tagline and colours live in `shared/brand.ts`; the Tailwind palette (Maal Blue `brand-*`, Crate Amber `accent-*`) is in `web/src/styles.css`. Logo sources: `web/public/brand/*.svg`.
