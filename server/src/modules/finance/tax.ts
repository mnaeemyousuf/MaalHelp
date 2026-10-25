/**
 * Tax engine. Rates come from the tenant's tax_rates configuration (seeded from
 * the localisation pack) — no country tax rules are hard-coded in documents.
 * Supports tax-exclusive and tax-inclusive pricing and line discounts.
 */
export interface TaxLineInput {
  quantity: number;
  unitPrice: number;
  discountPct?: number;
  taxRate?: number; // percent
}

export interface TaxLineResult {
  gross: number;     // quantity × unit price (before discount)
  discount: number;
  net: number;       // taxable amount
  tax: number;
  total: number;     // net + tax
}

export interface TaxTotals {
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  total: number;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function computeLine(line: TaxLineInput, inclusive: boolean): TaxLineResult {
  const gross = line.quantity * line.unitPrice;
  const discount = gross * ((line.discountPct ?? 0) / 100);
  const afterDiscount = gross - discount;
  const rate = (line.taxRate ?? 0) / 100;
  if (inclusive) {
    const net = afterDiscount / (1 + rate);
    return { gross: round2(gross), discount: round2(discount), net: round2(net), tax: round2(afterDiscount - net), total: round2(afterDiscount) };
  }
  const tax = afterDiscount * rate;
  return { gross: round2(gross), discount: round2(discount), net: round2(afterDiscount), tax: round2(tax), total: round2(afterDiscount + tax) };
}

export function computeDocument(lines: TaxLineInput[], inclusive: boolean): { lines: TaxLineResult[]; totals: TaxTotals } {
  const results = lines.map((l) => computeLine(l, inclusive));
  const totals = results.reduce<TaxTotals>((s, r) => ({
    subtotal: s.subtotal + r.net, discountTotal: s.discountTotal + r.discount, taxTotal: s.taxTotal + r.tax, total: s.total + r.total,
  }), { subtotal: 0, discountTotal: 0, taxTotal: 0, total: 0 });
  return { lines: results, totals: { subtotal: round2(totals.subtotal), discountTotal: round2(totals.discountTotal), taxTotal: round2(totals.taxTotal), total: round2(totals.total) } };
}
