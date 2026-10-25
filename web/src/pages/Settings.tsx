import { useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle2, Copy, Download, KeyRound, Plug, Plus, Trash2, Upload, Webhook } from 'lucide-react';
import { APPROVAL_ENTITY_TYPES, CURRENCIES, IMPORT_ENTITIES } from '@shared/domain';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn, dateTime, humanize, money, qty } from '@/lib/utils';
import { Badge, Button, Card, CardHeader, Checkbox, EmptyState, Field, Input, Progress, Select, Skeleton, StatusBadge, Textarea } from '@/components/ui/core';
import { ConfirmDialog, Dialog } from '@/components/ui/overlay';
import { PageHeader, Section } from '@/components/ui/blocks';
import { Table } from '@/components/ui/table';

const SECTIONS: { to: string; label: string; perm?: string[] }[] = [
  { to: 'profile', label: 'My profile' },
  { to: 'company', label: 'Company', perm: ['settings.manage'] },
  { to: 'users', label: 'Users', perm: ['user.manage'] },
  { to: 'roles', label: 'Roles & permissions', perm: ['user.manage'] },
  { to: 'tax', label: 'Tax & currency', perm: ['settings.manage'] },
  { to: 'approvals', label: 'Approval rules', perm: ['settings.manage'] },
  { to: 'preferences', label: 'Inventory, notifications & AI', perm: ['settings.manage'] },
  { to: 'barcode', label: 'Barcode, printing & billing', perm: ['settings.manage'] },
  { to: 'import', label: 'Import data', perm: ['import.execute'] },
  { to: 'integrations', label: 'Integrations', perm: ['integration.manage'] },
  { to: 'webhooks', label: 'Webhooks & API', perm: ['integration.manage'] },
  { to: 'plan', label: 'Plan & usage' },
];

export function Settings() {
  const { can } = useAuth();
  const visible = SECTIONS.filter((s) => !s.perm || can(...(s.perm as never[])));
  return (
    <div>
      <PageHeader title="Settings" />
      <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
        <nav className="flex gap-1 overflow-x-auto lg:flex-col">{visible.map((s) => <NavLink key={s.to} to={s.to} className={({ isActive }) => cn('whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium', isActive ? 'bg-brand-50 text-brand-800' : 'text-ink-600 hover:bg-ink-100')}>{s.label}</NavLink>)}</nav>
        <div className="min-w-0">
          <Routes>
            <Route index element={<Navigate to={can('settings.manage') ? 'company' : 'profile'} replace />} />
            <Route path="profile" element={<Profile />} />
            <Route path="onboarding" element={<Onboarding />} />
            <Route path="company" element={<Company />} />
            <Route path="users" element={<Users />} />
            <Route path="roles" element={<Roles />} />
            <Route path="tax" element={<Tax />} />
            <Route path="approvals" element={<ApprovalRules />} />
            <Route path="preferences" element={<Preferences />} />
            <Route path="barcode" element={<BarcodePrinting />} />
            <Route path="import" element={<ImportData />} />
            <Route path="integrations" element={<Integrations />} />
            <Route path="webhooks" element={<Webhooks />} />
            <Route path="plan" element={<Plan />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}

function useCompany() {
  return useQuery({ queryKey: ['company'], queryFn: () => api.get<any>('/company') });
}

function Profile() {
  const { me } = useAuth();
  const [f, setF] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const m = useMutation({ mutationFn: () => api.post('/auth/change-password', { currentPassword: f.currentPassword, newPassword: f.newPassword }), onSuccess: () => { toast.success('Password changed'); setF({ currentPassword: '', newPassword: '', confirm: '' }); } });
  return (
    <Card className="p-6">
      <Section title="Your account" description="Signed in identity and role."><div className="space-y-1 text-sm"><div><b>{me?.user.name}</b></div><div className="text-ink-600">{me?.user.email}</div><div><Badge tone="teal">{me?.role.name}</Badge> <span className="text-ink-500">at {me?.tenant?.name}</span></div></div></Section>
      <Section title="Change password" description="At least 10 characters with letters and numbers.">
        <div className="grid max-w-md gap-3">
          <Field label="Current password"><Input type="password" value={f.currentPassword} onChange={(e) => setF({ ...f, currentPassword: e.target.value })} autoComplete="current-password" /></Field>
          <Field label="New password"><Input type="password" value={f.newPassword} onChange={(e) => setF({ ...f, newPassword: e.target.value })} autoComplete="new-password" /></Field>
          <Field label="Confirm new password" error={f.confirm && f.confirm !== f.newPassword ? 'Passwords do not match' : undefined}><Input type="password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} /></Field>
          <Button variant="primary" className="w-fit" loading={m.isPending} disabled={!f.currentPassword || f.newPassword.length < 10 || f.newPassword !== f.confirm} onClick={() => m.mutate()}><KeyRound /> Change password</Button>
        </div>
      </Section>
    </Card>
  );
}

function Onboarding() {
  const { me, can } = useAuth();
  const steps = [
    { done: !me?.onboarding.needsWarehouse, label: 'Create your first warehouse', to: '/warehouses', hint: 'Docks for receiving and dispatch are added automatically.' },
    { done: false, label: 'Generate zones, racks and bins', to: '/warehouses', hint: 'Open the warehouse and use “Generate zone layout”.' },
    { done: false, label: 'Add products (or import from Excel)', to: '/settings/import?entity=products', hint: 'SKUs, barcodes, units, dimensions and reorder levels.' },
    { done: false, label: 'Add suppliers and customers', to: '/suppliers', hint: 'Import them too if you have a list.' },
    { done: false, label: 'Invite your team', to: '/settings/users', hint: 'Give each person the role that matches their job.' },
    { done: false, label: 'Load opening stock', to: '/settings/import?entity=opening_inventory', hint: 'Or receive goods against a purchase order.' },
  ];
  return (
    <Card className="p-6">
      <h2 className="text-lg font-semibold">Welcome to Maal Help, {me?.user.name.split(' ')[0]}!</h2>
      <p className="mt-1 text-sm text-ink-600">Six steps to a working warehouse. You can do them in any order.</p>
      <ol className="mt-5 space-y-2">{steps.map((s, i) => <li key={i}><Link to={s.to} className="flex items-start gap-3 rounded-xl border border-ink-200 p-3 hover:border-brand-300"><span className={cn('grid size-6 shrink-0 place-items-center rounded-full text-xs font-bold', s.done ? 'bg-emerald-500 text-white' : 'bg-ink-100 text-ink-600')}>{s.done ? <CheckCircle2 className="size-4" /> : i + 1}</span><div><div className="text-sm font-medium">{s.label}</div><div className="text-xs text-ink-500">{s.hint}</div></div></Link></li>)}</ol>
      {can('dashboard.view') && <Link to="/"><Button variant="primary" className="mt-5">Go to dashboard</Button></Link>}
    </Card>
  );
}

function Company() {
  const qc = useQueryClient();
  const { data } = useCompany();
  const [f, setF] = useState<any>(null);
  useEffect(() => { if (data && !f) setF({ name: data.name, legalName: data.legalName, email: data.email, phone: data.phone, address: data.address, city: data.city, country: data.country, ntn: data.ntn, strn: data.strn, baseCurrency: data.baseCurrency, timezone: data.timezone, taxInclusivePricing: data.taxInclusivePricing }); }, [data, f]);
  const m = useMutation({ mutationFn: () => api.patch('/company', f), onSuccess: () => { toast.success('Company profile saved'); qc.invalidateQueries(); } });
  if (!f) return <Skeleton className="h-96" />;
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Card className="p-6">
      <Section title="Company profile" description="Printed on invoices, GRNs and purchase orders.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Trading name"><Input value={f.name} onChange={set('name')} /></Field>
          <Field label="Legal name"><Input value={f.legalName} onChange={set('legalName')} /></Field>
          <Field label="Email"><Input value={f.email} onChange={set('email')} /></Field>
          <Field label="Phone"><Input value={f.phone} onChange={set('phone')} /></Field>
          <Field label="Address" className="sm:col-span-2"><Input value={f.address} onChange={set('address')} /></Field>
          <Field label="City"><Select value={f.city} onChange={set('city')}>{[f.city, ...(data.localization?.cities ?? [])].filter((v, i, a) => v && a.indexOf(v) === i).map((c: string) => <option key={c}>{c}</option>)}</Select></Field>
          <Field label="Country"><Input value={f.country} onChange={set('country')} maxLength={2} /></Field>
        </div>
      </Section>
      <Section title="Tax registration" description="Pakistan: NTN and STRN (sales tax registration).">
        <div className="grid gap-4 sm:grid-cols-2"><Field label="NTN" hint="Example 1234567-8"><Input value={f.ntn} onChange={set('ntn')} /></Field><Field label="STRN"><Input value={f.strn} onChange={set('strn')} /></Field></div>
      </Section>
      <Section title="Currency & pricing">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Base currency"><Select value={f.baseCurrency} onChange={set('baseCurrency')}>{Object.entries(CURRENCIES).map(([k, v]) => <option key={k} value={k}>{k} · {v.name}</option>)}</Select></Field>
          <Field label="Time zone"><Input value={f.timezone} onChange={set('timezone')} /></Field>
          <div className="sm:col-span-2"><Checkbox label="Prices include tax (tax-inclusive pricing)" hint="When on, tax is calculated out of entered prices instead of added on top." checked={f.taxInclusivePricing} onChange={(v) => setF({ ...f, taxInclusivePricing: v })} /></div>
        </div>
      </Section>
      <div className="flex justify-end"><Button variant="primary" loading={m.isPending} onClick={() => m.mutate()}>Save changes</Button></div>
    </Card>
  );
}

function Users() {
  const qc = useQueryClient();
  const { me } = useAuth();
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<any[]>('/users') });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<any[]>('/roles') });
  const [add, setAdd] = useState(false);
  const [edit, setEdit] = useState<any>(null);
  const [temp, setTemp] = useState<{ email: string; password: string } | null>(null);
  const reset = useMutation({ mutationFn: (u: any) => api.post<any>(`/users/${u.id}/reset-password`).then((r) => ({ ...r, email: u.email })), onSuccess: (r) => setTemp({ email: r.email, password: r.temporaryPassword }) });
  return (
    <Card>
      <CardHeader title="Users" description="Each person gets a role. Floor roles see the simplified mobile task app." actions={<Button variant="primary" size="sm" onClick={() => setAdd(true)}><Plus /> Add user</Button>} />
      <Table rows={users.data} loading={users.isLoading} columns={[
        { key: 'n', header: 'Name', cell: (u: any) => <div><div className="font-medium">{u.name}</div><div className="text-xs text-ink-500">{u.email}</div></div> },
        { key: 'r', header: 'Role', cell: (u: any) => <div className="flex flex-wrap gap-1"><Badge tone="teal">{u.roleName}</Badge>{u.extraPermissions.map((p: string) => <Badge key={p}>+{p}</Badge>)}</div> },
        { key: 's', header: 'Status', cell: (u: any) => <StatusBadge status={u.status} /> },
        { key: 'l', header: 'Last sign-in', hideOnMobile: true, cell: (u: any) => dateTime(u.lastLoginAt) },
        { key: 'a', header: '', align: 'right', cell: (u: any) => u.id !== me?.user.id && <div className="flex justify-end gap-1"><Button size="sm" variant="ghost" onClick={() => setEdit(u)}>Edit</Button><Button size="sm" variant="ghost" onClick={() => reset.mutate(u)}>Reset password</Button></div> },
      ]} />
      {add && <UserDialog roles={roles.data ?? []} onClose={() => setAdd(false)} onDone={(r) => { if (r.temporaryPassword) setTemp({ email: r.email, password: r.temporaryPassword }); qc.invalidateQueries({ queryKey: ['users'] }); }} />}
      {edit && <UserDialog roles={roles.data ?? []} user={edit} onClose={() => setEdit(null)} onDone={() => qc.invalidateQueries({ queryKey: ['users'] })} />}
      {temp && <Dialog open onOpenChange={() => setTemp(null)} title="Temporary password" description={`Share this securely with ${temp.email}. It is shown only once; ask them to change it after signing in.`}><div className="flex items-center gap-2"><code className="flex-1 rounded-lg bg-ink-100 px-3 py-2 font-mono">{temp.password}</code><Button size="icon" onClick={() => { void navigator.clipboard.writeText(temp.password); toast.success('Copied'); }} aria-label="Copy"><Copy /></Button></div></Dialog>}
    </Card>
  );
}

function UserDialog({ roles, user, onClose, onDone }: { roles: any[]; user?: any; onClose: () => void; onDone: (r: any) => void }) {
  const [f, setF] = useState({ name: user?.name ?? '', email: user?.email ?? '', phone: user?.phone ?? '', roleId: user?.roleId ?? roles.find((r) => r.key === 'operator')?.id ?? '', status: user?.status ?? 'active', financeAccess: user?.extraPermissions?.includes('finance.view') ?? false });
  const m = useMutation({
    mutationFn: () => user ? api.patch(`/users/${user.id}`, { roleId: f.roleId, status: f.status, name: f.name, extraPermissions: f.financeAccess ? ['finance.view'] : [] }) : api.post<any>('/users', { name: f.name, email: f.email, phone: f.phone, roleId: f.roleId, extraPermissions: f.financeAccess ? ['finance.view'] : [] }),
    onSuccess: (r) => { toast.success(user ? 'User updated' : 'User added'); onDone(r ?? {}); onClose(); },
  });
  const role = roles.find((r) => r.id === f.roleId);
  return (
    <Dialog open onOpenChange={onClose} title={user ? `Edit ${user.name}` : 'Add user'} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={!f.name || !f.email || !f.roleId} onClick={() => m.mutate()}>Save</Button></>}>
      <div className="grid gap-4">
        <Field label="Full name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        {!user && <Field label="Email (sign-in)"><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>}
        {!user && <Field label="Mobile"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>}
        <Field label="Role" hint={role?.description}><Select value={f.roleId} onChange={(e) => setF({ ...f, roleId: e.target.value })}>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select></Field>
        {role && !role.permissions.includes('finance.view') && <Checkbox label="Also allow financial figures (cost, value, margin)" hint="Grants finance.view on top of the role." checked={f.financeAccess} onChange={(v) => setF({ ...f, financeAccess: v })} />}
        {user && <Field label="Status"><Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="active">Active</option><option value="disabled">Disabled (signs the user out)</option></Select></Field>}
        {!user && <p className="text-xs text-ink-500">A temporary password is generated and shown once after saving.</p>}
      </div>
    </Dialog>
  );
}

function Roles() {
  const qc = useQueryClient();
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<any[]>('/roles') });
  const perms = useQuery({ queryKey: ['permissions'], queryFn: () => api.get<any[]>('/roles/permissions') });
  const [edit, setEdit] = useState<any>(null);
  const groups = [...new Set((perms.data ?? []).map((p) => p.group))];
  const save = useMutation({ mutationFn: () => edit.id ? api.patch(`/roles/${edit.id}`, { name: edit.name, description: edit.description, permissions: edit.permissions }) : api.post('/roles', { name: edit.name, description: edit.description, permissions: edit.permissions }), onSuccess: () => { toast.success('Role saved'); setEdit(null); qc.invalidateQueries({ queryKey: ['roles'] }); } });
  return (
    <Card>
      <CardHeader title="Roles & permissions" description="Permissions are enforced by the server on every request — hiding a menu is never the only control." actions={<Button size="sm" variant="primary" onClick={() => setEdit({ name: '', description: '', permissions: [] })}><Plus /> Custom role</Button>} />
      <Table rows={roles.data} loading={roles.isLoading} onRowClick={(r) => r.key !== 'owner' && setEdit({ ...r })} columns={[
        { key: 'n', header: 'Role', cell: (r: any) => <div><div className="font-medium">{r.name}{!r.isSystem && <Badge tone="violet" className="ml-1">Custom</Badge>}</div><div className="text-xs text-ink-500">{r.description}</div></div> },
        { key: 'p', header: 'Permissions', align: 'right', cell: (r: any) => r.permissions.length }, { key: 'm', header: 'Users', align: 'right', cell: (r: any) => r.members },
      ]} />
      {edit && <Dialog open onOpenChange={() => setEdit(null)} title={edit.id ? `Edit ${edit.name}` : 'New custom role'} size="xl" footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={!edit.name || !edit.permissions.length} onClick={() => save.mutate()}>Save role</Button></>}>
        <div className="mb-4 grid gap-4 sm:grid-cols-2"><Field label="Name"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field><Field label="Description"><Input value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field></div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{groups.map((g) => (
          <div key={g} className="rounded-xl border border-ink-200 p-3"><div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">{humanize(g)}</div>
            <div className="space-y-2">{perms.data!.filter((p) => p.group === g).map((p) => <Checkbox key={p.key} label={p.key} hint={p.description} checked={edit.permissions.includes(p.key)} onChange={(v) => setEdit({ ...edit, permissions: v ? [...edit.permissions, p.key] : edit.permissions.filter((x: string) => x !== p.key) })} />)}</div>
          </div>
        ))}</div>
      </Dialog>}
    </Card>
  );
}

function Tax() {
  const qc = useQueryClient();
  const taxes = useQuery({ queryKey: ['tax-rates'], queryFn: () => api.get<any[]>('/tax-rates') });
  const [edit, setEdit] = useState<any>(null);
  const save = useMutation({ mutationFn: () => { const { id, tenantId: _t, createdAt: _c, ...body } = edit; return id ? api.patch(`/tax-rates/${id}`, body) : api.post('/tax-rates', body); }, onSuccess: () => { toast.success('Tax rate saved'); setEdit(null); qc.invalidateQueries({ queryKey: ['tax-rates'] }); } });
  return (
    <Card>
      <CardHeader title="Tax rates" description="The tax engine applies these to purchase and sales documents. Pakistan presets were added when your company was created." actions={<Button size="sm" variant="primary" onClick={() => setEdit({ code: '', name: '', rate: 0, type: 'sales_tax', appliesTo: 'both', isDefault: false, active: true })}><Plus /> Add rate</Button>} />
      <Table rows={taxes.data} loading={taxes.isLoading} onRowClick={(r) => setEdit({ ...r })} columns={[
        { key: 'c', header: 'Code', cell: (t: any) => <b>{t.code}</b> }, { key: 'n', header: 'Name', cell: (t: any) => t.name }, { key: 'r', header: 'Rate', align: 'right', cell: (t: any) => `${t.rate}%` },
        { key: 't', header: 'Type', cell: (t: any) => humanize(t.type) }, { key: 'a', header: 'Applies to', cell: (t: any) => humanize(t.appliesTo) },
        { key: 'd', header: '', cell: (t: any) => <div className="flex gap-1">{t.isDefault && <Badge tone="teal">Default</Badge>}{!t.active && <Badge>Inactive</Badge>}</div> },
      ]} />
      {edit && <Dialog open onOpenChange={() => setEdit(null)} title={edit.id ? 'Edit tax rate' : 'New tax rate'} footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Code"><Input value={edit.code} onChange={(e) => setEdit({ ...edit, code: e.target.value.toUpperCase() })} /></Field>
          <Field label="Name"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
          <Field label="Rate %"><Input type="number" step="any" value={edit.rate} onChange={(e) => setEdit({ ...edit, rate: Number(e.target.value) })} /></Field>
          <Field label="Type"><Select value={edit.type} onChange={(e) => setEdit({ ...edit, type: e.target.value })}>{['sales_tax', 'gst', 'vat', 'withholding', 'none'].map((x) => <option key={x} value={x}>{humanize(x)}</option>)}</Select></Field>
          <Field label="Applies to"><Select value={edit.appliesTo} onChange={(e) => setEdit({ ...edit, appliesTo: e.target.value })}>{['both', 'sales', 'purchase'].map((x) => <option key={x} value={x}>{humanize(x)}</option>)}</Select></Field>
          <div className="space-y-2 pt-6"><Checkbox label="Default rate" checked={edit.isDefault} onChange={(v) => setEdit({ ...edit, isDefault: v })} /><Checkbox label="Active" checked={edit.active} onChange={(v) => setEdit({ ...edit, active: v })} /></div>
        </div>
      </Dialog>}
    </Card>
  );
}

function ApprovalRules() {
  const qc = useQueryClient();
  const rules = useQuery({ queryKey: ['approval-rules'], queryFn: () => api.get<any[]>('/approval-rules') });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<any[]>('/roles') });
  const [edit, setEdit] = useState<any>(null);
  const [del, setDel] = useState<any>(null);
  const save = useMutation({ mutationFn: () => { const body = { entityType: edit.entityType, threshold: Number(edit.threshold), approverRoleKey: edit.approverRoleKey, description: edit.description, active: edit.active !== 'false' && edit.active !== false }; return edit.id ? api.patch(`/approval-rules/${edit.id}`, body) : api.post('/approval-rules', body); }, onSuccess: () => { toast.success('Rule saved'); setEdit(null); qc.invalidateQueries({ queryKey: ['approval-rules'] }); } });
  return (
    <Card>
      <CardHeader title="Approval rules" description="Transactions above a threshold wait for the approver role. The strictest matching rule applies." actions={<Button size="sm" variant="primary" onClick={() => setEdit({ entityType: 'stock_adjustment', threshold: 100000, approverRoleKey: 'warehouse_manager', description: '', active: true })}><Plus /> Add rule</Button>} />
      <Table rows={rules.data} loading={rules.isLoading} onRowClick={(r) => setEdit({ ...r })} columns={[
        { key: 'e', header: 'Applies to', cell: (r: any) => humanize(r.entityType) }, { key: 't', header: 'Above', align: 'right', cell: (r: any) => money(r.threshold) },
        { key: 'a', header: 'Approver', cell: (r: any) => humanize(r.approverRoleKey) }, { key: 'd', header: 'Description', hideOnMobile: true, cell: (r: any) => r.description },
        { key: 's', header: 'Status', cell: (r: any) => <StatusBadge status={r.active === 'true' ? 'active' : 'inactive'} /> },
        { key: 'x', header: '', align: 'right', cell: (r: any) => <Button size="icon" variant="ghost" onClick={(e) => { e.stopPropagation(); setDel(r); }} aria-label="Delete"><Trash2 /></Button> },
      ]} />
      {edit && <Dialog open onOpenChange={() => setEdit(null)} title="Approval rule" footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Applies to"><Select value={edit.entityType} onChange={(e) => setEdit({ ...edit, entityType: e.target.value })}>{APPROVAL_ENTITY_TYPES.filter((x) => x !== 'transfer').map((x) => <option key={x} value={x}>{humanize(x)}</option>)}</Select></Field>
          <Field label="Value threshold"><Input type="number" min={0} value={edit.threshold} onChange={(e) => setEdit({ ...edit, threshold: e.target.value })} /></Field>
          <Field label="Approver role"><Select value={edit.approverRoleKey} onChange={(e) => setEdit({ ...edit, approverRoleKey: e.target.value })}>{roles.data?.filter((r) => r.permissions.includes('approval.decide')).map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}</Select></Field>
          <Field label="Description"><Input value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
        </div>
      </Dialog>}
      <ConfirmDialog open={!!del} onOpenChange={() => setDel(null)} title="Delete this rule?" tone="danger" confirmLabel="Delete" onConfirm={async () => { await api.del(`/approval-rules/${del.id}`); qc.invalidateQueries({ queryKey: ['approval-rules'] }); }} />
    </Card>
  );
}

function useSettingsSection(section: string) {
  const qc = useQueryClient();
  const { data } = useCompany();
  return { value: data?.settings?.[section] ?? {}, save: useMutation({ mutationFn: (value: unknown) => api.put(`/company/settings/${section}`, { value }), onSuccess: () => { toast.success('Settings saved'); qc.invalidateQueries({ queryKey: ['company'] }); qc.invalidateQueries({ queryKey: ['me'] }); } }) };
}

function Preferences() {
  const inv = useSettingsSection('inventory');
  const notif = useSettingsSection('notifications');
  const ai = useSettingsSection('ai');
  const [i, setI] = useState<any>(null);
  const [n, setN] = useState<any>(null);
  const [a, setA] = useState<any>(null);
  const company = useCompany();
  useEffect(() => { if (company.data && !i) { setI(inv.value); setN({ ...notif.value, recipients: (notif.value.recipients ?? []).join(', ') }); setA(ai.value); } }, [company.data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!i || !n || !a) return <Skeleton className="h-96" />;
  return (
    <Card className="p-6">
      <Section title="Inventory" description="Negative stock is never allowed.">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Count variance tolerance %" hint="Above this a manager must approve"><Input type="number" min={0} value={i.defaultCountTolerancePct ?? 2} onChange={(e) => setI({ ...i, defaultCountTolerancePct: Number(e.target.value) })} /></Field>
          <Field label="Expiry warning (days)"><Input type="number" min={1} value={i.expiryAlertDays ?? 30} onChange={(e) => setI({ ...i, expiryAlertDays: Number(e.target.value) })} /></Field>
          <Field label="Dead stock after (days)"><Input type="number" min={15} value={i.deadStockDays ?? 90} onChange={(e) => setI({ ...i, deadStockDays: Number(e.target.value) })} /></Field>
        </div>
        <Button size="sm" variant="primary" className="mt-3" loading={inv.save.isPending} onClick={() => inv.save.mutate({ defaultCountTolerancePct: i.defaultCountTolerancePct, expiryAlertDays: i.expiryAlertDays, deadStockDays: i.deadStockDays })}>Save inventory settings</Button>
      </Section>
      <Section title="Notifications" description="In-app alerts are always on. Email and WhatsApp use the providers configured on the server.">
        <div className="space-y-2">
          <Checkbox label="Email critical and warning alerts" checked={!!n.email} onChange={(v) => setN({ ...n, email: v })} />
          <Checkbox label="WhatsApp critical and warning alerts" hint="Requires a WhatsApp Business provider on the server" checked={!!n.whatsapp} onChange={(v) => setN({ ...n, whatsapp: v })} />
          <Checkbox label="Mobile push notifications" checked={!!n.push} onChange={(v) => setN({ ...n, push: v })} />
          <Field label="Extra email recipients" hint="Comma separated"><Input value={n.recipients} onChange={(e) => setN({ ...n, recipients: e.target.value })} /></Field>
          <Button size="sm" variant="primary" loading={notif.save.isPending} onClick={() => notif.save.mutate({ email: n.email, whatsapp: n.whatsapp, push: n.push, dailyBriefing: n.dailyBriefing, recipients: n.recipients.split(',').map((x: string) => x.trim()).filter(Boolean) })}>Save notification settings</Button>
        </div>
      </Section>
      <Section title="AI" description="The Mistral API key is set on the server only (MISTRAL_API_KEY) and never sent to browsers.">
        <div className="space-y-2">
          <Checkbox label="Enable AI Copilot" checked={a.enabled !== false} onChange={(v) => setA({ ...a, enabled: v })} />
          <Checkbox label="Daily AI briefing" checked={a.dailyBriefing !== false} onChange={(v) => setA({ ...a, dailyBriefing: v })} />
          <Checkbox label="Anomaly detection" checked={a.anomalyDetection !== false} onChange={(v) => setA({ ...a, anomalyDetection: v })} />
          <Checkbox label="Document extraction" checked={a.documentExtraction !== false} onChange={(v) => setA({ ...a, documentExtraction: v })} />
          <Button size="sm" variant="primary" loading={ai.save.isPending} onClick={() => ai.save.mutate({ enabled: a.enabled !== false, dailyBriefing: a.dailyBriefing !== false, anomalyDetection: a.anomalyDetection !== false, documentExtraction: a.documentExtraction !== false })}>Save AI settings</Button>
        </div>
      </Section>
    </Card>
  );
}

function BarcodePrinting() {
  const bc = useSettingsSection('barcode');
  const pr = useSettingsSection('printing');
  const bl = useSettingsSection('billing');
  const units = useSettingsSection('units');
  const company = useCompany();
  const [b, setB] = useState<any>(null);
  const [p, setP] = useState<any>(null);
  const [l, setL] = useState<any>(null);
  const [u, setU] = useState('');
  useEffect(() => { if (company.data && !b) { setB(bc.value); setP(pr.value); setL(bl.value); setU((company.data.settings.units ?? []).join(', ')); } }, [company.data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!b || !p || !l) return <Skeleton className="h-96" />;
  return (
    <Card className="p-6">
      <Section title="Barcodes" description="Internal barcodes are EAN-13 in the 29x in-store range so they never clash with retail barcodes.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Default symbology for labels"><Select value={b.defaultSymbology ?? 'code128'} onChange={(e) => setB({ ...b, defaultSymbology: e.target.value })}><option value="code128">Code 128</option><option value="ean13">EAN-13</option><option value="qrcode">QR code</option></Select></Field>
          <Field label="Label size"><Select value={b.labelSize ?? '50x25'} onChange={(e) => setB({ ...b, labelSize: e.target.value })}><option value="50x25">50 × 25 mm</option><option value="100x50">100 × 50 mm</option><option value="100x150">100 × 150 mm (shipping)</option></Select></Field>
        </div>
        <Button size="sm" variant="primary" className="mt-3" onClick={() => bc.save.mutate({ defaultSymbology: b.defaultSymbology, labelSize: b.labelSize })}>Save</Button>
      </Section>
      <Section title="Printing">
        <div className="grid gap-4 sm:grid-cols-2"><Field label="Paper size"><Select value={p.paperSize ?? 'A4'} onChange={(e) => setP({ ...p, paperSize: e.target.value })}><option>A4</option><option>Letter</option></Select></Field></div>
        <Button size="sm" variant="primary" className="mt-3" onClick={() => pr.save.mutate({ paperSize: p.paperSize })}>Save</Button>
      </Section>
      <Section title="Billing defaults">
        <div className="grid gap-4 sm:grid-cols-2"><Field label="Default payment terms (days)"><Input type="number" value={l.paymentTermsDays ?? 30} onChange={(e) => setL({ ...l, paymentTermsDays: Number(e.target.value) })} /></Field><Field label="Storage billing day of month"><Input type="number" min={1} max={28} value={l.storageBillingDay ?? 1} onChange={(e) => setL({ ...l, storageBillingDay: Number(e.target.value) })} /></Field></div>
        <Button size="sm" variant="primary" className="mt-3" onClick={() => bl.save.mutate({ paymentTermsDays: l.paymentTermsDays, storageBillingDay: l.storageBillingDay })}>Save</Button>
      </Section>
      <Section title="Units of measure" description="Available in product forms.">
        <Textarea value={u} onChange={(e) => setU(e.target.value)} />
        <Button size="sm" variant="primary" className="mt-3" onClick={() => units.save.mutate(u.split(',').map((x) => x.trim()).filter(Boolean))}>Save units</Button>
      </Section>
    </Card>
  );
}

function ImportData() {
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [entity, setEntity] = useState(params.get('entity') ?? 'products');
  const [preview, setPreview] = useState<any>(null);
  const [ack, setAck] = useState(false);
  const history = useQuery({ queryKey: ['imports'], queryFn: () => api.get<any[]>('/imports') });
  const upload = useMutation({ mutationFn: (file: File) => { const fd = new FormData(); fd.append('entity', entity); fd.append('file', file); return api.upload<any>('/imports', fd); }, onSuccess: (r) => { setPreview(r); setAck(false); } });
  const commit = useMutation({ mutationFn: () => api.post<any>(`/imports/${preview.id}/commit`, { acknowledgeInvalidRows: ack }), onSuccess: (r) => { toast.success(`Imported ${r.imported} rows${r.skipped ? `, skipped ${r.skipped}` : ''}`); setPreview(null); qc.invalidateQueries(); } });
  return (
    <div className="space-y-4">
      <Card className="p-6">
        <h3 className="text-sm font-semibold">Import from Excel or CSV</h3>
        <p className="mt-1 text-sm text-ink-500">1. Download the template · 2. Fill it in · 3. Upload to preview · 4. Fix errors or confirm. Nothing is imported until you confirm.</p>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <Field label="What are you importing?"><Select value={entity} onChange={(e) => { setEntity(e.target.value); setPreview(null); }} className="w-56">{IMPORT_ENTITIES.map((e) => <option key={e} value={e}>{humanize(e)}</option>)}</Select></Field>
          <Button onClick={() => api.download(`/imports/templates/${entity}`, undefined, `${entity}_template.csv`).catch((e) => toast.error(errorMessage(e)))}><Download /> Template</Button>
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800"><Upload className="size-4" />{upload.isPending ? 'Checking…' : 'Upload file'}<input type="file" accept=".csv,.xlsx" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.target.value = ''; }} /></label>
        </div>
      </Card>
      {preview && (
        <Card>
          <CardHeader title={`Preview: ${preview.fileName}`} description={`${preview.totalRows} rows · ${preview.validRows} valid · ${preview.invalidRows} with errors`} actions={<><Button size="sm" onClick={() => setPreview(null)}>Discard</Button><Button size="sm" variant="primary" loading={commit.isPending} disabled={!preview.validRows || (preview.invalidRows > 0 && !ack)} onClick={() => commit.mutate()}>Import {preview.validRows} valid rows</Button></>} />
          {preview.invalidRows > 0 && <div className="border-b border-ink-100 bg-amber-50 px-5 py-3"><Checkbox label={`Skip the ${preview.invalidRows} rows with errors and import the rest`} checked={ack} onChange={setAck} /></div>}
          <Table rows={preview.preview} dense rowKey={(r) => String(r.row)} columns={[
            { key: 'row', header: 'Row', cell: (r: any) => r.row },
            { key: 'ok', header: 'Check', cell: (r: any) => r.errors.length ? <Badge tone="red">{r.errors.length} error{r.errors.length > 1 ? 's' : ''}</Badge> : <Badge tone="green">Valid</Badge> },
            { key: 'data', header: 'Data', cell: (r: any) => <span className="block max-w-xl truncate font-mono text-[11px] text-ink-600">{Object.entries(r.data).filter(([, v]) => v !== '' && v !== null).map(([k, v]) => `${k}=${v}`).join(' · ')}</span> },
            { key: 'e', header: 'Errors', cell: (r: any) => <span className="text-xs text-red-600">{r.errors.join('; ')}</span> },
          ]} />
        </Card>
      )}
      <Card><CardHeader title="Import history" /><Table rows={history.data} dense empty={<div className="p-5 text-sm text-ink-500">No imports yet.</div>} columns={[{ key: 'e', header: 'Type', cell: (r: any) => humanize(r.entity) }, { key: 'f', header: 'File', cell: (r: any) => r.fileName }, { key: 'r', header: 'Rows', align: 'right', cell: (r: any) => `${r.validRows} / ${r.totalRows}` }, { key: 's', header: 'Status', cell: (r: any) => <StatusBadge status={r.status === 'committed' ? 'completed' : 'draft'} label={r.status} /> }, { key: 'd', header: 'When', cell: (r: any) => dateTime(r.committedAt ?? r.createdAt) }]} /></Card>
      {void navigate}
    </div>
  );
}

function Integrations() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['integrations'], queryFn: () => api.get<any[]>('/integrations') });
  const [connect, setConnect] = useState<any>(null);
  const [vals, setVals] = useState<Record<string, string>>({});
  const conn = useMutation({ mutationFn: () => api.post(`/integrations/${connect.key}/connect`, { config: Object.fromEntries(connect.fields.filter((f: any) => !f.secret).map((f: any) => [f.key, vals[f.key] ?? ''])), credentials: Object.fromEntries(connect.fields.filter((f: any) => f.secret).map((f: any) => [f.key, vals[f.key] ?? ''])) }), onSuccess: () => { toast.success('Connected — credentials are encrypted at rest'); setConnect(null); setVals({}); qc.invalidateQueries({ queryKey: ['integrations'] }); } });
  const disc = useMutation({ mutationFn: (key: string) => api.post(`/integrations/${key}/disconnect`), onSuccess: () => qc.invalidateQueries({ queryKey: ['integrations'] }) });
  if (isLoading || !data) return <Skeleton className="h-96" />;
  return (
    <div className="space-y-4">
      <Card className="p-4 text-sm text-ink-600">Connectors use a common adapter layer. Providers marked <Badge tone="amber">Development mock</Badge> simulate the partner API until real credentials and certification are added — they never send data to the partner.</Card>
      {['accounting', 'ecommerce', 'shipping', 'messaging'].map((cat) => (
        <Card key={cat}><CardHeader title={humanize(cat)} />
          <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">{data.filter((p) => p.category === cat).map((p) => (
            <div key={p.key} className="rounded-xl border border-ink-200 p-4">
              <div className="flex items-center justify-between"><span className="flex items-center gap-2 text-sm font-semibold"><Plug className="size-4 text-ink-400" />{p.name}</span><StatusBadge status={p.status} /></div>
              <p className="mt-1 text-xs text-ink-500">{p.description}</p>
              <div className="mt-3 flex items-center justify-between">{p.mock ? <Badge tone="amber">Development mock</Badge> : <span />}{p.status === 'connected' ? <Button size="sm" variant="ghost" onClick={() => disc.mutate(p.key)}>Disconnect</Button> : <Button size="sm" onClick={() => setConnect(p)}>Connect</Button>}</div>
            </div>
          ))}</div>
        </Card>
      ))}
      {connect && <Dialog open onOpenChange={() => setConnect(null)} title={`Connect ${connect.name}`} footer={<><Button onClick={() => setConnect(null)}>Cancel</Button><Button variant="primary" loading={conn.isPending} onClick={() => conn.mutate()}>Connect</Button></>}>
        <div className="space-y-3">{connect.fields.map((f: any) => <Field key={f.key} label={f.label}><Input type={f.secret ? 'password' : 'text'} value={vals[f.key] ?? ''} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} autoComplete="off" /></Field>)}</div>
      </Dialog>}
    </div>
  );
}

function Webhooks() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['webhooks'], queryFn: () => api.get<any>('/webhooks') });
  const [create, setCreate] = useState(false);
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>(['shipment.dispatched']);
  const [secret, setSecret] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<string | null>(null);
  const del = useQuery({ queryKey: ['deliveries', deliveries], queryFn: () => api.get<any[]>(`/webhooks/${deliveries}/deliveries`), enabled: !!deliveries });
  const m = useMutation({ mutationFn: () => api.post<any>('/webhooks', { url, events }), onSuccess: (r) => { setSecret(r.secret); setCreate(false); setUrl(''); qc.invalidateQueries({ queryKey: ['webhooks'] }); } });
  const test = useMutation({ mutationFn: (id: string) => api.post(`/webhooks/${id}/test`), onSuccess: () => toast.success('Test event queued') });
  const remove = useMutation({ mutationFn: (id: string) => api.del(`/webhooks/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['webhooks'] }) });
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Webhooks" description="Signed (HMAC-SHA256) HTTP callbacks for business events, retried with backoff." actions={<Button size="sm" variant="primary" onClick={() => setCreate(true)}><Webhook /> Add webhook</Button>} />
        <Table rows={data?.hooks} empty={<EmptyState icon={Webhook} title="No webhooks" />} columns={[
          { key: 'u', header: 'URL', cell: (h: any) => <span className="font-mono text-xs">{h.url}</span> }, { key: 'e', header: 'Events', cell: (h: any) => <div className="flex flex-wrap gap-1">{h.events.map((e: string) => <Badge key={e}>{e}</Badge>)}</div> },
          { key: 's', header: 'Status', cell: (h: any) => <StatusBadge status={h.active ? 'active' : 'inactive'} /> },
          { key: 'a', header: '', align: 'right', cell: (h: any) => <div className="flex justify-end gap-1"><Button size="sm" variant="ghost" onClick={() => test.mutate(h.id)}>Test</Button><Button size="sm" variant="ghost" onClick={() => setDeliveries(h.id)}>Deliveries</Button><Button size="icon" variant="ghost" onClick={() => remove.mutate(h.id)} aria-label="Delete"><Trash2 /></Button></div> },
        ]} />
      </Card>
      <Card className="p-5 text-sm text-ink-600">REST API documentation (OpenAPI) is available at <a href="/api/docs" target="_blank" className="font-medium text-brand-700" rel="noreferrer">/api/docs</a>. Requests authenticate with the session cookie and must send the <code>X-Requested-With: stockpilot</code> header.</Card>
      {create && <Dialog open onOpenChange={() => setCreate(false)} title="Add webhook" footer={<><Button onClick={() => setCreate(false)}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={!url || !events.length} onClick={() => m.mutate()}>Create</Button></>}>
        <div className="space-y-4"><Field label="Endpoint URL" hint="HTTPS required in production"><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/hooks/stockpilot" /></Field>
          <div className="grid gap-2 sm:grid-cols-2">{(data?.events ?? []).map((e: string) => <Checkbox key={e} label={e} checked={events.includes(e)} onChange={(v) => setEvents(v ? [...events, e] : events.filter((x) => x !== e))} />)}</div></div>
      </Dialog>}
      {secret && <Dialog open onOpenChange={() => setSecret(null)} title="Signing secret" description="Store this secret now — it is shown only once. Verify the x-stockpilot-signature header with it."><code className="block break-all rounded-lg bg-ink-100 p-3 font-mono text-sm">{secret}</code></Dialog>}
      {deliveries && <Dialog open onOpenChange={() => setDeliveries(null)} title="Recent deliveries" size="lg"><Table rows={del.data} dense columns={[{ key: 'e', header: 'Event', cell: (d: any) => d.event }, { key: 's', header: 'Status', cell: (d: any) => <StatusBadge status={d.status === 'delivered' ? 'completed' : d.status} label={d.status} /> }, { key: 'c', header: 'HTTP', cell: (d: any) => d.responseCode ?? '—' }, { key: 'a', header: 'Attempts', cell: (d: any) => d.attempts }, { key: 'err', header: 'Error', cell: (d: any) => <span className="text-xs text-red-600">{d.lastError}</span> }, { key: 't', header: 'When', cell: (d: any) => dateTime(d.createdAt) }]} /></Dialog>}
    </div>
  );
}

function Plan() {
  const company = useCompany();
  const usage = useQuery({ queryKey: ['usage'], queryFn: () => api.get<any[]>('/company/usage') });
  return (
    <Card className="p-6">
      <Section title="Subscription" description="Plans and limits are managed by the platform administrator.">
        {company.data?.plan ? <div><div className="text-lg font-semibold">{company.data.plan.name}</div><div className="text-sm text-ink-500">{company.data.plan.description} · {company.data.plan.priceMonthly ? `${money(company.data.plan.priceMonthly, { code: company.data.plan.currency })}/month` : 'custom pricing'} · status <StatusBadge status={company.data.status} /></div></div> : <p className="text-sm text-ink-500">No plan assigned.</p>}
      </Section>
      <Section title="Usage this month">
        <div className="space-y-3">{usage.data?.map((u) => <div key={u.key}><div className="flex justify-between text-sm"><span className="capitalize">{u.label}</span><span className="num text-ink-600">{qty(u.used, 1)} / {u.limit < 0 ? 'unlimited' : qty(u.limit, 0)}</span></div>{u.limit > 0 && <Progress value={(u.used / u.limit) * 100} />}</div>)}</div>
      </Section>
    </Card>
  );
}
