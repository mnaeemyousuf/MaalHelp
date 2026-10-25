import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Building, ChevronRight, Grid3x3, LayoutGrid, Map, Plus, Printer, Save, Warehouse as WarehouseIcon } from 'lucide-react';
import { CAPACITY_UNITS, WAREHOUSE_TYPES } from '@shared/domain';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn, humanize, money, pct, qty } from '@/lib/utils';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, Input, Progress, Select, Skeleton, StatusBadge } from '@/components/ui/core';
import { Dialog, Tabs } from '@/components/ui/overlay';
import { KeyValue, PageHeader, StatCard } from '@/components/ui/blocks';
import { Table } from '@/components/ui/table';
import { LabelDialog } from './Products';

export function Warehouses() {
  const { can } = useAuth();
  const [create, setCreate] = useState(false);
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['warehouses'], queryFn: () => api.get<any[]>('/warehouses') });
  return (
    <div>
      <PageHeader title="Warehouses" description="Sites, capacity and the zone → aisle → rack → shelf → bin hierarchy." actions={can('warehouse.manage') && <Button variant="primary" onClick={() => setCreate(true)}><Plus /> New warehouse</Button>} />
      {error ? <Card><ErrorState error={error} onRetry={refetch} /></Card> : isLoading ? <div className="grid gap-4 md:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-56 rounded-xl" />)}</div> : !data?.length ? (
        <Card><EmptyState icon={WarehouseIcon} title="No warehouses yet" description="Create your first warehouse. Receiving and dispatch docks are added automatically." action={can('warehouse.manage') && <Button variant="primary" onClick={() => setCreate(true)}><Plus /> New warehouse</Button>} /></Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.map((w) => (
            <Link key={w.id} to={`/warehouses/${w.id}`} className="card group block p-5 hover:border-brand-300">
              <div className="flex items-start justify-between">
                <div><div className="flex items-center gap-2"><span className="font-mono text-xs font-semibold text-brand-700">{w.code}</span><StatusBadge status={w.status} /></div><h3 className="mt-1 text-base font-semibold">{w.name}</h3><p className="text-xs text-ink-500">{w.city} · {humanize(w.type)}{w.managerName ? ` · ${w.managerName}` : ''}</p></div>
                <ChevronRight className="size-5 text-ink-300 group-hover:text-brand-600" />
              </div>
              <div className="mt-5 flex items-end justify-between"><span className="num text-3xl font-semibold">{pct(w.capacityStats.utilizationPct, 0)}</span><span className="text-xs text-ink-500">{qty(w.capacityStats.used, 0)} of {qty(w.capacityStats.capacity, 0)} {w.capacityUnit}</span></div>
              <div className="mt-2"><Progress value={w.capacityStats.utilizationPct} /></div>
              <div className="mt-4 grid grid-cols-3 gap-2 text-center text-xs">
                <div className="rounded-lg bg-ink-50 py-2"><div className="num font-semibold text-ink-800">{w.capacityStats.totalLocations}</div><div className="text-ink-500">locations</div></div>
                <div className="rounded-lg bg-ink-50 py-2"><div className="num font-semibold text-ink-800">{w.capacityStats.emptyLocations}</div><div className="text-ink-500">empty</div></div>
                <div className="rounded-lg bg-ink-50 py-2"><div className="num font-semibold text-ink-800">{can('finance.view') ? money(w.capacityStats.stockValue, { compact: true }) : w.capacityStats.overloadedLocations}</div><div className="text-ink-500">{can('finance.view') ? 'stock value' : 'overloaded'}</div></div>
              </div>
            </Link>
          ))}
        </div>
      )}
      {create && <WarehouseForm onClose={() => setCreate(false)} />}
    </div>
  );
}

function WarehouseForm({ warehouse, onClose }: { warehouse?: any; onClose: () => void }) {
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['users-directory'], queryFn: () => api.get<any[]>('/users/directory') });
  const [f, setF] = useState<any>(warehouse ?? { code: '', name: '', type: 'owned', address: '', city: '', capacity: 500, capacityUnit: 'pallets', contactName: '', contactPhone: '', operatingHours: 'Mon–Sat 09:00–18:00', managerUserId: '' });
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.type === 'number' ? Number(e.target.value) : e.target.value });
  const m = useMutation({
    mutationFn: () => { const body = { code: f.code, name: f.name, type: f.type, address: f.address, city: f.city, capacity: f.capacity, capacityUnit: f.capacityUnit, contactName: f.contactName, contactPhone: f.contactPhone, operatingHours: f.operatingHours, managerUserId: f.managerUserId || null }; return warehouse ? api.patch(`/warehouses/${warehouse.id}`, body) : api.post('/warehouses', body); },
    onSuccess: () => { toast.success(warehouse ? 'Warehouse updated' : 'Warehouse created with receiving and dispatch docks'); qc.invalidateQueries({ queryKey: ['warehouses'] }); qc.invalidateQueries({ queryKey: ['warehouse'] }); onClose(); },
  });
  return (
    <Dialog open onOpenChange={onClose} title={warehouse ? 'Edit warehouse' : 'New warehouse'} size="lg" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={!f.code || !f.name} onClick={() => m.mutate()}>Save</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Code" required hint="e.g. KHI-01"><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} disabled={!!warehouse} /></Field>
        <Field label="Name" required><Input value={f.name} onChange={set('name')} /></Field>
        <Field label="Type"><Select value={f.type} onChange={set('type')}>{WAREHOUSE_TYPES.map((t) => <option key={t} value={t}>{humanize(t)}</option>)}</Select></Field>
        <Field label="Manager"><Select value={f.managerUserId ?? ''} onChange={set('managerUserId')}><option value="">—</option>{users.data?.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.roleName})</option>)}</Select></Field>
        <Field label="Address" className="sm:col-span-2"><Input value={f.address} onChange={set('address')} /></Field>
        <Field label="City"><Input value={f.city} onChange={set('city')} /></Field>
        <Field label="Operating hours"><Input value={f.operatingHours} onChange={set('operatingHours')} /></Field>
        <Field label="Capacity"><Input type="number" min={0} value={f.capacity} onChange={set('capacity')} /></Field>
        <Field label="Capacity unit" hint="Cubic and pallet units use product dimensions"><Select value={f.capacityUnit} onChange={set('capacityUnit')}>{CAPACITY_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}</Select></Field>
        <Field label="Contact person"><Input value={f.contactName} onChange={set('contactName')} /></Field>
        <Field label="Contact phone"><Input value={f.contactPhone} onChange={set('contactPhone')} /></Field>
      </div>
    </Dialog>
  );
}

export function WarehouseDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const [tab, setTab] = useState('map');
  const [edit, setEdit] = useState(false);
  const [generate, setGenerate] = useState(false);
  const w = useQuery({ queryKey: ['warehouse', id], queryFn: () => api.get<any>(`/warehouses/${id}`) });
  const locations = useQuery({ queryKey: ['locations', id], queryFn: () => api.get<any[]>(`/warehouses/${id}/locations`) });
  if (w.error) return <Card><ErrorState error={w.error} onRetry={w.refetch} /></Card>;
  if (!w.data) return <Skeleton className="h-96" />;
  const c = w.data.capacityStats;
  return (
    <div>
      <PageHeader back={{ to: '/warehouses', label: 'Warehouses' }} title={w.data.name} description={`${w.data.code} · ${w.data.city} · ${humanize(w.data.type)}${w.data.operatingHours ? ` · ${w.data.operatingHours}` : ''}`}
        actions={can('warehouse.manage') && <><Button onClick={() => setEdit(true)}>Edit</Button><Button variant="primary" onClick={() => setGenerate(true)}><LayoutGrid /> Generate zone layout</Button></>} />
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Capacity used" value={pct(c.utilizationPct)} sub={`${qty(c.used)} of ${qty(c.capacity)} ${c.capacityUnit}`} tone={c.utilizationPct >= 95 ? 'danger' : c.utilizationPct >= 85 ? 'warn' : 'good'} />
        <StatCard label="Free capacity" value={qty(c.free)} sub={c.capacityUnit} />
        <StatCard label="Storage locations" value={c.totalLocations} sub={`${c.occupiedLocations} occupied`} />
        <StatCard label="Empty locations" value={c.emptyLocations} tone="good" />
        <StatCard label="Overloaded / underused" value={`${c.overloadedLocations} / ${c.underutilizedLocations}`} tone={c.overloadedLocations ? 'danger' : 'default'} />
        <StatCard label="Cubic utilisation" value={c.capacityVolumeM3 ? pct((c.usedVolumeM3 / c.capacityVolumeM3) * 100) : '—'} sub={`${qty(c.usedVolumeM3)} of ${qty(c.capacityVolumeM3)} m³`} />
      </div>
      <Tabs value={tab} onValueChange={setTab} tabs={[{ value: 'map', label: <span className="flex items-center gap-1.5"><Map className="size-4" />Space map</span> }, { value: 'tree', label: <span className="flex items-center gap-1.5"><Grid3x3 className="size-4" />Locations</span> }, { value: 'utilization', label: 'Utilisation' }, { value: 'info', label: 'Details' }]} />
      <div className="mt-4">
        {locations.isLoading ? <Skeleton className="h-96" /> : locations.error ? <Card><ErrorState error={locations.error} /></Card> : (
          <>
            {tab === 'map' && <SpaceMap warehouse={w.data} locations={locations.data ?? []} editable={can('warehouse.manage')} />}
            {tab === 'tree' && <LocationTree warehouse={w.data} locations={locations.data ?? []} />}
            {tab === 'utilization' && <Utilization warehouseId={id!} />}
            {tab === 'info' && <Card className="p-5"><KeyValue cols={3} items={[['Code', w.data.code], ['Type', humanize(w.data.type)], ['Status', <StatusBadge key="s" status={w.data.status} />], ['Address', w.data.address], ['City', w.data.city], ['Operating hours', w.data.operatingHours], ['Contact', `${w.data.contactName} ${w.data.contactPhone}`], ['Capacity', `${qty(w.data.capacity)} ${w.data.capacityUnit}`], ['Area', `${qty(w.data.totalAreaSqm)} m²`]]} /></Card>}
          </>
        )}
      </div>
      {edit && <WarehouseForm warehouse={w.data} onClose={() => setEdit(false)} />}
      {generate && <GenerateDialog warehouseId={id!} onClose={() => setGenerate(false)} />}
    </div>
  );
}

const utilColor = (u: number, used: number) => (used <= 0 ? 'bg-white border-ink-200 text-ink-400' : u > 1 ? 'bg-red-500 border-red-600 text-white' : u >= 0.9 ? 'bg-amber-400 border-amber-500 text-amber-950' : u >= 0.5 ? 'bg-brand-500 border-brand-600 text-white' : 'bg-brand-200 border-brand-300 text-brand-900');

function SpaceMap({ warehouse, locations, editable }: { warehouse: any; locations: any[]; editable: boolean }) {
  const qc = useQueryClient();
  const CELL = 28;
  const blocks = useMemo(() => locations.filter((l) => ['rack', 'dock', 'staging'].includes(l.type) || (l.type === 'zone' && !locations.some((c) => c.parentId === l.id))).filter((l) => l.mapX !== null && l.mapY !== null), [locations]);
  const zones = locations.filter((l) => l.type === 'zone');
  const [pos, setPos] = useState<Record<string, { x: number; y: number }>>({});
  const [selected, setSelected] = useState<any | null>(null);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  useEffect(() => setPos({}), [locations]);
  const at = (l: any) => pos[l.id] ?? { x: l.mapX, y: l.mapY };
  const cols = Math.max(warehouse.mapCols, ...blocks.map((b) => at(b).x + b.mapW + 1));
  const rows = Math.max(warehouse.mapRows, ...blocks.map((b) => at(b).y + b.mapH + 1));
  const dirty = Object.keys(pos).length > 0;
  const save = useMutation({
    mutationFn: () => api.put(`/warehouses/${warehouse.id}/map`, { items: Object.entries(pos).map(([id, p]) => ({ id, mapX: p.x, mapY: p.y })) }),
    onSuccess: () => { toast.success('Layout saved'); qc.invalidateQueries({ queryKey: ['locations', warehouse.id] }); },
  });
  const zoneOf = (l: any) => zones.find((z) => l.code === z.code || l.code.startsWith(`${z.code}-`));
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current || !boardRef.current) return;
    const rect = boardRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.round((e.clientX - rect.left - drag.current.dx) / CELL));
    const y = Math.max(0, Math.round((e.clientY - rect.top - drag.current.dy) / CELL));
    setPos((p) => ({ ...p, [drag.current!.id]: { x, y } }));
  };
  const rackBins = selected ? locations.filter((l) => l.code.startsWith(`${selected.code}-`) && !locations.some((c) => c.parentId === l.id)) : [];
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
      <Card className="overflow-hidden">
        <CardHeader title="Space map" description={editable ? 'Drag racks and docks to match your floor plan, then save. Colour shows how full each rack is.' : 'Colour shows how full each rack is. Click a rack to see its bins.'}
          actions={editable && <Button size="sm" variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}><Save /> Save layout</Button>} />
        <div className="flex flex-wrap gap-3 border-b border-ink-100 px-5 py-2 text-[11px] text-ink-600">
          {[['bg-white border border-ink-300', 'Empty'], ['bg-brand-200', '< 50%'], ['bg-brand-500', '50–90%'], ['bg-amber-400', '90–100%'], ['bg-red-500', 'Over capacity']].map(([c, l]) => <span key={l} className="flex items-center gap-1.5"><span className={cn('size-3 rounded', c)} />{l}</span>)}
        </div>
        <div className="overflow-auto bg-[radial-gradient(circle,#e2e8f0_1px,transparent_1px)] p-4 [background-size:28px_28px]">
          <div ref={boardRef} className="relative touch-none" style={{ width: cols * CELL, height: rows * CELL }} onPointerMove={onPointerMove} onPointerUp={() => (drag.current = null)} onPointerLeave={() => (drag.current = null)}>
            {zones.map((z) => {
              const members = blocks.filter((b) => zoneOf(b)?.id === z.id);
              if (!members.length) return null;
              const minX = Math.min(...members.map((b) => at(b).x)), minY = Math.min(...members.map((b) => at(b).y));
              const maxX = Math.max(...members.map((b) => at(b).x + b.mapW)), maxY = Math.max(...members.map((b) => at(b).y + b.mapH));
              return <div key={z.id} className="pointer-events-none absolute rounded-xl border-2 border-dashed border-ink-300/80 bg-white/40" style={{ left: minX * CELL - 6, top: minY * CELL - 22, width: (maxX - minX) * CELL + 12, height: (maxY - minY) * CELL + 28 }}><span className="absolute left-2 top-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-500">{z.name} · {Math.round(z.utilization * 100)}%</span></div>;
            })}
            {blocks.map((b) => {
              const p = at(b);
              const isDock = b.type === 'dock' || b.type === 'staging';
              return (
                <button key={b.id} type="button" title={`${b.code} · ${Math.round(b.utilization * 100)}% · ${qty(b.usedUnits, 0)} units`}
                  onPointerDown={(e) => { setSelected(b); if (!editable || !boardRef.current) return; const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); drag.current = { id: b.id, dx: e.clientX - r.left, dy: e.clientY - r.top }; }}
                  className={cn('absolute flex select-none items-center justify-center rounded-md border text-[10px] font-semibold shadow-sm transition-shadow', isDock ? 'border-sky-400 bg-sky-100 text-sky-800' : utilColor(b.utilization, b.usedUnits), editable && 'cursor-grab active:cursor-grabbing', selected?.id === b.id && 'ring-2 ring-ink-900 ring-offset-1')}
                  style={{ left: p.x * CELL, top: p.y * CELL, width: b.mapW * CELL - 4, height: b.mapH * CELL - 4 }}>
                  {isDock ? b.name : b.code.split('-').slice(-1)[0]}
                </button>
              );
            })}
            {!blocks.length && <div className="absolute inset-0 grid place-items-center text-sm text-ink-500">Generate a zone layout to populate the map.</div>}
          </div>
        </div>
      </Card>
      <Card>
        <CardHeader title={selected ? selected.code : 'Rack details'} description={selected ? `${humanize(selected.type)} · ${Math.round(selected.utilization * 100)}% used` : 'Select a rack on the map'} />
        {selected ? (
          <div className="space-y-4 p-5">
            <KeyValue items={[['Units', qty(selected.usedUnits, 0)], ['SKU slots', selected.skuCount], ['Volume', `${qty(selected.usedVolumeM3)} / ${qty(selected.capacityVolumeM3)} m³`], ['Bins', `${selected.occupiedBins} / ${selected.binCount} occupied`]]} />
            {rackBins.length > 0 && <div className="grid grid-cols-4 gap-1.5">{rackBins.map((b) => <Link key={b.id} to={`/inventory?locationId=${b.id}`} title={`${b.code}: ${qty(b.usedUnits, 0)} units`} className={cn('rounded border px-1 py-1.5 text-center text-[9px] font-semibold', utilColor(b.utilization, b.usedUnits))}>{b.code.split('-').slice(-2).join('-')}</Link>)}</div>}
            <Link to={`/inventory?locationId=${selected.id}`} className="block text-xs font-medium text-brand-700">View stock in {selected.code} →</Link>
          </div>
        ) : <div className="p-5 text-sm text-ink-500">Click any rack to inspect its shelves and bins. Docks are shown in blue.</div>}
      </Card>
    </div>
  );
}

function LocationTree({ warehouse, locations }: { warehouse: any; locations: any[] }) {
  const { can } = useAuth();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [labels, setLabels] = useState<any[] | null>(null);
  const [add, setAdd] = useState<{ parent: any | null } | null>(null);
  const children = (pid: string | null) => locations.filter((l) => l.parentId === pid).sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  const leaves = (l: any): any[] => { const k = children(l.id); return k.length ? k.flatMap(leaves) : [l]; };
  const Row = ({ l, depth }: { l: any; depth: number }) => {
    const kids = children(l.id);
    return (
      <>
        <div className="flex items-center gap-2 border-b border-ink-100 py-2 pr-4 hover:bg-ink-50" style={{ paddingLeft: 12 + depth * 20 }}>
          <button className={cn('grid size-5 place-items-center rounded text-ink-400', !kids.length && 'invisible')} onClick={() => setOpen({ ...open, [l.id]: !open[l.id] })}><ChevronRight className={cn('size-4 transition', open[l.id] && 'rotate-90')} /></button>
          <span className="font-mono text-xs font-semibold text-ink-800">{l.code}</span>
          <Badge tone={l.type === 'zone' ? 'teal' : l.type === 'dock' || l.type === 'staging' ? 'blue' : 'gray'}>{humanize(l.type)}</Badge>
          {l.status === 'blocked' && <Badge tone="red">Blocked</Badge>}
          <span className="hidden flex-1 truncate text-xs text-ink-500 sm:block">{l.name}{l.temperatureClass !== 'ambient' ? ` · ${l.temperatureClass}` : ''}</span>
          <span className="ml-auto w-28"><Progress value={l.utilization * 100} /></span>
          <span className="num w-20 text-right text-xs text-ink-600">{qty(l.usedUnits, 0)} u</span>
          <span className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => setLabels(leaves(l))} title="Print labels"><Printer /></Button>
            {can('warehouse.manage') && kids.length >= 0 && l.type !== 'bin' && l.type !== 'dock' && l.type !== 'staging' && <Button size="sm" variant="ghost" onClick={() => setAdd({ parent: l })} title="Add child"><Plus /></Button>}
          </span>
        </div>
        {open[l.id] && kids.map((k) => <Row key={k.id} l={k} depth={depth + 1} />)}
      </>
    );
  };
  return (
    <Card>
      <CardHeader title="Location hierarchy" description="Every location has a unique barcode for scanning." actions={<>{can('warehouse.manage') && <Button size="sm" onClick={() => setAdd({ parent: null })}><Plus /> Zone / dock</Button>}<Button size="sm" onClick={() => setLabels(locations.filter((l) => !locations.some((c) => c.parentId === l.id)))}><Printer /> All bin labels</Button></>} />
      {children(null).length ? children(null).map((l) => <Row key={l.id} l={l} depth={0} />) : <EmptyState icon={Building} title="No locations" />}
      {labels && <LabelDialog title={`Location labels (${labels.length})`} onClose={() => setLabels(null)} items={labels.map((l) => ({ code: l.barcode, title: `${warehouse.code} · ${l.code}`, sub: l.name, symbology: 'code128' as const }))} />}
      {add && <AddLocationDialog warehouseId={warehouse.id} parent={add.parent} onClose={() => setAdd(null)} />}
    </Card>
  );
}

function AddLocationDialog({ warehouseId, parent, onClose }: { warehouseId: string; parent: any | null; onClose: () => void }) {
  const qc = useQueryClient();
  const childType = parent ? ({ zone: 'aisle', aisle: 'rack', rack: 'shelf', shelf: 'bin' } as Record<string, string>)[parent.type] ?? 'bin' : 'zone';
  const [f, setF] = useState({ type: childType, segment: '', name: '', capacityUnits: 0, capacityVolumeM3: 0.5, temperatureClass: parent?.temperatureClass ?? 'ambient', isPickable: childType === 'bin' });
  const m = useMutation({ mutationFn: () => api.post(`/warehouses/${warehouseId}/locations`, { ...f, parentId: parent?.id ?? null }), onSuccess: () => { toast.success('Location created'); qc.invalidateQueries({ queryKey: ['locations', warehouseId] }); onClose(); } });
  return (
    <Dialog open onOpenChange={onClose} title={parent ? `Add inside ${parent.code}` : 'Add zone or dock'} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={!f.segment} onClick={() => m.mutate()}>Create</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Type"><Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value, isPickable: e.target.value === 'bin' || e.target.value === 'shelf' })}>{(parent ? ['aisle', 'rack', 'shelf', 'bin'] : ['zone', 'dock', 'staging']).map((t) => <option key={t} value={t}>{humanize(t)}</option>)}</Select></Field>
        <Field label="Code segment" hint={`Full code: ${parent ? `${parent.code}-` : ''}${f.segment || '…'}`}><Input value={f.segment} onChange={(e) => setF({ ...f, segment: e.target.value.toUpperCase() })} placeholder={f.type === 'bin' ? 'B01' : f.type === 'rack' ? 'R01' : 'A'} /></Field>
        <Field label="Name (optional)"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Temperature"><Select value={f.temperatureClass} onChange={(e) => setF({ ...f, temperatureClass: e.target.value })}><option value="ambient">Ambient</option><option value="chilled">Chilled</option><option value="frozen">Frozen</option></Select></Field>
        <Field label="Unit capacity" hint="0 = not limited by units"><Input type="number" min={0} value={f.capacityUnits} onChange={(e) => setF({ ...f, capacityUnits: Number(e.target.value) })} /></Field>
        <Field label="Volume capacity m³"><Input type="number" min={0} step="any" value={f.capacityVolumeM3} onChange={(e) => setF({ ...f, capacityVolumeM3: Number(e.target.value) })} /></Field>
      </div>
    </Dialog>
  );
}

function GenerateDialog({ warehouseId, onClose }: { warehouseId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ zoneCode: 'D', zoneName: '', aisles: 2, racksPerAisle: 4, shelvesPerRack: 3, binsPerShelf: 4, binCapacityUnits: 0, binVolumeM3: 1.2, temperatureClass: 'ambient', pickPriority: 50, originX: 6, originY: 10 });
  const n = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: Number(e.target.value) });
  const total = f.aisles * f.racksPerAisle * f.shelvesPerRack * f.binsPerShelf;
  const m = useMutation({ mutationFn: () => api.post<any>(`/warehouses/${warehouseId}/locations/generate`, f), onSuccess: (r) => { toast.success(`Created ${r.created} locations`); qc.invalidateQueries({ queryKey: ['locations', warehouseId] }); qc.invalidateQueries({ queryKey: ['warehouse', warehouseId] }); onClose(); } });
  return (
    <Dialog open onOpenChange={onClose} title="Generate zone layout" description="Creates a zone with aisles, racks, shelves and bins, each with its own barcode." size="lg"
      footer={<><span className="mr-auto self-center text-sm text-ink-600">Creates <b>{total.toLocaleString()}</b> bins · codes like <span className="font-mono">{f.zoneCode}-01-R01-S01-B01</span></span><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={!f.zoneCode || total > 5000} onClick={() => m.mutate()}>Generate</Button></>}>
      <div className="grid gap-4 sm:grid-cols-4">
        <Field label="Zone code"><Input value={f.zoneCode} onChange={(e) => setF({ ...f, zoneCode: e.target.value.toUpperCase() })} /></Field>
        <Field label="Zone name" className="sm:col-span-3"><Input value={f.zoneName} onChange={(e) => setF({ ...f, zoneName: e.target.value })} placeholder="e.g. Zone D · Overflow" /></Field>
        <Field label="Aisles"><Input type="number" min={1} max={30} value={f.aisles} onChange={n('aisles')} /></Field>
        <Field label="Racks / aisle"><Input type="number" min={1} max={40} value={f.racksPerAisle} onChange={n('racksPerAisle')} /></Field>
        <Field label="Shelves / rack"><Input type="number" min={1} max={10} value={f.shelvesPerRack} onChange={n('shelvesPerRack')} /></Field>
        <Field label="Bins / shelf"><Input type="number" min={1} max={20} value={f.binsPerShelf} onChange={n('binsPerShelf')} /></Field>
        <Field label="Bin volume m³"><Input type="number" step="any" min={0} value={f.binVolumeM3} onChange={n('binVolumeM3')} /></Field>
        <Field label="Bin unit cap." hint="0 = by volume"><Input type="number" min={0} value={f.binCapacityUnits} onChange={n('binCapacityUnits')} /></Field>
        <Field label="Pick priority" hint="1 = nearest dispatch"><Input type="number" min={1} max={100} value={f.pickPriority} onChange={n('pickPriority')} /></Field>
        <Field label="Temperature"><Select value={f.temperatureClass} onChange={(e) => setF({ ...f, temperatureClass: e.target.value })}><option value="ambient">Ambient</option><option value="chilled">Chilled</option><option value="frozen">Frozen</option></Select></Field>
      </div>
    </Dialog>
  );
}

function Utilization({ warehouseId }: { warehouseId: string }) {
  const { data, isLoading } = useQuery({ queryKey: ['utilization', warehouseId], queryFn: () => api.get<any>(`/warehouses/${warehouseId}/utilization`) });
  if (isLoading || !data) return <Skeleton className="h-80" />;
  const cols = [
    { key: 'code', header: 'Location', cell: (r: any) => <span className="font-mono text-xs font-medium">{r.code}</span> },
    { key: 'u', header: 'Utilisation', cell: (r: any) => <div className="flex w-40 items-center gap-2"><Progress value={r.utilizationPct} /><span className="num w-12 text-right text-xs">{pct(r.utilizationPct, 0)}</span></div> },
    { key: 'units', header: 'Units', align: 'right' as const, cell: (r: any) => <span className="num">{qty(r.usedUnits, 0)}</span> },
    { key: 'vol', header: 'Volume m³', align: 'right' as const, cell: (r: any) => <span className="num text-xs">{qty(r.usedVolumeM3)} / {qty(r.capacityVolumeM3)}</span> },
  ];
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card><CardHeader title="Zones" /><Table rows={data.zones} columns={[...cols, { key: 'bins', header: 'Bins used', align: 'right', cell: (r: any) => `${r.occupiedBins}/${r.binCount}` }]} dense /></Card>
      <Card><CardHeader title="Overloaded locations" description="Above configured capacity — move stock out" /><Table rows={data.overloaded} columns={cols} dense empty={<div className="p-6 text-center text-sm text-ink-500">No overloaded locations.</div>} /></Card>
      <Card><CardHeader title="Underutilised locations" description="Under 20% used — consolidation candidates" /><Table rows={data.underutilized.slice(0, 50)} columns={cols} dense empty={<div className="p-6 text-center text-sm text-ink-500">None.</div>} /></Card>
      <Card><CardHeader title="Racks" /><Table rows={data.racks.slice(0, 60)} columns={cols} dense /></Card>
    </div>
  );
}
