import { useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Activity, Building2, Coins, Flag, LifeBuoy, Sparkles, Users } from 'lucide-react';
import { BRAND } from '@shared/brand';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn, date, dateTime, money, qty } from '@/lib/utils';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Select, Skeleton, StatusBadge } from '@/components/ui/core';
import { Dialog } from '@/components/ui/overlay';
import { PageHeader, StatCard } from '@/components/ui/blocks';
import { Table } from '@/components/ui/table';

export function Platform() {
  const { me } = useAuth();
  if (!me?.user.isPlatformAdmin) return <Card><EmptyState title="Platform administrators only" description="This area manages all customer companies on the SaaS platform." /></Card>;
  const tabs = [['overview', 'Overview'], ['tenants', 'Tenants'], ['plans', 'Plans & limits'], ['flags', 'Feature flags'], ['health', 'System health'], ['ai', 'AI usage'], ['support', 'Support']];
  return (
    <div>
      <PageHeader title={`${BRAND.name} platform`} description="SaaS administration. Aggregate figures only — customer operational records are never shown here." />
      <nav className="mb-6 flex gap-1 overflow-x-auto border-b border-ink-200">{tabs.map(([to, l]) => <NavLink key={to} to={to} className={({ isActive }) => cn('whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium', isActive ? 'border-brand-600 text-brand-800' : 'border-transparent text-ink-500 hover:text-ink-800')}>{l}</NavLink>)}</nav>
      <Routes>
        <Route index element={<Navigate to="overview" replace />} />
        <Route path="overview" element={<Overview />} />
        <Route path="tenants" element={<Tenants />} />
        <Route path="plans" element={<Plans />} />
        <Route path="flags" element={<Flags />} />
        <Route path="health" element={<Health />} />
        <Route path="ai" element={<AiUsage />} />
        <Route path="support" element={<Support />} />
      </Routes>
    </div>
  );
}

function Overview() {
  const { data } = useQuery({ queryKey: ['platform-overview'], queryFn: () => api.get<any>('/platform/overview') });
  if (!data) return <Skeleton className="h-64" />;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <StatCard label="Tenants" value={data.tenants} sub={`${data.active} active · ${data.trial} trial · ${data.suspended} suspended`} icon={Building2} />
      <StatCard label="Users" value={data.users} sub={`${data.active_sessions} active today`} icon={Users} />
      <StatCard label="MRR (active)" value={money(data.mrr, { code: 'PKR', compact: true })} icon={Coins} />
      <StatCard label="Ledger transactions (MTD)" value={qty(data.transactions_mtd, 0)} icon={Activity} />
      <StatCard label="AI requests (MTD)" value={qty(data.ai_requests_mtd, 0)} sub={`$${Number(data.ai_cost_mtd).toFixed(4)} estimated`} icon={Sparkles} />
      <StatCard label="Open support tickets" value={data.open_tickets} icon={LifeBuoy} tone={data.open_tickets ? 'warn' : 'good'} />
    </div>
  );
}

function Tenants() {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const tenants = useQuery({ queryKey: ['platform-tenants', q], queryFn: () => api.get<any[]>('/platform/tenants', { q: q || undefined }) });
  const plans = useQuery({ queryKey: ['platform-plans'], queryFn: () => api.get<any[]>('/platform/plans') });
  const [edit, setEdit] = useState<any>(null);
  const m = useMutation({ mutationFn: () => api.patch(`/platform/tenants/${edit.id}`, { status: edit.status, planId: edit.planId }), onSuccess: () => { toast.success('Tenant updated (recorded in the platform audit log)'); setEdit(null); qc.invalidateQueries({ queryKey: ['platform-tenants'] }); } });
  return (
    <Card>
      <div className="border-b border-ink-100 p-3"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search companies" className="w-72" /></div>
      <Table rows={tenants.data} loading={tenants.isLoading} onRowClick={(t) => setEdit({ ...t })} columns={[
        { key: 'n', header: 'Company', cell: (t: any) => <div><div className="font-medium">{t.name}</div><div className="text-xs text-ink-500">{t.city} · since {date(t.createdAt)}</div></div> },
        { key: 'p', header: 'Plan', cell: (t: any) => <Badge tone="blue">{t.planName ?? '—'}</Badge> },
        { key: 'u', header: 'Users', align: 'right', cell: (t: any) => t.users }, { key: 'w', header: 'Warehouses', align: 'right', cell: (t: any) => t.warehouses },
        { key: 's', header: 'SKUs', align: 'right', cell: (t: any) => t.skus }, { key: 'tx', header: 'Txns MTD', align: 'right', cell: (t: any) => qty(t.transactionsMtd, 0) },
        { key: 'st', header: 'Status', cell: (t: any) => <StatusBadge status={t.status} /> },
      ]} />
      {edit && <Dialog open onOpenChange={() => setEdit(null)} title={edit.name} footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" loading={m.isPending} onClick={() => m.mutate()}>Save</Button></>}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Status" hint="Suspending signs all users out"><Select value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}><option value="active">Active</option><option value="trial">Trial</option><option value="suspended">Suspended</option></Select></Field>
          <Field label="Plan"><Select value={edit.planId ?? ''} onChange={(e) => setEdit({ ...edit, planId: e.target.value })}>{plans.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
        </div>
      </Dialog>}
    </Card>
  );
}

function Plans() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['platform-plans'], queryFn: () => api.get<any[]>('/platform/plans') });
  const [edit, setEdit] = useState<any>(null);
  const m = useMutation({ mutationFn: () => api.patch(`/platform/plans/${edit.id}`, { priceMonthly: Number(edit.priceMonthly), limits: Object.fromEntries(Object.entries(edit.limits).map(([k, v]) => [k, Number(v)])) }), onSuccess: () => { toast.success('Plan saved'); setEdit(null); qc.invalidateQueries({ queryKey: ['platform-plans'] }); } });
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {data?.map((p) => (
        <Card key={p.id} className="p-5">
          <div className="flex items-center justify-between"><h3 className="text-base font-semibold">{p.name}</h3><Button size="sm" variant="ghost" onClick={() => setEdit({ ...p, limits: { ...p.limits } })}>Edit</Button></div>
          <div className="num mt-1 text-2xl font-semibold">{p.priceMonthly ? money(p.priceMonthly, { code: p.currency }) : 'Custom'}<span className="text-sm font-normal text-ink-500">{p.priceMonthly ? ' /month' : ''}</span></div>
          <p className="mt-1 text-xs text-ink-500">{p.description}</p>
          <ul className="mt-4 space-y-1 text-sm">{Object.entries(p.limits).map(([k, v]) => <li key={k} className="flex justify-between"><span className="text-ink-600">{k.replace(/([A-Z])/g, ' $1').toLowerCase()}</span><span className="num font-medium">{Number(v) < 0 ? 'Unlimited' : qty(v, 0)}</span></li>)}</ul>
        </Card>
      ))}
      {edit && <Dialog open onOpenChange={() => setEdit(null)} title={`Edit ${edit.name}`} footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" loading={m.isPending} onClick={() => m.mutate()}>Save</Button></>}>
        <div className="grid gap-3 sm:grid-cols-2"><Field label="Price per month"><Input type="number" value={edit.priceMonthly} onChange={(e) => setEdit({ ...edit, priceMonthly: e.target.value })} /></Field>
          {Object.keys(edit.limits).map((k) => <Field key={k} label={k} hint="-1 = unlimited"><Input type="number" value={edit.limits[k]} onChange={(e) => setEdit({ ...edit, limits: { ...edit.limits, [k]: e.target.value } })} /></Field>)}</div>
      </Dialog>}
    </div>
  );
}

function Flags() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['platform-flags'], queryFn: () => api.get<any[]>('/platform/feature-flags') });
  const m = useMutation({ mutationFn: (f: any) => api.patch(`/platform/feature-flags/${f.id}`, { enabled: !f.enabled }), onSuccess: () => qc.invalidateQueries({ queryKey: ['platform-flags'] }) });
  return (
    <Card><Table rows={data} columns={[
      { key: 'k', header: 'Flag', cell: (f: any) => <code className="text-xs">{f.key}</code> }, { key: 'd', header: 'Description', cell: (f: any) => f.description },
      { key: 'o', header: 'Tenant overrides', cell: (f: any) => Object.keys(f.tenantOverrides).length },
      { key: 'e', header: 'Global', align: 'right', cell: (f: any) => <Button size="sm" variant={f.enabled ? 'primary' : 'secondary'} onClick={() => m.mutate(f)}><Flag /> {f.enabled ? 'On' : 'Off'}</Button> },
    ]} /></Card>
  );
}

function Health() {
  const { data, refetch, isFetching } = useQuery({ queryKey: ['platform-health'], queryFn: () => api.get<any>('/platform/health'), refetchInterval: 30_000 });
  if (!data) return <Skeleton className="h-64" />;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Database" value={data.database.ok ? 'Healthy' : 'Down'} sub={`${data.database.driver} · ${data.database.latencyMs} ms · ${data.database.sizeMb} MB`} tone={data.database.ok ? 'good' : 'danger'} />
        <StatCard label="Requests since start" value={qty(data.requests.requests, 0)} sub={`${data.requests.unhandledErrors} unhandled errors`} tone={data.requests.unhandledErrors ? 'warn' : 'good'} />
        <StatCard label="Latency p50 / p95" value={`${data.requests.latencyMs.p50} / ${data.requests.latencyMs.p95} ms`} sub={`p99 ${data.requests.latencyMs.p99} ms`} />
        <StatCard label="Uptime" value={`${Math.round(data.requests.uptimeSeconds / 60)} min`} sub={`Node ${data.node} · ${data.requests.memoryMb} MB RSS · AI ${data.ai.configured ? 'configured' : 'not configured'}`} />
      </div>
      <Card><CardHeader title="Background jobs (7 days)" actions={<Button size="sm" onClick={() => refetch()} loading={isFetching}>Refresh</Button>} /><Table rows={data.jobs} dense empty={<div className="p-5 text-sm text-ink-500">No jobs in the last 7 days.</div>} columns={[{ key: 'n', header: 'Job', cell: (j: any) => <code className="text-xs">{j.name}</code> }, { key: 's', header: 'Status', cell: (j: any) => <StatusBadge status={j.status === 'completed' ? 'completed' : j.status === 'failed' ? 'failed' : 'pending'} label={j.status} /> }, { key: 'c', header: 'Count', align: 'right', cell: (j: any) => j.count }, { key: 'e', header: 'Last error', cell: (j: any) => <span className="text-xs text-red-600">{j.lastError}</span> }]} /></Card>
      <Card><CardHeader title="Slowest routes" /><Table rows={data.requests.slowestRoutes} dense rowKey={(r) => r.route} columns={[{ key: 'r', header: 'Route', cell: (r: any) => <code className="text-xs">{r.route}</code> }, { key: 'c', header: 'Calls', align: 'right', cell: (r: any) => r.count }, { key: 'a', header: 'Avg ms', align: 'right', cell: (r: any) => r.avgMs }]} /></Card>
    </div>
  );
}

function AiUsage() {
  const { data } = useQuery({ queryKey: ['platform-ai'], queryFn: () => api.get<any[]>('/platform/ai-usage') });
  return <Card><CardHeader title="AI usage this month" description="Requests, tokens, estimated cost and latency by tenant and feature." /><Table rows={data} empty={<div className="p-5 text-sm text-ink-500">No AI usage yet.</div>} columns={[{ key: 't', header: 'Tenant', cell: (r: any) => r.tenant }, { key: 'f', header: 'Feature', cell: (r: any) => r.feature }, { key: 'm', header: 'Model', cell: (r: any) => <code className="text-xs">{r.model}</code> }, { key: 's', header: 'Status', cell: (r: any) => <StatusBadge status={r.status === 'ok' ? 'completed' : r.status === 'error' ? 'failed' : 'pending'} label={r.status} /> }, { key: 'r', header: 'Requests', align: 'right', cell: (r: any) => r.requests }, { key: 'k', header: 'Tokens', align: 'right', cell: (r: any) => qty(r.tokens, 0) }, { key: 'c', header: 'Cost', align: 'right', cell: (r: any) => `$${Number(r.costUsd ?? 0).toFixed(4)}` }, { key: 'l', header: 'Avg latency', align: 'right', cell: (r: any) => `${r.avgLatencyMs} ms` }]} /></Card>;
}

function Support() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['platform-support'], queryFn: () => api.get<any[]>('/platform/support') });
  const m = useMutation({ mutationFn: ({ id, status }: { id: string; status: string }) => api.patch(`/platform/support/${id}`, { status }), onSuccess: () => qc.invalidateQueries({ queryKey: ['platform-support'] }) });
  return <Card><Table rows={data} empty={<EmptyState icon={LifeBuoy} title="No support tickets" />} columns={[{ key: 's', header: 'Subject', cell: (t: any) => <div><div className="font-medium">{t.subject}</div><div className="max-w-md truncate text-xs text-ink-500">{t.body}</div></div> }, { key: 't', header: 'Tenant', cell: (t: any) => t.tenant_name }, { key: 'p', header: 'Priority', cell: (t: any) => <StatusBadge status={t.priority} /> }, { key: 'd', header: 'Opened', cell: (t: any) => dateTime(t.created_at) }, { key: 'st', header: 'Status', cell: (t: any) => <Select value={t.status} onChange={(e) => m.mutate({ id: t.id, status: e.target.value })} className="h-8 w-36"><option value="open">Open</option><option value="in_progress">In progress</option><option value="resolved">Resolved</option></Select> }]} /></Card>;
}
