'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { safeStorage } from '../lib/safe-storage';

const KEY = 'clearview.focusDomain';
const DOMAINS = ['staff', 'patients', 'financial', 'marketing', 'equipment', 'inventory'] as const;

export function StoragePref() {
  const t = useTranslations('storage');
  const tDomains = useTranslations('domains');
  const [available, setAvailable] = useState(true);
  const [picked, setPicked] = useState<string | null>(null);

  // Reading storage happens after mount and is fully guarded — a blocked
  // localStorage yields isAvailable()=false and get()=null, never a crash.
  useEffect(() => {
    setAvailable(safeStorage.isAvailable());
    setPicked(safeStorage.get(KEY));
  }, []);

  function pick(domain: string): void {
    setPicked(domain);
    safeStorage.set(KEY, domain); // returns false if storage is blocked; never throws
  }

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-200">{t('label')}</h3>
        <span
          className={[
            'rounded-full px-2 py-0.5 text-xs',
            available ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300',
          ].join(' ')}
        >
          {available ? t('available') : t('unavailable')}
        </span>
      </div>
      <p className="mt-2 text-xs text-slate-400">{t('note')}</p>
      <p className="mt-4 text-xs uppercase tracking-wide text-slate-500">{t('pick')}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {DOMAINS.map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => pick(d)}
            className={[
              'rounded-lg px-3 py-1.5 text-sm transition-colors',
              picked === d
                ? 'bg-sky-500 text-white'
                : 'bg-slate-800 text-slate-300 hover:bg-slate-700',
            ].join(' ')}
          >
            {tDomains(d)}
          </button>
        ))}
      </div>
      {picked ? (
        <p className="mt-4 text-sm text-sky-300">{t('saved', { value: tDomains(picked) })}</p>
      ) : null}
    </div>
  );
}
