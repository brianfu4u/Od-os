'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { MyTaskSummary } from '@clearview/shared';
import type { Api } from '../../lib/api';
import { pct } from '../../lib/format';

/** Verdict colours — the verdict is ONLY Task.verifiedState (S2); null renders as unverified. */
const VERIFY_STYLE: Record<string, string> = {
  verified: 'bg-emerald-500/20 text-emerald-300',
  conflict: 'bg-rose-500/20 text-rose-300',
  pending: 'bg-amber-500/20 text-amber-300',
  unverified: 'bg-slate-700/60 text-slate-400',
};
const KNOWN = ['verified', 'conflict', 'pending', 'unverified'];

/**
 * T5 · "My tasks" — the staff's own assigned task queue (read-only projection from GET /tasks/mine).
 * Status badges use the command-center verdict vocabulary: the verdict comes ONLY from the Task's
 * verified_state (deterministic S2); a task with no verdict shows as `unverified`, never verified.
 * Picking a task hands it up to the terminal as the current subject so the existing report / photo /
 * scan / recording flows target it. Empty / failure degrade to a clear message, never a blank screen.
 */
export function MyTasks({ api, onPick }: { api: Api; onPick: (task: MyTaskSummary) => void }) {
  const t = useTranslations();
  const [tasks, setTasks] = useState<MyTaskSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        setTasks(await api.myTasks(signal));
        setError(null);
      } catch (e) {
        if ((e as { name?: string }).name === 'AbortError') return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">{t('mytasks.title')}</h2>
          <p className="mt-0.5 text-xs text-slate-500">{t('mytasks.subtitle')}</p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] text-slate-300 active:bg-slate-800 disabled:opacity-50"
        >
          {t('mytasks.refresh')}
        </button>
      </div>

      <div className="mt-3 space-y-2">
        {loading ? (
          <p className="text-xs text-slate-500">{t('shell.loading')}</p>
        ) : error ? (
          <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            {t('mytasks.loadFailed')}: {error}
          </p>
        ) : tasks.length === 0 ? (
          <p className="p-2 text-xs text-slate-500">{t('mytasks.empty')}</p>
        ) : (
          tasks.map((task) => {
            const v = task.verifiedState && KNOWN.includes(task.verifiedState) ? task.verifiedState : 'unverified';
            return (
              <div key={task.taskId} className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-slate-200">{task.label}</p>
                    <p className="text-[11px] text-slate-500">
                      {task.taskType ?? 'task'}
                      {task.roomLabel ? ` · ${task.roomLabel}` : ''}
                      {task.claimedState ? ` · ${t('mytasks.claimed')}: ${task.claimedState}` : ''}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    {/* Flow lifecycle badge: approved(closed) is terminal; otherwise the S2 verdict. */}
                    {task.flowState === 'closed' ? (
                      <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] text-emerald-300">
                        {t('mytasks.flow.approved')}
                      </span>
                    ) : task.rejection ? (
                      <span className="rounded-full bg-rose-500/20 px-2 py-0.5 text-[10px] text-rose-300">
                        {t('mytasks.flow.rejected')}
                      </span>
                    ) : (
                      <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] text-amber-300">
                        {t('mytasks.flow.pending')}
                      </span>
                    )}
                    <span className={['rounded-full px-2 py-0.5 text-[10px]', VERIFY_STYLE[v] ?? VERIFY_STYLE.unverified].join(' ')}>
                      {t(`verify.${v}`)}
                      {task.confidence != null ? ` · ${pct(task.confidence)}` : ''}
                    </span>
                  </div>
                </div>

                {/* Rejection banner: shows the manager's structured reason (+ optional detail) the
                    employee must address before resubmitting. Only while the flow is open (pending). */}
                {task.flowState !== 'closed' && task.rejection ? (
                  <div className="mt-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2">
                    <p className="text-[11px] font-medium text-rose-200">
                      {t('mytasks.flow.rejectionTitle')}
                      {task.rejection.count > 1 ? ` · ${t('mytasks.flow.rejectionCount', { count: task.rejection.count })}` : ''}
                    </p>
                    <p className="mt-0.5 text-[11px] text-rose-300/90">
                      {t(`mytasks.reject.${task.rejection.category}`)}
                    </p>
                    {task.rejection.detail ? (
                      <p className="mt-0.5 text-[11px] text-slate-300">{task.rejection.detail}</p>
                    ) : null}
                  </div>
                ) : null}

                {task.flowState === 'closed' ? (
                  <p className="mt-2 min-h-9 w-full rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-center text-sm font-medium text-emerald-200">
                    {t('mytasks.flow.doneNote')}
                  </p>
                ) : (
                  <button
                    type="button"
                    onClick={() => onPick(task)}
                    className="mt-2 min-h-9 w-full rounded-xl border border-sky-500/50 bg-sky-500/10 px-3 py-1.5 text-sm font-medium text-sky-200 active:bg-sky-500/20"
                  >
                    {task.rejection ? t('mytasks.flow.resubmit') : t('mytasks.pick')}
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
