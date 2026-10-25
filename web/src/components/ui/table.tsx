import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { request, qs, type Params } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button, EmptyState, ErrorState, Input, SkeletonRows } from './core';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell?: (row: T) => ReactNode;
  sortKey?: string;
  align?: 'left' | 'right' | 'center';
  className?: string;
  /** Hide on small screens (card view shows primary columns only). */
  hideOnMobile?: boolean;
}

interface TableProps<T> {
  columns: Column<T>[];
  rows: T[] | undefined;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  onRowClick?: (row: T) => void;
  rowKey?: (row: T) => string;
  empty?: ReactNode;
  sort?: { key?: string; dir: 'asc' | 'desc' };
  onSort?: (key: string) => void;
  dense?: boolean;
  footer?: ReactNode;
}

export function Table<T extends Record<string, any>>({ columns, rows, loading, error, onRetry, onRowClick, rowKey, empty, sort, onSort, dense, footer }: TableProps<T>) {
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (loading && !rows) return <SkeletonRows cols={Math.min(columns.length, 6)} />;
  if (!rows?.length) return <>{empty ?? <EmptyState title="Nothing here yet" />}</>;
  const align = (c: Column<T>) => (c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left');
  return (
    <div className={cn('relative', loading && 'opacity-60 transition-opacity')}>
      {/* Desktop / tablet table */}
      <div className="hidden overflow-x-auto md:block scrollbar-thin">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink-200 bg-ink-50/70">
              {columns.map((c) => (
                <th key={c.key} className={cn('whitespace-nowrap px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-ink-500', align(c), c.className)}>
                  {c.sortKey && onSort ? (
                    <button className="inline-flex items-center gap-1 uppercase hover:text-ink-800" onClick={() => onSort(c.sortKey!)}>
                      {c.header}{sort?.key === c.sortKey && (sort.dir === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
                    </button>
                  ) : c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {rows.map((r, i) => (
              <tr key={rowKey ? rowKey(r) : (r.id as string) ?? i} onClick={onRowClick ? () => onRowClick(r) : undefined} className={cn('bg-white', onRowClick && 'cursor-pointer hover:bg-brand-50/40')}>
                {columns.map((c) => <td key={c.key} className={cn('px-4 text-ink-700', dense ? 'py-2' : 'py-3', align(c), c.className)}>{c.cell ? c.cell(r) : (r[c.key] ?? '—')}</td>)}
              </tr>
            ))}
          </tbody>
          {footer && <tfoot className="border-t-2 border-ink-200 bg-ink-50 font-semibold">{footer}</tfoot>}
        </table>
      </div>
      {/* Mobile cards */}
      <div className="divide-y divide-ink-100 md:hidden">
        {rows.map((r, i) => (
          <div key={rowKey ? rowKey(r) : (r.id as string) ?? i} onClick={onRowClick ? () => onRowClick(r) : undefined} className={cn('space-y-1.5 bg-white px-4 py-3', onRowClick && 'active:bg-ink-50')}>
            {columns.filter((c) => !c.hideOnMobile).map((c, idx) => (
              <div key={c.key} className={cn('flex items-center justify-between gap-3 text-sm', idx === 0 && 'font-medium text-ink-900')}>
                {idx > 0 && <span className="text-xs text-ink-500">{c.header}</span>}
                <span className={cn('min-w-0', idx === 0 ? 'truncate' : 'text-right')}>{c.cell ? c.cell(r) : (r[c.key] ?? '—')}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function Pagination({ page, pageCount, total, pageSize, onPage }: { page: number; pageCount: number; total: number; pageSize: number; onPage: (p: number) => void }) {
  if (total <= pageSize) return total ? <div className="px-4 py-3 text-xs text-ink-500">{total} record{total === 1 ? '' : 's'}</div> : null;
  const from = (page - 1) * pageSize + 1;
  return (
    <div className="flex items-center justify-between gap-3 border-t border-ink-100 px-4 py-3">
      <span className="text-xs text-ink-500">{from.toLocaleString()}–{Math.min(total, page * pageSize).toLocaleString()} of {total.toLocaleString()}</span>
      <div className="flex items-center gap-1">
        <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page"><ChevronLeft /></Button>
        <span className="px-2 text-xs text-ink-600">Page {page} / {pageCount}</span>
        <Button size="sm" variant="ghost" disabled={page >= pageCount} onClick={() => onPage(page + 1)} aria-label="Next page"><ChevronRight /></Button>
      </div>
    </div>
  );
}

export function SearchInput({ value, onChange, placeholder = 'Search…', className }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  useEffect(() => { const t = setTimeout(() => { if (local !== value) onChange(local); }, 300); return () => clearTimeout(t); }, [local]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={cn('relative', className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-400" />
      <Input value={local} onChange={(e) => setLocal(e.target.value)} placeholder={placeholder} className="pl-8" />
    </div>
  );
}

/** Paged list backed by a REST endpoint returning { data, meta }. */
export function useServerList<T>(path: string, params: Params = {}, opts: { pageSize?: number; defaultSort?: string; enabled?: boolean } = {}) {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ key?: string; dir: 'asc' | 'desc' }>({ key: opts.defaultSort, dir: 'desc' });
  const pageSize = opts.pageSize ?? 25;
  const paramKey = JSON.stringify(params);
  useEffect(() => setPage(1), [paramKey, q]);
  const all = useMemo(() => ({ ...params, page, pageSize, q: q || undefined, sort: sort.key, dir: sort.dir }), [paramKey, page, pageSize, q, sort]); // eslint-disable-line react-hooks/exhaustive-deps
  const query = useQuery({
    queryKey: [path, all],
    queryFn: () => request<T[]>('GET', `${path}${qs(all)}`),
    placeholderData: keepPreviousData,
    enabled: opts.enabled ?? true,
  });
  const meta = query.data?.meta ?? {};
  return {
    rows: query.data?.data, meta, loading: query.isFetching, error: query.error, refetch: query.refetch,
    q, setQ, page, setPage, sort,
    onSort: (key: string) => setSort((s) => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' })),
    pagination: <Pagination page={page} pageCount={meta.pageCount ?? 1} total={meta.total ?? 0} pageSize={pageSize} onPage={setPage} />,
  };
}
