'use client';

import { useTranslations } from 'next-intl';
import { LocaleSwitcher } from '../LocaleSwitcher';
import { CLINIC } from '../../lib/config';
import type { FeedStatus } from '../../hooks/useLiveData';
import { Sparkline } from './Sparkline';

export interface PodiumKpis {
  activeTasks: number;
  onTimePct: number;
  conflicts: number;
  openCues: number;
}

const STATUS_STYLE: Record<FeedStatus, string> = {
  live: 'bg-emerald-500/20 text-emerald-300',
  connecting: 'bg-sky-500/20 text-sky-300',
  offline: 'bg-amber-500/20 text-amber-300',
};

export function Podium({
  score,
  kpis,
  status,
  clock,
}: {
  score: number;
  kpis: PodiumKpis;
  status: FeedStatus;
  clock: string;
}) {
  const t = useTranslations();
  const tempoLabel = score >= 80 ? t('podium.tempoGood') : score >= 55 ? t('podium.tempoWatch') : t('podium.tempoAct');
  const tempoColor = score >= 80 ? 'text-emerald-300' : score >= 55 ? 'text-sky-300' : 'text-amber-300';

  const kpiTiles: Array<{ label: string; value: string }> = [
    { label: t('podium.kpi.activeTasks'), value: String(kpis.activeTasks) },
    { label: t('podium.kpi.onTime'), value: `${kpis.onTimePct}%` },
    { label: t('podium.kpi.conflicts'), value: String(kpis.conflicts) },
    { label: t('podium.kpi.openCues'), value: String(kpis.openCues) },
  ];

  return (
    <header className="rounded-2xl border border-slate-800 bg-gradient-to-b from-slate-900/80 to-slate-900/40 p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        {/* identity */}
        <div>
          <div className="flex items-center gap-2.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-sky-400 shadow-[0_0_10px_2px_rgba(56,189,248,0.6)]" />
            <h1 className="text-xl font-bold tracking-tight text-slate-50">{t('app.title')}</h1>
            <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[11px] text-slate-400">{t('app.badge')}</span>
          </div>
          <p className="mt-1 text-sm text-slate-400">
            {CLINIC.branch} {t('podium.branch')} · {t('podium.commander')} {CLINIC.commander}
          </p>
        </div>

        {/* controls */}
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            <span className={['rounded-full px-2 py-0.5 text-[11px]', STATUS_STYLE[status]].join(' ')}>
              {t(`feed.${status}`)}
            </span>
            <span className="font-mono text-sm tabular-nums text-slate-300">{clock}</span>
          </div>
          <div className="flex items-center gap-2">
            <a
              href="console"
              className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300 transition-colors hover:border-slate-500 hover:text-white"
            >
              {t('app.navConsole')}
            </a>
            <LocaleSwitcher />
          </div>
        </div>
      </div>

      {/* tempo + kpis */}
      <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_2fr]">
        <div className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/50 px-5 py-4">
          <div>
            <p className="text-[10px] uppercase tracking-[0.2em] text-slate-500">{t('podium.tempo')}</p>
            <div className="mt-1 flex items-baseline gap-2">
              <span className={['text-4xl font-bold tabular-nums', tempoColor].join(' ')}>{score}</span>
              <span className="text-sm text-slate-400">{tempoLabel}</span>
            </div>
          </div>
          <Sparkline score={score} />
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {kpiTiles.map((k) => (
            <div key={k.label} className="rounded-xl border border-slate-800 bg-slate-950/50 px-4 py-3">
              <p className="text-2xl font-semibold tabular-nums text-slate-100">{k.value}</p>
              <p className="mt-0.5 text-[11px] text-slate-400">{k.label}</p>
            </div>
          ))}
        </div>
      </div>
    </header>
  );
}
