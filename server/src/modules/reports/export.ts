import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { BRAND } from '@shared/brand';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReportColumn } from './definitions';

type Row = Record<string, unknown>;

/** Brand mark for PDF letterheads (source tree in development, built assets in production). */
const LOGO_PNG = [resolve(process.cwd(), 'dist/web/brand/logo-mark.png'), resolve(process.cwd(), 'web/public/brand/logo-mark.png')].find((p) => existsSync(p));

export function formatCell(value: unknown, type: ReportColumn['type']): string {
  if (value === null || value === undefined || value === '') return '';
  switch (type) {
    case 'money': return Number(value).toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 0 });
    case 'number': return Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 });
    case 'percent': return `${(Math.round(Number(value) * 10) / 10).toFixed(1)}%`;
    case 'date': return new Date(String(value)).toISOString().slice(0, 10);
    case 'datetime': return new Date(String(value)).toISOString().replace('T', ' ').slice(0, 16);
    case 'status': return String(value).replace(/_/g, ' ');
    default: return String(value);
  }
}

/** RFC 4180 CSV with a UTF-8 BOM so Excel opens Urdu/English text correctly. Guards against CSV formula injection. */
export function toCsv(columns: ReportColumn[], data: Row[]): string {
  const esc = (v: string) => {
    const safe = /^[=+\-@\t\r]/.test(v) && !/^-?\d/.test(v) ? `'${v}` : v;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = [columns.map((c) => esc(c.label)).join(',')];
  for (const r of data) lines.push(columns.map((c) => esc(c.type === 'money' || c.type === 'number' || c.type === 'percent' ? (r[c.key] === null || r[c.key] === undefined ? '' : String(Math.round(Number(r[c.key]) * 100) / 100)) : formatCell(r[c.key], c.type))).join(','));
  return `﻿${lines.join('\r\n')}`;
}

export async function toXlsx(title: string, subtitle: string, columns: ReportColumn[], data: Row[], totals: Record<string, number> | null): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = BRAND.name;
  const ws = wb.addWorksheet(title.slice(0, 31));
  ws.addRow([title]).font = { bold: true, size: 14 };
  ws.addRow([subtitle]).font = { color: { argb: 'FF6B7280' } };
  ws.addRow([]);
  const header = ws.addRow(columns.map((c) => c.label));
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F37B0' } }; });
  for (const r of data) {
    ws.addRow(columns.map((c) => {
      const v = r[c.key];
      if (v === null || v === undefined) return null;
      if (['money', 'number'].includes(c.type)) return Number(v);
      if (c.type === 'percent') return Number(v) / 100;
      if (c.type === 'date' || c.type === 'datetime') return new Date(String(v));
      return String(v);
    }));
  }
  if (totals) {
    const row = ws.addRow(columns.map((c, i) => (i === 0 ? 'Total' : totals[c.key] ?? null)));
    row.font = { bold: true };
  }
  columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = Math.min(40, Math.max(10, c.label.length + 4));
    if (c.type === 'money') col.numFmt = '#,##0.00';
    if (c.type === 'number') col.numFmt = '#,##0.##';
    if (c.type === 'percent') col.numFmt = '0.0%';
    if (c.type === 'date') col.numFmt = 'yyyy-mm-dd';
    if (c.type === 'datetime') col.numFmt = 'yyyy-mm-dd hh:mm';
  });
  ws.views = [{ state: 'frozen', ySplit: 4 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function toPdf(company: string, title: string, subtitle: string, columns: ReportColumn[], data: Row[], totals: Record<string, number> | null): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: columns.length > 6 ? 'landscape' : 'portrait', margin: 36, bufferPages: true, info: { Title: title, Author: BRAND.name, Creator: BRAND.name } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const weights = columns.map((c) => (c.type === 'text' ? 2 : 1.1));
    const sum = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map((w) => (w / sum) * width);
    const numeric = (c: ReportColumn) => ['money', 'number', 'percent'].includes(c.type);

    const drawHeader = () => {
      if (LOGO_PNG) {
        doc.image(LOGO_PNG, left + width - 26, 28, { width: 26 });
        doc.fillColor(BRAND.colors.primaryDark).font('Helvetica-Bold').fontSize(8).text(BRAND.name, left, 30, { width: width - 32, align: 'right' });
      }
      doc.rect(left, 78, width, 2).fill(BRAND.colors.accent);
      doc.fillColor(BRAND.colors.primary).font('Helvetica-Bold').fontSize(9).text(company.toUpperCase(), left, 30, { width });
      doc.fillColor('#111827').fontSize(15).text(title, left, 44, { width });
      doc.fillColor('#6B7280').font('Helvetica').fontSize(8.5).text(subtitle, left, 64, { width });
      let x = left;
      const y = 84;
      doc.rect(left, y, width, 18).fill('#EEF3FF');
      doc.fillColor('#374151').font('Helvetica-Bold').fontSize(7.5);
      columns.forEach((c, i) => { doc.text(c.label, x + 3, y + 5, { width: widths[i]! - 6, align: numeric(c) ? 'right' : 'left', lineBreak: false, ellipsis: true }); x += widths[i]!; });
      return y + 20;
    };

    let y = drawHeader();
    doc.font('Helvetica').fontSize(7.5);
    const bottom = doc.page.height - doc.page.margins.bottom - 20;
    const drawRow = (values: string[], bold = false, shade = false) => {
      const h = 14;
      if (y + h > bottom) { doc.addPage(); y = drawHeader(); doc.font('Helvetica').fontSize(7.5); }
      if (shade) doc.rect(left, y - 2, width, h).fill('#FAFAFA');
      doc.fillColor('#111827').font(bold ? 'Helvetica-Bold' : 'Helvetica');
      let x = left;
      values.forEach((v, i) => { doc.text(v, x + 3, y + 1, { width: widths[i]! - 6, align: numeric(columns[i]!) ? 'right' : 'left', lineBreak: false, ellipsis: true }); x += widths[i]!; });
      y += h;
    };
    if (!data.length) { doc.fillColor('#6B7280').text('No records match the selected filters.', left, y + 10); }
    data.forEach((r, idx) => drawRow(columns.map((c) => formatCell(r[c.key], c.type)), false, idx % 2 === 1));
    if (totals) { doc.moveTo(left, y).lineTo(left + width, y).strokeColor('#D1D5DB').stroke(); y += 3; drawRow(columns.map((c, i) => (i === 0 ? 'Total' : totals[c.key] !== undefined ? formatCell(totals[c.key], c.type) : ''))); }

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.fillColor('#9CA3AF').font('Helvetica').fontSize(7).text(`Generated by ${BRAND.name} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · Page ${i + 1} of ${range.count}`, left, doc.page.height - 30, { width, align: 'center', lineBreak: false });
    }
    doc.end();
  });
}
