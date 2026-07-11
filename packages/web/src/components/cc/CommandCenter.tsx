'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useLiveData } from '../../hooks/useLiveData';
import { useSession } from '../session/SessionProvider';
import { buildDomainTiles } from '../../lib/domain-model';
import { API_BASE } from '../../lib/config';
import { Podium, type PodiumKpis } from './Podium';
import { LoopStrip } from './LoopStrip';
import { DomainGrid } from './DomainGrid';
import { CueFeed } from './CueFeed';
import { LedgerPanel } from './LedgerPanel';
import { CommsPanel } from './CommsPanel';
import { TranscriptStream } from './TranscriptStream';

function useClock(): string {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  if (!now) return '--:--:--';
  return [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}

export function CommandCenter() {
  const t = useTranslations();
  const { session } = useSession();
  const { overview, recommendations, results, transcripts, status, error, refresh, approve, undo, dismiss, snooze, retryTranscription } =
    useLiveData(session?.token ?? '');
  const clock = useClock();

  const tiles = useMemo(() => buildDomainTiles(overview, recommendations), [overview, recommendations]);

  const score = overview?.tempo.score ?? 0;
  const kpis: PodiumKpis = useMemo(() => {
    const tasks = overview?.counts.Task ?? 0;
    const overdue = overview?.tempo.overdue ?? 0;
    return {
      activeTasks: tasks,
      onTimePct: tasks > 0 ? Math.round(((tasks - overdue) / tasks) * 100) : 100,
      conflicts: overview?.tempo.openConflicts ?? 0,
      openCues: recommendations.length,
    };
  }, [overview, recommendations]);

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-[1400px] space-y-5 px-[4%] py-6">
        <Podium score={score} kpis={kpis} status={status} clock={clock} />

        {status === 'offline' ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            <span>
              {t('cc.offline', { base: API_BASE })}
              {error ? <span className="text-amber-300/70"> — {error}</span> : null}
            </span>
            <button
              type="button"
              onClick={refresh}
              className="rounded-lg border border-amber-400/40 px-3 py-1 text-xs text-amber-100 transition-colors hover:bg-amber-500/20"
            >
              {t('cc.retry')}
            </button>
          </div>
        ) : null}

        <LoopStrip />

        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)_minmax(0,1fr)]">
          {/* LEFT — 360° operating state */}
          <DomainGrid tiles={tiles} />

          {/* MIDDLE — AI Co-Pilot cues */}
          <CueFeed
            recs={recommendations}
            results={results}
            onApprove={approve}
            onUndo={undo}
            onDismiss={dismiss}
            onSnooze={snooze}
          />

          {/* RIGHT — ledger + comms + voice transcripts (STT «listen» layer, live) */}
          <div className="space-y-5">
            <LedgerPanel ledger={overview?.ledger ?? []} />
            <CommsPanel comms={overview?.comms ?? []} />
            <TranscriptStream items={transcripts} onRetry={retryTranscription} />
          </div>
        </div>

        <footer className="border-t border-slate-800 pt-5 text-xs text-slate-500">
          <p>{t('footer.synthetic')}</p>
          <p className="mt-1">{t('footer.sprint')}</p>
        </footer>
      </div>
    </main>
  );
}
