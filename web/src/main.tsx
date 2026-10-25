import { StrictMode, Suspense, lazy, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster, toast } from 'sonner';
import { registerSW } from 'virtual:pwa-register';
import './styles.css';
import { AuthProvider, isFloorRole, useAuth } from './lib/auth';
import { errorMessage } from './lib/api';
import { AppShell } from './components/layout/AppShell';
import { Spinner } from './components/ui/core';

registerSW({ immediate: true });

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: false, retry: (count, err: any) => count < 1 && !(err?.status >= 400 && err?.status < 500) } },
  mutationCache: new MutationCache({ onError: (err, _v, _c, mutation) => { if (!mutation.meta?.silent) toast.error(errorMessage(err)); } }),
});

/** Lazy-load a named export so each area ships as its own chunk. */
const L = <T,>(loader: () => Promise<T>, name: keyof T) => lazy(() => loader().then((m) => ({ default: m[name] as unknown as ComponentType<any> })));
const auth = () => import('./pages/Auth');
const dash = () => import('./pages/Dashboard');
const inv = () => import('./pages/Inventory');
const prod = () => import('./pages/Products');
const wh = () => import('./pages/Warehouses');
const inbound = () => import('./pages/Inbound');
const purch = () => import('./pages/Purchasing');
const sales = () => import('./pages/Sales');
const ful = () => import('./pages/Fulfillment');
const ops = () => import('./pages/Operations');
const parties = () => import('./pages/Parties');
const fin = () => import('./pages/Finance');
const rep = () => import('./pages/Reports');
const ai = () => import('./pages/Ai');
const admin = () => import('./pages/Admin');
const settings = () => import('./pages/Settings');
const platform = () => import('./pages/Platform');
const mobile = () => import('./pages/Mobile');
const print = () => import('./pages/Print');

const Login = L(auth, 'Login'), Register = L(auth, 'Register');
const Dashboard = L(dash, 'Dashboard');
const Inventory = L(inv, 'Inventory');
const Products = L(prod, 'Products'), ProductDetail = L(prod, 'ProductDetail');
const Warehouses = L(wh, 'Warehouses'), WarehouseDetail = L(wh, 'WarehouseDetail');
const Receiving = L(inbound, 'Receiving'), ReceiveGoods = L(inbound, 'ReceiveGoods'), ReceiptDetail = L(inbound, 'ReceiptDetail'), Putaway = L(inbound, 'Putaway');
const Purchasing = L(purch, 'Purchasing'), PurchaseOrderForm = L(purch, 'PurchaseOrderForm'), PurchaseOrderDetail = L(purch, 'PurchaseOrderDetail');
const Orders = L(sales, 'Orders'), OrderForm = L(sales, 'OrderForm'), OrderDetail = L(sales, 'OrderDetail');
const Picking = L(ful, 'Picking'), Packing = L(ful, 'Packing'), Dispatch = L(ful, 'Dispatch');
const Transfers = L(ops, 'Transfers'), TransferDetail = L(ops, 'TransferDetail'), Returns = L(ops, 'Returns'), StockCounts = L(ops, 'StockCounts'), CountDetail = L(ops, 'CountDetail');
const Customers = L(parties, 'Customers'), CustomerDetail = L(parties, 'CustomerDetail'), Suppliers = L(parties, 'Suppliers'), SupplierDetail = L(parties, 'SupplierDetail');
const Billing = L(fin, 'Billing'), InvoiceDetail = L(fin, 'InvoiceDetail'), StorageBilling = L(fin, 'StorageBilling'), Expenses = L(fin, 'Expenses'), Profitability = L(fin, 'Profitability');
const Reports = L(rep, 'Reports'), ReportView = L(rep, 'ReportView');
const Ai = L(ai, 'Ai');
const Alerts = L(admin, 'Alerts'), Approvals = L(admin, 'Approvals'), Audit = L(admin, 'Audit');
const Settings = L(settings, 'Settings');
const Platform = L(platform, 'Platform');
const MobileApp = L(mobile, 'MobileApp');
const PrintDocument = L(print, 'PrintDocument');

function Loading() {
  return <div className="grid min-h-[50vh] place-items-center"><Spinner className="size-6" /></div>;
}

function Protected({ children }: { children: React.ReactNode }) {
  const { me, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="grid min-h-screen place-items-center"><Spinner className="size-6" /></div>;
  if (!me) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  if (!me.tenant && me.user.isPlatformAdmin && !location.pathname.startsWith('/platform')) return <Navigate to="/platform" replace />;
  return <>{children}</>;
}

function Home() {
  const { me, can } = useAuth();
  if (isFloorRole(me?.role.key) || (!can('dashboard.view') && can('picking.execute', 'receiving.execute', 'dispatch.execute'))) return <Navigate to="/m" replace />;
  if (!can('dashboard.view')) return <Navigate to={can('inventory.view') ? '/inventory' : '/settings/profile'} replace />;
  return <Dashboard />;
}

function App() {
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/m/*" element={<Protected><MobileApp /></Protected>} />
        <Route path="/print/:kind/:id" element={<Protected><PrintDocument /></Protected>} />
        <Route element={<Protected><AppShell /></Protected>}>
          <Route index element={<Home />} />
          <Route path="inventory" element={<Inventory />} />
          <Route path="products" element={<Products />} />
          <Route path="products/:id" element={<ProductDetail />} />
          <Route path="warehouses" element={<Warehouses />} />
          <Route path="warehouses/:id" element={<WarehouseDetail />} />
          <Route path="receiving" element={<Receiving />} />
          <Route path="receiving/new" element={<ReceiveGoods />} />
          <Route path="receiving/:id" element={<ReceiptDetail />} />
          <Route path="putaway" element={<Putaway />} />
          <Route path="purchasing" element={<Purchasing />} />
          <Route path="purchasing/new" element={<PurchaseOrderForm />} />
          <Route path="purchasing/:id" element={<PurchaseOrderDetail />} />
          <Route path="orders" element={<Orders />} />
          <Route path="orders/new" element={<OrderForm />} />
          <Route path="orders/:id" element={<OrderDetail />} />
          <Route path="picking" element={<Picking />} />
          <Route path="packing" element={<Packing />} />
          <Route path="dispatch" element={<Dispatch />} />
          <Route path="transfers" element={<Transfers />} />
          <Route path="transfers/:id" element={<TransferDetail />} />
          <Route path="returns" element={<Returns />} />
          <Route path="stock-counts" element={<StockCounts />} />
          <Route path="stock-counts/:id" element={<CountDetail />} />
          <Route path="customers" element={<Customers />} />
          <Route path="customers/:id" element={<CustomerDetail />} />
          <Route path="suppliers" element={<Suppliers />} />
          <Route path="suppliers/:id" element={<SupplierDetail />} />
          <Route path="billing" element={<Billing />} />
          <Route path="billing/invoices/:id" element={<InvoiceDetail />} />
          <Route path="storage-billing" element={<StorageBilling />} />
          <Route path="expenses" element={<Expenses />} />
          <Route path="profitability" element={<Profitability />} />
          <Route path="reports" element={<Reports />} />
          <Route path="reports/:key" element={<ReportView />} />
          <Route path="ai" element={<Ai />} />
          <Route path="alerts" element={<Alerts />} />
          <Route path="approvals" element={<Approvals />} />
          <Route path="audit" element={<Audit />} />
          <Route path="settings/*" element={<Settings />} />
          <Route path="platform/*" element={<Platform />} />
          <Route path="*" element={<div className="py-20 text-center"><h1 className="text-lg font-semibold">Page not found</h1><a href="/" className="mt-2 inline-block text-sm text-brand-700">Back to dashboard</a></div>} />
        </Route>
      </Routes>
    </Suspense>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <App />
          <Toaster position="top-right" richColors closeButton />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
