# Maal Help — MVP Acceptance Criteria

Each criterion is testable. **Status** reflects this workspace on 25 Oct 2026: ✔ met and verified · ◐ met with a stated limitation · ✘ not met.
Evidence: **T** = automated test (`npm test`), **S** = real screenshot from the running app, **C** = code review only.

## A. Inventory integrity (must all pass to ship)

| ID | Given / When / Then | Status | Evidence |
|---|---|---|---|
| A1 | Receiving 100 units creates a GRN, a ledger receipt of +100 at the dock and a putaway task | ✔ | T |
| A2 | Replaying a request with the same Idempotency-Key does not change stock | ✔ | T |
| A3 | Putaway moves 100 from dock to bin; total on hand unchanged | ✔ | T |
| A4 | Confirming an order for 20 shows available 80 / reserved 20 | ✔ | T |
| A5 | Picking from a wrong location, wrong product or excess quantity is rejected with a clear error | ✔ | T |
| A6 | Pick → pack (scan-verified) → dispatch of 20 reduces on hand by 20 and creates an invoice | ✔ | T |
| A7 | Transfer of 30 between locations keeps the total constant | ✔ | T |
| A8 | Return of 10 to available raises stock to 90 | ✔ | T |
| A9 | Removing more than available is refused; balance never below zero | ✔ | T |
| A10 | UPDATE/DELETE on posted ledger or audit rows fails at database level | ✔ | T |
| A11 | Three simultaneous 60-unit orders against 80 units: exactly one succeeds | ✔ | T |
| A12 | Dashboard and reports show the same totals as the ledger | ✔ | T |

## B. Security and access

| ID | Criterion | Status | Evidence |
|---|---|---|---|
| B1 | Unauthenticated API calls get 401 | ✔ | T |
| B2 | A company cannot read or change another company's data, even with valid IDs | ✔ | T |
| B3 | Operators, sales users and auditors are refused actions outside their role (403) | ✔ | T |
| B4 | Roles without finance permission never receive cost, value or margin fields | ✔ | T |
| B5 | Adjustments above the threshold wait for approval; requester cannot self-approve | ✔ | T |
| B6 | The platform admin cannot open tenant operational data | ✔ | T |
| B7 | No secrets in browser code, screenshots, logs or manuals | ✔ | C + S (screenshots reviewed; Settings shows the key is server-only) |
| B8 | Production start fails with insecure configuration | ✔ | C |

## C. Role journeys (each role can finish its daily job)

| ID | Role | Journey | Status | Evidence |
|---|---|---|---|---|
| C1 | Business Owner | Sign in → see ranked attention items → drill into one → export a report | ✔ | S |
| C2 | Warehouse Manager | Review space map, approve a transfer, assign pick tasks | ✔ | S |
| C3 | Inventory Controller | Run a cycle count, review variance, request adjustment | ✔ | S |
| C4 | Receiving Clerk | Receive a PO on a phone, record batch/expiry, put away to the suggested bin | ✔ | S + T |
| C5 | Picker / Packer | Pick with scan validation, pack with verification | ✔ | S + T |
| C6 | Dispatch Officer | Dispatch packed orders with vehicle/driver, update delivery status | ✔ | S |
| C7 | Sales | Create and confirm an order with availability and credit checks; process a return | ✔ | S |
| C8 | Purchase | Create a PO (approval if over threshold), track supplier performance | ✔ | S |
| C9 | Accountant | Record payments, view aging, run storage billing, print an invoice | ✔ | S |
| C10 | Auditor | Read-only access to records and the full audit trail | ✔ | S + T |
| C11 | Super Admin | Manage tenants, plans, flags; view health and AI usage | ✔ | S |

## D. AI

| ID | Criterion | Status | Evidence |
|---|---|---|---|
| D1 | Copilot answers stock questions with figures that match the database | ✔ | T |
| D2 | Every answer shows its mode and data sources | ✔ | S |
| D3 | AI cannot post stock, approve or change finance; proposals become drafts only after confirmation | ✔ | T + C |
| D4 | Mistral-powered answers work with a configured key | ◐ | Implemented; **not tested** (no key) |
| D5 | Scanned PDF/image invoices are extracted for human review | ◐ | Needs Mistral OCR (key); CSV/TXT path works |

## E. Usability and delivery

| ID | Criterion | Status | Evidence |
|---|---|---|---|
| E1 | Consistent Maal Help brand: logo, colours, name and tagline on every screen, export and manual | ✔ | S |
| E2 | Floor screens usable one-handed on a 390-px phone | ✔ | S |
| E3 | Works through short connectivity loss without double posting | ◐ | Idempotent queue implemented; offline not tested by cutting network |
| E4 | Import products/customers/suppliers/opening stock from Excel with row errors before commit | ✔ | S + C |
| E5 | Documentation and role manuals with real screenshots | ✔ | `docs/` |

## F. Go-live (beyond MVP demo; required before paying customers)

| ID | Criterion | Status |
|---|---|---|
| F1 | Test suite passes against managed PostgreSQL 15+ | ✘ not run |
| F2 | At least one real courier and one accounting integration | ✘ |
| F3 | Email delivery configured (alerts, password resets) | ✘ |
| F4 | Backups and restore rehearsed | ✘ |
| F5 | Pilot on target Android devices and scanners | ✘ |
| F6 | Live Mistral smoke test with usage limits | ✘ |
