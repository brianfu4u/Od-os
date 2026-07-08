'use client';

import { useTranslations } from 'next-intl';

const STAGES = ['sense', 'map', 'verify', 'reason', 'recommend', 'act', 'learn'] as const;

/** The 7-stage agentic loop; "act" (approve) is highlighted as the human-in-the-loop gate. */
export function LoopStrip() {
  const t = useTranslations('loop');
  return (
    <section aria-label={t('label')}>
      <p className="text-[10px] uppercase tracking-[0.2em] text-slate-500">{t('label')}</p>
      <ol className="mt-2 flex flex-wrap items-center gap-1.5">
        {STAGES.map((stage, i) => {
          const isGate = stage === 'act';
          return (
            <li key={stage} className="flex items-center gap-1.5">
              <span
                className={[
                  'rounded-md border px-2.5 py-1 text-xs',
                  isGate
                    ? 'border-sky-400/60 bg-sky-500/15 text-sky-200 shadow-[0_0_0_1px_rgba(56,189,248,0.25)]'
                    : 'border-slate-800 bg-slate-900/60 text-slate-300',
                ].join(' ')}
              >
                <span className="mr-1 text-slate-500">{i + 1}</span>
                {t(`stages.${stage}`)}
                {isGate ? <span className="ml-1 text-sky-300">· {t('gate')}</span> : null}
              </span>
              {i < STAGES.length - 1 ? <span className="text-slate-700">→</span> : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
