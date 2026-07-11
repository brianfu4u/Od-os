/**
 * Env-gated synthetic transcript samples for offline UI development / demo (see config.STT_SYNTHETIC:
 * NEXT_PUBLIC_STT_SYNTHETIC, default OFF, FORCED off in production). Every item is flagged
 * `synthetic: true` so the UI badges it as "合成·演示" — this data is CLEARLY synthetic and never
 * silently mixes with real backend transcripts. Prefer the real path (backend STT_PROVIDER=mock),
 * which exercises the full pipeline with no key; this shim only exists for pure front-end work.
 */
import { transcriptView, type TranscriptFeedItem } from './transcript-model';

/** A few representative states so the four render paths are all visible in a demo. */
export function syntheticFeedItems(now: number = Date.now()): TranscriptFeedItem[] {
  const iso = (offsetMin: number) => new Date(now - offsetMin * 60_000).toISOString();
  return [
    {
      id: 'synthetic-done',
      at: iso(1),
      synthetic: true,
      transcript: transcriptView({
        text: '3号房已为下一位患者备好',
        status: 'done',
        language: 'zh',
        confidence: 0.9,
        provider: 'mock',
        model: 'mock',
        at: iso(1),
      }),
      claim: { taskType: 'room_turnover', claimedState: 'ready' },
      verdict: { verifiedState: 'conflict', confidence: 0.5 },
    },
    {
      id: 'synthetic-low',
      at: iso(4),
      synthetic: true,
      transcript: transcriptView({
        text: '……好像准备好了？（背景嘈杂）',
        status: 'low_confidence',
        language: 'zh',
        confidence: 0.32,
        provider: 'mock',
        model: 'mock',
        at: iso(4),
      }),
      claim: null,
      verdict: null,
    },
    {
      id: 'synthetic-failed',
      at: iso(7),
      synthetic: true,
      transcript: transcriptView({
        text: null,
        status: 'failed',
        language: null,
        confidence: null,
        provider: 'mock',
        model: 'mock',
        error: 'HTTP 500',
        at: iso(7),
      }),
      claim: null,
      verdict: null,
    },
  ];
}
