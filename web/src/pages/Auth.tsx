import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { BarChart3, Boxes, ScanLine, ShieldCheck, Sparkles } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Button, Field, Input, Select } from '@/components/ui/core';
import { BrandLogo } from '@/components/Brand';

function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      <div className="relative hidden overflow-hidden bg-gradient-to-br from-brand-950 via-brand-900 to-brand-700 p-12 text-white lg:flex lg:flex-col">
        <BrandLogo tone="dark" size="lg" />
        <div className="my-auto max-w-lg">
          <h1 className="text-4xl font-semibold leading-tight text-white">Know your stock, your space and your money — in one place.</h1>
          <p className="mt-4 text-brand-100">The warehouse operating system for traders, wholesalers and distributors. Simple enough for the floor team, powerful enough for the owner.</p>
          <ul className="mt-10 space-y-4 text-sm">
            {[[Boxes, 'Accurate stock by warehouse, bin, batch and expiry — every movement on an immutable ledger'], [ScanLine, 'Scan-driven receiving, putaway, picking and packing on any Android phone'], [BarChart3, 'Owner command center: capacity, receivables, profitability and alerts'], [Sparkles, 'AI Copilot that answers from your real data, never guesses'], [ShieldCheck, 'Roles, approvals and a full audit trail for staff accountability']].map(([Icon, text], i) => (
              <li key={i} className="flex gap-3"><span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent-500/20 text-accent-300"><Icon className="size-4" /></span><span className="pt-1.5 text-brand-50">{text as string}</span></li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-brand-200">Built for Pakistan & South Asia · PKR, USD, AED, SAR, GBP, EUR</p>
      </div>
      <div className="flex items-center justify-center bg-white px-6 py-12">{children}</div>
    </div>
  );
}

export function Login() {
  const { me, refresh } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (me) return <Navigate to={params.get('next') || '/'} replace />;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await api.post('/auth/login', { email, password });
      qc.clear();
      await refresh();
      navigate(params.get('next') || '/', { replace: true });
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  };
  return (
    <AuthLayout>
      <form onSubmit={submit} className="w-full max-w-sm space-y-5">
        <div className="lg:hidden"><BrandLogo /></div>
        <div><h2 className="text-2xl font-semibold">Sign in</h2><p className="mt-1 text-sm text-ink-500">Welcome back to Maal Help. Sign in to your company workspace.</p></div>
        {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        <Field label="Email"><Input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoFocus /></Field>
        <Field label="Password"><Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>Sign in</Button>
        <p className="text-center text-sm text-ink-500">New to Maal Help? <Link to="/register" className="font-medium text-brand-700 hover:underline">Create your company</Link></p>
        <p className="text-center text-xs text-ink-400">Forgot your password? Ask your company administrator to issue a temporary password from Settings → Users.</p>
      </form>
    </AuthLayout>
  );
}

export function Register() {
  const { me, refresh } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ company: '', name: '', email: '', phone: '', city: 'Karachi', currency: 'PKR', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (me) return <Navigate to="/" replace />;
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try { await api.post('/auth/register', form); await refresh(); navigate('/settings/onboarding', { replace: true }); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  };
  return (
    <AuthLayout>
      <form onSubmit={submit} className="w-full max-w-md space-y-4">
        <div><h2 className="text-2xl font-semibold">Create your company</h2><p className="mt-1 text-sm text-ink-500">Start a 30-day trial. You'll be the business owner with full access.</p></div>
        {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        <Field label="Company name" required><Input required value={form.company} onChange={set('company')} placeholder="e.g. Al-Madina Traders" /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Your name" required><Input required value={form.name} onChange={set('name')} /></Field>
          <Field label="Mobile number"><Input value={form.phone} onChange={set('phone')} placeholder="+92 300 1234567" /></Field>
        </div>
        <Field label="Work email" required><Input type="email" required value={form.email} onChange={set('email')} /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="City"><Input value={form.city} onChange={set('city')} /></Field>
          <Field label="Currency"><Select value={form.currency} onChange={set('currency')}>{['PKR', 'USD', 'AED', 'SAR', 'GBP', 'EUR'].map((c) => <option key={c}>{c}</option>)}</Select></Field>
        </div>
        <Field label="Password" required hint="At least 10 characters with letters and numbers."><Input type="password" required minLength={10} value={form.password} onChange={set('password')} autoComplete="new-password" /></Field>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>Create company</Button>
        <p className="text-center text-sm text-ink-500">Already have an account? <Link to="/login" className="font-medium text-brand-700 hover:underline">Sign in</Link></p>
      </form>
    </AuthLayout>
  );
}
