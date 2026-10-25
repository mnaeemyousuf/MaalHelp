import {
  ArrowLeftRight, BarChart3, Bell, Boxes, Building2, ClipboardCheck, ClipboardList, Coins, FileSearch, Gauge, HandCoins, LayoutDashboard, MapPinned,
  PackageCheck, PackageOpen, PackagePlus, Receipt, RotateCcw, Settings, ShieldCheck, ShoppingCart, Sparkles, Truck, Users, Warehouse, Wallet, ScanLine, ServerCog,
} from 'lucide-react';
import type { Permission } from '@shared/permissions';

export interface NavItem { label: string; to: string; icon: React.ComponentType<{ className?: string }>; perms: Permission[]; badge?: 'alerts' | 'approvals' | 'putaway' | 'picking' }
export interface NavGroup { label: string; items: NavItem[] }

export const NAV: NavGroup[] = [
  { label: 'Overview', items: [
    { label: 'Dashboard', to: '/', icon: LayoutDashboard, perms: ['dashboard.view'] },
    { label: 'AI Copilot', to: '/ai', icon: Sparkles, perms: ['ai.use'] },
    { label: 'Alerts', to: '/alerts', icon: Bell, perms: ['alert.view', 'dashboard.view', 'inventory.view'], badge: 'alerts' },
    { label: 'Approvals', to: '/approvals', icon: ShieldCheck, perms: ['approval.decide'], badge: 'approvals' },
  ] },
  { label: 'Inventory', items: [
    { label: 'Inventory', to: '/inventory', icon: Boxes, perms: ['inventory.view'] },
    { label: 'Products', to: '/products', icon: PackageOpen, perms: ['product.view'] },
    { label: 'Warehouses', to: '/warehouses', icon: Warehouse, perms: ['warehouse.view'] },
    { label: 'Transfers', to: '/transfers', icon: ArrowLeftRight, perms: ['transfer.request', 'transfer.execute', 'transfer.approve'] },
    { label: 'Stock counts', to: '/stock-counts', icon: ClipboardCheck, perms: ['inventory.count'] },
  ] },
  { label: 'Inbound', items: [
    { label: 'Purchasing', to: '/purchasing', icon: ShoppingCart, perms: ['purchase.view'] },
    { label: 'Receiving', to: '/receiving', icon: PackagePlus, perms: ['receiving.execute'] },
    { label: 'Putaway', to: '/putaway', icon: MapPinned, perms: ['putaway.execute'], badge: 'putaway' },
    { label: 'Suppliers', to: '/suppliers', icon: Building2, perms: ['purchase.view', 'supplier.manage'] },
  ] },
  { label: 'Outbound', items: [
    { label: 'Sales orders', to: '/orders', icon: ClipboardList, perms: ['sales.view'] },
    { label: 'Picking', to: '/picking', icon: ScanLine, perms: ['picking.execute', 'task.manage'], badge: 'picking' },
    { label: 'Packing', to: '/packing', icon: PackageCheck, perms: ['packing.execute'] },
    { label: 'Dispatch', to: '/dispatch', icon: Truck, perms: ['dispatch.execute'] },
    { label: 'Returns', to: '/returns', icon: RotateCcw, perms: ['returns.manage'] },
    { label: 'Customers', to: '/customers', icon: Users, perms: ['customer.view'] },
  ] },
  { label: 'Finance', items: [
    { label: 'Billing', to: '/billing', icon: Receipt, perms: ['billing.view'] },
    { label: 'Storage billing', to: '/storage-billing', icon: HandCoins, perms: ['billing.view'] },
    { label: 'Expenses', to: '/expenses', icon: Wallet, perms: ['expense.view'] },
    { label: 'Profitability', to: '/profitability', icon: Coins, perms: ['report.financial'] },
  ] },
  { label: 'Insights', items: [
    { label: 'Reports', to: '/reports', icon: BarChart3, perms: ['report.view', 'report.financial', 'billing.view'] },
    { label: 'Audit trail', to: '/audit', icon: FileSearch, perms: ['audit.view'] },
  ] },
  { label: 'System', items: [
    { label: 'Settings', to: '/settings', icon: Settings, perms: ['settings.manage', 'user.manage', 'integration.manage', 'import.execute'] },
    { label: 'Mobile tasks', to: '/m', icon: Gauge, perms: ['receiving.execute', 'putaway.execute', 'picking.execute', 'packing.execute', 'dispatch.execute', 'inventory.count', 'transfer.execute'] },
  ] },
];

export const PLATFORM_NAV: NavItem = { label: 'Platform admin', to: '/platform', icon: ServerCog, perms: [] };
