# AI copilot

The running copilot is read-only. It derives tenant-scoped facts in the API, routes common questions to a deterministic answer, and optionally sends those structured facts to Mistral for explanation. The database is authoritative; the model cannot run SQL or mutate business records.

## Supported facts today

- Company-owned available inventory units, SKU count, cost value and low-stock count.
- Products at or below reorder level.
- Top ten products by on-hand cost value.
- Warehouse stock value ranking.
- Products with available stock and no picks/dispatches in the last 90 days.
- Products with 30 days or less of cover based on dispatches recorded in the last 30 days.
- Today's receipt and dispatch movement totals.

Customer receivables, supplier payables, expiry dates, payments, profitability, delayed-order root causes, and forecast demand are not tracked sufficiently for factual answers yet. Questions about unsupported data receive an explicit unavailable response where recognized. The runout calculation is a simple recent-rate indicator, not a statistical forecast.

## Request flow

1. Resolve the authenticated membership and tenant.
2. Run parameterized, tenant-scoped read queries in the API.
3. Format supported responses deterministically; if configured, pass the question and structured results to Mistral with instructions to use only supplied facts.
4. If Mistral errors or times out, return the deterministic answer.

The API key is read only from `MISTRAL_API_KEY` on the server. Configure the endpoint and model with `MISTRAL_API_URL` and `MISTRAL_MODEL`. The copilot currently has no document upload/extraction, action execution, usage ledger, scheduled daily briefing, configurable admin settings, or token/cost telemetry.
