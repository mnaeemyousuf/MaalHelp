// One-off rebrand (Stockpilot → Maal Help). Exact-match replacements so nothing unrelated changes.
// Kept in the repo as a record of what was changed; safe to re-run (already-applied edits are reported as skipped).
import { readFileSync, writeFileSync } from 'node:fs';

const edits = {
  'web/index.html': [
    ['content="#0f766e"', 'content="#1f37b0"'],
    ['content="Stockpilot — warehouse, inventory and trading operations for SMEs."', 'content="Maal Help — Your Warehouse. Under Control. Warehouse, inventory and trading operations for SMEs."'],
    ['<link rel="icon" href="/favicon.svg" type="image/svg+xml" />', '<link rel="icon" href="/favicon.svg" type="image/svg+xml" />\n    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />\n    <meta name="application-name" content="Maal Help" />\n    <meta property="og:title" content="Maal Help — Your Warehouse. Under Control." />\n    <meta property="og:image" content="/brand/logo.png" />'],
    ['<title>Stockpilot · Warehouse OS</title>', '<title>Maal Help · Your Warehouse. Under Control.</title>'],
  ],
  'web/vite.config.ts': [
    ["name: 'Stockpilot Warehouse OS',", "name: 'Maal Help — Your Warehouse. Under Control.',"],
    ["short_name: 'Stockpilot',", "short_name: 'Maal Help',"],
    ["theme_color: '#0f766e',", "theme_color: '#1f37b0',"],
    ["includeAssets: ['favicon.svg'],", "includeAssets: ['favicon.svg', 'apple-touch-icon.png', 'brand/*.svg', 'brand/*.png'],"],
    ["{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' },", "{ src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },\n          { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' },"],
  ],
  'web/src/components/layout/AppShell.tsx': [
    ['<Link to="/" onClick={onNavigate} className="flex items-center gap-2.5 px-5 pb-4 pt-5">\n        <img src="/favicon.svg" alt="" className="size-8" />\n        <div><div className="text-[15px] font-bold tracking-tight text-ink-900">Stockpilot</div><div className="-mt-0.5 text-[10px] font-medium uppercase tracking-widest text-ink-400">Warehouse OS</div></div>\n      </Link>',
      '<Link to="/" onClick={onNavigate} className="flex items-center px-5 pb-4 pt-5" aria-label="Maal Help home">\n        <BrandLogo />\n      </Link>'],
    ["import { NAV, PLATFORM_NAV } from './nav';", "import { NAV, PLATFORM_NAV } from './nav';\nimport { BrandLogo } from '@/components/Brand';"],
    ['from-brand-700 to-teal-600', 'from-brand-700 to-brand-500'],
    ["'bg-amber-500 text-white' : issues ? 'bg-red-600 text-white' : 'bg-sky-600 text-white'", "'bg-accent-500 text-ink-900' : issues ? 'bg-red-600 text-white' : 'bg-brand-700 text-white'"],
  ],
  'web/src/pages/Auth.tsx': [
    ['bg-gradient-to-br from-brand-900 via-brand-800 to-teal-700', 'bg-gradient-to-br from-brand-950 via-brand-900 to-brand-700'],
    ['<div className="flex items-center gap-2.5"><img src="/favicon.svg" className="size-9" alt="" /><span className="text-lg font-bold">Stockpilot</span></div>', '<BrandLogo tone="dark" size="lg" />'],
    ['<span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/10">', '<span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent-500/20 text-accent-300">'],
    ['<div className="lg:hidden flex items-center gap-2"><img src="/favicon.svg" className="size-8" alt="" /><span className="font-bold">Stockpilot</span></div>', '<div className="lg:hidden"><BrandLogo /></div>'],
    ["import { Button, Field, Input, Select } from '@/components/ui/core';", "import { Button, Field, Input, Select } from '@/components/ui/core';\nimport { BrandLogo } from '@/components/Brand';"],
    ['<p className="mt-1 text-sm text-ink-500">Welcome back. Sign in to your company workspace.</p>', '<p className="mt-1 text-sm text-ink-500">Welcome back to Maal Help. Sign in to your company workspace.</p>'],
    ['<p className="text-xs text-brand-200">Built for Pakistan & South Asia · PKR, USD, AED, SAR, GBP, EUR</p>', '<p className="text-xs text-brand-200">Built for Pakistan & South Asia · PKR, USD, AED, SAR, GBP, EUR</p>'],
    ['New to Stockpilot?', 'New to Maal Help?'],
  ],
  'web/src/pages/Dashboard.tsx': [
    ["available: '#0d9488',", "available: '#2647d8',"],
    ['<stop offset="0%" stopColor="#0d9488" stopOpacity={0.35} /><stop offset="100%" stopColor="#0d9488" stopOpacity={0} />', '<stop offset="0%" stopColor="#2647d8" stopOpacity={0.3} /><stop offset="100%" stopColor="#2647d8" stopOpacity={0} />'],
    ['<stop offset="0%" stopColor="#6366f1" stopOpacity={0.3} /><stop offset="100%" stopColor="#6366f1" stopOpacity={0} />', '<stop offset="0%" stopColor="#f59e0b" stopOpacity={0.3} /><stop offset="100%" stopColor="#f59e0b" stopOpacity={0} />'],
    ['name="Received" stroke="#0d9488"', 'name="Received" stroke="#2647d8"'],
    ['name="Dispatched" stroke="#6366f1"', 'name="Dispatched" stroke="#d97706"'],
    ['<Bar dataKey="sales" name="Sales" fill="#0d9488"', '<Bar dataKey="sales" name="Sales" fill="#2647d8"'],
    ['from-brand-50 via-white to-teal-50', 'from-brand-50 via-white to-accent-50'],
  ],
  'web/src/pages/Finance.tsx': [['<Bar dataKey="amount" fill="#0d9488"', '<Bar dataKey="amount" fill="#2647d8"']],
  'web/src/pages/Ai.tsx': [['bg-gradient-to-br from-brand-600 to-teal-500', 'bg-gradient-to-br from-brand-700 to-brand-500']],
  'web/src/pages/Settings.tsx': [['Welcome to Stockpilot,', 'Welcome to Maal Help,']],
  'server/src/modules/reports/export.ts': [
    ["wb.creator = 'Stockpilot';", 'wb.creator = BRAND.name;'],
    ["fgColor: { argb: 'FF0F766E' }", "fgColor: { argb: 'FF1F37B0' }"],
    ["info: { Title: title, Author: 'Stockpilot' }", 'info: { Title: title, Author: BRAND.name, Creator: BRAND.name }'],
    ["doc.fillColor('#0F766E')", 'doc.fillColor(BRAND.colors.primary)'],
    ["doc.rect(left, y, width, 18).fill('#F3F4F6');", "doc.rect(left, y, width, 18).fill('#EEF3FF');"],
    ['`Generated by Stockpilot · ${', '`Generated by ${BRAND.name} · ${'],
    ["import PDFDocument from 'pdfkit';", "import PDFDocument from 'pdfkit';\nimport { BRAND } from '@shared/brand';"],
  ],
  'server/src/modules/reports/routes.ts': [["tenant?.name ?? 'Stockpilot'", 'tenant?.name ?? BRAND.name'], ["import { toCsv, toPdf, toXlsx } from './export';", "import { toCsv, toPdf, toXlsx } from './export';\nimport { BRAND } from '@shared/brand';"]],
  'server/src/modules/integrations/routes.ts': [["message: 'Stockpilot webhook test'", "message: 'Maal Help webhook test'"]],
  'server/src/modules/integrations/events.ts': [["'user-agent': 'Stockpilot-Webhooks/1.0'", "'user-agent': 'MaalHelp-Webhooks/1.0'"]],
  'server/src/index.ts': [['`Stockpilot API ready on', '`Maal Help API ready on'], ["'Failed to start Stockpilot:'", "'Failed to start Maal Help:'"]],
  'server/src/core/openapi.ts': [["title: 'Stockpilot Warehouse OS API',", "title: 'Maal Help API',"], ["description: 'REST API. All", "description: 'Maal Help — Your Warehouse. Under Control. REST API. All"]],
  'server/src/core/context.ts': [["userEmail: 'system@stockpilot',", "userEmail: 'system@maalhelp',"], ["userName: 'Stockpilot system',", "userName: 'Maal Help system',"]],
  'server/src/config/env.ts': [["EMAIL_FROM: str('Stockpilot <no-reply@stockpilot.local>'),", "EMAIL_FROM: str('Maal Help <no-reply@maalhelp.local>'),"]],
  'server/src/ai/copilot.ts': [['You are Stockpilot Copilot, an assistant for warehouse owners and teams.', 'You are the Maal Help Copilot ("Your Warehouse. Under Control."), an assistant for warehouse owners and teams.']],
  '.env.example': [['# Stockpilot environment configuration.', '# Maal Help environment configuration.'], ['EMAIL_FROM=Stockpilot <no-reply@stockpilot.local>', 'EMAIL_FROM=Maal Help <no-reply@maalhelp.local>']],
  'package.json': [['"name": "stockpilot",', '"name": "maal-help",'], ['"description": "Stockpilot — AI-powered', '"description": "Maal Help — Your Warehouse. Under Control. AI-powered']],
};

let applied = 0, skipped = 0;
for (const [file, list] of Object.entries(edits)) {
  let s = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  for (const [from, to] of list) {
    if (s.includes(from)) { s = s.split(from).join(to); applied++; }
    else { console.log(`skip (not found / already applied) ${file}: ${from.slice(0, 60)}`); skipped++; }
  }
  writeFileSync(file, s);
}
console.log(`${applied} replacements applied, ${skipped} skipped`);
