// Generates docs/ROLE_PERMISSION_MATRIX.md from the permission catalogue the server enforces.
// Usage: npx tsx scripts/gen-role-matrix.ts
import { writeFileSync } from 'node:fs';
import { PERMISSIONS, SYSTEM_ROLES, type Permission } from '../shared/permissions';
import { BRAND } from '../shared/brand';

const short: Record<string, string> = {
  owner: 'Owner', warehouse_manager: 'WH Mgr', inventory_controller: 'Inv Ctrl', operator: 'Operator', receiving_clerk: 'Receiving',
  picker_packer: 'Pick/Pack', dispatch_officer: 'Dispatch', sales: 'Sales', purchase: 'Purchase', accountant: 'Accountant', auditor: 'Auditor',
};
const perms = Object.keys(PERMISSIONS) as Permission[];
const lines: string[] = [];
lines.push(`# ${BRAND.name} — Role & Permission Matrix`, '');
lines.push(`> Generated from \`shared/permissions.ts\` (the catalogue the API enforces on every route) by \`npx tsx scripts/gen-role-matrix.ts\`. Do not edit by hand.`, '');
lines.push('Permissions are checked **on the server** for every request; the web menu only hides what a role cannot use. Business Owners can create custom roles in **Settings → Roles** from the same catalogue. The SaaS **Super Admin** is a platform account outside any company: it sees tenants, plans, feature flags, health, AI usage and support tickets, and has **no access** to a company\'s operational data (verified by an automated test).', '');
lines.push('## Roles', '', '| Role | Key | Purpose | Permissions |', '|---|---|---|---|');
for (const r of SYSTEM_ROLES) lines.push(`| ${r.name} | \`${r.key}\` | ${r.description} | ${r.permissions.length} |`);
lines.push('| SaaS Super Admin | platform admin | Tenants, plans, flags, health, AI usage, support. No tenant data. | platform only |', '');
lines.push('## Matrix', '', `| Permission | Meaning | ${SYSTEM_ROLES.map((r) => short[r.key]).join(' | ')} |`, `|---|---|${SYSTEM_ROLES.map(() => ':-:').join('|')}|`);
for (const p of perms) lines.push(`| \`${p}\` | ${PERMISSIONS[p]} | ${SYSTEM_ROLES.map((r) => (r.permissions.includes(p) ? '✔' : '·')).join(' | ')} |`);
lines.push('', '## Important rules enforced in code', '',
  '- **Financial visibility:** without `finance.view`, cost price, inventory value, margins and receivables are removed from API responses (not just hidden in the UI). The AI Copilot applies the same redaction to its tools.',
  '- **Approvals:** a requester cannot approve their own request (Business Owner excepted). Thresholds are configured in Settings → Approval rules.',
  '- **Posted stock is immutable:** the inventory ledger and audit log reject UPDATE/DELETE at database level; corrections are new, reversing transactions.',
  '- **AI is read-only:** Copilot tools only read data within the caller\'s permissions; suggested purchase orders open as drafts that a user with `purchase.manage` must save.',
  '- **Tenant isolation:** every query is scoped to the signed-in company; IDs from another company return 404.', '');
writeFileSync('docs/ROLE_PERMISSION_MATRIX.md', lines.join('\n'));
console.log('wrote docs/ROLE_PERMISSION_MATRIX.md');
