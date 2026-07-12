'use client';

import { useTranslations } from 'next-intl';
import type { CommSummary } from '@clearview/shared';
import { hhmm, initials } from '../../lib/format';

const KNOWN_REPORT_TYPES = ['clock_in', 'clock_out', 'task_update', 'event', 'evidence', 'scan', 'support_request'];

/** Maps a report type to the LLM "listening" annotation shown under each message. */
function annotationKey(reportType?: string): string {
  switch (reportType) {
    case 'scan':
      return 'comms.annScan';
    case 'evidence':
      return 'comms.annEvidence';
    case 'task_update':
      return 'comms.annTask';
    case 'support_request':
      return 'comms.annSupport';
    case 'clock_in':
    case 'clock_out':
      return 'comms.annClock';
    default:
      return 'comms.annDefault';
  }
}

export function CommsPanel({ comms }: { comms: CommSummary[] }) {
  const t = useTranslations();
  return (
    <section aria-label={t('comms.title')} className="flex flex-col rounded-xl border border-slate-800 bg-slate-900/60">
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">{t('comms.title')}</h2>
          <p className="text-xs text-slate-500">{t('comms.subtitle')}</p>
        </div>
        <span className="flex items-center gap-1.5 text-[10px] text-emerald-300">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
          {t('comms.listening')}
        </span>
      </div>
      <div className="max-h-[20rem] flex-1 space-y-3 overflow-y-auto p-4">
        {comms.length === 0 ? (
          <p className="p-4 text-center text-sm text-slate-500">{t('comms.empty')}</p>
        ) : (
          comms.map((c) => (
            <div key={c.id} className="flex gap-3">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-slate-800 text-xs font-medium text-slate-300">
                {initials(c.author)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-slate-200">{c.author}</span>
                  {c.reportType ? (
                    <span
                      className={[
                        'rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wide',
                        c.reportType === 'support_request' ? 'bg-rose-500/20 text-rose-300' : 'bg-slate-800 text-slate-400',
                      ].join(' ')}
                    >
                      {KNOWN_REPORT_TYPES.includes(c.reportType)
                        ? t(`comms.reportTypes.${c.reportType}`)
                        : c.reportType}
                    </span>
                  ) : null}
                  <span className="ml-auto font-mono text-[10px] text-slate-500">{hhmm(c.at)}</span>
                </div>
                {c.text ? <p className="mt-0.5 break-words text-sm text-slate-300">{c.text}</p> : null}
                <p className="mt-1 flex items-center gap-1 text-[10px] text-sky-300/80">
                  <span aria-hidden>✦</span>
                  {t(annotationKey(c.reportType))}
                </p>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
