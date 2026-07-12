'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { OpsSummary } from '@clearview/shared';
import { useSessionApi } from '../session/SessionProvider';

/**
 * Manager-only, READ-ONLY ops view: deploy version, DB health, process metrics (requests / error
 * rate / DeepSeek + STT / sweeps / verifies), recent errors, and tenant-scoped activity (24h). The
 * server enforces manager via RolesGuard and scopes the tenant section by RLS; this component only
 * displays what the endpoint returns. Polls every 15s. No PHI/secret is ever present in the payload.
 */
export function OpsPanel() {
  const t = useTranslations();
  const api = useSessionApi();
  const [data, setData] = useState<OpsSummary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!api) return;
      setBusy(true);
      setErr(null);
      try {
        setData(await api.opsSummary(signal));
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
    const id = setInterval(() => void load(), 15000);
    return () => {
      ac.abort();
      clearInterval(id);
    };
  }, [load]);

  const m = data?.metrics;
  const errorRate = m && m.http.total > 0 ? Math.round((m.http.serverErrors / m.http.total) * 1000) / 10 : 0;

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-slate-100">{t('ops.title')}</h2>
          {data ? (
            <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] text-slate-400" title={data.version.buildTime ?? ''}>
              {data.version.nodeEnv} · {data.version.commit.slice(0, 7)}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={busy}
          className="rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] text-slate-300 transition-colors hover:border-slate-500 disabled:opacity-50"
        >
          {busy ? t('ops.refreshing') : t('ops.refresh')}
        </button>
      </div>

      {err ? <p className="mt-3 rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{err}</p> : null}

      {data && m ? (
        <div className="mt-3 space-y-3">
          {/* health */}
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className={`rounded-full px-2 py-0.5 ${data.db.ok ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300'}`}>
              {t('ops.db')}: {data.db.ok ? t('ops.ok') : t('ops.down')}
              {data.db.latencyMs != null ? ` · ${data.db.latencyMs}ms` : ''}
            </span>
            <span className="text-slate-500">
              {t('ops.uptime')}: {formatUptime(m.uptimeSec)}
            </span>
          </div>

          {/* process metrics */}
          <div className="grid grid-cols-3 gap-2 text-center">
            <Metric label={t('ops.requests')} value={m.http.total} />
            <Metric label={t('ops.errorRate')} value={`${errorRate}%`} warn={errorRate > 0} />
            <Metric label={t('ops.verifies')} value={m.derived.verifyRequests} />
            <Metric label="DeepSeek" value={`${m.llm.calls}/${m.llm.failures}`} sub={t('ops.callsFails')} warn={m.llm.failures > 0} />
            <Metric label="STT" value={`${m.stt.calls}/${m.stt.failures}`} sub={t('ops.callsFails')} warn={m.stt.failures > 0} />
            <Metric label={t('ops.sweeps')} value={m.derived.sweepRuns} />
          </div>

          {/* tenant-scoped activity */}
          <div>
            <p className="text-[10px] uppercase tracking-wide text-slate-500">
              {t('ops.tenantActivity', { hours: data.tenant.windowHours })}
            </p>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-300">
              <span>{t('ops.reports')}: {data.tenant.reports}</span>
              <span>{t('ops.verdicts')}: {data.tenant.verdicts}</span>
              <span>{t('ops.transcriptions')}: {data.tenant.transcriptions}</span>
              <span>{t('ops.llmAnalyses')}: {data.tenant.llmAnalyses}</span>
              <span>{t('ops.actions')}: {data.tenant.actions}</span>
            </div>
          </div>

          {/* recent errors */}
          <div>
            <p className="text-[10px] uppercase tracking-wide text-slate-500">
              {t('ops.recentErrors')} ({m.recentErrors.length})
            </p>
            {m.recentErrors.length === 0 ? (
              <p className="mt-1 text-[11px] text-slate-500">{t('ops.noErrors')}</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {m.recentErrors.slice(0, 5).map((e, i) => (
                  <li key={`${e.at}-${i}`} className="truncate text-[11px] text-slate-400">
                    <span className="text-rose-300">{e.status}</span> {e.method ?? ''} {e.route ?? ''} · {e.name}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : !err ? (
        <p className="mt-3 text-xs text-slate-500">{t('ops.loading')}</p>
      ) : null}
    </section>
  );
}

function Metric({ label, value, sub, warn }: { label: string; value: string | number; sub?: string; warn?: boolean }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-2 py-1.5">
      <div className={`text-sm font-semibold ${warn ? 'text-amber-300' : 'text-slate-100'}`}>{value}</div>
      <div className="text-[10px] text-slate-500">{sub ? `${label} · ${sub}` : label}</div>
    </div>
  );
}

function formatUptime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}
