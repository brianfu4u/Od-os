'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { StatusBoardRow } from '@clearview/shared';
import { useSessionApi } from '../session/SessionProvider';
import { hhmm } from '../../lib/format';

/**
 * T-09 · MANAGER status board — READ-ONLY whole-roster snapshot.
 *
 * Shows, for EVERY in-roster staff, the CLAIM layer (`claimedStatus`, the employee's self-declared
 * state) alongside the read-time freshness OBSERVATION (`secondsSinceLastEvent`, colour-graded). It
 * is deliberately NOT a decision surface:
 *   - it renders NO three-state verdict button (approve / reject / shelve / decide) — the single
 *     source of adjudication stays in AssignPanel;
 *   - it exposes NO verification / confidence / LLM field (the endpoint never sends one);
 *   - it never mutates world state — every action here is a passive refetch.
 *
 * The server (RolesGuard manager + RLS) is the real boundary; this UI hiding is cosmetic only.
 * Polls every 15s and refetches on demand.
 */

const STATUS_STYLE: Record<string, string> = {
  on_duty: 'bg-emerald-500/20 text-emerald-300',
  busy: 'bg-amber-500/20 text-amber-300',
  idle: 'bg-sky-500/20 text-sky-300',
  rest: 'bg-slate-600/40 text-slate-300',
  off_duty: 'bg-slate-700/60 text-slate-400',
};

/** Freshness grading (display only). Thresholds mirror the backend's silence window semantics. */
function freshnessMeta(secs: number | null): { style: string; level: 'fresh' | 'warn' | 'stale' } {
  if (secs === null) return { style: 'bg-rose-500/20 text-rose-300', level: 'stale' };
  if (secs >= 3600) return { style: 'bg-rose-500/20 text-rose-300', level: 'stale' };
  if (secs >= 1800) return { style: 'bg-amber-500/20 text-amber-300', level: 'warn' };
  return { style: 'bg-emerald-500/20 text-emerald-300', level: 'fresh' };
}

function humanizeAgo(secs: number | null, t: (k: string) => string): string {
  if (secs === null) return t('attention.board.never');
  if (secs < 60) return t('attention.board.justNow');
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h${mins % 60 ? ` ${mins % 60}m` : ''}`;
}

export function StatusBoard() {
  const t = useTranslations();
  const api = useSessionApi();
  const [rows, setRows] = useState<StatusBoardRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!api) return;
      setBusy(true);
      setErr(null);
      try {
        const view = await api.fetchStatusBoard(signal);
        setRows(view.rows);
      } catch (e) {
        if ((e as { name?: string })?.name === 'AbortError') return;
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
    const id = setInterval(() => void load(), 15000);
    return () => {
      ac.abort();
      clearInterval(id);
    };
  }, [load]);

  return (
    <section
      aria-label={t('attention.board.title')}
      data-testid="status-board"
      className="flex flex-col rounded-xl border border-slate-800 bg-slate-900/60"
    >
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">{t('attention.board.title')}</h2>
          <p className="text-xs text-slate-500">{t('attention.board.subtitle')}</p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-lg border border-slate-700 px-2.5 py-1 text-xs text-slate-300 transition-colors hover:bg-slate-800/60"
        >
          {busy ? t('attention.refreshing') : t('attention.refresh')}
        </button>
      </div>
      <div className="max-h-[22rem] flex-1 space-y-1.5 overflow-y-auto p-3">
        {err ? (
          <p className="p-4 text-center text-sm text-rose-300">{err}</p>
        ) : rows.length === 0 ? (
          <p className="p-4 text-center text-sm text-slate-500">{t('attention.board.empty')}</p>
        ) : (
          rows.map((r) => {
            const statusStyle = r.claimedStatus ? STATUS_STYLE[r.claimedStatus] ?? 'bg-slate-700/60 text-slate-300' : 'bg-slate-800/60 text-slate-500';
            const fresh = freshnessMeta(r.secondsSinceLastEvent);
            return (
              <div
                key={r.employeeId}
                className="flex items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2"
              >
                <span className="min-w-0 truncate text-sm text-slate-200">{r.employeeName}</span>
                <div className="flex shrink-0 items-center gap-1.5">
                  <span className={['rounded-full px-2 py-0.5 text-[10px]', statusStyle].join(' ')}>
                    {r.claimedStatus ? t(`attention.status.${r.claimedStatus}`) : t('attention.board.noClaim')}
                  </span>
                  <span
                    className={['rounded-full px-2 py-0.5 text-[10px]', fresh.style].join(' ')}
                    title={r.lastEventAt ? hhmm(r.lastEventAt) : t('attention.board.never')}
                  >
                    {humanizeAgo(r.secondsSinceLastEvent, t)}
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
