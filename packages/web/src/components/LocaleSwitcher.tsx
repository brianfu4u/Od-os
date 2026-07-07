'use client';

import { useLocale } from 'next-intl';
import { routing } from '../i18n/routing';

const LABELS: Record<string, string> = {
  zh: '中文',
  en: 'English',
  ja: '日本語',
};

export function LocaleSwitcher() {
  const active = useLocale();
  return (
    <nav aria-label="language" className="flex items-center gap-1 rounded-full bg-slate-800/70 p-1">
      {routing.locales.map((loc) => (
        <a
          key={loc}
          href={`/${loc}`}
          className={[
            'rounded-full px-3 py-1 text-sm transition-colors',
            loc === active
              ? 'bg-sky-500 text-white'
              : 'text-slate-300 hover:bg-slate-700 hover:text-white',
          ].join(' ')}
        >
          {LABELS[loc] ?? loc}
        </a>
      ))}
    </nav>
  );
}
