import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DOCUMENT_TYPES } from '@shared/domain';
import { db, num, rows, t } from '../db';
import { idParam, pageQuery, paged, SENT, type Router } from '../core/http';
import { badRequest, forbidden, invalidState, notFound } from '../core/errors';
import { audit } from '../core/audit';
import { sha256 } from '../core/crypto';
import { sniffMime, storage } from '../core/storage';
import { env } from '../config/env';
import { enqueue, runDueJobs } from '../jobs/queue';
import { assertWithinLimit } from '../modules/platform/limits';
import { classifyStock, productVelocity, reorderRecommendation } from '../modules/analytics/metrics';
import { detectAnomalies, persistAnomalies, spaceRecommendations } from '../modules/analytics/insights';
import { createPurchaseOrder, poBody } from '../modules/purchasing/routes';
import { toPdf } from '../modules/reports/export';
import { mistral } from './mistral';
import { askCopilot } from './copilot';
import { generateBriefing, monthlyReport } from './briefing';
import { latestExtraction } from './documents';
import { TOOLS } from './tools';

export function registerAiRoutes(r: Router) {
  r.get('/status', { summary: 'AI configuration status (never returns the key)', permission: 'ai.use' }, async ({ ctx }) => {
    const [usage] = await rows<Record<string, string>>(db(), sql`SELECT COUNT(*) AS requests, COALESCE(SUM(total_tokens), 0) AS tokens, COALESCE(SUM(cost_usd), 0) AS cost FROM ai_usage WHERE tenant_id = ${ctx.tenantId} AND created_at >= date_trunc('month', now())`);
    return { configured: mistral.configured, model: mistral.configured ? env.MISTRAL_CHAT_MODEL : null, ocrModel: mistral.configured ? env.MISTRAL_OCR_MODEL : null, tools: TOOLS.filter((x) => ctx.permissions.has(x.permission)).map((x) => ({ name: x.name, description: x.description })), monthToDate: { requests: num(usage?.requests), tokens: num(usage?.tokens), costUsd: num(usage?.cost) } };
  });

  r.post('/chat', {
    summary: 'Ask the Copilot. Answers come only from permission-checked, read-only data tools.',
    permission: 'ai.use',
    rateLimit: { max: 30, timeWindow: '1 minute' },
    body: z.object({ message: z.string().trim().min(1).max(1000), conversationId: z.string().uuid().nullish() }),
  }, async ({ ctx, body }) => {
    await assertWithinLimit(db(), ctx.tenantId, 'monthlyAiRequests');
    return askCopilot(ctx, body.message, body.conversationId);
  });

  r.get('/conversations', { summary: 'My Copilot conversations', permission: 'ai.use' }, async ({ ctx }) =>
    db().select().from(t.aiConversations).where(and(eq(t.aiConversations.tenantId, ctx.tenantId), eq(t.aiConversations.userId, ctx.userId))).orderBy(desc(t.aiConversations.updatedAt)).limit(30));

  r.get('/conversations/:id', { summary: 'Conversation messages', permission: 'ai.use', params: idParam }, async ({ ctx, params }) => {
    const [c] = await db().select().from(t.aiConversations).where(and(eq(t.aiConversations.id, params.id), eq(t.aiConversations.tenantId, ctx.tenantId), eq(t.aiConversations.userId, ctx.userId))).limit(1);
    if (!c) throw notFound('Conversation');
    return { ...c, messages: await db().select().from(t.aiMessages).where(eq(t.aiMessages.conversationId, c.id)).orderBy(t.aiMessages.createdAt) };
  });

  r.post('/actions/confirm', {
    summary: 'Confirm an AI-proposed action. Creates DRAFT purchase orders only; the backend validates everything.',
    permission: 'purchase.manage',
    body: z.object({ type: z.literal('create_purchase_orders'), warehouseId: z.string().uuid(), orders: z.array(z.object({ supplierId: z.string().uuid(), lines: z.array(z.object({ productId: z.string().uuid(), quantity: z.number().positive(), unitCost: z.number().min(0) })).min(1) })).min(1).max(20) }),
  }, async ({ ctx, body }) => {
    return db().transaction(async (tx) => {
      const created = [];
      for (const o of body.orders) {
        const po = await createPurchaseOrder(tx, ctx, poBody.parse({ supplierId: o.supplierId, warehouseId: body.warehouseId, source: 'ai_reorder', notes: 'Draft created from Smart Reorder recommendation — review before submitting.', lines: o.lines }));
        created.push({ id: po.id, number: po.number, total: po.total });
      }
      await audit(tx, ctx, { action: 'ai.action_confirmed', entityType: 'purchase_order', entityId: created.map((c) => c.id).join(','), newValue: { type: body.type, orders: created } });
      return { created };
    });
  });

  r.get('/briefing', { summary: "Today's Warehouse Intelligence Brief (generated if missing)", permission: ['ai.use', 'dashboard.view'] }, async ({ ctx }) => {
    const [row] = await db().select().from(t.aiBriefings).where(and(eq(t.aiBriefings.tenantId, ctx.tenantId), eq(t.aiBriefings.briefingDate, new Date().toISOString().slice(0, 10)))).limit(1);
    return row ?? generateBriefing(ctx.tenantId, ctx.userId);
  });

  r.post('/briefing', { summary: 'Regenerate today\'s briefing', permission: 'ai.use', rateLimit: { max: 6, timeWindow: '1 minute' } }, async ({ ctx }) => generateBriefing(ctx.tenantId, ctx.userId));

  r.get('/stock-intelligence', { summary: 'Fast / slow / dead / overstock / understock classification with cover', permission: 'inventory.view' }, async ({ ctx }) => {
    const items = (await productVelocity(db(), ctx.tenantId)).map((v) => classifyStock(v));
    const counts = items.reduce<Record<string, number>>((m, x) => ({ ...m, [x.classification]: (m[x.classification] ?? 0) + 1 }), {});
    return { counts, stockoutRisk: items.filter((x) => x.stockoutRisk).length, items: items.sort((a, b) => (a.daysOfCover ?? 1e9) - (b.daysOfCover ?? 1e9)) };
  });

  r.get('/reorder', { summary: 'Smart reorder recommendations with reasoning (no automatic ordering)', permission: ['purchase.view', 'inventory.view'] }, async ({ ctx }) => {
    const recs = (await productVelocity(db(), ctx.tenantId)).map((v) => reorderRecommendation(v));
    const rank = { order_now: 0, increase_order: 1, reduce_order: 2, wait: 3 };
    return recs.sort((a, b) => rank[a.action] - rank[b.action] || b.estimatedCost - a.estimatedCost);
  });

  r.get('/anomalies', { summary: 'Detected unusual activity awaiting review', permission: ['inventory.approve', 'audit.view', 'inventory.view'], query: pageQuery.extend({ status: z.enum(['open', 'reviewed', 'dismissed', 'all']).default('open') }) }, async ({ ctx, query }) => {
    await persistAnomalies(db(), ctx.tenantId, await detectAnomalies(db(), ctx.tenantId));
    const list = await rows<Record<string, unknown>>(db(), sql`SELECT a.*, u.name AS reviewed_by_name, COUNT(*) OVER() AS total_count FROM anomalies a LEFT JOIN users u ON u.id = a.reviewed_by WHERE a.tenant_id = ${ctx.tenantId} ${query.status === 'all' ? sql`` : sql`AND a.status = ${query.status}`} ORDER BY a.detected_at DESC LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`);
    return paged(list.map(({ total_count: _t, ...x }) => x), num(list[0]?.total_count), query.page, query.pageSize);
  });

  r.post('/anomalies/:id/review', { summary: 'Record a human review of unusual activity', permission: ['inventory.approve', 'audit.view'], params: idParam, body: z.object({ status: z.enum(['reviewed', 'dismissed']), note: z.string().trim().min(3).max(500) }) }, async ({ ctx, params, body }) => {
    const [a] = await db().update(t.anomalies).set({ status: body.status, reviewNote: body.note, reviewedBy: ctx.userId, reviewedAt: new Date() }).where(and(eq(t.anomalies.id, params.id), eq(t.anomalies.tenantId, ctx.tenantId))).returning();
    if (!a) throw notFound('Anomaly');
    await audit(db(), ctx, { action: `anomaly.${body.status}`, entityType: 'anomaly', entityId: a.id, newValue: body });
    return a;
  });

  r.get('/space', { summary: 'Smart space / slotting recommendations (rule-based)', permission: 'warehouse.view' }, async ({ ctx }) => spaceRecommendations(db(), ctx.tenantId));

  r.get('/reports/monthly', { summary: 'AI monthly warehouse performance report (JSON or PDF)', permission: ['report.view', 'ai.use'], query: z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), format: z.enum(['json', 'pdf']).default('json') }) }, async ({ ctx, query, reply }) => {
    const rep = await monthlyReport(ctx.tenantId, query.month, ctx.userId);
    const report = ctx.permissions.has('finance.view') ? rep : { ...rep, financial: null, kpis: rep.kpis.filter((k) => !/Sales|profit|value/i.test(k.label)) };
    if (query.format === 'json') return report;
    const columns = [{ key: 'label', label: 'Metric', type: 'text' as const }, { key: 'value', label: 'Value', type: 'text' as const }];
    const body = [
      ...report.kpis.map((k) => ({ label: k.label, value: String(k.value) })),
      { label: '', value: '' }, { label: 'EXECUTIVE SUMMARY', value: '' }, ...chunk(report.executiveSummary).map((s) => ({ label: s, value: '' })),
      { label: '', value: '' }, { label: 'MAJOR ISSUES', value: '' }, ...(report.issues.length ? report.issues : ['None recorded']).map((s) => ({ label: `• ${s}`, value: '' })),
      { label: '', value: '' }, { label: 'RECOMMENDATIONS', value: '' }, ...report.recommendations.map((s) => ({ label: `• ${s}`, value: '' })),
    ];
    const pdf = await toPdf(report.company, report.title, `${report.period.from} to ${report.period.to} · ${report.generatedBy === 'mistral' ? 'Narrative by Mistral AI from system data' : 'Generated from system data'}`, columns, body, null);
    reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="monthly_report_${query.month}.pdf"`).send(pdf);
    return SENT;
  });

  // ───── Document intelligence ─────
  r.post('/documents', {
    summary: 'Upload a purchase invoice, PO, delivery note, GRN, supplier invoice or packing list for AI extraction (multipart: file, docType)',
    permission: ['purchase.manage', 'receiving.execute'],
    rateLimit: { max: 20, timeWindow: '1 minute' },
  }, async ({ ctx, req }) => {
    const part = await req.file();
    if (!part) throw badRequest('Attach a file.');
    const buffer = await part.toBuffer();
    if (!buffer.length) throw badRequest('The file is empty.');
    const mime = sniffMime(buffer);
    const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'text/plain'];
    if (!mime || !allowed.includes(mime)) throw badRequest('Upload a PDF, JPG, PNG, WEBP, CSV or TXT file.');
    const docType = z.enum(DOCUMENT_TYPES).catch('purchase_invoice').parse((part.fields.docType as { value?: string } | undefined)?.value);
    await assertWithinLimit(db(), ctx.tenantId, 'storageMb', buffer.length / 1048576);
    const safeName = part.filename.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'document';
    const key = `${ctx.tenantId}/documents/${Date.now()}-${sha256(buffer).slice(0, 16)}`;
    await storage.put(key, buffer, mime);
    const [doc] = await db().insert(t.documents).values({ tenantId: ctx.tenantId, fileName: safeName, mimeType: mime === 'text/plain' && /\.csv$/i.test(safeName) ? 'text/csv' : mime, sizeBytes: buffer.length, storageKey: key, sha256: sha256(buffer), docType, uploadedBy: ctx.userId }).returning();
    await enqueue(db(), 'documents.extract', { documentId: doc!.id }, { tenantId: ctx.tenantId, maxAttempts: 1 });
    await audit(db(), ctx, { action: 'document.uploaded', entityType: 'document', entityId: doc!.id, newValue: { fileName: safeName, docType, size: buffer.length } });
    void runDueJobs(5); // start extraction promptly; the worker also picks it up
    return doc;
  });

  r.get('/documents', { summary: 'Uploaded documents', permission: ['purchase.view', 'receiving.execute'] }, async ({ ctx }) =>
    rows(db(), sql`SELECT d.id, d.file_name AS "fileName", d.mime_type AS "mimeType", d.size_bytes AS "sizeBytes", d.doc_type AS "docType", d.status, d.error, d.created_at AS "createdAt", u.name AS "uploadedBy" FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by WHERE d.tenant_id = ${ctx.tenantId} ORDER BY d.created_at DESC LIMIT 100`));

  r.get('/documents/:id', { summary: 'Document with its extraction for review', permission: ['purchase.view', 'receiving.execute'], params: idParam }, async ({ ctx, params }) => {
    const [doc] = await db().select().from(t.documents).where(and(eq(t.documents.id, params.id), eq(t.documents.tenantId, ctx.tenantId))).limit(1);
    if (!doc) throw notFound('Document');
    return { ...doc, storageKey: undefined, extraction: await latestExtraction(ctx.tenantId, doc.id) };
  });

  r.post('/documents/:id/approve', {
    summary: 'Approve reviewed extraction. Creates a DRAFT purchase order (purchase docs) or returns a pre-filled receipt (delivery docs). Never posts inventory or payments.',
    permission: ['purchase.manage', 'receiving.execute'],
    params: idParam,
    body: z.object({ supplierId: z.string().uuid(), warehouseId: z.string().uuid(), action: z.enum(['create_po', 'prefill_receipt']), lines: z.array(z.object({ productId: z.string().uuid(), quantity: z.number().positive(), unitCost: z.number().min(0), batchNo: z.string().max(60).nullish(), expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish() })).min(1) }),
  }, async ({ ctx, params, body }) => {
    const [doc] = await db().select().from(t.documents).where(and(eq(t.documents.id, params.id), eq(t.documents.tenantId, ctx.tenantId))).limit(1);
    if (!doc) throw notFound('Document');
    const ex = await latestExtraction(ctx.tenantId, doc.id);
    if (!ex || ex.status !== 'pending_review') throw invalidState('This document has no extraction awaiting review.');
    if (body.action === 'create_po') {
      if (!ctx.permissions.has('purchase.manage')) throw forbidden();
      return db().transaction(async (tx) => {
        const po = await createPurchaseOrder(tx, ctx, poBody.parse({ supplierId: body.supplierId, warehouseId: body.warehouseId, source: 'document', notes: `Created from document ${doc.fileName}${ex.extracted.invoiceNumber ? ` (supplier ref ${ex.extracted.invoiceNumber})` : ''}. Review before submitting.`, lines: body.lines.map((l) => ({ productId: l.productId, quantity: l.quantity, unitCost: l.unitCost })) }));
        await tx.update(t.documentExtractions).set({ status: 'approved', reviewedBy: ctx.userId, reviewedAt: new Date(), createdEntityType: 'purchase_order', createdEntityId: po.id }).where(eq(t.documentExtractions.id, ex.id));
        await tx.update(t.documents).set({ status: 'confirmed' }).where(eq(t.documents.id, doc.id));
        await audit(tx, ctx, { action: 'document.approved', entityType: 'document', entityId: doc.id, newValue: { purchaseOrder: po.number } });
        return { purchaseOrder: { id: po.id, number: po.number } };
      });
    }
    await db().update(t.documentExtractions).set({ status: 'approved', reviewedBy: ctx.userId, reviewedAt: new Date(), createdEntityType: 'receipt_prefill' }).where(eq(t.documentExtractions.id, ex.id));
    await db().update(t.documents).set({ status: 'confirmed' }).where(eq(t.documents.id, doc.id));
    await audit(db(), ctx, { action: 'document.approved', entityType: 'document', entityId: doc.id, newValue: { action: 'prefill_receipt' } });
    return { receiptPrefill: { supplierId: body.supplierId, warehouseId: body.warehouseId, deliveryNoteNo: ex.extracted.invoiceNumber ?? '', lines: body.lines.map((l) => ({ productId: l.productId, quantity: l.quantity, unitCost: l.unitCost, batchNo: l.batchNo ?? null, expiryDate: l.expiryDate ?? null })) } };
  });

  r.post('/documents/:id/reject', { summary: 'Reject an extraction', permission: ['purchase.manage', 'receiving.execute'], params: idParam }, async ({ ctx, params }) => {
    const [doc] = await db().update(t.documents).set({ status: 'rejected' }).where(and(eq(t.documents.id, params.id), eq(t.documents.tenantId, ctx.tenantId))).returning();
    if (!doc) throw notFound('Document');
    await db().update(t.documentExtractions).set({ status: 'rejected', reviewedBy: ctx.userId, reviewedAt: new Date() }).where(eq(t.documentExtractions.documentId, doc.id));
    return { ok: true };
  });
}

function chunk(text: string, size = 110): string[] {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let line = '';
  for (const w of words) { if ((line + ' ' + w).length > size) { out.push(line); line = w; } else line = line ? `${line} ${w}` : w; }
  if (line) out.push(line);
  return out;
}
