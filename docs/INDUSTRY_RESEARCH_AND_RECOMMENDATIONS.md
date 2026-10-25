# Maal Help — Industry Research & Recommendations

*Research date: 25 October 2026. Method: web searches run during this audit, plus a review of what Maal Help actually implements. Sources are listed with every finding.*

## How to read this document

- **Limits of the research.** It is desk research from public web pages. Many sources are **vendor-written or affiliate "best of" roundups**, which are marked. No vendor product was trialled hands-on, no customers were interviewed, and no market-size statistics were found that we could verify, so none are quoted.
- Prices change often and are quoted only where a source stated them, as "per source, at time of search".
- Recommendations are judgements from the findings, marked as such.

---

## 1. Competitor landscape (SME inventory and WMS)

| Product | What sources say it covers | Source type |
|---|---|---|
| **Zoho Inventory** | Multi-warehouse management, transfer orders, picklists and bin locations; serial and batch tracking; pick, pack and ship | Vendor site ([zoho.com/inventory/whats-new](https://www.zoho.com/inventory/whats-new/)) |
| **Odoo Inventory** | Configurable 1-, 2- or 3-step delivery routes (pick → pack → ship); putaway rules; batches. Barcode scanning is described as an Enterprise-edition feature, and advanced wave picking and directed putaway as add-ons | Blog ([cleverence.com](https://www.cleverence.com/amp/articles/business-blogs/odoo-picking-4832/)) and an add-on vendor's sales page ([ecosire.com](https://ecosire.com/apps/odoo/warehouse-management-pro)), which is a biased source |
| **Cin7 Core** | Inventory, purchasing, light manufacturing, batch/serial; a WMS app for picking, receiving, putaway and stocktakes on Android/iOS. One review says the mobile side is adequate but could be better | Roundups ([cleverence.com](https://www.cleverence.com/amp/articles/for-business/best-small-business-inventory-management-software-4721/)), [Capterra comparison](https://www.capterra.ie/compare/133038/1036048/cin7-core/vs/inventory) |
| **inFlow Inventory** | Barcode workflows for receiving, picking, counting and fulfilment, label printing, own scanner hardware. A third-party guide warns that offline-first operation can be a weak point | Vendor ([inflowinventory.com](https://www.inflowinventory.com/inflow-vs-sortly)) and roundup |
| **Sortly** | Simple, mobile-first, visual folder-based tracking; suited to assets more than warehouse orchestration | Vendor comparison and roundups ([softwareconnect.com](https://softwareconnect.com/roundups/best-stock-control-software)) |
| **HysabOne** (Pakistan) | Cloud accounting, inventory and POS for Pakistani SMEs; says it has an Urdu interface and FBR compliance; listed from PKR 3,499/month per its site | Vendor site ([hysabone.com](https://hysabone.com/erp-software-pakistan/)), unverified |
| **Custom local builds** (e.g. Softvirtue, freelancers) | Multi-branch stock, reorder alerts, barcode. Softvirtue argues that imported tools handle Pakistani mixed payments (cash + EasyPaisa + JazzCash + credit in one sale) poorly | Vendor blog ([softvirtue.com](https://softvirtue.com/blog/inventory-management-software-pakistan)), a vendor claim |

### Where Maal Help stands (our assessment)

| Capability | Typical SME tools (per sources) | Maal Help today |
|---|---|---|
| Multi-warehouse, bins, transfers | Common | ✔ Implemented, including capacity in units, m³, kg and pallets and a drag-and-drop space map |
| Batch / serial / expiry | Common | ✔ Implemented with FEFO reservation |
| Scan-verified pick and pack | Mid-tier and up (Cin7 WMS app, inFlow, Odoo Enterprise) | ✔ Implemented; wrong location, product or quantity blocked server-side |
| Wave / zone picking | Often an add-on (Odoo per vendor source) | ✔ Basic batch and zone waves |
| Offline floor operation | Named as a weak point for some (inFlow per roundup) | ◐ PWA offline queue with idempotent replay and a Sync Center; not a full offline database |
| **3PL storage billing** | Usually needs a dedicated 3PL product | ✔ Contracts, per-pallet/unit/m³ storage, handling, minimum charge, from the ledger |
| **Immutable ledger + audit** | Rarely stated explicitly | ✔ Enforced by database triggers |
| AI grounded in own data | Not found in sources for SME tools | ✔ Read-only tool-based Copilot, briefing, anomalies, reorder (Mistral path untested without a key) |
| Pakistan localisation (PKR, NTN/STRN, GST presets, cities, banks) | Local vendors claim it; global tools are generic | ✔ Localisation pack |
| FBR-integrated e-invoicing | Local vendors claim it | ✘ Not implemented (see §2) |
| Urdu interface | Claimed by HysabOne | ✘ English only (mobile greeting uses "Assalam-o-Alaikum") |
| Accounting, e-commerce, courier integrations | Zoho and Odoo have native ecosystems | ◐ Adapter layer with **mock** providers only |

## 2. Pakistan-specific findings

1. **FBR e-invoicing is real and expanding.** A tax-advisory guide describes Pakistan's FBR e-invoicing as a clearance model: invoices are validated in real time, with an invoice reference number and QR code before they are valid. It says the mandate applies only to taxpayers the FBR notifies, phased by sector ([vatit.com guide](https://vatit.com/?p=90102), which is inconsistent on some dates). A Thomson Reuters regulatory update reports a **draft** FBR notification of 18 Feb 2026 that would require specified sectors (including couriers and many retailers) to connect POS and e-invoicing systems to the FBR, with QR codes, digital signatures and an integrator licensing regime ([Thomson Reuters](https://europe.thomsonreuters.com/uk/compliance/regulatory-updates/pakistan)). We could not confirm whether it has been finalised.
   *Recommendation:* design an **FBR e-invoicing adapter** (invoice submission, IRN/QR stored on the invoice, retry queue). Prioritise it once a pilot customer is a notified taxpayer, and check with a tax adviser.
2. **Courier integrations are fragmented.** We found no official public developer documentation for TCS or Leopards in our search. A WooCommerce aggregator (TrackKaro) lists PostEx, TCS, Leopards, Trax, M&P, Daewoo FastEx and others, and handles credentials centrally ([wordpress.org plugin page](https://en-au.wordpress.org/plugins/dango-trackkar/)).
   *Recommendation:* integrate through **one aggregator first** rather than courier by courier, behind Maal Help's existing courier adapter interface. Confirm direct APIs with each courier.
3. **WhatsApp is the practical notification channel.** Meta's official docs say the WhatsApp Business Platform charges **per delivered template message** (since 1 July 2025), at rates set by category and country. Non-template replies are free within the customer-service window ([Meta pricing docs](https://developers.facebook.com/docs/whatsapp/pricing)). A third-party guide claims a change from 1 Oct 2026 that Meta's page did not show, so re-check before launch ([courier.com](https://www.courier.com/guides/whatsapp-pricing)).
   *Recommendation:* use **utility templates** for order dispatched, invoice due and low-stock alerts to owners. Make them opt-in per company and per user, and track message cost like AI cost.
4. **Mixed payments and credit trading.** Local vendors stress cash + JazzCash/EasyPaisa + bank + credit in one transaction (vendor claim above). Maal Help records multiple payments per invoice with method, and enforces credit limits at order confirmation. *Recommendation:* add a **split-payment entry** in one dialog, and payment reminders through WhatsApp.

## 3. 3PL / storage billing practice

Industry guides describe 3PL billing as client-specific **rate cards** (storage per pallet or cubic unit, receiving and outbound handling by pallet, carton or each, value-added services, minimum monthly charges, tiered and seasonal rates, surcharges), with activity **captured automatically from the WMS** and compiled into draft invoices at cycle end ([Extensiv](https://www.extensiv.com/blog/billing-per-client-in-3pl-wms-complete-guide), [Velocity WMS](https://velocitywms.com/features/3pl-warehouse-billing/), [Shipium](https://hub.shipium.com/content/3pl-billing/), [Infios glossary](https://www.infios.com/en/knowledge-center/glossary/wms-3pl-billing)). These are vendor or industry publications.

**Gap check:** Maal Help already captures activity from the ledger, applies per-contract rates for storage (pallet-, unit- or m³-days), special storage, inbound/outbound handling, picking, packing, loading/unloading and additional handling, plus a minimum-charge top-up, and generates invoices. **Missing:** tiered (volume-break) rates, free-days policies, seasonal surcharges and named value-added services (kitting, labelling) with their own activity capture. *Recommendation:* add tiers, free days and named VAS next. They fit the existing `storage_rates` model.

## 4. Prioritised recommendations

| # | Recommendation | Why (finding) | Effort | Priority |
|---|---|---|---|---|
| 1 | Configure and test the **live Mistral path** with a real key; add a contract test | Only grounded mode is tested | S | P0 before AI is marketed |
| 2 | **Real courier integration via one aggregator** + shipment tracking sync | §2.2 | M | P1 |
| 3 | **WhatsApp utility notifications** (dispatch, invoice due, low stock) | §2.3 | M | P1 |
| 4 | **FBR e-invoicing adapter** (behind a feature flag) | §2.1 | L | P1 for notified taxpayers |
| 5 | **Scoped API tokens** for integrations | Integrations need non-interactive auth | S | P1 |
| 6 | **Urdu UI** for the mobile floor app first (labels, numbers, right-to-left) | A local competitor markets Urdu | M | P2 |
| 7 | 3PL **tiered rates, free days, named VAS** | §3 | M | P2 |
| 8 | Real **accounting sync** (start with one: Zoho Books, QuickBooks or Xero) | Mock adapters only | M | P2 |
| 9 | Fuller **offline mode** (local cache of tasks and product lookups for full shifts) | Offline weakness noted for some competitors; our queue covers short outages | L | P2 |
| 10 | **Split payments** in one dialog; payment reminders | §2.4 | S | P3 |

*Effort is a rough estimate: S ≈ days, M ≈ 1–3 weeks, L ≈ 1–2 months for one developer.*
