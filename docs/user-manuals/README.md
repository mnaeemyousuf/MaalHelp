# Maal Help — User Manuals

*Your Warehouse. Under Control.* · Version 1.0 · 25 October 2026

Start with **[USER_MANUAL_INDEX.pdf](USER_MANUAL_INDEX.pdf)**. It explains which manual to read and gives a five-minute quick start.

| Manual | Role in the system | Pages |
|---|---|---|
| [Super_Admin_User_Manual.pdf](Super_Admin_User_Manual.pdf) | SaaS Super Admin (platform) | 15 |
| [Business_Owner_User_Manual.pdf](Business_Owner_User_Manual.pdf) | Business Owner | 39 |
| [Warehouse_Manager_User_Manual.pdf](Warehouse_Manager_User_Manual.pdf) | Warehouse Manager | 35 |
| [Inventory_Controller_User_Manual.pdf](Inventory_Controller_User_Manual.pdf) | Inventory Controller | 23 |
| [Warehouse_Operator_User_Manual.pdf](Warehouse_Operator_User_Manual.pdf) | Warehouse Operator | 23 |
| [Receiving_Clerk_User_Manual.pdf](Receiving_Clerk_User_Manual.pdf) | Receiving Clerk | 21 |
| [Picker_Packer_User_Manual.pdf](Picker_Packer_User_Manual.pdf) | Picker / Packer | 19 |
| [Dispatch_Officer_User_Manual.pdf](Dispatch_Officer_User_Manual.pdf) | Dispatch Officer | 16 |
| [Sales_User_Manual.pdf](Sales_User_Manual.pdf) | Sales User | 19 |
| [Purchase_User_Manual.pdf](Purchase_User_Manual.pdf) | Purchase User | 19 |
| [Accountant_Billing_User_Manual.pdf](Accountant_Billing_User_Manual.pdf) | Accountant | 20 |
| [Auditor_User_Manual.pdf](Auditor_User_Manual.pdf) | Auditor | 16 |

Every role has its own manual; none were merged. The Receiving Clerk, Picker/Packer and Dispatch Officer manuals reuse the Warehouse Operator's mobile chapters, limited to that job, because their menus differ.

## What each manual contains

Cover · document information and contents with page numbers · introduction (what the role can and cannot do) · access and navigation · home screen · features step by step with screenshots and captions · end-to-end workflows · reports, notifications and exception messages · FAQ and troubleshooting · quick reference and glossary. Every page has a branded header and a footer with version and page number.

## Screenshots

`screenshots/` holds **98 real captures** from the running application, signed in as each demo role with the fictional company *ABC Trading & Warehousing*: desktop at 1440×900, phone at 390×844. Nothing was mocked up. No passwords, API keys or secrets appear in any screenshot or manual. `capture-report.json` records that no role page logged a JS error or a failed API call during capture.

## Regenerating

With the app running on demo data (`npm run db:reset`, then start the server):

```bash
BASE_URL=http://localhost:47831 node scripts/capture-screenshots.mjs
```
```bash
BASE_URL=http://localhost:47831 node scripts/capture-workflows.mjs
```
```bash
node scripts/build-manuals.mjs
```

- Content: `scripts/manual-content.mjs`. Renderer: `scripts/build-manuals.mjs` (headless Chrome/Edge + pdf-lib; table-of-contents page numbers are measured, not guessed).
- `capture-workflows.mjs` picks **one** pending order through the API so the packing screens have work to show. It never dispatches, puts away or adjusts stock. Run it on a demo database only.
- Visual check: `node scripts/preview-pdf.mjs docs/user-manuals/<file>.pdf 1 6` writes a contact sheet to `.data/pdf-preview/`.
