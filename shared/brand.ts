/**
 * Product brand. Change the product name, tagline or palette here — server
 * (API docs, PDFs, AI prompts, notifications) and web read from this module.
 * Technical identifiers (cookie names, header names, storage keys) are kept
 * stable separately so renaming the product never breaks sessions or integrations.
 */
export const BRAND = {
  name: 'Maal Help',
  shortName: 'Maal Help',
  tagline: 'Your Warehouse. Under Control.',
  description: 'Warehouse, inventory and trading operations for SMEs — with an AI Copilot that answers from your own data.',
  /** Hex values mirror the Tailwind theme tokens in web/src/styles.css. */
  colors: {
    primary: '#1f37b0', // brand-700 · Maal Blue
    primaryDark: '#1e2e6f', // brand-900
    primaryLight: '#3b63f0', // brand-500
    accent: '#f59e0b', // accent-500 · Crate Amber
    accentDark: '#b45309', // accent-700
    ink: '#0f172a',
    muted: '#64748b',
    surface: '#f8fafc',
    success: '#059669',
    warning: '#d97706',
    danger: '#dc2626',
  },
  /** Categorical palette for charts (colour-blind friendly order). */
  chart: ['#2647d8', '#f59e0b', '#0ea5e9', '#8b5cf6', '#10b981', '#ef4444', '#64748b'],
} as const;

export type Brand = typeof BRAND;
