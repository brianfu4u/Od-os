'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import type { ObjectTimeline, RecommendationRecord } from '@clearview/shared';
import { useSessionApi } from '../session/SessionProvider';
import { pct } from '../../lib/format';
import { DOMAIN_TYPES, TILE_TO_RECDOMAIN, DOMAIN_ICON, type DomainKey } from '../../lib/domains';

interface ObjRow {
  id: string;
  type: string;
  properties: Record<string, unknown>;
  verifiedState: string | null;
  claimedState: string | null;
  confidence: number | null;
}

const VERIFY_STYLE: Record<string, string> = {
  verified: 'bg-emerald-500/20 text-emerald-300',
  conflict: 'bg-rose-500/20 text-rose-300',
  pending: 'bg-amber-500/20 text-amber-300',
  unverified: 'bg-slate-700/60 text-slate-400',
};

function labelOf(o: { type: string; properties: Record<string, unknown> }): string {
  const p = o.properties;
  return (
    (typeof p.label === 'string' && p.label) ||
    (typeof p.name === 'string' && p.name) ||
    (typeof p.taskType === 'string' && p.taskType) ||
    o.type
  );
}

export function DomainDetail({ domain }: { domain: DomainKey }) {
  const t = useTranslations();
  const locale = useLocale();
  const api = useSessionApi();
  const [objects, setObjects] = useState<ObjRow[]>([]);
  const [alerts, setAlerts] = useState<ObjRow[]>([]);
  const [cues, setCues] = useState<RecommendationRecord[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<ObjectTimeline | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fmtTime = useCallback(
    (iso: string): string => {
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(locale);
    },
    [locale],
  );

  useEffect(() => {
    if (!api) return;
    const ctrl = new AbortController();
    setLoading(true);
    void (async () => {
      try {
        const types = DOMAIN_TYPES[domain];
        const [objLists, alertList, recs] = await Promise.all([
          Promise.all(types.map((ty) => api.objects(ty, ctrl.signal))),
          api.objects('Alert', ctrl.signal),
          api.recommendations('open', ctrl.signal),
        ]);
        const objs = objLists.flat() as unknown as ObjRow[];
        setObjects(objs);
        const ids = new Set(objs.map((o) => o.id));
        setAlerts((alertList as unknown as ObjRow[]).filter((a) => ids.has(String(a.properties?.objectId ?? ''))));
        setCues(recs.filter((r) => r.domain === TILE_TO_RECDOMAIN[domain]));
        setError(null);
      } catch (e) {
        if ((e as { name?: string }).name === 'AbortError') return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
    return () => ctrl.abort();
  }, [api, domain]);

  const openTimeline = useCallback(
    async (id: string) => {
      if (!api) return;
      setSelected(id);
      setTimeline(null);
      try {
        setTimeline(await api.timeline(id));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [api],
  );

  const counts = useMemo(
    () => ({ objects: objects.length, alerts: alerts.length, cues: cues.length }),
    [objects, alerts, cues],
  );

  return (
    <main className="mx-auto max-w-[1400px] space-y-5 px-[4%] py-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xl" aria-hidden>
            {DOMAIN_ICON[domain]}
          </span>
          <h1 className="text-lg font-semibold text-slate-100">{t(`domains.${domain}`)}</h1>
          <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[11px] text-slate-400">
            {t('domainPage.counts', { objects: counts.objects, alerts: counts.alerts, cues: counts.cues })}
          </span>
        </div>
        <Link href={`/${locale}`} className="rounded-lg border border-slate-700 px-3 py-1 text-xs text-slate-300 transition-colors hover:border-slate-500">
          ← {t('domainPage.back')}
        </Link>
      </div>

      {error ? <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">{error}</p> : null}
      {loading ? <p className="text-sm text-slate-500">{t('shell.loading')}</p> : null}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        {/* LEFT: domain objects + alerts */}
        <div className="space-y-5">
          <section className="rounded-xl border border-slate-800 bg-slate-900/60">
            <div className="border-b border-slate-800 px-4 py-3">
              <h2 className="text-sm font-semibold text-slate-100">{t('domainPage.objects')}</h2>
            </div>
            <ul className="divide-y divide-slate-800/70">
              {objects.length === 0 && !loading ? (
                <li className="p-4 text-sm text-slate-500">{t('domainPage.empty')}</li>
              ) : (
                objects.map((o) => {
                  const v = o.verifiedState ?? 'unverified';
                  return (
                    <li key={o.id} className="flex items-center justify-between gap-3 px-4 py-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm text-slate-200">{labelOf(o)}</p>
                        <p className="text-[11px] text-slate-500">{o.type}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className={['rounded-full px-2 py-0.5 text-[10px]', VERIFY_STYLE[v] ?? VERIFY_STYLE.unverified].join(' ')}>
                          {t(`verify.${v}`)}
                        </span>
                        <button
                          type="button"
                          onClick={() => void openTimeline(o.id)}
                          className={[
                            'rounded-md border px-2 py-0.5 text-[11px] transition-colors',
                            selected === o.id ? 'border-sky-500 text-sky-300' : 'border-slate-700 text-slate-300 hover:border-slate-500',
                          ].join(' ')}
                        >
                          {t('domainPage.timeline')}
                        </button>
                      </div>
                    </li>
                  );
                })
              )}
            </ul>
          </section>

          {alerts.length > 0 ? (
            <section className="rounded-xl border border-slate-800 bg-slate-900/60">
              <div className="border-b border-slate-800 px-4 py-3">
                <h2 className="text-sm font-semibold text-slate-100">{t('domainPage.alerts')}</h2>
              </div>
              <ul className="divide-y divide-slate-800/70">
                {alerts.map((a) => (
                  <li key={a.id} className="px-4 py-3">
                    <p className="text-xs text-slate-300">{String(a.properties?.reason ?? '')}</p>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {(Array.isArray(a.properties?.triggered) ? (a.properties.triggered as string[]) : []).map((x) => (
                        <span key={x} className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
                          {x}
                        </span>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>

        {/* RIGHT: domain cues + selected timeline */}
        <div className="space-y-5">
          <section className="rounded-xl border border-slate-800 bg-slate-900/60">
            <div className="border-b border-slate-800 px-4 py-3">
              <h2 className="text-sm font-semibold text-slate-100">{t('domainPage.cues')}</h2>
            </div>
            <ul className="divide-y divide-slate-800/70">
              {cues.length === 0 ? (
                <li className="p-4 text-sm text-slate-500">{t('domainPage.noCues')}</li>
              ) : (
                cues.map((c) => (
                  <li key={c.id} className="px-4 py-3">
                    <p className="text-sm text-slate-200">{c.title}</p>
                    <p className="mt-1 text-xs text-slate-400">{c.why}</p>
                    <div className="mt-1.5 flex items-center gap-2 text-[10px] text-slate-500">
                      <span>{t('cues.confidence')}: {pct(c.confidence)}</span>
                      <span>·</span>
                      <span>{t(`agents.${c.sourceAgent}`)}</span>
                    </div>
                  </li>
                ))
              )}
            </ul>
          </section>

          <section className="rounded-xl border border-slate-800 bg-slate-900/60">
            <div className="border-b border-slate-800 px-4 py-3">
              <h2 className="text-sm font-semibold text-slate-100">{t('domainPage.timelineTitle')}</h2>
              <p className="text-xs text-slate-500">{t('domainPage.timelineHint')}</p>
            </div>
            <div className="p-4">
              {!selected ? (
                <p className="text-sm text-slate-500">{t('domainPage.selectPrompt')}</p>
              ) : !timeline ? (
                <p className="text-sm text-slate-500">{t('shell.loading')}</p>
              ) : (
                <div className="space-y-4">
                  {timeline.object ? (
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm text-slate-200">{labelOf(timeline.object)}</p>
                      <span
                        className={[
                          'rounded-full px-2 py-0.5 text-[10px]',
                          VERIFY_STYLE[timeline.object.verifiedState ?? 'unverified'] ?? VERIFY_STYLE.unverified,
                        ].join(' ')}
                      >
                        {t(`verify.${timeline.object.verifiedState ?? 'unverified'}`)}
                      </span>
                    </div>
                  ) : null}

                  {timeline.ledger.length > 0 ? (
                    <div>
                      <p className="text-[11px] uppercase tracking-wide text-slate-500">{t('domainPage.ledger')}</p>
                      <ol className="mt-2 space-y-2 border-l border-slate-800 pl-3">
                        {timeline.ledger.map((l) => (
                          <li key={l.id} className="relative">
                            <span className="absolute -left-[17px] top-1 h-2 w-2 rounded-full bg-sky-500" aria-hidden />
                            <div className="flex items-center gap-2">
                              <span className={['rounded-full px-2 py-0.5 text-[10px]', VERIFY_STYLE[l.verifiedState] ?? VERIFY_STYLE.unverified].join(' ')}>
                                {t(`verify.${l.verifiedState}`)}
                              </span>
                              <span className="tabular-nums text-[10px] text-slate-400">{pct(l.confidence)}</span>
                              <span className="text-[10px] text-slate-600">{fmtTime(l.at)}</span>
                            </div>
                            {l.reason ? <p className="mt-0.5 text-[11px] text-slate-400">{l.reason}</p> : null}
                          </li>
                        ))}
                      </ol>
                    </div>
                  ) : null}

                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-slate-500">{t('domainPage.events')}</p>
                    <ol className="mt-2 space-y-1.5">
                      {timeline.events.map((e) => (
                        <li key={e.id} className="flex items-center justify-between gap-2 text-[11px]">
                          <code className="rounded bg-slate-800 px-1.5 py-0.5 text-slate-300">{e.eventType}</code>
                          <span className="text-slate-600">{fmtTime(e.at)}</span>
                        </li>
                      ))}
                      {timeline.events.length === 0 ? <li className="text-[11px] text-slate-500">{t('domainPage.empty')}</li> : null}
                    </ol>
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
