# Maal Help — Demo Script (15–20 minutes)

*Your Warehouse. Under Control.*

Audience: a warehouse owner, trader or distributor. Story: **"See the whole business, then watch one carton move from supplier to customer with nothing lost and nothing unexplained."**

## Before the demo (10 minutes, once)

1. Reset the fictional demo company (takes a few minutes):
   ```bash
   npm run db:reset
   ```
2. Start the app:
   ```bash
   npm run dev
   ```
   Then open http://localhost:5173. For a production-like single server: `npm run build`, then `npm start` and http://localhost:4000.
3. Sign in on two browser profiles, or one browser plus a phone on the same Wi-Fi:
   - **Laptop:** `owner@example.com` (Business Owner)
   - **Phone or narrow window:** `operator@example.com` (Warehouse Operator)
   - Demo password: the development value in `README.md` (`DEMO_PASSWORD` overrides it). **Never show it on a projected screen and never use it outside a local demo.**
4. Optional: set `MISTRAL_API_KEY` on the server (never in the browser) to show Mistral-written answers. Without it, the Copilot runs in clearly labelled *grounded* mode.

### Demo data
The fictional company **ABC Trading & Warehousing (Pvt.) Ltd.**: 3 warehouses (Karachi Main, Lahore, Islamabad), 102 products across electronics, textiles, food (batch + expiry), packaging and general merchandise, 12 suppliers, 12 customers plus 2 storage (3PL) clients, and 120 days of simulated history driven through the real API (latest reset: 251 sales orders, 34 purchase orders, 3,062 ledger transactions; counts vary slightly per reset). All names, numbers, NTN/STRN and phone numbers are invented.

| Demo user | Role |
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

---

## Script

| Time | Screen | Say | Do |
|---|---|---|---|
| 0:00–2:00 | **Dashboard** (owner) | "This is what you see each morning: what needs attention today, ranked." | Point to *Today's intelligence*: out of stock, warehouse 88% full, delayed orders, expiring batches. Each has a one-click action. Change warehouse filter to Lahore |
| 2:00–3:30 | Dashboard KPIs, charts | "Stock value, dead stock and receivables come from the same ledger, so they always agree." | Click **Dead stock → Clear stock** to show the dead-stock report; export to Excel |
| 3:30–5:00 | **AI Copilot** | "Ask in plain English. It answers only from your data and shows its sources." | Ask *How much inventory do I have?* then *Which customers owe me the most?* Open "data sources". Point out the mode badge |
| 5:00–6:00 | **Warehouses → Karachi Main** | "Your floor plan. Colour shows how full each rack is." | Drag a rack, click it to show shelves and bins; open *Utilisation* |
| 6:00–8:30 | **Phone: Receive** (operator) | "Receiving is scanning, not typing." | Mobile → RECEIVE → pick an open PO → scan or type product barcode → quantity, batch and expiry → Confirm. Then PUTAWAY: the suggested bin and the reason. Scan the bin |
| 8:30–10:30 | **Sales order** (owner or sales) | "Confirming an order reserves stock first-expiry-first-out. You can't sell what you don't have." | Sales orders → New → customer, 2 products → Confirm & reserve. Show reserved vs available. Show the credit-limit block if a customer is over limit |
| 10:30–12:30 | **Phone: Pick → Pack** | "Wrong bin or wrong product is rejected on the spot." | PICK → deliberately scan a wrong bin (error shown) → correct bin → quantity. PACK → scan items → complete. Back on laptop: **Dispatch** with vehicle and driver → invoice created |
| 12:30–13:30 | **Inventory → ledger** | "Every unit has a history. Nobody can edit or delete it, not even us." | Open the product → movement history: receipt → putaway → reserve → pick → dispatch |
| 13:30–15:00 | **Storage billing** | "If you rent space to other businesses, Maal Help bills them from actual pallets and handling." | Show a 3PL contract and its invoice; open the print view |
| 15:00–16:30 | **Approvals & audit** | "Big adjustments wait for approval, and nobody approves their own." | Approvals → open a pending adjustment → approve with a comment. Audit trail → filter by user |
| 16:30–18:00 | **Reports** | "35 reports. Filter, export to Excel, CSV or PDF, or print." | Inventory valuation → export PDF (Maal Help letterhead) |
| 18:00–20:00 | Q&A | Hand over the roadmap: integrations, FBR e-invoicing, Urdu | Optional: show Settings → Roles to make the permission model concrete |

## Likely questions and honest answers

| Question | Answer |
|---|---|
| Does it work without internet? | The phone app queues scans during short outages and syncs safely without double posting. Long offline shifts are not supported yet |
| Can it connect to TCS/Leopards/Shopify/QuickBooks? | The connection layer exists, but this version uses **demo (mock) connectors**. Real connections are next on the roadmap |
| Is the AI making decisions? | No. It reads and recommends. Stock moves and approvals are always done by a person with permission |
| FBR e-invoicing? | Not yet. Planned as an integration (see `docs/INDUSTRY_RESEARCH_AND_RECOMMENDATIONS.md`) |
| Urdu? | English interface today; the mobile app is first in line for Urdu |

## After the demo

Reset to a clean state with `npm run db:reset`. Stop the server with **Ctrl+C**, not a forced kill: the embedded development database can be damaged by a hard kill.
