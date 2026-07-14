'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { AssignmentOverview, ManagerDecision, RejectionReasonCategory } from '@clearview/shared';
import { REJECTION_REASON_CATEGORIES } from '@clearview/shared';
import { useSessionApi } from '../session/SessionProvider';

/**
 * Manager-only task assignment (command center). Lists this tenant's tasks with their current
 * assignee and lets the manager assign/reassign to any tenant staff, plus create a task. The server
 * (RolesGuard=manager + RLS) is the boundary; this UI only orchestrates. Writes go through
 * assignedTo links + Task properties — never verified_state — so /tasks/mine reflects changes at once.
 */
export function AssignPanel() {
  const t = useTranslations();
  const api = useSessionApi();
  const [data, setData] = useState<AssignmentOverview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const [decidingTaskId, setDecidingTaskId] = useState<string | null>(null);
  // Per-task reject form: which task's reject form is open, its category + optional detail.
  const [rejectFor, setRejectFor] = useState<string | null>(null);
  const [rejectCategory, setRejectCategory] = useState<RejectionReasonCategory>('missing_evidence');
  const [rejectDetail, setRejectDetail] = useState('');

  // create-task form
  const [label, setLabel] = useState('');
  const [taskType, setTaskType] = useState('');
  const [dueBy, setDueBy] = useState('');
  const [newStaffId, setNewStaffId] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!api) return;
      setBusy(true);
      setErr(null);
      try {
        setData(await api.assignmentOverview(signal));
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [api],
  );

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  const onAssign = useCallback(
    async (taskId: string, staffId: string) => {
      if (!api || !staffId) return;
      setPendingTaskId(taskId);
      setErr(null);
      try {
        await api.assignTask(taskId, staffId);
        await load();
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setPendingTaskId(null);
      }
    },
    [api, load],
  );

  const onCreate = useCallback(async () => {
    if (!api) return;
    if (!label.trim()) {
      setErr(t('assign.needLabel'));
      return;
    }
    setCreating(true);
    setErr(null);
    try {
      await api.createTask({
        label: label.trim(),
        taskType: taskType.trim() || null,
        dueBy: dueBy.trim() || null,
        staffId: newStaffId || null,
      });
      setLabel('');
      setTaskType('');
      setDueBy('');
      setNewStaffId('');
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }, [api, label, taskType, dueBy, newStaffId, load, t]);

  const onDecide = useCallback(
    async (taskId: string, decision: ManagerDecision, reason?: { category: RejectionReasonCategory; detail: string }) => {
      if (!api) return;
      setDecidingTaskId(taskId);
      setErr(null);
      try {
        await api.decideTask(taskId, {
          decision,
          rejectionReasonCategory: decision === 'reject' ? reason?.category ?? null : null,
          rejectionReasonDetail: decision === 'reject' ? (reason?.detail.trim() || null) : null,
        });
        setRejectFor(null);
        setRejectDetail(''); 
        await load();
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setDecidingTaskId(null);
      }
    },
    [api, load],
  );

  const staff = data?.staff ?? [];
  const staffName = (staffId: string): string => {
    const s = staff.find((x) => x.staffId === staffId);
    return s?.displayName ?? s?.handle ?? staffId.slice(0, 8);
  };

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-100">{t('assign.title')}</h2>
        <button
          type="button"
          onClick={() => void load()}
          disabled={busy}
          className="rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] text-slate-300 transition-colors hover:border-slate-500 disabled:opacity-50"
        >
          {busy ? t('assign.refreshing') : t('assign.refresh')}
        </button>
      </div>

      {err ? <p className="mt-3 rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{err}</p> : null}

      {/* create task */}
      <div className="mt-3 flex flex-wrap items-end gap-2 rounded-xl border border-slate-800 bg-slate-950/50 p-3">
        <div className="flex-1 min-w-[160px]">
          <label className="block text-[10px] uppercase tracking-wide text-slate-500">{t('assign.newTask')}</label>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t('assign.labelPlaceholder')}
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-sm text-slate-100 focus:border-sky-500 focus:outline-none"
          />
        </div>
        <input
          value={taskType}
          onChange={(e) => setTaskType(e.target.value)}
          placeholder={t('assign.taskTypePlaceholder')}
          className="w-28 rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-sm text-slate-100 focus:border-sky-500 focus:outline-none"
        />
        <select
          value={newStaffId}
          onChange={(e) => setNewStaffId(e.target.value)}
          className="rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-sm text-slate-200 focus:border-sky-500 focus:outline-none"
        >
          <option value="">{t('assign.unassigned')}</option>
          {staff.map((s) => (
            <option key={s.staffId} value={s.staffId}>
              {s.displayName ?? s.handle ?? s.staffId.slice(0, 8)}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void onCreate()}
          disabled={creating}
          className="rounded-lg bg-sky-500 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-sky-400 disabled:opacity-50"
        >
          {creating ? t('assign.creating') : t('assign.create')}
        </button>
      </div>

      {/* task list */}
      <div className="mt-3">
        {!data ? (
          <p className="text-xs text-slate-500">{t('assign.loading')}</p>
        ) : data.tasks.length === 0 ? (
          <p className="text-xs text-slate-500">{t('assign.empty')}</p>
        ) : (
          <ul className="space-y-1.5">
            {data.tasks.map((task) => {
              const closed = task.flowState === 'closed';
              const deciding = decidingTaskId === task.taskId;
              return (
              <li
                key={task.taskId}
                className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm text-slate-100">{task.label}</span>
                      {/* Flow lifecycle badge */}
                      {closed ? (
                        <span className="shrink-0 rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] text-emerald-300">
                          {t('assign.flow.closed')}
                        </span>
                      ) : task.rejection ? (
                        <span className="shrink-0 rounded-full bg-rose-500/20 px-2 py-0.5 text-[10px] text-rose-300">
                          {t('assign.flow.rejected')}
                        </span>
                      ) : (
                        <span className="shrink-0 rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] text-amber-300">
                          {t('assign.flow.pending')}
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-slate-500">
                      {task.assignee ? `${t('assign.assignee')}: ${staffName(task.assignee.staffId)}` : t('assign.unassigned')}
                      {task.dueBy ? ` · ${task.dueBy.slice(0, 10)}` : ''}
                    </div>
                  </div>
                  <select
                    value={task.assignee?.staffId ?? ''}
                    disabled={pendingTaskId === task.taskId || staff.length === 0 || closed}
                    onChange={(e) => void onAssign(task.taskId, e.target.value)}
                    className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200 focus:border-sky-500 focus:outline-none disabled:opacity-50"
                  >
                    <option value="">{staff.length === 0 ? t('assign.staffEmpty') : t('assign.assignTo')}</option>
                    {staff.map((s) => (
                      <option key={s.staffId} value={s.staffId}>
                        {s.displayName ?? s.handle ?? s.staffId.slice(0, 8)}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Prior rejection context for the manager (last reason on the open flow). */}
                {!closed && task.rejection ? (
                  <p className="mt-1.5 text-[11px] text-rose-300/80">
                    {t('assign.flow.lastReject')}: {t(`mytasks.reject.${task.rejection.category}`)}
                    {task.rejection.detail ? ` — ${task.rejection.detail}` : ''}
                  </p>
                ) : null}

                {/* THREE-STATE manager decision. Hidden once the flow is closed (terminal, no reopen). */}
                {closed ? (
                  <p className="mt-2 text-[11px] text-emerald-300/80">{t('assign.flow.closedNote')}</p>
                ) : (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      disabled={deciding}
                      onClick={() => void onDecide(task.taskId, 'approve')}
                      className="rounded-lg border border-emerald-500/50 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50"
                    >
                      {t('assign.decide.approve')}
                    </button>
                    <button
                      type="button"
                      disabled={deciding}
                      onClick={() => setRejectFor(rejectFor === task.taskId ? null : task.taskId)}
                      className="rounded-lg border border-rose-500/50 bg-rose-500/10 px-2.5 py-1 text-[11px] font-medium text-rose-200 hover:bg-rose-500/20 disabled:opacity-50"
                    >
                      {t('assign.decide.reject')}
                    </button>
                    <button
                      type="button"
                      disabled={deciding}
                      onClick={() => void onDecide(task.taskId, 'shelve')}
                      className="rounded-lg border border-slate-600 bg-slate-800/60 px-2.5 py-1 text-[11px] font-medium text-slate-300 hover:bg-slate-700/60 disabled:opacity-50"
                    >
                      {t('assign.decide.shelve')}
                    </button>
                  </div>
                )}

                {/* Reject reason form (structured category + optional detail). */}
                {!closed && rejectFor === task.taskId ? (
                  <div className="mt-2 space-y-2 rounded-lg border border-rose-500/30 bg-rose-500/5 p-2">
                    <select
                      value={rejectCategory}
                      onChange={(e) => setRejectCategory(e.target.value as RejectionReasonCategory)}
                      className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200 focus:border-rose-500 focus:outline-none"
                    >
                      {REJECTION_REASON_CATEGORIES.map((c) => (
                        <option key={c} value={c}>{t(`mytasks.reject.${c}`)}</option>
                      ))}
                    </select>
                    <input
                      value={rejectDetail}
                      onChange={(e) => setRejectDetail(e.target.value)}
                      placeholder={t('assign.decide.detailPlaceholder')}
                      className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100 focus:border-rose-500 focus:outline-none"
                    />
                    <button
                      type="button"
                      disabled={deciding}
                      onClick={() => void onDecide(task.taskId, 'reject', { category: rejectCategory, detail: rejectDetail })}
                      className="rounded-lg bg-rose-500 px-3 py-1 text-[11px] font-medium text-white hover:bg-rose-400 disabled:opacity-50"
                    >
                      {t('assign.decide.confirmReject')}
                    </button>
                  </div>
                ) : null}
              </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
