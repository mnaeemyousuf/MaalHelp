import { and, asc, eq } from 'drizzle-orm';
import { db, num, t } from '../db';
import type { Ctx } from '../core/context';
import { notFound } from '../core/errors';
import { attentionItems } from '../modules/dashboard/routes';
import { mistral, type ChatMessage } from './mistral';
import { runTool, toolSpecs, toolsFor } from './tools';

export interface ToolTrace { name: string; args: unknown; ok: boolean; data: unknown }
export interface ProposedAction { type: 'create_purchase_orders'; label: string; description: string; payload: { orders: { supplierId: string; supplierName: string | null; lines: { productId: string; sku: string; quantity: number; unitCost: number }[] }[] } }
export interface CopilotAnswer {
  conversationId: string;
  answer: string;
  mode: 'mistral' | 'grounded';
  model: string | null;
  notice: string | null;
  tools: ToolTrace[];
  proposedActions: ProposedAction[];
  generatedAt: string;
}

const SYSTEM_PROMPT = `You are the Maal Help Copilot ("Your Warehouse. Under Control."), an assistant for warehouse owners and teams.
Rules you must follow:
1. Use ONLY facts returned by the provided tools. Never invent quantities, values, names or dates. If the tools do not return the information, say it is not available.
2. Always call a tool before answering any question about the business's data. Prefer the most specific tool.
3. Distinguish facts from estimates: forecasts, days of cover and recommendations are estimates — say so.
4. You cannot change any data. You may recommend actions; the user confirms them in the app, and the system validates them.
5. Unusual activity must be described neutrally ("unusual activity", "needs review"). Never accuse a person of theft or fraud.
6. Be concise and practical: lead with the answer, then 2–5 bullet points, then a "Next step" line when useful.
7. Currency is {CURRENCY}. Format numbers with thousands separators. Today is {TODAY}.`;

function fmt(n: unknown, currency?: string): string {
  const v = Math.round(num(n) * 100) / 100;
  const s = v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return currency ? `${currency} ${s}` : s;
}

/** Keyword intent router used when no model is configured (or the model is unavailable). */
function detectIntents(q: string): { tool: string; args: Record<string, unknown> }[] {
  const text = q.toLowerCase();
  const numberIn = (re: RegExp, def: number) => { const m = text.match(re); return m ? Number(m[1]!.replace(/,/g, '')) : def; };
  const order = q.match(/\b(SO|PO)-\d+\b/i)?.[0];
  if (order) return [{ tool: 'get_order_status', args: { orderNumber: order } }];
  if (/(problem|issue|attention|wrong|risk).*(today|warehouse)|biggest problem|what should i do/.test(text)) return [{ tool: '__attention', args: {} }, { tool: 'get_anomalies', args: {} }];
  if (/summary|brief|overview|what happened|how .* doing/.test(text)) return [{ tool: 'get_operations_summary', args: { range: /yesterday/.test(text) ? 'yesterday' : /week|7/.test(text) ? '7d' : 'today' } }, { tool: 'get_inventory', args: {} }, { tool: 'get_warehouse_utilization', args: {} }, { tool: 'get_low_stock', args: { limit: 5 } }];
  if (/why .*(decrease|drop|down|fell|increase|up|change)|movement/.test(text)) return [{ tool: 'get_stock_movements', args: { range: /month/.test(text) ? 'month' : /today/.test(text) ? 'today' : '7d' } }];
  if (/haven.?t moved|not moved|no movement|dead|idle|aging|aged/.test(text)) return [{ tool: 'get_dead_stock', args: { days: numberIn(/(\d+)\s*days?/, 90) } }];
  if (/run out|stock ?out|running out|next \d+ days|likely to/.test(text)) return [{ tool: 'get_stock_intelligence', args: { classification: 'stockout_risk', limit: 20 } }];
  if (/reorder|order now|what should i (buy|order)|purchase recommendation|replenish/.test(text)) return [{ tool: 'get_reorder_recommendations', args: { limit: 15 } }];
  if (/expir/.test(text)) return [{ tool: 'get_expiring_stock', args: { days: numberIn(/(\d+)\s*days?/, 30) } }];
  if (/low|below reorder|short of|running low/.test(text)) return [{ tool: 'get_low_stock', args: { limit: 25 } }];
  if (/owe me|receivable|outstanding|overdue|debtor|customers? (who )?owe/.test(text)) return [{ tool: 'get_customer_balance', args: { minAmount: numberIn(/(?:pkr|rs\.?|more than|over|above)\s*([\d,]+)/, 0), limit: 15 } }];
  if (/i owe|payable|suppliers? .*owe|pay suppliers/.test(text)) return [{ tool: 'get_supplier_balance', args: { limit: 15 } }];
  if (/top \d+|top products|most valuable|highest value product|by value/.test(text) && !/warehouse/.test(text)) return [{ tool: 'get_top_products_by_value', args: { limit: numberIn(/top\s*(\d+)/, 10) } }];
  if (/warehouse.*(most|highest|value|valuable)|which warehouse/.test(text)) return [{ tool: 'get_inventory_by_warehouse', args: {} }];
  if (/full|capacity|utili[sz]|space|empty location|slot/.test(text)) return [{ tool: 'get_warehouse_utilization', args: {} }, { tool: 'get_space_recommendations', args: {} }];
  if (/profit|margin|net income|loss/.test(text)) return [{ tool: 'get_profitability', args: { range: /year/.test(text) ? 'year' : /week/.test(text) ? '7d' : 'month' } }];
  if (/purchas|bought|supplier/.test(text)) return [{ tool: 'get_purchase_summary', args: { range: /year/.test(text) ? 'year' : 'month' } }];
  if (/sales|sold|revenue|turnover/.test(text)) return [{ tool: 'get_sales_summary', args: { range: /today/.test(text) ? 'today' : /year/.test(text) ? 'year' : /week/.test(text) ? '7d' : 'month' } }];
  if (/anomal|unusual|suspicious|discrepanc|variance/.test(text)) return [{ tool: 'get_anomalies', args: {} }, { tool: 'get_inventory_variances', args: {} }];
  if (/fast|slow|overstock|understock|intelligence/.test(text)) return [{ tool: 'get_stock_intelligence', args: { classification: /fast/.test(text) ? 'fast' : /slow/.test(text) ? 'slow' : /overstock/.test(text) ? 'overstock' : /understock/.test(text) ? 'understock' : 'all' } }];
  const productMatch = q.match(/(?:stock of|how many|quantity of|where is|location of)\s+(.+?)\??$/i);
  if (productMatch) return [{ tool: 'get_inventory_by_product', args: { product: productMatch[1]!.trim() } }];
  if (/stock|inventory|units|how much/.test(text)) return [{ tool: 'get_inventory', args: {} }];
  return [];
}

/** Turns tool results into a plain-language answer without a language model. */
function groundedAnswer(question: string, traces: ToolTrace[], currency: string): string {
  if (!traces.length) {
    return 'I can answer questions using your live warehouse data, for example:\n• How much inventory do I have?\n• Which products are low?\n• Which products haven\'t moved for 90 days?\n• Top 10 products by value\n• Which products may run out in the next 30 days?\n• Why did inventory decrease this week?\n• Which customers owe me the most?\n• Give me today\'s warehouse summary\n• What is the status of SO-10001?';
  }
  const parts: string[] = [];
  for (const tr of traces) {
    if (!tr.ok) { parts.push(`I couldn't retrieve ${tr.name.replace(/^get_/, '').replace(/_/g, ' ')}: ${(tr.data as { error?: string }).error ?? 'not available'}.`); continue; }
    const d = tr.data as Record<string, unknown> & unknown[];
    switch (tr.name) {
      case 'get_inventory': {
        const k = d as unknown as Record<string, number>;
        parts.push(`You have **${fmt(k.totalUnits)} units** across **${fmt(k.skusInStock)} SKUs in stock** (${fmt(k.totalSkus)} active SKUs)${k.inventoryValue !== undefined ? `, valued at **${fmt(k.inventoryValue, currency)}** at cost` : ''}.\n• Available: ${fmt(k.available)} · Reserved: ${fmt(k.reserved)} · In transit: ${fmt(k.inTransit)}\n• Damaged: ${fmt(k.damaged)} · Quarantine: ${fmt(k.quarantine)} · Expired: ${fmt(k.expired)} · Blocked: ${fmt(k.blocked)}\n• ${fmt(k.lowStockSkus)} ${k.lowStockSkus === 1 ? 'SKU is' : 'SKUs are'} at or below reorder level; ${fmt(k.outOfStockSkus)} ${k.outOfStockSkus === 1 ? 'is' : 'are'} out of stock.${k.deadStockValue !== undefined ? `\n• ${fmt(k.deadStockSkus)} SKUs (${fmt(k.deadStockValue, currency)}) have not moved in ${k.deadStockDays} days.` : ''}`);
        break;
      }
      case 'get_low_stock': {
        const list = d as Record<string, unknown>[];
        parts.push(list.length ? `**${list.length} products are at or below their reorder level:**\n${list.slice(0, 15).map((p) => `• ${p.sku} — ${p.name}: ${fmt(p.available)} available (reorder at ${fmt(p.reorderLevel)})${num(p.incoming) ? `, ${fmt(p.incoming)} on order` : ', nothing on order'}`).join('\n')}${list.length > 15 ? `\n…and ${list.length - 15} more.` : ''}\nNext step: open Smart Reorder to create purchase orders.` : 'No products are below their reorder level right now.');
        break;
      }
      case 'get_operations_summary': {
        const o = d as unknown as Record<string, number> & { period: { label: string } };
        parts.push(`**${o.period.label}:** ${fmt(o.receipts)} goods receipts (${fmt(o.unitsReceived)} units in) and ${fmt(o.dispatches)} dispatches (${fmt(o.unitsDispatched)} units out).\n• Pending: ${fmt(o.pendingReceipts)} POs to receive, ${fmt(o.pendingPutaway)} putaway tasks, ${fmt(o.pendingPicking)} orders picking, ${fmt(o.pendingPacking)} to pack, ${fmt(o.pendingDispatch)} to dispatch\n• ${fmt(o.delayedOrders)} delayed orders · ${fmt(o.pendingApprovals)} approvals waiting · ${fmt(o.openTransfers)} open transfers`);
        break;
      }
      case 'get_warehouse_utilization': {
        const w = d as unknown as { warehouses: Record<string, unknown>[]; capacityPct: number };
        parts.push(`**Warehouse capacity:**\n${w.warehouses.map((x) => `• ${x.name}: ${x.utilizationPct}% used (${fmt(x.used)} of ${fmt(x.capacity)} ${x.capacityUnit}), ${fmt(x.emptyLocations)} empty locations`).join('\n')}`);
        break;
      }
      case 'get_space_recommendations': {
        const list = d as Record<string, unknown>[];
        if (list.length) parts.push(`**Space recommendations:**\n${list.slice(0, 6).map((r) => `• ${r.title} — ${r.detail}`).join('\n')}`);
        break;
      }
      case 'get_dead_stock': {
        const list = d as Record<string, unknown>[];
        const total = list.reduce((s, x) => s + num(x.value), 0);
        parts.push(list.length ? `**${list.length} products have stock but no dispatches in the period**${list[0]?.value !== undefined ? ` (${fmt(total, currency)} tied up)` : ''}:\n${list.slice(0, 12).map((p) => `• ${p.sku} — ${p.name}: ${fmt(p.quantity)} units${p.value !== undefined ? ` (${fmt(p.value, currency)})` : ''}`).join('\n')}\nNext step: consider promotions, bundling or returning to supplier.` : 'Every product in stock has moved in this period.');
        break;
      }
      case 'get_top_products_by_value': {
        const list = d as Record<string, unknown>[];
        parts.push(`**Top ${list.length} products by stock value:**\n${list.map((p, i) => `${i + 1}. ${p.sku} — ${p.name}: ${fmt(p.quantity)} units${p.value !== undefined ? `, ${fmt(p.value, currency)}` : ''}`).join('\n')}`);
        break;
      }
      case 'get_stock_intelligence': {
        const res = d as unknown as { items: Record<string, unknown>[]; counts: Record<string, number> };
        parts.push(res.items.length ? `**Estimated stock-out risk (based on the last 90 days of dispatches):**\n${res.items.slice(0, 12).map((x) => `• ${x.sku}: ${fmt(x.available)} available, ~${fmt(x.monthlyDemand)}/month → about ${x.daysOfCover} days of cover`).join('\n')}\nThese are estimates; demand can change.` : 'No products are projected to run out in the next 30 days at current demand (estimate).');
        break;
      }
      case 'get_reorder_recommendations': {
        const list = d as Record<string, unknown>[];
        parts.push(list.length ? `**Reorder recommendations (estimates):**\n${list.slice(0, 10).map((r) => `• ${String(r.action).replace('_', ' ').toUpperCase()} — ${r.sku}: suggest ${fmt(r.suggestedQty)} units${r.supplierName ? ` from ${r.supplierName}` : ''}. ${String(r.reasoning).split('.')[0]}.`).join('\n')}\nNothing is ordered until you confirm.` : 'No products need reordering right now.');
        break;
      }
      case 'get_expiring_stock': {
        const list = d as Record<string, unknown>[];
        parts.push(list.length ? `**${list.length} batches are expiring soon or expired:**\n${list.slice(0, 12).map((b) => `• ${b.sku} batch ${b.batchNo}: ${fmt(b.quantity)} units, ${num(b.daysLeft) < 0 ? `expired ${Math.abs(num(b.daysLeft))} days ago` : `expires in ${b.daysLeft} days`} (${b.warehouses})`).join('\n')}` : 'No batches expire in this window.');
        break;
      }
      case 'get_customer_balance': {
        const list = d as Record<string, unknown>[];
        parts.push(list.length ? `**Customers with outstanding balances:**\n${list.map((c) => `• ${c.name}: ${fmt(c.outstanding, currency)} outstanding${num(c.overdue) ? `, ${fmt(c.overdue, currency)} overdue (up to ${c.maxDaysOverdue} days)` : ''}`).join('\n')}` : 'No customer has an outstanding balance above that amount.');
        break;
      }
      case 'get_supplier_balance': {
        const list = d as Record<string, unknown>[];
        parts.push(list.length ? `**You owe suppliers:**\n${list.map((s) => `• ${s.name}: ${fmt(s.payable, currency)}${num(s.overdue) ? ` (${fmt(s.overdue, currency)} overdue)` : ''}`).join('\n')}` : 'There are no unpaid supplier bills.');
        break;
      }
      case 'get_inventory_by_warehouse': {
        const list = d as Record<string, unknown>[];
        parts.push(list.length ? `**${list[0]!.name}** holds the most stock${list[0]!.value !== undefined ? ` by value (${fmt(list[0]!.value, currency)})` : ''}.\n${list.map((w) => `• ${w.name}: ${fmt(w.units)} units${w.value !== undefined ? `, ${fmt(w.value, currency)}` : ''}, ${w.utilizationPct ?? '–'}% full`).join('\n')}` : 'No warehouses found.');
        break;
      }
      case 'get_stock_movements': {
        const m = d as unknown as { period: { label: string }; netValueChange: number; byType: Record<string, unknown>[]; largestMovements: Record<string, unknown>[] };
        const down = m.byType.filter((x) => num(x.net_units) < 0).sort((a, b) => num(a.net_value) - num(b.net_value));
        parts.push(`**${m.period.label}: inventory value changed by ${fmt(m.netValueChange, currency)}.**\nBy transaction type:\n${m.byType.map((x) => `• ${String(x.type).replace(/_/g, ' ')}: ${fmt(x.net_units)} units (${fmt(x.net_value, currency)}) in ${x.transactions} transactions`).join('\n')}${down[0] ? `\nThe biggest reduction came from **${String(down[0].type).replace(/_/g, ' ')}**.` : ''}${m.largestMovements.length ? `\nLargest single movement: ${m.largestMovements[0]!.reference_no ?? ''} ${m.largestMovements[0]!.sku} ${fmt(m.largestMovements[0]!.quantity)} units.` : ''}`);
        break;
      }
      case 'get_order_status': {
        const o = d as Record<string, unknown>;
        if (o.found === false) parts.push(String(o.message));
        else if (o.type) parts.push(`**${o.number}** (${String(o.type).replace('_', ' ')}) is **${String(o.status).replace('_', ' ')}**${o.customer ? ` for ${o.customer}` : o.supplier ? ` from ${o.supplier}` : ''}${o.total !== undefined ? `, total ${fmt(o.total, currency)}` : ''}.${o.shipments ? `\nShipments: ${o.shipments}` : ''}`);
        else parts.push(`**Open orders:** ${(o.openOrdersByStatus as Record<string, unknown>[]).map((x) => `${x.orders} ${x.status}`).join(', ') || 'none'}. Delayed: ${(o.delayed as unknown[]).length}.`);
        break;
      }
      case 'get_profitability': {
        const p = d as unknown as Record<string, unknown> & { revenue: Record<string, number>; costs: Record<string, number> };
        parts.push(`**Estimated profitability ${(p.period as { from: string; to: string }).from} → ${(p.period as { to: string }).to}:**\n• Revenue ${fmt(p.revenue.total, currency)} (sales ${fmt(p.revenue.sales, currency)}, storage ${fmt(p.revenue.storageAndHandling, currency)})\n• Cost of goods ${fmt(p.costs.costOfGoodsSold, currency)} → gross profit ${fmt(p.grossProfit, currency)}${p.grossMarginPct !== null ? ` (${p.grossMarginPct}%)` : ''}\n• Operating costs ${fmt(p.operatingCost, currency)} → **estimated net ${fmt(p.netProfit, currency)}**\nThis is a management estimate, not a statutory statement.`);
        break;
      }
      case 'get_sales_summary': {
        const s = d as unknown as Record<string, unknown> & { period: { label: string }; topCustomers: Record<string, unknown>[] };
        parts.push(`**Sales, ${s.period.label}:** ${fmt(s.sales, currency)} invoiced (net of tax), gross margin ${fmt(s.grossMargin, currency)}${s.grossMarginPct !== null ? ` (${s.grossMarginPct}%)` : ''}. Receivables ${fmt(s.receivables, currency)}, of which ${fmt(s.overdueReceivables, currency)} overdue.${s.topCustomers.length ? `\nTop customers: ${s.topCustomers.map((c) => `${c.name} (${fmt(c.sales, currency)})`).join(', ')}` : ''}`);
        break;
      }
      case 'get_purchase_summary': {
        const s = d as unknown as Record<string, unknown> & { period: { label: string }; bySupplier: Record<string, unknown>[]; openPurchaseOrders: Record<string, unknown>[] };
        parts.push(`**Purchases, ${s.period.label}:** ${s.bySupplier.map((x) => `${x.name} ${fmt(x.value, currency)} (${x.orders} POs)`).join(', ') || 'none'}.\nOpen POs: ${s.openPurchaseOrders.length}${s.openPurchaseOrders.filter((x) => x.overdue).length ? `, ${s.openPurchaseOrders.filter((x) => x.overdue).length} overdue` : ''}.`);
        break;
      }
      case 'get_anomalies': {
        const list = d as Record<string, unknown>[];
        parts.push(list.length ? `**Unusual activity detected (needs human review):**\n${list.slice(0, 6).map((a) => `• ${a.title} — ${a.description}`).join('\n')}` : 'No unusual activity was detected.');
        break;
      }
      case 'get_inventory_variances': {
        const v = d as unknown as { counts: unknown[]; adjustments: Record<string, unknown>[]; shortPicks: unknown[] };
        parts.push(`Last 30 days: ${v.counts.length} stock counts submitted, ${v.adjustments.length} adjustments, ${v.shortPicks.length} short picks.`);
        break;
      }
      case 'get_inventory_by_product': {
        const r = d as Record<string, unknown> & { stock?: Record<string, unknown>[]; product?: Record<string, unknown>; insight?: { message: string } | null };
        if (r.found === false) { parts.push(String(r.message)); break; }
        const total = (r.stock ?? []).reduce((s, x) => s + num(x.quantity), 0);
        parts.push(`**${r.product!.sku} — ${r.product!.name}: ${fmt(total)} units on hand.**\n${(r.stock ?? []).slice(0, 12).map((s) => `• ${s.warehouse} / ${s.location}: ${fmt(s.quantity)} ${String(s.status)}${s.batch ? ` (batch ${s.batch})` : ''}`).join('\n')}${r.insight ? `\n${r.insight.message}` : ''}`);
        break;
      }
      case '__attention': {
        const list = d as Record<string, unknown>[];
        parts.push(list.length ? `**${list.length} thing${list.length > 1 ? 's' : ''} need your attention today:**\n${list.slice(0, 6).map((a, i) => `${i + 1}. ${a.title} — ${a.detail}`).join('\n')}` : 'Nothing needs urgent attention right now.');
        break;
      }
      default:
        parts.push(`Data from ${tr.name}: ${JSON.stringify(tr.data).slice(0, 600)}`);
    }
  }
  void question;
  return parts.join('\n\n');
}

function buildProposedActions(ctx: Ctx, traces: ToolTrace[]): ProposedAction[] {
  if (!ctx.permissions.has('purchase.manage')) return [];
  const recs = traces.find((x) => x.name === 'get_reorder_recommendations' && x.ok)?.data as Record<string, unknown>[] | undefined;
  if (!recs?.length) return [];
  const bySupplier = new Map<string, ProposedAction['payload']['orders'][number]>();
  for (const r of recs) {
    if (!r.supplierId || num(r.suggestedQty) <= 0 || !['order_now', 'increase_order'].includes(String(r.action))) continue;
    const g = bySupplier.get(String(r.supplierId)) ?? { supplierId: String(r.supplierId), supplierName: (r.supplierName as string) ?? null, lines: [] };
    g.lines.push({ productId: String(r.productId), sku: String(r.sku), quantity: num(r.suggestedQty), unitCost: num(r.unitCost) });
    bySupplier.set(String(r.supplierId), g);
  }
  const orders = [...bySupplier.values()];
  if (!orders.length) return [];
  const lines = orders.reduce((s, o) => s + o.lines.length, 0);
  return [{ type: 'create_purchase_orders', label: `Create ${orders.length} draft purchase order${orders.length > 1 ? 's' : ''}`, description: `${lines} product line(s) across ${orders.map((o) => o.supplierName).join(', ')}. Drafts only — you review and submit them.`, payload: { orders } }];
}

export async function askCopilot(ctx: Ctx, message: string, conversationId?: string | null): Promise<CopilotAnswer> {
  let convoId = conversationId ?? null;
  if (convoId) {
    const [c] = await db().select().from(t.aiConversations).where(and(eq(t.aiConversations.id, convoId), eq(t.aiConversations.tenantId, ctx.tenantId), eq(t.aiConversations.userId, ctx.userId))).limit(1);
    if (!c) throw notFound('Conversation');
  } else {
    const [c] = await db().insert(t.aiConversations).values({ tenantId: ctx.tenantId, userId: ctx.userId, title: message.slice(0, 80) }).returning();
    convoId = c!.id;
  }
  const history = await db().select().from(t.aiMessages).where(eq(t.aiMessages.conversationId, convoId)).orderBy(asc(t.aiMessages.createdAt)).limit(20);
  await db().insert(t.aiMessages).values({ tenantId: ctx.tenantId, conversationId: convoId, role: 'user', content: message });

  const traces: ToolTrace[] = [];
  let answer = '';
  let mode: CopilotAnswer['mode'] = 'grounded';
  let model: string | null = null;
  let notice: string | null = null;

  if (mistral.configured) {
    try {
      const tools = toolsFor(ctx);
      const messages: ChatMessage[] = [
        { role: 'system', content: SYSTEM_PROMPT.replace('{CURRENCY}', ctx.currency).replace('{TODAY}', new Date().toISOString().slice(0, 10)) },
        ...history.slice(-8).map((h) => ({ role: h.role as 'user' | 'assistant', content: h.content })),
        { role: 'user', content: message },
      ];
      for (let round = 0; round < 4; round++) {
        const res = await mistral.chat(messages, { tenantId: ctx.tenantId, userId: ctx.userId, feature: 'copilot', tools: toolSpecs(tools), toolChoice: round === 0 ? 'any' : 'auto' });
        model = res.model;
        const calls = res.message.tool_calls ?? [];
        if (!calls.length) { answer = String(res.message.content ?? '').trim(); break; }
        messages.push({ role: 'assistant', content: res.message.content ?? '', tool_calls: calls });
        for (const call of calls) {
          let args: unknown = {};
          try { args = JSON.parse(call.function.arguments || '{}'); } catch { args = {}; }
          const result = await runTool(ctx, call.function.name, args);
          traces.push({ name: call.function.name, args, ok: result.ok, data: result.data });
          messages.push({ role: 'tool', name: call.function.name, tool_call_id: call.id, content: JSON.stringify(result.data).slice(0, 24_000) });
        }
      }
      if (!answer) answer = groundedAnswer(message, traces, ctx.currency);
      mode = 'mistral';
    } catch (err) {
      notice = `The AI model is unavailable (${err instanceof Error ? err.message : 'error'}). This answer was generated directly from your data.`;
      traces.length = 0;
    }
  } else {
    notice = 'AI model not configured (MISTRAL_API_KEY is not set). This answer was generated directly from your data without a language model.';
  }

  if (mode === 'grounded') {
    for (const intent of detectIntents(message)) {
      if (intent.tool === '__attention') {
        traces.push({ name: '__attention', args: {}, ok: true, data: await attentionItems(db(), ctx) });
        continue;
      }
      const r = await runTool(ctx, intent.tool, intent.args);
      traces.push({ name: intent.tool, args: intent.args, ok: r.ok, data: r.data });
    }
    answer = groundedAnswer(message, traces, ctx.currency);
    await mistral.track({ tenantId: ctx.tenantId, userId: ctx.userId, feature: 'copilot' }, 'grounded-rules', { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, 0, 'fallback');
  }

  const proposedActions = buildProposedActions(ctx, traces);
  await db().insert(t.aiMessages).values({ tenantId: ctx.tenantId, conversationId: convoId, role: 'assistant', content: answer, toolCalls: traces.map((x) => ({ name: x.name, args: x.args })), data: traces.map((x) => ({ name: x.name, ok: x.ok })), proposedActions, mode });
  await db().update(t.aiConversations).set({ updatedAt: new Date() }).where(eq(t.aiConversations.id, convoId));
  return { conversationId: convoId, answer, mode, model, notice, tools: traces, proposedActions, generatedAt: new Date().toISOString() };
}
