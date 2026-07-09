'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OverviewResult, RecommendationRecord } from '@clearview/shared';
import { makeApi } from '../lib/api';

export type FeedStatus = 'connecting' | 'live' | 'offline';

export interface LiveData {
  overview: OverviewResult | null;
  recommendations: RecommendationRecord[];
  /** Recently acted cues (approve/undo) this session, with their execution result. */
  results: RecommendationRecord[];
  status: FeedStatus;
  lastEventAt: number | null;
  error: string | null;
  refresh: () => void;
  approve: (id: string) => Promise<void>;
  undo: (id: string) => Promise<void>;
  dismiss: (id: string) => Promise<void>;
  snooze: (id: string) => Promise<void>;
}

/**
 * Wires the command center to the LIVE API using the manager SESSION token: initial load of the
 * overview aggregate + open recommendations, an EventSource on /objects/stream (?session=) that
 * debounces a refetch on every change and AUTO-RECONNECTS with capped backoff, and approve/undo/
 * dismiss/snooze. Approve/undo surface the execution result (executed / blocked / recorded / undone)
 * in `results`. All fetches run only in the browser, so the static prerender stays data-free.
 */
export function useLiveData(token: string): LiveData {
  const api = useMemo(() => makeApi({ token }), [token]);
  const [overview, setOverview] = useState<OverviewResult | null>(null);
  const [recommendations, setRecommendations] = useState<RecommendationRecord[]>([]);
  const [results, setResults] = useState<RecommendationRecord[]>([]);
  const [status, setStatus] = useState<FeedStatus>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const [ov, recs] = await Promise.all([api.overview(signal), api.recommendations('open', signal)]);
        setOverview(ov);
        setRecommendations(recs);
        setError(null);
        setStatus((s) => (s === 'offline' ? 'live' : s));
      } catch (e) {
        if ((e as { name?: string }).name === 'AbortError') return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus('offline');
      }
    },
    [api],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  // SSE with auto-reconnect (capped exponential backoff). On (re)connect we reload so a gap while
  // offline is reconciled. EventSource can't set headers, so the session travels as ?session=.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') return;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let closed = false;

    const connect = (): void => {
      es = new EventSource(api.streamUrl());
      es.onopen = () => {
        attempt = 0;
        setStatus('live');
        void load();
      };
      es.onmessage = () => {
        setLastEventAt(Date.now());
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => void load(), 250);
      };
      es.onerror = () => {
        setStatus('offline');
        es?.close();
        if (closed) return;
        attempt += 1;
        const delay = Math.min(1000 * 2 ** (attempt - 1), 15000);
        retry = setTimeout(connect, delay);
      };
    };
    connect();

    return () => {
      closed = true;
      es?.close();
      if (retry) clearTimeout(retry);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [api, load]);

  const refresh = useCallback(() => void load(), [load]);

  const approve = useCallback(
    async (id: string) => {
      const rec = await api.approve(id);
      setResults((prev) => [rec, ...prev.filter((r) => r.id !== id)]);
      setRecommendations((prev) => prev.filter((r) => r.id !== id));
      void load();
    },
    [api, load],
  );

  const undo = useCallback(
    async (id: string) => {
      await api.undo(id);
      setResults((prev) => prev.filter((r) => r.id !== id)); // reopened → returns to the open feed
      void load();
    },
    [api, load],
  );

  const remove = useCallback(
    async (id: string, action: 'dismiss' | 'snooze') => {
      setRecommendations((prev) => prev.filter((r) => r.id !== id));
      try {
        await api.act(id, action);
      } finally {
        void load();
      }
    },
    [api, load],
  );

  const dismiss = useCallback((id: string) => remove(id, 'dismiss'), [remove]);
  const snooze = useCallback((id: string) => remove(id, 'snooze'), [remove]);

  return { overview, recommendations, results, status, lastEventAt, error, refresh, approve, undo, dismiss, snooze };
}
