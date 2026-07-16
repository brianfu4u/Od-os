'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { AttentionItem } from '@clearview/shared';
import { useSessionApi } from '../session/SessionProvider';
import type { Api } from '../../lib/api';
import { hhmm } from '../../lib/format';

/**
 * T-09 · MANAGER attention panel — a READ-ONLY "待关注列表", NOT a message feed and NOT an
 * adjudication surface.
 *
 * Hard guarantees enforced here (server is the real boundary; this is the presentation half):
 *   - NO accept / dismiss / snooze / approve / reject / shelve / decide control. A finding is
 *     surfaced for the manager to LOOK AT; acting on it (if at all) happens elsewhere (AssignPanel).
 *   - Each card shows only the neutral five-element evidence summary (who / when / claimed /
 *     submitted / systemObserved). No verdict, no confidence, no LLM text, nothing employee-facing.
 *   - Purely passive: the only interaction is a manual refetch (poll every 20s).
 *
 * The queue is read-time on the server (no stored table): a finding that no longer holds simply
 * stops appearing on the next poll (auto-dequeue).
 */

const KIND_STYLE: Record<string, string> = {
  silence: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  status_inconsistency: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  scan_no_followup: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  low_confidence: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
};

export function AttentionPanel() {
  const t = useTranslations();
  const api = useSessionApi();
  const [items, setItems] = useState<AttentionItem[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!api) return;
      setBusy(true);
      setErr(null);
      try {
        const view = await api.fetchAttentionQueue(signal);
        setItems(view.items);
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
    const id = setInterval(() => void load(), 20000);
    return () => {
      ac.abort();
      clearInterval(id);
    };
  }, [load]);

  return (
    <section
      aria-label={t('attention.panel.title')}
      data-testid="attention-panel"
      className="flex flex-col rounded-xl border border-slate-800 bg-slate-900/60"
    >
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">{t('attention.panel.title')}</h2>
          <p className="text-xs text-slate-500">{t('attention.panel.subtitle')}</p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-lg border border-slate-700 px-2.5 py-1 text-xs text-slate-300 transition-colors hover:bg-slate-800/60"
        >
          {busy ? t('attention.refreshing') : t('attention.refresh')}
        </button>
      </div>
      <div className="max-h-[26rem] flex-1 space-y-2 overflow-y-auto p-3">
        {err ? (
          <p className="p-4 text-center text-sm text-rose-300">{err}</p>
        ) : items.length === 0 ? (
          <p className="p-4 text-center text-sm text-slate-500">{t('attention.panel.empty')}</p>
        ) : (
          items.map((it) => {
            const kindStyle = KIND_STYLE[it.kind] ?? 'bg-slate-700/40 text-slate-300 border-slate-600/40';
            const ev = it.evidenceSummary;
            return (
              <article key={it.id} className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-sm font-medium text-slate-200">{it.employeeName}</span>
                  <span className={['shrink-0 rounded-full border px-2 py-0.5 text-[10px]', kindStyle].join(' ')}>
                    {t(`attention.kind.${it.kind}`)}
                  </span>
                </div>
                {/* Neutral five-element evidence — facts only, never a verdict. */}
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
                  <dt className="text-slate-500">{t('attention.evidence.who')}</dt>
                  <dd className="text-slate-300">{ev.who ?? '—'}</dd>
                  <dt className="text-slate-500">{t('attention.evidence.when')}</dt>
                  <dd className="font-mono text-slate-400">{ev.when ? hhmm(ev.when) : '—'}</dd>
                  <dt className="text-slate-500">{t('attention.evidence.claimed')}</dt>
                  <dd className="text-slate-300">{ev.claimed ?? '—'}</dd>
                  <dt className="text-slate-500">{t('attention.evidence.submitted')}</dt>
                  <dd className="text-slate-300">
                    <SubmittedCell
                      masked={ev.submitted}
                      revealable={ev.revealable === true}
                      staffId={it.employeeId}
                      api={api}
                    />
                  </dd>
                  <dt className="text-slate-500">{t('attention.evidence.systemObserved')}</dt>
                  <dd className="text-slate-300">{ev.systemObserved ?? '—'}</dd>
                </dl>
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}

/**
 * P1-6-f · the `submitted` cell renders the MASKED scan code. When the finding is `revealable`, a
 * manager may tap "查看原文" to fetch the full raw code from the audited reveal endpoint. Revealing is
 * a server-side WRITE (each view is recorded), so once revealed we show a "此次查看已记录" hint — the
 * reveal itself is the only interaction; nothing here changes world state or flows to the employee.
 */
function SubmittedCell({
  masked,
  revealable,
  staffId,
  api,
}: {
  masked: string | null;
  revealable: boolean;
  staffId: string;
  api: Api | null;
}) {
  const t = useTranslations();
  const [raw, setRaw] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reveal = useCallback(async () => {
    if (!api || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await api.revealScanCode(staffId);
      setRaw(res.scanCode);
      setRevealed(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [api, busy, staffId]);

  if (!revealable) return <>{masked ?? '—'}</>;

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="font-mono">{revealed ? (raw ?? t('attention.reveal.absent')) : (masked ?? '—')}</span>
      {revealed ? (
        <span className="text-[10px] text-slate-500">{t('attention.reveal.recorded')}</span>
      ) : (
        <button
          type="button"
          onClick={() => void reveal()}
          disabled={busy}
          className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 transition-colors hover:bg-slate-800/60 disabled:opacity-50"
        >
          {busy ? t('attention.reveal.revealing') : t('attention.reveal.action')}
        </button>
      )}
      {err ? <span className="text-[10px] text-rose-300">{err}</span> : null}
    </span>
  );
}
