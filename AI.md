# Maal Help — AI

Maal Help's AI features answer from **your own data**. They help people decide; they never act on their own. The Copilot can read, summarise and propose. Stock changes, approvals and financial postings always go through the normal, permission-checked workflows, done by a person.

## Configuration (server only)

| Variable | Default | Purpose |
|---|---|---|
| `MISTRAL_API_KEY` | *(empty)* | Enables Mistral. **Server-side only.** Never put it in web code, docs, screenshots, logs or source control |
| `MISTRAL_API_URL` | `https://api.mistral.ai/v1` | API base URL |
| `MISTRAL_CHAT_MODEL` | `mistral-small-latest` | Chat and tool-calling model |
| `MISTRAL_OCR_MODEL` | `mistral-ocr-latest` | Document OCR model |
| `MISTRAL_TIMEOUT_MS` / `MISTRAL_MAX_RETRIES` | 20000 / 2 | Resilience |
| `AI_RATE_LIMIT_PER_MINUTE` | 20 | Per-company rate limit |
| `AI_COST_INPUT_PER_MTOK` / `AI_COST_OUTPUT_PER_MTOK` | 0.1 / 0.3 | Used to estimate cost in `ai_usage` (check against current Mistral pricing) |

Plans also cap monthly AI calls per company. Usage (tokens, estimated cost, latency, errors) is recorded per call and shown in **Platform → AI usage**.

## Two modes, always labelled

| Mode | When | How answers are produced |
|---|---|---|
| **Mistral** | `MISTRAL_API_KEY` is set | The model chooses read-only tools; the server runs them with the user's permissions; the model writes the answer from the tool results only. The answer shows a "Mistral AI · from your data" badge and lists its data sources |
| **Grounded** (fallback) | No key, or the API is unavailable | A keyword intent router runs the same tools and assembles the answer directly from the facts. No language model is used. The answer shows "Direct from your data (no AI model)" and a notice explaining why |

> **Test status:** grounded mode is covered by automated tests. **The live Mistral path has not been exercised in this workspace because no API key was configured.** It is implemented (chat, tool calling, JSON mode, OCR, retries, timeouts, usage tracking), but verify it with a real key before you rely on it.

## Copilot tools (`server/src/ai/tools.ts`)

All tools are read-only and scoped to the caller's company. Each declares a permission. Tools that need finance access are not offered to roles without `finance.view`, and cost and value fields are redacted in shared tools.

`get_inventory`, `get_inventory_by_product`, `get_inventory_by_warehouse`, `get_low_stock`, `get_expiring_stock`, `get_dead_stock`, `get_top_products_by_value`, `get_sales_summary`, `get_purchase_summary`, `get_customer_balance`, `get_supplier_balance`, `get_warehouse_utilization`, `get_order_status`, `get_stock_movements`, `get_inventory_variances`, `get_profitability`, `get_operations_summary`, `get_stock_intelligence`, `get_reorder_recommendations`, `get_anomalies`, `get_space_recommendations`.

## Features

| Feature | Route | Notes |
|---|---|---|
| Ask your business (chat) | `POST /api/v1/ai/chat` | Conversation history stored per user; every answer cites its tools |
| Proposed actions | `POST /api/v1/ai/actions/confirm` | The only proposal type is **draft purchase orders** from reorder suggestions. Nothing is created until a user with `purchase.manage` confirms, and then only as drafts that go through normal PO approval |
| Daily briefing | `GET/POST /api/v1/ai/briefing` | Built from yesterday's facts and today's risks by rules; Mistral rewrites the narrative when configured. Generated every morning by a job |
| Stock intelligence | `GET /api/v1/ai/stock-intelligence` | Fast / slow / dead / overstock / understock classification with reasons |
| Smart reorder | `GET /api/v1/ai/reorder` | Order now / increase order / wait / reduce order / stop buying, from demand rate, lead time, safety stock and stock on order |
| Anomaly detection | `GET /api/v1/ai/anomalies`, `POST …/:id/review` | Unusual adjustments, off-hours activity, repeated variances, sudden drops. **Flags for human review; never accuses anyone.** Reviewer must write findings |
| Space recommendations | `GET /api/v1/ai/space` | Rule-based slotting: move fast movers near dispatch, consolidate part-empty bins, warn on near-full zones |
| Document extraction | `POST /api/v1/ai/documents` | Supplier invoices and delivery notes. PDF/image need Mistral OCR; CSV/TXT are parsed without AI. Results open for **human review and approval**; on approval they become a draft PO or a supplier bill |
| Monthly report | `GET /api/v1/ai/reports/monthly` | Business summary for a month |

## Safety rules (enforced in code)

1. The Copilot cannot post inventory movements, approve anything, or edit financial records. No tool performs writes.
2. Tools run with the signed-in user's permissions. The model cannot see more than the user can.
3. The system prompt tells the model to answer only from tool results and to say when data is missing.
4. The API key lives only in server environment variables. Browsers never receive it, and the Settings page says so.
5. Prompts and answers are stored in the company's own tables (`ai_conversations`, `ai_messages`) for audit.
6. Rate limits and plan quotas prevent runaway cost.
