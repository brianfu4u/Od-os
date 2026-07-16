'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OverviewResult, RecommendationRecord } from '@clearview/shared';
import { makeApi } from '../lib/api';
import { STT_SYNTHETIC } from '../lib/config';
import { buildFeed, type TranscriptFeedItem } from '../lib/transcript-model';
import { syntheticFeedItems } from '../lib/synthetic-transcripts';

export type FeedStatus = 'connecting' | 'live' | 'offline';

/**
 * Two independent signals drive the UI:
 *  - `status` (data availability) — drives the offline BANNER. It only becomes 'offline' when a real
 *    data fetch (`load()`) fails, and returns to 'live' as soon as one succeeds. A flaky SSE socket
 *    never flips this, so the banner no longer flickers when the realtime stream reconnects.
 *  - `streaming` (realtime link) — a soft indicator for the live/reconnecting pill; SSE drops just
 *    downgrade this, they don't raise the banner.
 */
export type StreamState = 'connecting' | 'open' | 'reconnecting';

export interface LiveData {
  overview: OverviewResult | null;
  recommendations: RecommendationRecord[];
  /** Recently acted cues (approve/undo) this session, with their execution result. */
  results: RecommendationRecord[];
  /** P7/T4: voice transcripts (voice → transcript → claim → verdict), newest first. */
  transcripts: TranscriptFeedItem[];
  status: FeedStatus;
  /** Realtime SSE link state — soft indicator, does not gate the offline banner. */
  streaming: StreamState;
  lastEventAt: number | null;
  error: string | null;
  refresh: () => void;
  approve: (id: string) => Promise<void>;
  undo: (id: string) => Promise<void>;
  dismiss: (id: string) => Promise<void>;
  snooze: (id: string) => Promise<void>;
  /** Re-run STT for a voice object (used by the failed/unavailable retry entry). */
  retryTranscription: (id: string) => Promise<void>;
}

/**
 * Wires the command center to the LIVE API using the manager SESSION token: initial load of the
 * overview aggregate + open recommendations + the scoped voice-transcript feed, an EventSource on
 * /objects/stream (?ticket=) that debounces a refetch on every change and AUTO-RECONNECTS with
 * capped backoff, and approve/undo/dismiss/snooze + transcription retry. Because the SSE refetch
 * reloads the transcript feed too, a transcript.completed/failed write (which changes the voice
 * Document) flows into the UI live. The voice feed uses the scoped /transcription/feed endpoint, so
 * the command center never pulls every Document + Task. All fetches run only in the browser, so the
 * static prerender stays data-free.
 */
export function useLiveData(token: string): LiveData {
  const api = useMemo(() => makeApi({ token }), [token]);
  const [overview, setOverview] = useState<OverviewResult | null>(null);
  const [recommendations, setRecommendations] = useState<RecommendationRecord[]>([]);
  const [results, setResults] = useState<RecommendationRecord[]>([]);
  const [transcripts, setTranscripts] = useState<TranscriptFeedItem[]>([]);
  const [status, setStatus] = useState<FeedStatus>('connecting');
  const [streaming, setStreaming] = useState<StreamState>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Whether at least one data load has ever succeeded. Until then we stay in 'connecting' (no scary
  // banner on first paint); after the first success, a later failure shows the banner.
  const everLoaded = useRef(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const [ov, recs, feed] = await Promise.all([
          api.overview(signal),
          api.recommendations('open', signal),
          api.transcripts(undefined, signal),
        ]);
        setOverview(ov);
        setRecommendations(recs);
        setTranscripts(
          buildFeed(feed, {
            synthetic: STT_SYNTHETIC,
            syntheticItems: STT_SYNTHETIC ? syntheticFeedItems() : undefined,
          }),
        );
        everLoaded.current = true;
        setError(null);
        setStatus('live'); // a successful data load is the single source of truth for "online"
      } catch (e) {
        if ((e as { name?: string }).name === 'AbortError') return;
        setError(e instanceof Error ? e.message : String(e));
        // Only surface the offline banner once a fetch has genuinely failed. (SSE hiccups never reach
        // here — they only touch `streaming` below — so the banner stays stable.)
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
  // offline is reconciled. EventSource can't set headers or read the HttpOnly cookie cross-site, so
  // each (re)connect first mints a short-lived single-use ticket and passes it as ?ticket=.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') return;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let closed = false;

    const scheduleReconnect = (): void => {
      if (closed) return;
      attempt += 1;
      const delay = Math.min(1000 * 2 ** (attempt - 1), 15000);
      retry = setTimeout(() => void connect(), delay);
    };

    const connect = async (): Promise<void> => {
      let ticket: string;
      try {
        ticket = await api.sseTicket();
      } catch {
        // Couldn't mint a ticket (e.g. not authenticated yet) — back off and retry. Data
        // availability is still governed by load(), so this never flips the offline banner.
        setStreaming('reconnecting');
        scheduleReconnect();
        return;
      }
      if (closed) return;
      es = new EventSource(api.streamUrl(ticket), { withCredentials: true });
      es.onopen = () => {
        attempt = 0;
        setStreaming('open');
        void load(); // reconcile any gap while the socket was down
      };
      es.onmessage = () => {
        setLastEventAt(Date.now());
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => void load(), 250);
      };
      es.onerror = () => {
        // A dropped SSE socket downgrades the realtime pill and triggers a backoff reconnect, but it
        // does NOT flip the offline banner — data availability is decided by load() alone. This is
        // what stops the banner from flickering on every reconnect attempt.
        setStreaming('reconnecting');
        es?.close();
        scheduleReconnect();
      };
    };
    void connect();

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

  const retryTranscription = useCallback(
    async (id: string) => {
      await api.retryTranscription(id);
      void load();
    },
    [api, load],
  );

  return {
    overview,
    recommendations,
    results,
    transcripts,
    status,
    streaming,
    lastEventAt,
    error,
    refresh,
    approve,
    undo,
    dismiss,
    snooze,
    retryTranscription,
  };
}
