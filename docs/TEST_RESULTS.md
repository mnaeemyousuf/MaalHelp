# Maal Help — Test Results

*Run date: 25 October 2026 · Windows 11 · Node.js 24 · Vitest 3.2.7 · database: PGlite (PostgreSQL 17 engine, WASM), fresh in-memory instance per test file.*

Every result below comes from an actual run in this workspace. Nothing is extrapolated.

## Summary

| Check | Command | Result |
|---|---|---|
| Automated tests | `npm test` | **31 passed, 0 failed** (3 files, ~40 s) |
| TypeScript strict, server + web | `npm run typecheck` | **Pass**, 0 errors |
| Production build | `npm run build` | **Pass**: web bundle + PWA service worker, server bundle incl. `create-admin-cli.js` |
| Demo data rebuild | `npm run db:reset` | **Pass** (counts below) |
| Screenshot capture: 87 screens as 12 accounts + 11 workflow states | `scripts/capture-screenshots.mjs`, `scripts/capture-workflows.mjs` | **98 captured**; no role page logged a JS error or failed API call (`docs/user-manuals/capture-report.json`); inspected visually |
| Role manuals | `node scripts/build-manuals.mjs` | **12 role PDFs + index** generated; TOC page numbers verified against the rendered PDFs |
| Platform admin CLI | `npm run admin:create` | Weak password rejected (exit 1); valid input creates the admin (exit 0) |

## Automated tests (verbatim names)

### `tests/inventory.test.ts` (14), the critical scenario and data integrity
| # | Test | Result |
|---|---|---|
| 1 | 1. receives 100 units into the receiving dock and creates a putaway task | ✔ |
| 2 | is idempotent: replaying the same receipt request does not double stock | ✔ |
| 3 | 2. puts away all 100 units into a bin | ✔ |
| 4 | 3. reserves 20 units for a confirmed sales order (available 80, reserved 20) | ✔ |
| 5 | blocks wrong location, wrong product and excess quantity at picking | ✔ |
| 6 | 4. picks, packs (scan-verified) and dispatches 20 units | ✔ |
| 7 | 5. transfers 30 units between locations without creating or losing stock | ✔ |
| 8 | 6. a customer return of 10 to available increases stock to 90 | ✔ |
| 9 | dashboard and reports agree with the ledger | ✔ |
| 10 | prevents negative stock: removing more than available is refused | ✔ |
| 11 | the ledger is append-only at the database level | ✔ |
| 12 | audit trail records each step with the acting user | ✔ |
| 13 | concurrency: simultaneous orders never over-reserve stock (3 × 60 units against 80 → exactly 1 succeeds) | ✔ |
| 14 | concurrency: simultaneous adjustments cannot drive a balance negative | ✔ |

### `tests/security.test.ts` (9): authentication, RBAC, tenant isolation
| # | Test | Result |
|---|---|---|
| 1 | rejects unauthenticated requests | ✔ |
| 2 | rejects wrong passwords with a generic message | ✔ |
| 3 | requires the anti-CSRF header on state-changing requests | ✔ |
| 4 | isolates tenants: B cannot see or touch A's data, even by id | ✔ |
| 5 | enforces permissions on the API, not only in the menu | ✔ |
| 6 | hides cost and valuation from roles without finance access | ✔ |
| 7 | routes large adjustments for approval and blocks self-approval | ✔ |
| 8 | platform admin sees aggregates but has no tenant operational access | ✔ |
| 9 | returns standard error envelopes and never leaks internals | ✔ |

### `tests/ai-and-brand.test.ts` (8): AI (grounded mode) and branding
| # | Test | Result |
|---|---|---|
| 1 | answers "How much inventory do I have?" with the database figure (127 units) | ✔ |
| 2 | answers "Which products are low?" with the right products | ✔ |
| 3 | produces today's warehouse summary from operations data | ✔ |
| 4 | never exposes financial tools to roles without finance access | ✔ |
| 5 | daily briefing and reorder recommendations come from data and never create orders | ✔ |
| 6 | exposes the product name in the API documentation ("Maal Help API" + tagline) | ✔ |
| 7 | brand constants are complete | ✔ |
| 8 | PDF report exports carry the Maal Help name (valid `%PDF`) | ✔ |

## Demo data (latest `npm run db:reset`)

From the run that produced the manual screenshots: **3 warehouses, 102 products, 12 suppliers, 14 customers (incl. 2 storage clients), 251 sales orders, 34 purchase orders, 3,062 ledger transactions, 11 demo users + 1 platform admin.** (Counts vary slightly between resets because the 120-day simulation is randomised.)

## Manual verification in the running app

The screenshot script signs in as each demo role through the real API and opens 87 screens: desktop 1440×900, and phone 390×844 for floor roles. While reviewing them, these defects were found and **fixed**:

| Defect | Fix |
|---|---|
| Sidebar tagline wrapped onto two cramped lines | `Brand.tsx`: no-wrap tagline |
| Dashboard showed "updated —" instead of a time | `relativeTime` accepted numeric timestamps incorrectly (`lib/utils.ts`) |
| "1 SKUs are out of stock", "1 batches expire…", "1 transactions" | Singular/plural wording in dashboard, briefing, Copilot and storage invoices |
| AI Copilot scrolled the whole page and hid the header on each answer | Scroll only the message pane (`Ai.tsx`) |
| Draft sales orders showed a "units are back-ordered" warning before confirmation | Warning shown only after confirmation (`Sales.tsx`) |
| Invoice amounts wrapped ("Rs / 59,000") in print view | No-wrap money columns (`Print.tsx`) |
| Production would accept the sample `SESSION_SECRET` from `.env.example` | Guard rejects `dev-only`/`change-me` values (`config/env.ts`) |
| No safe way to create a platform admin in production | `npm run admin:create` reading credentials from the environment |
| A real company name in demo customers | Renamed to fictional "Metropolitan Wholesale Club" |
| Demo catalogue had 94 products (spec: 100+) | 8 products added; now 102 |
| Sidebar requested approval/picking counts the role could not see (403 errors in the console) | Badge queries limited to permitted counts (`AppShell.tsx`) |
| Receive-goods line row cramped ("Pas", cut-off expiry) | Two-row responsive layout (`Inbound.tsx`) |
| Dev server could not serve a rebuilt web bundle without a restart | Static files served dynamically outside production (`app.ts`) |

## Not tested (honest gaps)

- **Live Mistral API.** No `MISTRAL_API_KEY` was available. Chat with tool calling, narrative briefing and PDF/image OCR were not exercised against Mistral.
- **Real integrations.** Courier, accounting, e-commerce, payments, WhatsApp and email run on mock or log providers.
- **Physical devices.** Camera scanning, USB/Bluetooth scanners and thermal label printers were not tested on hardware.
- **Offline mode.** Not tested by cutting the network.
- **Browser E2E assertions.** The screenshot script loads pages but does not assert behaviour.
- **Load and performance.** No load test. PGlite (single process) is not representative of production PostgreSQL.
- **Accessibility audit.** No WCAG/axe audit was run.
- **Production PostgreSQL.** Tests and demo used PGlite. Run the suite against PostgreSQL 15+ before go-live.
