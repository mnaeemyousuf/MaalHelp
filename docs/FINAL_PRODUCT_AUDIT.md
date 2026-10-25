# Maal Help — Final Product Audit

*Your Warehouse. Under Control.* · Audit date 25 October 2026 · Version 1.0

## 1. Verdict

| Level | Status |
|---|---|
| **Implemented** | 90 of 109 traced requirements complete, 6 partial, 7 missing, 6 blocked on external credentials ([traceability matrix](REQUIREMENTS_TRACEABILITY_MATRIX.md)) |
| **Tested** | 31/31 automated tests pass; strict typecheck and production build pass ([test results](TEST_RESULTS.md)) |
| **Demonstrated** | All 11 company roles + Super Admin exercised in the running app; 98 real screenshots; role manuals generated |
| **Production-ready** | **No: ready for a controlled pilot.** Blockers: live Mistral path untested (no key), integrations are mock connectors, email not configured, not yet run against managed PostgreSQL |

**MVP readiness: ready for demos and a supervised pilot with one customer.** Every P0 inventory, security and workflow requirement is implemented and covered by automated tests, except AI-02 (live Mistral), which is blocked only by the missing API key.

## 2. What was delivered in this phase

### Rebrand to Maal Help
- Name, tagline and palette are centralised in `shared/brand.ts` (Maal Blue `#1f37b0`, Crate Amber `#f59e0b`) and in the Tailwind `brand-*`/`accent-*` scales in `web/src/styles.css`.
- Logo: a warehouse roof forming an "M" over an amber crate with a check mark. Files: `web/public/brand/logo-mark.svg`, `logo.svg`, `logo-on-dark.svg`; PNG and PWA icons via `scripts/render-brand.mjs`; `web/public/favicon.svg`.
- Applied to the login page, sidebar, mobile app header, dashboards and charts, buttons, forms, tables, status badges, print/PDF letterheads, report exports, the PWA manifest, page titles and metadata, the OpenAPI title, email sender name, webhook user agent and AI system prompt.
- **Technical identifiers kept on purpose** (renaming them would break existing clients, data or receivers without any user-visible benefit):

| Identifier | Where | Why kept |
|---|---|---|
| `X-Requested-With: stockpilot` | `server/src/core/http.ts`, `web/src/lib/api.ts`, `tests/helpers.ts`, seed, capture scripts | Anti-CSRF header value checked by the server; changing it breaks scripted clients |
| `x-stockpilot-event` / `-timestamp` / `-signature` | `server/src/modules/integrations/events.ts`, Settings page help text | Webhook headers that receivers verify |
| IndexedDB stores `stockpilot-offline` / `-cache` / `-sync` | `web/src/lib/api.ts` | Renaming would orphan queued offline scans on devices |
| `stockpilot_block_mutation()` trigger function | `server/drizzle/0001_ledger_immutability.sql` | Renaming needs a migration; not user-visible |
| `sp_session` cookie | auth | Renaming signs everyone out; not user-visible |
| `legacy/` folder | Archived prototype | Kept unchanged for reference; README marked archived |

### Bugs fixed (found during this audit)
Sidebar tagline wrapping · "updated —" timestamp · singular/plural wording ("1 SKUs") in the dashboard, briefing, Copilot and storage invoices · Copilot answers scrolling the whole page · back-order warning shown on draft orders · invoice amounts wrapping in print · cramped receive-goods line row · 403 errors from sidebar counts for floor roles · the dev server not serving rebuilt bundles · **security:** production accepted the sample `SESSION_SECRET` · a real company name in the demo customers.

### Features added
- `npm run admin:create`: create or reset a platform admin in production from environment variables. Production never seeds a default admin.
- Demo catalogue raised to 102 products (spec: 100+).
- Screenshot, workflow-capture, manual-generation and PDF-preview tooling (`scripts/`), including a per-role smoke report.
- Generated docs: role/permission matrix (from the enforced catalogue), API endpoint index (213 operations, from the route registry), traceability matrix.

## 3. Module-by-module status

| Area | Status | Notes |
|---|---|---|
| Multi-tenant SaaS, plans, Super Admin | ✔ | No subscription payments (manual) |
| Security, RBAC, audit | ✔ | No 2FA; password reset is admin-issued |
| Warehouses, locations, space map | ✔ | |
| Products, batches, expiry, serials | ✔ | Variants partial; no kits |
| Inventory ledger, balances, adjustments, statuses | ✔ | Database-enforced immutability and non-negative stock |
| Transfers, counts | ✔ | |
| Purchasing, receiving, putaway | ✔ | |
| Sales, reservation, picking, packing, dispatch, returns | ✔ | Courier tracking is manual (mock adapters) |
| Finance: invoices, bills, payments, aging, expenses, storage billing, profitability | ✔ | No FBR e-invoicing; documents single-currency |
| Dashboard, 35 reports, exports, alerts, search | ✔ | No scheduled emailed reports |
| AI Copilot, briefing, anomalies, reorder, space, documents, monthly report | ✔ grounded / ◐ Mistral | Live Mistral and OCR untested without a key |
| Mobile PWA, scanning, offline queue | ✔ / ◐ | Offline covers short outages; not device-tested |
| Import/export, REST API, webhooks | ✔ | No API tokens |
| Integrations (accounting, e-commerce, courier, payments, messaging) | ✘ blocked | Interfaces + mock adapters only |
| Localisation (Pakistan) | ✔ / ✘ | PKR, NTN/STRN, GST presets, cities, banks; no Urdu |

## 4. Tests run

| Run | Result |
|---|---|
| `npm test` (Vitest, real PostgreSQL engine via PGlite) | **31 passed / 0 failed**, including the spec's critical scenario (receive 100 → pick 20 → transfer 30 → return 10 = 90), concurrency, ledger immutability, tenant isolation, RBAC, finance redaction, approvals, AI grounding, branding |
| `npm run typecheck` | Pass |
| `npm run build` | Pass |
| Role smoke via screenshot capture (12 accounts, 87 screens + 11 workflow states) | No JS errors or failed API calls on any signed-in screen |

Not tested: live Mistral, real integrations, physical scanners/printers/phones, network-cut offline mode, load, accessibility audit, managed PostgreSQL.

## 5. AI status

Implemented: Mistral client (chat, tool calling, JSON mode, OCR, retries, timeouts, rate limits, usage and cost tracking); 21 read-only, permission-checked tools; grounded fallback, clearly labelled; draft-only proposed actions. **Verified:** grounded mode by automated tests. **Not verified:** any call to the Mistral API. The key is read only from the server environment and never reaches the browser, docs, screenshots or logs. See [AI.md](../AI.md).

## 6. Demo

- Reset: `npm run db:reset` (fictional *ABC Trading & Warehousing*, 3 warehouses, 102 products, 120 days of history; latest run 251 SOs, 34 POs, 3,062 transactions).
- Script: [DEMO_SCRIPT.md](DEMO_SCRIPT.md) (15–20 minutes).
- Demo accounts are listed in the README. The development password is not printed in any manual.

## 7. User manuals

`docs/user-manuals/`: `USER_MANUAL_INDEX.pdf` plus 12 role manuals (Super Admin, Business Owner, Warehouse Manager, Inventory Controller, Warehouse Operator, Receiving Clerk, Picker/Packer, Dispatch Officer, Sales, Purchase, Accountant/Billing, Auditor), 15–39 pages each, with real screenshots, contents with measured page numbers, branded headers and footers. None were merged. See [user-manuals/README.md](user-manuals/README.md).

## 8. Research

[INDUSTRY_RESEARCH_AND_RECOMMENDATIONS.md](INDUSTRY_RESEARCH_AND_RECOMMENDATIONS.md) cites the web sources found in this audit. Many are vendor or affiliate material and are marked as such. No market statistics are claimed.

## 9. Recommended next steps

1. Set `MISTRAL_API_KEY` on a staging server; run the Copilot sample questions and OCR on a real supplier invoice.
2. Run the test suite against managed PostgreSQL 15+; configure SMTP; rehearse backup and restore.
3. Pilot on target Android phones with a Bluetooth scanner and a thermal label printer.
4. First real integrations: one courier (via an aggregator), WhatsApp utility alerts, and FBR e-invoicing if the pilot customer is a notified taxpayer.
5. Add scoped API tokens, 2FA for owners, Urdu for the mobile app, and Playwright E2E assertions built on the existing capture scripts.
