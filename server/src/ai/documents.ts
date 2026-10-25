import { and, eq, sql } from 'drizzle-orm';
import { db, rows, t } from '../db';
import type { ExtractedDocument } from '../db/schema';
import { storage } from '../core/storage';
import { registerJob } from '../jobs/queue';
import { mistral } from './mistral';

const EXTRACTION_PROMPT = `Extract structured data from a purchase invoice, purchase order, delivery note, GRN, supplier invoice or packing list.
Return JSON with exactly these keys:
{"supplierName": string|null, "invoiceNumber": string|null, "date": "YYYY-MM-DD"|null, "currency": string|null,
 "lines": [{"sku": string|null, "description": string|null, "quantity": number|null, "unitPrice": number|null, "tax": number|null, "total": number|null, "batch": string|null, "expiry": "YYYY-MM-DD"|null}],
 "subtotal": number|null, "tax": number|null, "total": number|null}
Use null for anything not present. Do not guess values. Numbers must be plain numbers without currency symbols or commas.`;

/** Development/no-key fallback: parses simple CSV / text line items ("SKU, qty, price"). Clearly limited. */
export function heuristicExtract(text: string): ExtractedDocument {
  const lines: ExtractedDocument['lines'] = [];
  let supplierName: string | null = null;
  let invoiceNumber: string | null = null;
  let date: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const kv = line.match(/^(supplier|vendor|invoice\s*(?:no|number|#)?|date)\s*[:=,]\s*(.+)$/i);
    if (kv) {
      const key = kv[1]!.toLowerCase();
      if (key.startsWith('supplier') || key.startsWith('vendor')) supplierName = kv[2]!.trim();
      else if (key.startsWith('invoice')) invoiceNumber = kv[2]!.trim();
      else if (/^\d{4}-\d{2}-\d{2}/.test(kv[2]!.trim())) date = kv[2]!.trim().slice(0, 10);
      continue;
    }
    const cells = line.split(/[,;\t|]/).map((c) => c.trim()).filter(Boolean);
    if (cells.length >= 2 && /^[A-Za-z0-9._/-]{2,40}$/.test(cells[0]!) && cells.some((c) => /^\d+(\.\d+)?$/.test(c))) {
      const nums = cells.slice(1).map((c) => Number(c.replace(/,/g, ''))).filter((n) => Number.isFinite(n));
      const desc = cells.slice(1).find((c) => !/^[\d.,]+$/.test(c)) ?? null;
      if (/^(sku|code|item)$/i.test(cells[0]!)) continue;
      lines.push({ sku: cells[0]!, description: desc, quantity: nums[0] ?? null, unitPrice: nums[1] ?? null, tax: null, total: nums[2] ?? (nums[0] && nums[1] ? nums[0] * nums[1] : null), batch: null, expiry: null });
    }
  }
  const total = lines.reduce((s, l) => s + (l.total ?? 0), 0) || null;
  return { supplierName, invoiceNumber, date, currency: null, lines, subtotal: total, tax: null, total };
}

async function matchEntities(tenantId: string, ex: ExtractedDocument) {
  let supplierId: string | null = null;
  if (ex.supplierName) {
    const [s] = await rows<{ id: string }>(db(), sql`SELECT id FROM suppliers WHERE tenant_id = ${tenantId} AND (lower(name) = lower(${ex.supplierName}) OR lower(name) LIKE ${`%${ex.supplierName.toLowerCase().slice(0, 20)}%`} OR lower(${ex.supplierName}) LIKE '%' || lower(name) || '%') LIMIT 1`);
    supplierId = s?.id ?? null;
  }
  for (const line of ex.lines) {
    const code = line.sku?.trim();
    const desc = line.description?.trim();
    const [p] = await rows<{ id: string }>(db(), sql`SELECT p.id FROM products p WHERE p.tenant_id = ${tenantId} AND (
      ${code ? sql`upper(p.sku) = upper(${code}) OR p.barcode = ${code} OR EXISTS (SELECT 1 FROM product_barcodes b WHERE b.product_id = p.id AND b.barcode = ${code})` : sql`false`}
      ${desc ? sql`OR lower(p.name) = lower(${desc}) OR lower(p.name) LIKE ${`%${desc.toLowerCase().slice(0, 30)}%`}` : sql``}) LIMIT 1`);
    line.matchedProductId = p?.id ?? null;
  }
  return supplierId;
}

/** Background job: OCR + extraction. Results wait for human review — nothing is posted. */
registerJob('documents.extract', async (payload) => {
  const documentId = String(payload.documentId);
  const [doc] = await db().select().from(t.documents).where(eq(t.documents.id, documentId)).limit(1);
  if (!doc) return { skipped: true };
  await db().update(t.documents).set({ status: 'processing', error: null }).where(eq(t.documents.id, doc.id));
  try {
    const file = await storage.get(doc.storageKey);
    const isText = doc.mimeType.startsWith('text/');
    let text = '';
    let extracted: ExtractedDocument;
    let model = 'heuristic-parser';
    if (isText) text = file.toString('utf8').slice(0, 200_000);
    if (mistral.configured) {
      if (!isText) text = await mistral.ocr({ base64: file.toString('base64'), mimeType: doc.mimeType }, { tenantId: doc.tenantId, userId: doc.uploadedBy });
      extracted = await mistral.json<ExtractedDocument>(EXTRACTION_PROMPT, `Document type hint: ${doc.docType}\n\n${text.slice(0, 60_000)}`, { tenantId: doc.tenantId, userId: doc.uploadedBy, feature: 'document', maxTokens: 2500 });
      extracted.lines = Array.isArray(extracted.lines) ? extracted.lines : [];
      model = `${mistral.chatModel} + OCR`;
    } else if (isText) {
      extracted = heuristicExtract(text);
    } else {
      throw new Error('Reading PDFs and images requires the AI model. Set MISTRAL_API_KEY on the server, or upload a CSV/text file.');
    }
    const supplierId = await matchEntities(doc.tenantId, extracted);
    await db().insert(t.documentExtractions).values({ tenantId: doc.tenantId, documentId: doc.id, model, rawText: text.slice(0, 100_000), extracted, matchedSupplierId: supplierId });
    await db().update(t.documents).set({ status: 'extracted' }).where(eq(t.documents.id, doc.id));
    return { lines: extracted.lines.length };
  } catch (err) {
    await db().update(t.documents).set({ status: 'failed', error: err instanceof Error ? err.message.slice(0, 500) : String(err) }).where(eq(t.documents.id, doc.id));
    return { failed: true };
  }
});

export async function latestExtraction(tenantId: string, documentId: string) {
  const [x] = await db().select().from(t.documentExtractions).where(and(eq(t.documentExtractions.documentId, documentId), eq(t.documentExtractions.tenantId, tenantId))).orderBy(sql`${t.documentExtractions.createdAt} DESC`).limit(1);
  return x ?? null;
}
