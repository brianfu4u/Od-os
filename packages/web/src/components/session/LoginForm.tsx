'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { DEV_TENANTS, IS_STAGING } from '../../lib/config';
import { useSession } from './SessionProvider';

/**
 * Manager sign-in. Two modes:
 *  - **staging** (`NEXT_PUBLIC_STAGING=true`): a single password field → the env-gated, password-
 *    protected `/auth/manager/staging-login` (the tenant is decided server-side). This is the only
 *    login exposed on the public staging env; the wide-open dev-login stays 404 in production.
 *  - **dev/local**: the tenant picker → the dev-gated `/auth/manager/dev-login` mock.
 */
export function LoginForm() {
  const t = useTranslations();
  const { login, stagingLogin, storageAvailable } = useSession();
  const [tenantId, setTenantId] = useState(DEV_TENANTS[0]!.id);
  const [name, setName] = useState('Dana · Manager');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (IS_STAGING) await stagingLogin(password);
      else await login(tenantId, name.trim() || 'manager', name.trim() || undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-[70vh] items-center justify-center px-[5%] py-10">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900/70 p-6 shadow-xl">
        <h1 className="text-lg font-semibold text-slate-100">{t('login.title')}</h1>
        <p className="mt-1 text-xs text-slate-500">{IS_STAGING ? t('login.stagingSubtitle') : t('login.subtitle')}</p>

        {IS_STAGING ? (
          <>
            <label className="mt-5 block text-xs font-medium text-slate-400">{t('login.password')}</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none"
              placeholder="••••••••"
            />
          </>
        ) : (
          <>
            <label className="mt-5 block text-xs font-medium text-slate-400">{t('login.tenant')}</label>
            <select
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none"
            >
              {DEV_TENANTS.map((tn) => (
                <option key={tn.id} value={tn.id}>
                  {tn.label}
                </option>
              ))}
            </select>

            <label className="mt-4 block text-xs font-medium text-slate-400">{t('login.name')}</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none"
              placeholder="manager"
            />
          </>
        )}

        {error ? <p className="mt-3 rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</p> : null}

        <button
          type="submit"
          disabled={busy}
          className="mt-5 w-full rounded-lg bg-sky-500 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-400 disabled:opacity-50"
        >
          {busy ? t('login.signingIn') : t('login.signIn')}
        </button>

        <p className="mt-4 text-[11px] leading-relaxed text-slate-500">{IS_STAGING ? t('login.stagingNote') : t('login.devNote')}</p>
        {!storageAvailable ? <p className="mt-2 text-[11px] text-amber-400/80">{t('login.storageWarning')}</p> : null}
      </form>
    </main>
  );
}
