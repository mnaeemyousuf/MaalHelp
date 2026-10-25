import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Permission } from '@shared/permissions';
import { api, ApiError, onUnauthorized } from './api';
import { setCurrency } from './utils';

export interface Me {
  user: { id: string; email: string; name: string; isPlatformAdmin: boolean };
  tenant: { id: string; name: string; baseCurrency: string; city: string; country: string; status: string; timezone: string; settings: any } | null;
  role: { key: string; name: string };
  permissions: string[];
  memberships: { tenantId: string; name: string; role: string; roleKey: string }[];
  onboarding: { needsWarehouse: boolean };
}

interface AuthValue {
  me: Me | null;
  loading: boolean;
  can: (...anyOf: Permission[]) => boolean;
  refresh: () => Promise<unknown>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try { return await api.get<Me>('/auth/me'); } catch (e) { if (e instanceof ApiError && e.status === 401) return null; throw e; }
    },
    staleTime: 60_000,
    retry: false,
  });
  useEffect(() => { if (data?.tenant) setCurrency(data.tenant.baseCurrency); }, [data]);
  useEffect(() => onUnauthorized(() => { qc.setQueryData(['me'], null); }), [qc]);
  const value: AuthValue = {
    me: data ?? null,
    loading: isLoading,
    can: (...anyOf) => !!data && anyOf.some((p) => data.permissions.includes(p)),
    refresh: () => refetch(),
    logout: async () => { await api.post('/auth/logout').catch(() => undefined); qc.clear(); qc.setQueryData(['me'], null); },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}

/** Floor roles land on the simplified mobile task app. */
export function isFloorRole(roleKey: string | undefined): boolean {
  return ['operator', 'receiving_clerk', 'picker_packer', 'dispatch_officer'].includes(roleKey ?? '');
}
