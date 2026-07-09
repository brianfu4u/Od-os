'use client';

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import type { DomainStatus, DomainVM } from '../../lib/domain-model';

const STATUS_STYLE: Record<DomainStatus, string> = {
  action: 'bg-rose-500/20 text-rose-300',
  watch: 'bg-amber-500/20 text-amber-300',
  steady: 'bg-emerald-500/20 text-emerald-300',
};

export function DomainGrid({ tiles }: { tiles: DomainVM[] }) {
  const t = useTranslations();
  const locale = useLocale();
  return (
    <section aria-label={t('cc.domainsHeading')}>
      <h2 className="text-sm font-semibold text-slate-200">{t('cc.domainsHeading')}</h2>
      <p className="text-xs text-slate-500">{t('cc.domainsTagline')}</p>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {tiles.map((tile) => {
          const note =
            tile.status === 'action'
              ? t('domains.noteAction', { n: tile.cueCount })
              : tile.status === 'watch'
                ? t('domains.noteWatch')
                : t(`domains.notes.${tile.key}`);
          return (
            <Link
              key={tile.key}
              href={`/${locale}/domain/${tile.key}`}
              className="group block rounded-xl border border-slate-800 bg-slate-900/60 p-4 transition-colors hover:border-sky-600/60 hover:bg-slate-900"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-lg" aria-hidden>
                    {tile.icon}
                  </span>
                  <h3 className="text-sm font-semibold text-slate-100">{t(`domains.${tile.key}`)}</h3>
                </div>
                <span className={['rounded-full px-2 py-0.5 text-[11px]', STATUS_STYLE[tile.status]].join(' ')}>
                  {t(`domains.status.${tile.status}`)}
                </span>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                {tile.metrics.map((m) => (
                  <div key={m.label}>
                    <p className="text-xl font-semibold tabular-nums text-slate-100">{m.value}</p>
                    <p className="text-[11px] text-slate-500">{t(`domains.metrics.${m.label}`)}</p>
                  </div>
                ))}
              </div>
              <p className="mt-3 flex items-center justify-between gap-1.5 text-[11px] text-slate-400">
                <span className="flex items-center gap-1.5">
                  <span className="text-sky-400" aria-hidden>
                    ✦
                  </span>
                  {note}
                </span>
                <span className="text-sky-400/70 transition-transform group-hover:translate-x-0.5" aria-hidden>
                  {t('domains.drilldown')} →
                </span>
              </p>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
