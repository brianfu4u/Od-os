'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { LocaleSwitcher } from '../LocaleSwitcher';
import { SessionProvider, useSession } from './SessionProvider';
import { LoginForm } from './LoginForm';

/**
 * The manager shell: a slim top bar (brand · locale · who · sign out) over a session gate. Nothing
 * fetches data until a session exists, so the static prerender stays crash-free and simply shows the
 * login. Each page wraps its content in <AppShell/>; the session token is persisted (safe-storage),
 * so navigating between the command center and a drill-down page keeps you signed in.
 */
function TopBar() {
  const t = useTranslations();
  const { session, logout, storageAvailable } = useSession();
  return (
    <header className="sticky top-0 z-10 border-b border-slate-800 bg-slate-950/90 backdrop-blur">
      <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-3 px-[4%] py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold tracking-tight text-slate-100">Clearview OD</span>
          <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] text-slate-400">{t('shell.tag')}</span>
        </div>
        <div className="flex items-center gap-3">
          {!storageAvailable ? (
            <span className="hidden text-[10px] text-amber-400/80 sm:inline" title={t('login.storageWarning')}>
              {t('shell.storageOff')}
            </span>
          ) : null}
          <LocaleSwitcher />
          {session ? (
            <div className="flex items-center gap-2">
              <span className="hidden text-[11px] text-slate-400 sm:inline">
                {session.identity.displayName ?? session.identity.role ?? t('shell.manager')}
              </span>
              <button
                type="button"
                onClick={() => void logout()}
                className="rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] text-slate-300 transition-colors hover:border-slate-500"
              >
                {t('shell.signOut')}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}

function Gate({ children }: { children: ReactNode }) {
  const t = useTranslations();
  const { session, ready } = useSession();
  if (!ready) {
    return <div className="px-[5%] py-16 text-center text-sm text-slate-500">{t('shell.loading')}</div>;
  }
  return session ? <>{children}</> : <LoginForm />;
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <div className="min-h-screen bg-slate-950 text-slate-100">
        <TopBar />
        <Gate>{children}</Gate>
      </div>
    </SessionProvider>
  );
}
