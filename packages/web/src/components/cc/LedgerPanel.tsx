'use client';

import { useTranslations } from 'next-intl';
import type { LedgerEntrySummary } from '@clearview/shared';
import { hhmm, pct } from '../../lib/format';

const STATE_META: Record<string, { icon: string; style: string }> = {
  verified: { icon: '✓', style: 'bg-emerald-500/20 text-emerald-300' },
  pending: { icon: '◐', style: 'bg-amber-500/20 text-amber-300' },
  conflict: { icon: '✕', style: 'bg-rose-500/20 text-rose-300' },
  unverified: { icon: '○', style: 'bg-slate-700/60 text-slate-300' },
};

function evidenceLabel(kind: string, t: (k: string) => string): string {
  const known = ['qr_scan', 'snapshot', 'document', 'communication', 'timing', 'cross_object'];
  return known.includes(kind) ? t(`ledger.evidenceKinds.${kind}`) : kind;
}

export function LedgerPanel({ ledger }: { ledger: LedgerEntrySummary[] }) {
  const t = useTranslations();
  return (
    <section aria-label={t('ledger.title')} className="flex flex-col rounded-xl border border-slate-800 bg-slate-900/60">
      <div className="border-b border-slate-800 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-100">{t('ledger.title')}</h2>
        <p className="text-xs text-slate-500">{t('ledger.subtitle')}</p>
      </div>
      <div className="max-h-[22rem] flex-1 space-y-2 overflow-y-auto p-3">
        {ledger.length === 0 ? (
          <p className="p-4 text-center text-sm text-slate-500">{t('ledger.empty')}</p>
        ) : (
          ledger.map((e, i) => {
            const meta = STATE_META[e.verifiedState] ?? STATE_META.unverified!;
            return (
              <div key={`${e.objectId}-${i}`} className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className={['grid h-5 w-5 place-items-center rounded-full text-[11px]', meta.style].join(' ')}>
                      {meta.icon}
                    </span>
                    <span className="text-sm text-slate-200">{e.title}</span>
                  </div>
                  <span className="shrink-0 font-mono text-[10px] text-slate-500">{hhmm(e.at)}</span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {e.evidenceKinds.map((k) => (
                    <span
                      key={k}
                      className="rounded-md border border-slate-700 bg-slate-800/60 px-1.5 py-0.5 text-[10px] text-slate-300"
                    >
                      {evidenceLabel(k, t)}
                    </span>
                  ))}
                  <span className={['ml-auto rounded-full px-2 py-0.5 text-[10px]', meta.style].join(' ')}>
                    {t(`ledger.states.${e.verifiedState}`)} · {pct(e.verificationScore)}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
