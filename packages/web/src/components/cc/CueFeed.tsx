'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { ActionResult, RecommendationRecord } from '@clearview/shared';
import { pct } from '../../lib/format';

function priority(rank: number): 'high' | 'med' | 'low' {
  if (rank <= 1) return 'high';
  if (rank <= 3) return 'med';
  return 'low';
}

const PRIORITY_STYLE: Record<'high' | 'med' | 'low', string> = {
  high: 'bg-rose-500/20 text-rose-300',
  med: 'bg-amber-500/20 text-amber-300',
  low: 'bg-slate-700/60 text-slate-300',
};

const RESULT_STYLE: Record<ActionResult, string> = {
  executed: 'bg-emerald-500/20 text-emerald-300',
  blocked_high_risk: 'bg-rose-500/20 text-rose-300',
  recorded_intent: 'bg-slate-700/60 text-slate-300',
  not_executable: 'bg-amber-500/20 text-amber-300',
  undone: 'bg-sky-500/20 text-sky-300',
};

export function CueFeed({
  recs,
  results,
  onApprove,
  onUndo,
  onDismiss,
  onSnooze,
}: {
  recs: RecommendationRecord[];
  results: RecommendationRecord[];
  onApprove: (id: string) => Promise<void>;
  onUndo: (id: string) => Promise<void>;
  onDismiss: (id: string) => Promise<void>;
  onSnooze: (id: string) => Promise<void>;
}) {
  const t = useTranslations();
  const [busy, setBusy] = useState<string | null>(null);

  async function run(id: string, fn: () => Promise<void>): Promise<void> {
    setBusy(id);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-label={t('cues.title')} className="flex h-full flex-col rounded-xl border border-slate-800 bg-slate-900/60">
      <div className="border-b border-slate-800 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-100">{t('cues.title')}</h2>
        <p className="text-xs text-slate-500">{t('cues.subtitle')}</p>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {/* Recently acted — the outcome of an approval (P2/S4), with undo for reversible executions. */}
        {results.length > 0 ? (
          <div className="space-y-2">
            <p className="text-[11px] uppercase tracking-wide text-slate-500">{t('cues.recent')}</p>
            {results.map((r) => {
              const state = (r.execution?.state ?? 'recorded_intent') as ActionResult;
              return (
                <div key={r.id} className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-xs font-medium text-slate-200">{r.title}</p>
                    <span className={['shrink-0 rounded-full px-2 py-0.5 text-[10px]', RESULT_STYLE[state]].join(' ')}>
                      {t(`results.${state}`)}
                    </span>
                  </div>
                  <div className="mt-1.5 flex items-center justify-between gap-2">
                    <span className="text-[10px] text-slate-500">
                      {r.execution?.actionType ? (
                        <code className="rounded bg-slate-800 px-1 py-0.5 text-slate-300">{r.execution.actionType}</code>
                      ) : null}
                    </span>
                    {state === 'executed' && r.execution?.undoable ? (
                      <button
                        type="button"
                        disabled={busy === r.id}
                        onClick={() => void run(r.id, () => onUndo(r.id))}
                        className="rounded-md border border-sky-500/40 px-2 py-0.5 text-[11px] text-sky-300 transition-colors hover:bg-sky-500/10 disabled:opacity-50"
                      >
                        {t('cues.undo')}
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}

        {recs.length === 0 && results.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-800 p-6 text-center text-sm text-slate-500">
            {t('cues.empty')}
          </p>
        ) : (
          recs.map((r) => {
            const prio = priority(r.rank);
            return (
              <article key={r.id} className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                <div className="flex items-start justify-between gap-3">
                  <h3 className="text-sm font-semibold text-slate-100">{r.title}</h3>
                  <span className={['shrink-0 rounded-full px-2 py-0.5 text-[10px]', PRIORITY_STYLE[prio]].join(' ')}>
                    {t(`cues.priority.${prio}`)}
                  </span>
                </div>

                <p className="mt-2 text-xs text-slate-400">
                  <span className="text-slate-500">{t('cues.why')}: </span>
                  {r.why}
                </p>

                {r.evidence.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {r.evidence.map((e, i) => (
                      <span
                        key={`${e.kind}-${i}`}
                        className="rounded-md border border-slate-700 bg-slate-800/60 px-2 py-0.5 text-[10px] text-slate-300"
                        title={e.note ?? e.ref ?? undefined}
                      >
                        {e.kind}
                        {e.note ? ` · ${e.note}` : ''}
                      </span>
                    ))}
                  </div>
                ) : null}

                {r.tradeoff ? (
                  <p className="mt-2 rounded-md bg-amber-500/10 px-2 py-1 text-[11px] text-amber-300">
                    ⚖ {t('cues.tradeoff')}: {r.tradeoff}
                  </p>
                ) : null}

                <div className="mt-3">
                  <div className="flex items-center justify-between text-[10px] text-slate-500">
                    <span>{t('cues.confidence')}</span>
                    <span className="tabular-nums text-slate-300">{pct(r.confidence)}</span>
                  </div>
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-sky-500 to-emerald-400"
                      style={{ width: `${Math.round(r.confidence * 100)}%` }}
                    />
                  </div>
                </div>

                {/* actions — human-in-the-loop gate */}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={busy === r.id}
                    onClick={() => void run(r.id, () => onApprove(r.id))}
                    className="rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-sky-400 disabled:opacity-50"
                  >
                    {t('cues.approve')}
                  </button>
                  <button
                    type="button"
                    disabled={busy === r.id}
                    onClick={() => void run(r.id, () => onSnooze(r.id))}
                    className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition-colors hover:border-slate-500 disabled:opacity-50"
                  >
                    {t('cues.snooze')}
                  </button>
                  <button
                    type="button"
                    disabled={busy === r.id}
                    onClick={() => void run(r.id, () => onDismiss(r.id))}
                    className="rounded-lg px-3 py-1.5 text-xs text-slate-400 transition-colors hover:text-slate-200 disabled:opacity-50"
                  >
                    {t('cues.dismiss')}
                  </button>
                  <span className="ml-auto text-[10px] text-slate-600">
                    {t('cues.source')}: {t(`agents.${r.sourceAgent}`)}
                  </span>
                </div>

                {r.actions.length > 0 ? (
                  <p className="mt-2 text-[10px] text-slate-500">
                    {t('cues.proposed')}: {r.actions.map((a) => a.label).join(' · ')}
                  </p>
                ) : null}
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}
