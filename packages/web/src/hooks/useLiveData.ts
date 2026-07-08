'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OverviewResult, RecommendationRecord } from '@clearview/shared';
import { makeApi } from '../lib/api';

export type FeedStatus = 'connecting' | 'live' | 'offline';

export interface LiveData {
  overview: OverviewResult | null;
  recommendations: RecommendationRecord[];
  status: FeedStatus;
  /** Last SSE change type observed, for a subtle "just updated" pulse. */
  lastEventAt: number | null;
  error: string | null;
  refresh: () => void;
  act: (id: string, action: 'approve' | 'dismiss' | 'snooze') => Promise<void>;
}

/**
 * One hook wiring the command center to the LIVE API: initial load of the overview
 * aggregate + open recommendations, an EventSource on /objects/stream that debounces a
 * refetch on every change, and optimistic approve/dismiss/snooze. Fetches run only in the
 * browser (useEffect), so the static prerender stays data-free and never crashes when the
 * API is down — it just shows the offline state.
 */
export function useLiveData(tenantId?: string): LiveData {
  const api = useMemo(() => makeApi(tenantId), [tenantId]);
  const [overview, setOverview] = useState<OverviewResult | null>(null);
  const [recommendations, setRecommendations] = useState<RecommendationRecord[]>([]);
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

  // Initial load.
  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  // SSE — refetch (debounced) on every object change for this tenant.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') return;
    const es = new EventSource(api.streamUrl());
    es.onopen = () => setStatus('live');
    es.onmessage = () => {
      setLastEventAt(Date.now());
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void load(), 250);
    };
    es.onerror = () => setStatus((s) => (s === 'live' ? 'live' : 'offline'));
    return () => {
      es.close();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [api, load]);

  const refresh = useCallback(() => void load(), [load]);

  const act = useCallback(
    async (id: string, action: 'approve' | 'dismiss' | 'snooze') => {
      // Optimistic: drop the cue from the open feed immediately; SSE + refetch reconcile.
      setRecommendations((prev) => prev.filter((r) => r.id !== id));
      try {
        await api.act(id, action);
      } finally {
        void load();
      }
    },
    [api, load],
  );

  return { overview, recommendations, status, lastEventAt, error, refresh, act };
}
