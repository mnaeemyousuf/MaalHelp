import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, Bot, Database, FileUp, Lightbulb, RefreshCw, Send, ShoppingCart, Sparkles, User } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn, date, dateTime, humanize, money, qty, today } from '@/lib/utils';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, Input, Select, Skeleton, StatusBadge, Textarea } from '@/components/ui/core';
import { Dialog, Tabs } from '@/components/ui/overlay';
import { EntityPicker, PageHeader } from '@/components/ui/blocks';
import { Table } from '@/components/ui/table';
import { useWarehouses } from './Inventory';

const SUGGESTIONS = ['How much inventory do I have?', 'Which products are low?', "Give me today's warehouse summary", "Which products haven't moved for 90 days?", 'Show me my top 10 products by value', 'Which products may run out in the next 30 days?', 'Why did inventory decrease this week?', 'Which warehouse has the highest stock value?', 'Which customers owe me the most?', 'What are the biggest problems in my warehouse today?'];

/** Minimal, safe markdown: **bold**, bullets and line breaks (no HTML injection). */
function Markdown({ text }: { text: string }) {
  const lines = text.split('\n');
  const render = (s: string) => s.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith('**') && part.endsWith('**') ? <strong key={i} className="font-semibold text-ink-900">{part.slice(2, -2)}</strong> : <span key={i}>{part}</span>));
  return <div className="space-y-1.5 text-sm leading-relaxed text-ink-700">{lines.map((l, i) => (l.trim() === '' ? <div key={i} className="h-1" /> : /^\s*[•\-*]\s/.test(l) ? <div key={i} className="flex gap-2 pl-1"><span className="text-brand-600">•</span><span>{render(l.replace(/^\s*[•\-*]\s/, ''))}</span></div> : /^\d+\.\s/.test(l) ? <div key={i} className="pl-1">{render(l)}</div> : <p key={i}>{render(l)}</p>))}</div>;
}

export function Ai() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'chat';
  const status = useQuery({ queryKey: ['ai-status'], queryFn: () => api.get<any>('/ai/status') });
  return (
    <div>
      <PageHeader title={<span className="flex items-center gap-2"><Sparkles className="size-6 text-brand-600" />AI Copilot</span>}
        description="Answers come only from your live data through permission-checked, read-only tools. The AI can recommend — you decide, and the system validates."
        actions={status.data && <Badge tone={status.data.configured ? 'green' : 'amber'}>{status.data.configured ? `Mistral connected · ${status.data.model}` : 'AI model not configured — grounded answers from your data'}</Badge>} />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v })} tabs={[{ value: 'chat', label: 'Ask your business' }, { value: 'briefing', label: 'Daily briefing' }, { value: 'reorder', label: 'Smart reorder' }, { value: 'intelligence', label: 'Stock intelligence' }, { value: 'anomalies', label: 'Anomalies' }, { value: 'space', label: 'Space' }, { value: 'documents', label: 'Documents' }, { value: 'report', label: 'Monthly report' }]} />
      <div className="mt-4">
        {tab === 'chat' && <Chat initial={params.get('q') ?? undefined} configured={!!status.data?.configured} />}
        {tab === 'briefing' && <Briefing />}
        {tab === 'reorder' && <Reorder />}
        {tab === 'intelligence' && <Intelligence />}
        {tab === 'anomalies' && <Anomalies />}
        {tab === 'space' && <Space />}
        {tab === 'documents' && <Documents />}
        {tab === 'report' && <MonthlyReport />}
      </div>
    </div>
  );
}

interface Msg { role: 'user' | 'assistant'; content: string; mode?: string; notice?: string | null; tools?: any[]; proposedActions?: any[]; at: string }

function Chat({ initial, configured }: { initial?: string; configured: boolean }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [action, setAction] = useState<any>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const sent = useRef(false);
  const ask = useMutation({
    mutationFn: (message: string) => api.post<any>('/ai/chat', { message, conversationId }),
    onMutate: (message) => setMessages((m) => [...m, { role: 'user', content: message, at: new Date().toISOString() }]),
    onSuccess: (r) => { setConversationId(r.conversationId); setMessages((m) => [...m, { role: 'assistant', content: r.answer, mode: r.mode, notice: r.notice, tools: r.tools, proposedActions: r.proposedActions, at: r.generatedAt }]); },
    onError: (e) => setMessages((m) => [...m, { role: 'assistant', content: errorMessage(e), mode: 'error', at: new Date().toISOString() }]),
  });
  // Scroll only the message pane, never the whole page.
  useEffect(() => { const pane = endRef.current?.parentElement; if (pane) pane.scrollTo({ top: pane.scrollHeight, behavior: 'smooth' }); }, [messages, ask.isPending]);
  useEffect(() => { if (initial && !sent.current) { sent.current = true; ask.mutate(initial); } }, [initial]); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = (text: string) => { const t = text.trim(); if (!t || ask.isPending) return; setInput(''); ask.mutate(t); };
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_300px]">
      <Card className="flex h-[calc(100vh-15rem)] min-h-[520px] flex-col">
        <div className="flex-1 space-y-5 overflow-y-auto p-5">
          {!messages.length && (
            <div className="mx-auto max-w-xl py-8 text-center">
              <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-gradient-to-br from-brand-700 to-brand-500 text-white shadow-lg"><Sparkles className="size-7" /></div>
              <h2 className="mt-4 text-lg font-semibold">Ask anything about your business</h2>
              <p className="mt-1 text-sm text-ink-500">Stock, warehouses, orders, customers, suppliers and profitability — answered from your own records.</p>
              <div className="mt-6 flex flex-wrap justify-center gap-2">{SUGGESTIONS.slice(0, 6).map((s) => <button key={s} onClick={() => submit(s)} className="rounded-full border border-ink-200 bg-white px-3 py-1.5 text-xs text-ink-700 hover:border-brand-300 hover:bg-brand-50">{s}</button>)}</div>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={cn('flex gap-3', m.role === 'user' && 'flex-row-reverse')}>
              <span className={cn('grid size-8 shrink-0 place-items-center rounded-full', m.role === 'user' ? 'bg-ink-800 text-white' : 'bg-brand-100 text-brand-700')}>{m.role === 'user' ? <User className="size-4" /> : <Bot className="size-4" />}</span>
              <div className={cn('max-w-[85%] rounded-2xl px-4 py-3', m.role === 'user' ? 'bg-ink-800 text-white' : m.mode === 'error' ? 'border border-red-200 bg-red-50' : 'border border-ink-200 bg-white')}>
                {m.role === 'user' ? <p className="text-sm">{m.content}</p> : <Markdown text={m.content} />}
                {m.role === 'assistant' && m.mode !== 'error' && (
                  <div className="mt-3 space-y-2 border-t border-ink-100 pt-2">
                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-500">
                      <Badge tone={m.mode === 'mistral' ? 'teal' : 'gray'}>{m.mode === 'mistral' ? 'Mistral AI · from your data' : 'Direct from your data (no AI model)'}</Badge>
                      {!!m.tools?.length && <details className="cursor-pointer"><summary className="inline-flex items-center gap-1"><Database className="size-3" />{m.tools.length} data source{m.tools.length > 1 ? 's' : ''}</summary><ul className="mt-1 space-y-0.5 pl-4">{m.tools.map((t, j) => <li key={j}><code>{t.name.replace('__attention', 'attention_items')}</code>{t.args && Object.keys(t.args).length ? ` ${JSON.stringify(t.args)}` : ''}{!t.ok && ' — not permitted'}</li>)}</ul></details>}
                      <span>{dateTime(m.at)}</span>
                    </div>
                    {m.notice && <p className="text-[11px] text-amber-700">{m.notice}</p>}
                    {m.proposedActions?.map((a, j) => <div key={j} className="rounded-xl border border-brand-200 bg-brand-50 p-3"><div className="text-sm font-medium text-brand-900">{a.label}</div><div className="text-xs text-brand-800">{a.description}</div><Button size="sm" variant="primary" className="mt-2" onClick={() => setAction(a)}><ShoppingCart /> Review & create drafts</Button></div>)}
                  </div>
                )}
              </div>
            </div>
          ))}
          {ask.isPending && <div className="flex gap-3"><span className="grid size-8 place-items-center rounded-full bg-brand-100 text-brand-700"><Bot className="size-4" /></span><div className="rounded-2xl border border-ink-200 bg-white px-4 py-3 text-sm text-ink-500"><span className="inline-flex gap-1"><span className="size-1.5 animate-bounce rounded-full bg-ink-400" /><span className="size-1.5 animate-bounce rounded-full bg-ink-400 [animation-delay:120ms]" /><span className="size-1.5 animate-bounce rounded-full bg-ink-400 [animation-delay:240ms]" /></span> Checking your data…</div></div>}
          <div ref={endRef} />
        </div>
        <form onSubmit={(e) => { e.preventDefault(); submit(input); }} className="flex gap-2 border-t border-ink-100 p-3">
          <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask about stock, orders, customers, space or profit…" className="h-11" maxLength={1000} />
          <Button type="submit" variant="primary" size="lg" disabled={!input.trim()} loading={ask.isPending} aria-label="Send"><Send /></Button>
        </form>
      </Card>
      <div className="space-y-4">
        <Card><CardHeader title="Try asking" /><div className="flex flex-col p-2">{SUGGESTIONS.map((s) => <button key={s} onClick={() => submit(s)} className="rounded-lg px-3 py-2 text-left text-sm text-ink-700 hover:bg-ink-100">{s}</button>)}</div></Card>
        <Card className="p-4 text-xs leading-relaxed text-ink-600"><div className="mb-1 flex items-center gap-1.5 font-semibold text-ink-800"><Lightbulb className="size-4 text-amber-500" />How the Copilot works</div>It looks up facts with read-only tools limited to what your role may see, then {configured ? 'Mistral writes the explanation from those facts only.' : 'the answer is assembled directly from those facts.'} It never changes stock or approves anything. Suggested actions open as drafts for you to review.</Card>
      </div>
      {action && <ConfirmDraftPos action={action} onClose={() => setAction(null)} />}
    </div>
  );
}

function ConfirmDraftPos({ action, onClose }: { action: any; onClose: () => void }) {
  const warehouses = useWarehouses();
  const navigate = useNavigate();
  const [warehouseId, setWarehouseId] = useState('');
  const [orders, setOrders] = useState(action.payload.orders as any[]);
  const m = useMutation({ mutationFn: () => api.post<any>('/ai/actions/confirm', { type: 'create_purchase_orders', warehouseId, orders: orders.map((o) => ({ supplierId: o.supplierId, lines: o.lines.filter((l: any) => l.quantity > 0).map((l: any) => ({ productId: l.productId, quantity: l.quantity, unitCost: l.unitCost })) })).filter((o) => o.lines.length) }), onSuccess: (r) => { toast.success(`Created ${r.created.length} draft PO(s): ${r.created.map((c: any) => c.number).join(', ')}`); onClose(); navigate('/purchasing?status=draft'); } });
  return (
    <Dialog open onOpenChange={onClose} title="Create draft purchase orders" description="Nothing is sent to suppliers. Drafts are checked by the system and must be submitted by you." size="lg" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={!warehouseId} onClick={() => m.mutate()}>Create drafts</Button></>}>
      <Field label="Deliver to warehouse" required><Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className="w-64"><option value="">Select…</option>{warehouses.data?.map((w) => <option key={w.id} value={w.id}>{w.code} · {w.name}</option>)}</Select></Field>
      <div className="mt-4 space-y-3">
        {orders.map((o, i) => (
          <Card key={o.supplierId}><CardHeader title={o.supplierName ?? 'Supplier'} />
            {o.lines.map((l: any, j: number) => <div key={l.productId} className="flex items-center justify-between gap-3 border-b border-ink-100 px-5 py-2 last:border-0"><span className="text-sm">{l.sku}</span><Input type="number" min={0} value={l.quantity} onChange={(e) => setOrders(orders.map((x, a) => (a === i ? { ...x, lines: x.lines.map((y: any, b: number) => (b === j ? { ...y, quantity: Number(e.target.value) } : y)) } : x)))} className="h-8 w-28 text-right" /></div>)}
          </Card>
        ))}
      </div>
    </Dialog>
  );
}

function Briefing() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ['briefing'], queryFn: () => api.get<any>('/ai/briefing') });
  const regen = useMutation({ mutationFn: () => api.post('/ai/briefing'), onSuccess: () => qc.invalidateQueries({ queryKey: ['briefing'] }) });
  if (error) return <Card><ErrorState error={error} /></Card>;
  if (isLoading || !data) return <Skeleton className="h-64" />;
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
      <Card className="p-6">
        <div className="flex items-center justify-between"><div className="text-xs font-semibold uppercase tracking-wider text-brand-700">Warehouse Intelligence Brief · {date(data.briefingDate)}</div><Button size="sm" variant="ghost" loading={regen.isPending} onClick={() => regen.mutate()}><RefreshCw /> Refresh</Button></div>
        <p className="mt-4 text-[15px] leading-relaxed text-ink-800">{data.content}</p>
        <p className="mt-4 text-xs text-ink-500">{data.generatedBy === 'mistral' ? 'Written by Mistral AI from the facts below.' : 'Generated from your data by rules (AI model not configured).'} Generated {dateTime(data.createdAt)}.</p>
      </Card>
      <Card><CardHeader title="Needs attention" />{(data.items as any[]).length ? (data.items as any[]).map((it, i) => <Link key={i} to={it.href} className="flex gap-3 border-b border-ink-100 px-5 py-3 text-sm last:border-0 hover:bg-ink-50"><span className={cn('mt-1.5 size-2 shrink-0 rounded-full', it.severity === 'critical' ? 'bg-red-500' : it.severity === 'warning' ? 'bg-amber-500' : 'bg-sky-500')} />{it.text}</Link>) : <p className="p-5 text-sm text-ink-500">Nothing urgent.</p>}</Card>
    </div>
  );
}

const ACTION_TONE: Record<string, any> = { order_now: 'red', increase_order: 'amber', reduce_order: 'violet', wait: 'green' };

function Reorder() {
  const { can } = useAuth();
  const [filter, setFilter] = useState('needs');
  const [selected, setSelected] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<any>(null);
  const { data, isLoading, error } = useQuery({ queryKey: ['reorder'], queryFn: () => api.get<any[]>('/ai/reorder') });
  const rows = (data ?? []).filter((r) => (filter === 'needs' ? ['order_now', 'increase_order'].includes(r.action) : filter === 'all' ? true : r.action === filter));
  const build = () => {
    const bySupplier = new Map<string, any>();
    for (const r of rows.filter((x) => selected.includes(x.productId) && x.supplierId && x.suggestedQty > 0)) {
      const g = bySupplier.get(r.supplierId) ?? { supplierId: r.supplierId, supplierName: r.supplierName, lines: [] };
      g.lines.push({ productId: r.productId, sku: r.sku, quantity: r.suggestedQty, unitCost: r.unitCost });
      bySupplier.set(r.supplierId, g);
    }
    setConfirm({ payload: { orders: [...bySupplier.values()] } });
  };
  return (
    <Card>
      <CardHeader title="Smart reorder" description="Current stock + incoming − back-orders − forecast demand over lead time. Recommendations only: nothing is ordered automatically."
        actions={can('purchase.manage') && <Button variant="primary" size="sm" disabled={!selected.length} onClick={build}><ShoppingCart /> Draft POs for {selected.length || ''} selected</Button>} />
      <div className="flex flex-wrap gap-1 border-b border-ink-100 p-3">{[['needs', 'Needs action'], ['order_now', 'Order now'], ['increase_order', 'Increase order'], ['reduce_order', 'Reduce order'], ['wait', 'Wait'], ['all', 'All']].map(([v, l]) => <button key={v} onClick={() => setFilter(v)} className={cn('rounded-full px-3 py-1 text-xs font-medium', filter === v ? 'bg-brand-700 text-white' : 'bg-ink-100 text-ink-600')}>{l}</button>)}</div>
      {error ? <ErrorState error={error} /> : <Table rows={rows} loading={isLoading} rowKey={(r) => r.productId} empty={<EmptyState title="Nothing to reorder" description="Stock covers expected demand." />} columns={[
        ...(can('purchase.manage') ? [{ key: 'sel', header: '', cell: (r: any) => <input type="checkbox" className="size-4 accent-brand-700" disabled={!r.supplierId || !r.suggestedQty} checked={selected.includes(r.productId)} onChange={() => setSelected((s) => (s.includes(r.productId) ? s.filter((x) => x !== r.productId) : [...s, r.productId]))} aria-label="Select" /> }] : []),
        { key: 'p', header: 'Product', cell: (r) => <div><Link to={`/products/${r.productId}`} className="font-medium hover:text-brand-700">{r.sku}</Link><div className="max-w-56 truncate text-xs text-ink-500">{r.name}</div></div> },
        { key: 'a', header: 'Recommendation', cell: (r) => <StatusBadge status={ACTION_TONE[r.action] === 'red' ? 'critical' : r.action === 'wait' ? 'ok' : 'warning'} label={humanize(r.action)} /> },
        { key: 'av', header: 'Available', align: 'right', cell: (r) => qty(r.available) }, { key: 'in', header: 'Incoming', align: 'right', hideOnMobile: true, cell: (r) => qty(r.incoming) },
        { key: 'f', header: 'Forecast', align: 'right', hideOnMobile: true, cell: (r) => qty(r.forecastDemand) }, { key: 's', header: 'Suggested', align: 'right', cell: (r) => <b className="num">{qty(r.suggestedQty)}</b> },
        { key: 'sup', header: 'Supplier', hideOnMobile: true, cell: (r) => r.supplierName ?? <span className="text-xs text-amber-700">No default supplier</span> },
        { key: 'why', header: 'Why', hideOnMobile: true, cell: (r) => <span className="block max-w-80 text-xs text-ink-500" title={r.reasoning}>{r.reasoning}</span> },
      ]} />}
      {confirm && <ConfirmDraftPos action={confirm} onClose={() => { setConfirm(null); setSelected([]); }} />}
    </Card>
  );
}

function Intelligence() {
  const [cls, setCls] = useState('all');
  const { data, isLoading } = useQuery({ queryKey: ['intelligence'], queryFn: () => api.get<any>('/ai/stock-intelligence') });
  const items = (data?.items ?? []).filter((x: any) => cls === 'all' || (cls === 'risk' ? x.stockoutRisk : x.classification === cls));
  return (
    <Card>
      <CardHeader title="Stock intelligence" description="Classified from the last 180 days of dispatches. Cover and forecasts are estimates." />
      <div className="flex flex-wrap gap-1 border-b border-ink-100 p-3">{[['all', 'All'], ['risk', `Stock-out risk (${data?.stockoutRisk ?? 0})`], ...['fast', 'slow', 'dead', 'overstock', 'understock', 'new', 'normal'].map((c) => [c, `${humanize(c)} (${data?.counts?.[c] ?? 0})`])].map(([v, l]) => <button key={v} onClick={() => setCls(v)} className={cn('rounded-full px-3 py-1 text-xs font-medium', cls === v ? 'bg-brand-700 text-white' : 'bg-ink-100 text-ink-600')}>{l}</button>)}</div>
      <Table rows={items.slice(0, 200)} loading={isLoading} rowKey={(r) => r.productId} columns={[
        { key: 'p', header: 'Product', cell: (r: any) => <div><Link to={`/products/${r.productId}`} className="font-medium hover:text-brand-700">{r.sku}</Link><div className="max-w-60 truncate text-xs text-ink-500">{r.name}</div></div> },
        { key: 'c', header: 'Class', cell: (r: any) => <div className="flex gap-1"><Badge tone={({ fast: 'green', slow: 'amber', dead: 'red', overstock: 'violet', understock: 'red', new: 'blue' } as any)[r.classification] ?? 'gray'}>{humanize(r.classification)}</Badge>{r.seasonal && <Badge tone="blue">Seasonal</Badge>}</div> },
        { key: 'oh', header: 'On hand', align: 'right', cell: (r: any) => qty(r.onHand) }, { key: 'd', header: 'Demand / month', align: 'right', cell: (r: any) => qty(r.monthlyDemand) },
        { key: 'cov', header: 'Cover', align: 'right', cell: (r: any) => r.monthsOfCover === null ? '—' : <span className={cn('num', r.stockoutRisk && 'font-semibold text-red-600')}>{r.monthsOfCover} mo</span> },
        { key: 't', header: 'Trend', hideOnMobile: true, cell: (r: any) => humanize(r.trend) },
        { key: 'm', header: 'Insight', hideOnMobile: true, cell: (r: any) => <span className="block max-w-96 text-xs text-ink-500">{r.message}</span> },
      ]} />
    </Card>
  );
}

function Anomalies() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [status, setStatus] = useState('open');
  const [review, setReview] = useState<any>(null);
  const [note, setNote] = useState('');
  const { data, isLoading } = useQuery({ queryKey: ['anomalies', status], queryFn: () => api.get<any[]>('/ai/anomalies', { status }) });
  const m = useMutation({ mutationFn: (s: string) => api.post(`/ai/anomalies/${review.id}/review`, { status: s, note }), onSuccess: () => { toast.success('Review recorded'); setReview(null); setNote(''); qc.invalidateQueries({ queryKey: ['anomalies'] }); } });
  return (
    <Card>
      <CardHeader title="Unusual activity" description="Detected statistically and by rules. These are prompts for human review — never accusations." actions={<Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-36"><option value="open">Open</option><option value="reviewed">Reviewed</option><option value="dismissed">Dismissed</option><option value="all">All</option></Select>} />
      {isLoading ? <Skeleton className="m-5 h-40" /> : !data?.length ? <EmptyState icon={AlertTriangle} title="No unusual activity" description="Adjustments, receiving quantities, short picks and stock levels look normal." /> : (
        <div className="divide-y divide-ink-100">{data.map((a) => (
          <div key={a.id} className="flex items-start gap-3 px-5 py-4">
            <AlertTriangle className={cn('mt-0.5 size-5 shrink-0', a.severity === 'critical' ? 'text-red-500' : a.severity === 'warning' ? 'text-amber-500' : 'text-sky-500')} />
            <div className="flex-1"><div className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink-900">{a.title}<StatusBadge status={a.status} /></div><p className="mt-0.5 text-sm text-ink-600">{a.description}</p><p className="mt-1 text-xs text-ink-400">Detected {dateTime(a.detected_at)}{a.review_note ? ` · Review: “${a.review_note}” by ${a.reviewed_by_name}` : ''}</p></div>
            {a.status === 'open' && can('inventory.approve', 'audit.view') && <Button size="sm" onClick={() => setReview(a)}>Review</Button>}
          </div>
        ))}</div>
      )}
      {review && <Dialog open onOpenChange={() => setReview(null)} title="Record review" description={review.title} footer={<><Button onClick={() => m.mutate('dismissed')} disabled={note.trim().length < 3}>Dismiss (normal)</Button><Button variant="primary" onClick={() => m.mutate('reviewed')} disabled={note.trim().length < 3}>Mark reviewed</Button></>}><Field label="Findings" required><Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Confirmed with supervisor: damaged cartons disposed, photos attached." /></Field></Dialog>}
    </Card>
  );
}

function Space() {
  const { data, isLoading } = useQuery({ queryKey: ['space'], queryFn: () => api.get<any[]>('/ai/space') });
  return (
    <Card>
      <CardHeader title="Smart space recommendations" description="Rule-based slotting from picking velocity, rack level, distance to dispatch and occupancy." />
      {isLoading ? <Skeleton className="m-5 h-40" /> : !data?.length ? <EmptyState title="No recommendations" description="Your slotting looks efficient." /> : (
        <div className="divide-y divide-ink-100">{data.map((r, i) => <div key={i} className="flex items-start gap-3 px-5 py-3"><Badge tone={r.priority === 'high' ? 'red' : r.priority === 'medium' ? 'amber' : 'blue'}>{r.priority}</Badge><div className="flex-1"><div className="text-sm font-medium">{r.title}</div><p className="text-xs text-ink-600">{r.detail}</p></div>{r.locationId && <Link to={`/inventory?locationId=${r.locationId}`} className="text-xs font-medium text-brand-700">View</Link>}</div>)}</div>
      )}
    </Card>
  );
}

function Documents() {
  const qc = useQueryClient();
  const [docType, setDocType] = useState('purchase_invoice');
  const [reviewId, setReviewId] = useState<string | null>(null);
  const docs = useQuery({ queryKey: ['documents'], queryFn: () => api.get<any[]>('/ai/documents'), refetchInterval: (q) => ((q.state.data ?? []).some((d: any) => ['uploaded', 'processing'].includes(d.status)) ? 2000 : false) });
  const upload = useMutation({ mutationFn: (file: File) => { const fd = new FormData(); fd.append('docType', docType); fd.append('file', file); return api.upload('/ai/documents', fd); }, onSuccess: () => { toast.success('Uploaded — extracting…'); qc.invalidateQueries({ queryKey: ['documents'] }); } });
  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Document type"><Select value={docType} onChange={(e) => setDocType(e.target.value)} className="w-52">{['purchase_invoice', 'purchase_order', 'delivery_note', 'grn', 'supplier_invoice', 'packing_list'].map((d) => <option key={d} value={d}>{humanize(d)}</option>)}</Select></Field>
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800"><FileUp className="size-4" />{upload.isPending ? 'Uploading…' : 'Upload PDF, image or CSV'}<input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.csv,.txt" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.target.value = ''; }} /></label>
          <p className="text-xs text-ink-500">Extracted data always waits for your review. Nothing is posted to stock or accounts automatically.</p>
        </div>
      </Card>
      <Card><Table rows={docs.data} loading={docs.isLoading} onRowClick={(d) => d.status === 'extracted' && setReviewId(d.id)} empty={<EmptyState icon={FileUp} title="No documents yet" description="Upload a supplier invoice or delivery note to extract its lines." />} columns={[
        { key: 'f', header: 'File', cell: (d: any) => <div><div className="font-medium">{d.fileName}</div><div className="text-xs text-ink-500">{humanize(d.docType)} · {(d.sizeBytes / 1024).toFixed(0)} KB</div></div> },
        { key: 'by', header: 'Uploaded', cell: (d: any) => `${d.uploadedBy} · ${dateTime(d.createdAt)}` },
        { key: 's', header: 'Status', cell: (d: any) => <div><StatusBadge status={d.status} />{d.error && <div className="mt-1 max-w-80 text-xs text-red-600">{d.error}</div>}</div> },
        { key: 'a', header: '', align: 'right', cell: (d: any) => d.status === 'extracted' && <Button size="sm" variant="primary">Review</Button> },
      ]} /></Card>
      {reviewId && <ReviewExtraction id={reviewId} onClose={() => setReviewId(null)} />}
    </div>
  );
}

function ReviewExtraction({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const warehouses = useWarehouses();
  const { data } = useQuery({ queryKey: ['document', id], queryFn: () => api.get<any>(`/ai/documents/${id}`) });
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [warehouseId, setWarehouseId] = useState('');
  const [lines, setLines] = useState<any[] | null>(null);
  useEffect(() => { if (data?.extraction) { setSupplierId(data.extraction.matchedSupplierId); setLines(data.extraction.extracted.lines.map((l: any, i: number) => ({ ...l, key: i, productId: l.matchedProductId }))); } }, [data]);
  const isDelivery = ['delivery_note', 'grn', 'packing_list'].includes(data?.docType);
  const approve = useMutation({
    mutationFn: () => api.post<any>(`/ai/documents/${id}/approve`, { supplierId, warehouseId, action: isDelivery ? 'prefill_receipt' : 'create_po', lines: (lines ?? []).filter((l) => l.productId && l.quantity > 0).map((l) => ({ productId: l.productId, quantity: Number(l.quantity), unitCost: Number(l.unitPrice ?? 0), batchNo: l.batch, expiryDate: l.expiry })) }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['documents'] }); if (r.purchaseOrder) { toast.success(`Draft ${r.purchaseOrder.number} created — review and submit it.`); navigate(`/purchasing/${r.purchaseOrder.id}`); } else { toast.success('Opening receiving with the extracted lines…'); navigate('/receiving/new', { state: { prefill: r.receiptPrefill } }); } onClose(); },
  });
  const reject = useMutation({ mutationFn: () => api.post(`/ai/documents/${id}/reject`), onSuccess: () => { qc.invalidateQueries({ queryKey: ['documents'] }); onClose(); } });
  if (!data || !lines) return null;
  const ex = data.extraction.extracted;
  return (
    <Dialog open onOpenChange={onClose} title={`Review: ${data.fileName}`} description={`Extracted by ${data.extraction.model}. Check every line before approving.`} size="xl"
      footer={<><Button variant="ghost" className="mr-auto text-red-600" onClick={() => reject.mutate()}>Reject</Button><Button onClick={onClose}>Close</Button><Button variant="primary" loading={approve.isPending} disabled={!supplierId || !warehouseId || !lines.some((l) => l.productId)} onClick={() => approve.mutate()}>{isDelivery ? 'Approve & open receiving' : 'Approve & create draft PO'}</Button></>}>
      <div className="mb-4 grid gap-4 sm:grid-cols-4">
        <Field label="Supplier (as read)"><Input value={ex.supplierName ?? ''} disabled /></Field>
        <Field label="Matched supplier" required><EntityPicker value={supplierId} onChange={setSupplierId} endpoint="/suppliers" map={(s) => ({ id: s.id, label: s.name })} placeholder="Select supplier" /></Field>
        <Field label="Invoice no. / date"><Input value={`${ex.invoiceNumber ?? '—'} · ${ex.date ?? '—'}`} disabled /></Field>
        <Field label="Warehouse" required><Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}><option value="">Select…</option>{warehouses.data?.map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}</Select></Field>
      </div>
      <div className="space-y-2">
        {lines.map((l, i) => (
          <div key={l.key} className={cn('grid gap-2 rounded-xl border p-3 sm:grid-cols-[1fr_1.2fr_90px_110px]', l.productId ? 'border-ink-200' : 'border-amber-300 bg-amber-50/50')}>
            <div className="text-xs"><div className="font-medium text-ink-800">{l.sku ?? '—'}</div><div className="text-ink-500">{l.description}</div>{l.batch && <div>Batch {l.batch} {l.expiry ? `· exp ${l.expiry}` : ''}</div>}</div>
            <EntityPicker value={l.productId} onChange={(pid) => setLines(lines.map((x, j) => (j === i ? { ...x, productId: pid } : x)))} endpoint="/products" placeholder={l.productId ? 'Matched product' : 'Match a product'} map={(p) => ({ id: p.id, label: `${p.sku} — ${p.name}` })} />
            <Input type="number" value={l.quantity ?? 0} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: Number(e.target.value) } : x)))} aria-label="Quantity" />
            <Input type="number" value={l.unitPrice ?? 0} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, unitPrice: Number(e.target.value) } : x)))} aria-label="Unit price" />
          </div>
        ))}
      </div>
      <p className="mt-3 text-right text-sm text-ink-600">Document total (as read): <b>{ex.total !== null && ex.total !== undefined ? money(ex.total) : '—'}</b></p>
    </Dialog>
  );
}

function MonthlyReport() {
  const [month, setMonth] = useState(today().slice(0, 7));
  const { data, isFetching, refetch } = useQuery({ queryKey: ['monthly-report', month], queryFn: () => api.get<any>('/ai/reports/monthly', { month }), enabled: false });
  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-end gap-3 p-5">
        <Field label="Month"><Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-44" /></Field>
        <Button variant="primary" loading={isFetching} onClick={() => refetch()}><Sparkles /> Prepare monthly warehouse performance report</Button>
        {data && <Button onClick={() => api.download('/ai/reports/monthly', { month, format: 'pdf' }, `monthly_report_${month}.pdf`)}>Download PDF</Button>}
      </Card>
      {data && (
        <Card className="p-6">
          <h2 className="text-lg font-semibold">{data.title}</h2>
          <p className="text-xs text-ink-500">{data.company} · {data.period.from} to {data.period.to} · {data.generatedBy === 'mistral' ? 'summary written by Mistral AI from system data' : 'generated from system data'}</p>
          <h3 className="mt-5 text-sm font-semibold">Executive summary</h3><p className="mt-1 text-sm leading-relaxed text-ink-700">{data.executiveSummary}</p>
          <h3 className="mt-5 text-sm font-semibold">Key performance indicators</h3>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">{data.kpis.map((k: any) => <div key={k.label} className="rounded-lg bg-ink-50 p-3"><div className="text-xs text-ink-500">{k.label}</div><div className="num font-semibold">{typeof k.value === 'number' ? qty(k.value, 0) : k.value}</div></div>)}</div>
          <Section title="Major issues" items={data.issues.length ? data.issues : ['No major issues recorded.']} />
          <Section title="Recommendations" items={data.recommendations} />
          {data.inventoryAnalysis.topMovers.length > 0 && <Section title="Top movers" items={data.inventoryAnalysis.topMovers.map((m: any) => `${m.sku} — ${m.name}: ${qty(m.units, 0)} units dispatched`)} />}
        </Card>
      )}
    </div>
  );
}

function Section({ title, items }: { title: string; items: ReactNode[] }) {
  return <><h3 className="mt-5 text-sm font-semibold">{title}</h3><ul className="mt-1 space-y-1 text-sm text-ink-700">{items.map((i, n) => <li key={n} className="flex gap-2"><span className="text-brand-600">•</span>{i}</li>)}</ul></>;
}
