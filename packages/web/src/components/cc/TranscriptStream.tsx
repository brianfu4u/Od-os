'use client';

import { useTranslations } from 'next-intl';
import type { TranscriptFeedItem } from '../../lib/transcript-model';
import { TranscriptPanel } from './TranscriptPanel';

/**
 * Command-center live panel for the STT «listen» layer: voice evidence → transcript → claim →
 * verdict. Fed by useLiveData (voice Documents + Tasks), it updates in real time — the SSE stream
 * refetches on every object change (incl. the transcript.completed/failed writes), so a new/updated
 * transcript flows in without a manual refresh. Read-only rendering of real backend data (plus
 * clearly-flagged synthetic demo items when the env shim is on).
 */
export function TranscriptStream({
  items,
  onRetry,
}: {
  items: TranscriptFeedItem[];
  onRetry?: (id: string) => Promise<void> | void;
}) {
  const t = useTranslations();
  return (
    <section aria-label={t('transcript.title')} className="flex flex-col rounded-xl border border-slate-800 bg-slate-900/60">
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">{t('transcript.title')}</h2>
          <p className="text-xs text-slate-500">{t('transcript.subtitle')}</p>
        </div>
        <span className="flex items-center gap-1.5 text-[10px] text-emerald-300">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
          {t('transcript.listening')}
        </span>
      </div>
      <div className="max-h-[22rem] flex-1 space-y-2 overflow-y-auto p-3">
        {items.length === 0 ? (
          <p className="p-4 text-center text-sm text-slate-500">{t('transcript.empty')}</p>
        ) : (
          items.map((item) => <TranscriptPanel key={item.id} item={item} onRetry={onRetry} />)
        )}
      </div>
    </section>
  );
}
