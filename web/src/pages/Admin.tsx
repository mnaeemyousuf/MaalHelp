import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Bell, CheckCheck, CheckCircle2, FileSearch, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn, dateTime, humanize, money, relativeTime } from '@/lib/utils';
import { Badge, Button, Card, EmptyState, Field, Input, Select, StatusBadge, Textarea } from '@/components/ui/core';
import { Dialog } from '@/components/ui/overlay';
import { PageHeader } from '@/components/ui/blocks';
import { SearchInput, Table, useServerList } from '@/components/ui/table';

export function Alerts() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [severity, setSeverity] = useState('');
  const [status, setStatus] = useState('open');
  const list = useServerList<any>('/alerts', { severity: severity || undefined, status }, { pageSize: 50 });
  const counts = (list.meta.counts ?? {}) as Record<string, { total: number; unread: number }>;
  const readAll = useMutation({ mutationFn: () => api.post('/alerts/read-all'), onSuccess: () => qc.invalidateQueries() });
  const scan = useMutation({ mutationFn: () => api.post<any>('/alerts/scan'), onSuccess: () => { toast.success('Alert conditions re-checked'); qc.invalidateQueries(); } });
  const read = useMutation({ mutationFn: (id: string) => api.post(`/alerts/${id}/read`), onSuccess: () => qc.invalidateQueries({ queryKey: ['nav-badges'] }) });
  const resolve = useMutation({ mutationFn: (id: string) => api.post(`/alerts/${id}/resolve`), onSuccess: () => qc.invalidateQueries() });
  return (
    <div>
      <PageHeader title="Alert center" description="Critical issues, warnings and information — only what your role is allowed to see. Each alert links to the next action."
        actions={<><Button onClick={() => scan.mutate()} loading={scan.isPending}><RefreshCw /> Check now</Button><Button onClick={() => readAll.mutate()}><CheckCheck /> Mark all read</Button></>} />
      <div className="mb-4 grid grid-cols-3 gap-3">
        {(['critical', 'warning', 'info'] as const).map((s) => (
          <button key={s} onClick={() => setSeverity(severity === s ? '' : s)} className={cn('card p-4 text-left', severity === s && 'ring-2 ring-brand-200 border-brand-400')}>
            <div className="flex items-center gap-2"><span className={cn('size-2.5 rounded-full', s === 'critical' ? 'bg-red-500' : s === 'warning' ? 'bg-amber-500' : 'bg-sky-500')} /><span className="text-sm font-medium capitalize">{s}</span></div>
            <div className="num mt-1 text-2xl font-semibold">{counts[s]?.total ?? 0}</div><div className="text-xs text-ink-500">{counts[s]?.unread ?? 0} unread</div>
          </button>
        ))}
      </div>
      <Card>
        <div className="flex gap-2 border-b border-ink-100 p-3"><Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40"><option value="open">Open</option><option value="resolved">Resolved</option><option value="all">All</option></Select></div>
        {!list.rows?.length && !list.loading ? <EmptyState icon={Bell} title="No alerts" description="You're all caught up." /> : (
          <div className="divide-y divide-ink-100">
            {list.rows?.map((a) => (
              <div key={a.id} className={cn('flex items-start gap-3 px-5 py-3.5', !a.read && 'bg-brand-50/30')}>
                <span className={cn('mt-1.5 size-2.5 shrink-0 rounded-full', a.severity === 'critical' ? 'bg-red-500' : a.severity === 'warning' ? 'bg-amber-500' : 'bg-sky-500')} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2"><span className={cn('text-sm text-ink-900', !a.read && 'font-semibold')}>{a.title}</span><Badge>{humanize(a.category)}</Badge>{a.resolvedAt && <Badge tone="green">Resolved</Badge>}</div>
                  {a.body && <p className="mt-0.5 text-sm text-ink-600">{a.body}</p>}
                  <div className="mt-1 text-xs text-ink-400">{relativeTime(a.createdAt)}</div>
                </div>
                <div className="flex shrink-0 gap-1">
                  {a.actionUrl && <Link to={a.actionUrl} onClick={() => read.mutate(a.id)}><Button size="sm" variant="primary">Open</Button></Link>}
                  {!a.read && <Button size="sm" variant="ghost" onClick={() => read.mutate(a.id)}>Read</Button>}
                  {!a.resolvedAt && can('task.manage', 'alert.view') && <Button size="sm" variant="ghost" onClick={() => resolve.mutate(a.id)}>Resolve</Button>}
                </div>
              </div>
            ))}
          </div>
        )}
        {list.pagination}
      </Card>
    </div>
  );
}

const ENTITY_LINK: Record<string, (id: string) => string> = {
  purchase_order: (id) => `/purchasing/${id}`, stock_count: (id) => `/stock-counts/${id}`, stock_adjustment: () => '/inventory?tab=adjustments', expense: () => '/expenses', transfer: (id) => `/transfers/${id}`,
};

export function Approvals() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('pending');
  const [decide, setDecide] = useState<{ req: any; decision: 'approved' | 'rejected' } | null>(null);
  const [comment, setComment] = useState('');
  const list = useServerList<any>('/approvals', { status });
  const m = useMutation({ mutationFn: () => api.post(`/approvals/${decide!.req.id}/decide`, { decision: decide!.decision, comment }), onSuccess: () => { toast.success(decide!.decision === 'approved' ? 'Approved — the transaction has been posted' : 'Rejected'); setDecide(null); setComment(''); qc.invalidateQueries(); } });
  return (
    <div>
      <PageHeader title="Approvals" description="Requests above your configured thresholds. Approving posts the transaction; you can't approve your own request (except owners)." actions={<Link to="/settings/approvals"><Button>Approval rules</Button></Link>} />
      <Card>
        <div className="border-b border-ink-100 p-3"><Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40"><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="all">All</option></Select></div>
        <Table rows={list.rows} loading={list.loading} error={list.error} empty={<EmptyState icon={ShieldCheck} title="Nothing waiting for approval" />}
          columns={[
            { key: 'e', header: 'Request', cell: (r) => <div><Link to={ENTITY_LINK[r.entityType]?.(r.entityId) ?? '#'} className="font-medium hover:text-brand-700">{r.entityNumber}</Link><div className="text-xs text-ink-500">{humanize(r.entityType)}</div></div> },
            { key: 's', header: 'Summary', cell: (r) => <span className="text-sm">{r.summary}</span> },
            { key: 'a', header: 'Amount', align: 'right', cell: (r) => money(r.amount) },
            { key: 'by', header: 'Requested', hideOnMobile: true, cell: (r) => <div className="text-xs"><div>{r.requestedBy}</div><div className="text-ink-500">{dateTime(r.createdAt)}</div></div> },
            { key: 'who', header: 'Approver', hideOnMobile: true, cell: (r) => humanize(r.approverRoleKey) },
            { key: 'st', header: 'Status', cell: (r) => <div><StatusBadge status={r.status} />{r.decidedBy && <div className="mt-0.5 text-xs text-ink-500">{r.decidedBy}{r.comment ? ` · “${r.comment}”` : ''}</div>}</div> },
            { key: 'act', header: '', align: 'right', cell: (r) => r.status === 'pending' && (r.canDecide ? <div className="flex justify-end gap-1"><Button size="sm" variant="ghost" className="text-red-600" onClick={() => setDecide({ req: r, decision: 'rejected' })}><XCircle /> Reject</Button><Button size="sm" variant="primary" onClick={() => setDecide({ req: r, decision: 'approved' })}><CheckCircle2 /> Approve</Button></div> : <span className="text-xs text-ink-400">Needs {humanize(r.approverRoleKey).toLowerCase()}</span>) },
          ]} />
        {list.pagination}
      </Card>
      {decide && <Dialog open onOpenChange={() => setDecide(null)} title={`${decide.decision === 'approved' ? 'Approve' : 'Reject'} ${decide.req.entityNumber}?`} description={decide.req.summary}
        footer={<><Button onClick={() => setDecide(null)}>Cancel</Button><Button variant={decide.decision === 'approved' ? 'primary' : 'danger'} loading={m.isPending} disabled={decide.decision === 'rejected' && comment.trim().length < 3} onClick={() => m.mutate()}>{decide.decision === 'approved' ? 'Approve' : 'Reject'}</Button></>}>
        <Field label={decide.decision === 'rejected' ? 'Reason (required)' : 'Comment (optional)'}><Textarea value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
      </Dialog>}
    </div>
  );
}

export function Audit() {
  const [entityType, setEntityType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [detail, setDetail] = useState<any>(null);
  const list = useServerList<any>('/audit', { entityType: entityType || undefined, from: from || undefined, to: to || undefined }, { pageSize: 50 });
  return (
    <div>
      <PageHeader title="Audit trail" description="Append-only record of every important action: who, what, old and new values, IP address, device and time. It cannot be edited or deleted." />
      <Card>
        <div className="flex flex-wrap gap-2 border-b border-ink-100 p-3">
          <SearchInput value={list.q} onChange={list.setQ} placeholder="Action, user, record or value" className="w-full sm:w-72" />
          <Select value={entityType} onChange={(e) => setEntityType(e.target.value)} className="w-48"><option value="">All records</option>{['product', 'purchase_order', 'goods_receipt', 'sales_order', 'pick_task', 'transfer', 'stock_adjustment', 'stock_count', 'customer_return', 'invoice', 'user', 'role', 'settings', 'warehouse', 'location', 'tenant'].map((e) => <option key={e} value={e}>{humanize(e)}</option>)}</Select>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-36" aria-label="From" /><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-36" aria-label="To" />
        </div>
        <Table rows={list.rows} loading={list.loading} error={list.error} dense onRowClick={setDetail} empty={<EmptyState icon={FileSearch} title="No audit entries match" />}
          columns={[
            { key: 't', header: 'When', cell: (r) => <span className="whitespace-nowrap text-xs">{dateTime(r.createdAt)}</span> },
            { key: 'u', header: 'User', cell: (r) => <div className="text-xs"><div className="font-medium text-ink-800">{r.userName ?? 'System'}</div><div className="text-ink-500">{r.userEmail}</div></div> },
            { key: 'a', header: 'Action', cell: (r) => <code className="rounded bg-ink-100 px-1.5 py-0.5 text-xs">{r.action}</code> },
            { key: 'e', header: 'Record', cell: (r) => <span className="text-xs">{humanize(r.entityType)}</span> },
            { key: 'v', header: 'Change', hideOnMobile: true, cell: (r) => <span className="block max-w-md truncate font-mono text-[11px] text-ink-500">{r.newValue ? JSON.stringify(r.newValue) : ''}</span> },
            { key: 'ip', header: 'IP', hideOnMobile: true, cell: (r) => <span className="text-xs text-ink-500">{r.ip}</span> },
          ]} />
        {list.pagination}
      </Card>
      {detail && <Dialog open onOpenChange={() => setDetail(null)} title={detail.action} description={`${detail.userName ?? 'System'} · ${dateTime(detail.createdAt)} · ${detail.ip} · ${detail.device?.slice(0, 80)}`} size="lg">
        <div className="grid gap-4 sm:grid-cols-2">
          <div><div className="mb-1 text-xs font-semibold text-ink-500">Before</div><pre className="max-h-80 overflow-auto rounded-lg bg-ink-50 p-3 text-[11px]">{detail.oldValue ? JSON.stringify(detail.oldValue, null, 2) : '—'}</pre></div>
          <div><div className="mb-1 text-xs font-semibold text-ink-500">After</div><pre className="max-h-80 overflow-auto rounded-lg bg-ink-50 p-3 text-[11px]">{detail.newValue ? JSON.stringify(detail.newValue, null, 2) : '—'}</pre></div>
        </div>
      </Dialog>}
    </div>
  );
}
