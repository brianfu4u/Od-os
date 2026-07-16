'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { EMPLOYEE_STATUSES, type EmployeeStatus } from '@clearview/shared';
import type { Api } from '../../lib/api';
import { hhmm } from '../../lib/format';

/**
 * T-08 · EMPLOYEE status bar — the employee's own five-state self-declaration (CLAIM layer).
 *
 * The seven principles this component physically enforces:
 *   1. 提交不驳回 — every legal five-state tap succeeds; there is no path that blocks/rejects it, and
 *      the optional note is skippable (never required).
 *   2. AI输出只给经理参考 — this surface NEVER renders a verification result, verification score, consistency
 *      verdict, or any AI/evaluative feedback. It reads back ONLY the employee-facing claim view
 *      (claimedStatus / note / claimedAt). No feedback loop to the employee, by construction.
 *   3. claim vs verified 分离 — we only ever touch the CLAIM layer (api.submitStatusClaim →
 *      EmployeeStatusView). The verification layer is not imported and not reachable from here.
 *
 * "点忙碌即生效" — tapping a state submits it immediately and reflects it as the current claim; the
 * note is a separate, optional afterthought that never gates the tap.
 */

const STATUS_STYLE: Record<EmployeeStatus, { active: string; idle: string }> = {
  on_duty: { active: 'bg-emerald-500 text-white', idle: 'border-emerald-500/40 text-emerald-200' },
  busy: { active: 'bg-rose-500 text-white', idle: 'border-rose-500/40 text-rose-200' },
  idle: { active: 'bg-sky-500 text-white', idle: 'border-sky-500/40 text-sky-200' },
  rest: { active: 'bg-amber-500 text-white', idle: 'border-amber-500/40 text-amber-200' },
  off_duty: { active: 'bg-slate-500 text-white', idle: 'border-slate-500/40 text-slate-300' },
};

export function EmployeeStatusBar({ api }: { api: Api }) {
  const t = useTranslations();
  const [current, setCurrent] = useState<EmployeeStatus | null>(null);
  const [claimedAt, setClaimedAt] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [pending, setPending] = useState<EmployeeStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const loadMe = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const view = await api.employeeStatusMe(signal);
        setCurrent(view.claimedStatus);
        setClaimedAt(view.claimedAt);
        if (view.note) setNote(view.note);
      } catch (e) {
        if ((e as { name?: string })?.name === 'AbortError') return;
        // A read miss must never block the employee from claiming; swallow silently.
      }
    },
    [api],
  );

  useEffect(() => {
    const ac = new AbortController();
    void loadMe(ac.signal);
    return () => ac.abort();
  }, [loadMe]);

  // Tapping a state submits it right away (点即生效). The note, if any, rides along but is optional.
  const claim = useCallback(
    async (status: EmployeeStatus) => {
      setPending(status);
      setErr(null);
      try {
        const view = await api.submitStatusClaim({
          claimedStatus: status,
          note: note.trim() ? note.trim() : null,
        });
        setCurrent(view.claimedStatus);
        setClaimedAt(view.claimedAt);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setPending(null);
      }
    },
    [api, note],
  );

  return (
    <section aria-label={t('employeeStatus.title')} data-testid="employee-status-bar" className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-slate-100">{t('employeeStatus.title')}</h2>
        {current ? (
          <span className="text-[11px] text-slate-400">
            {t('employeeStatus.currentIs', { status: t(`employeeStatus.status.${current}`) })}
            {claimedAt ? ` · ${hhmm(claimedAt)}` : ''}
          </span>
        ) : (
          <span className="text-[11px] text-slate-500">{t('employeeStatus.none')}</span>
        )}
      </div>
      <p className="mt-1 text-[11px] text-slate-500">{t('employeeStatus.hint')}</p>

      {/* Five big tap targets. Tap = immediate claim, no confirm, no gate. */}
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
        {EMPLOYEE_STATUSES.map((s) => {
          const isActive = current === s;
          const style = STATUS_STYLE[s];
          return (
            <button
              key={s}
              type="button"
              disabled={pending !== null}
              aria-pressed={isActive}
              onClick={() => void claim(s)}
              className={[
                'min-h-16 rounded-xl border px-2 py-3 text-sm font-semibold transition-colors disabled:opacity-60',
                isActive ? `${style.active} border-transparent` : `bg-slate-950/40 ${style.idle} active:bg-slate-800`,
              ].join(' ')}
            >
              {pending === s ? t('employeeStatus.submitting') : t(`employeeStatus.status.${s}`)}
            </button>
          );
        })}
      </div>

      {/* Optional, non-blocking note. Skippable by design — never required to change status. */}
      <label className="mt-3 block text-[11px] uppercase tracking-wide text-slate-500">
        {t('employeeStatus.noteLabel')}
      </label>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        placeholder={t('employeeStatus.notePlaceholder')}
        className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-slate-500 focus:outline-none"
      />

      {err ? <p className="mt-2 text-xs text-rose-300">{err}</p> : null}
    </section>
  );
}
