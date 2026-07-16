'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { hhmm, pct } from '../../lib/format';
import type { TranscriptFeedItem, Tone } from '../../lib/transcript-model';

const TONE_BADGE: Record<Tone, string> = {
  ok: 'bg-emerald-500/20 text-emerald-300',
  warn: 'bg-amber-500/20 text-amber-300',
  bad: 'bg-rose-500/20 text-rose-300',
  muted: 'bg-slate-700/60 text-slate-300',
};

/** Verdict colours — deliberately DISTINCT visual language from the STT status badge (the moat). */
const VERIFY_BADGE: Record<string, string> = {
  verified: 'bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/40',
  conflict: 'bg-rose-500/20 text-rose-300 ring-1 ring-rose-500/40',
  pending: 'bg-amber-500/20 text-amber-300 ring-1 ring-amber-500/40',
  unverified: 'bg-slate-700/60 text-slate-300 ring-1 ring-slate-600/40',
};
const VERIFY_KEYS = ['verified', 'conflict', 'pending', 'unverified'];

/** One voice transcript: text/status + STT metadata + the voice → claim → verdict provenance chain. */
export function TranscriptPanel({
  item,
  onRetry,
}: {
  item: TranscriptFeedItem;
  onRetry?: (id: string) => Promise<void> | void;
}) {
  const t = useTranslations();
  const { transcript: v, claim, verdict } = item;
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  const retry = async () => {
    if (!onRetry || retrying) return;
    setRetrying(true);
    setRetryError(null);
    try {
      await onRetry(item.id);
    } catch (e) {
      setRetryError(e instanceof Error ? e.message : String(e));
    } finally {
      setRetrying(false);
    }
  };

  const verifyState = verdict && VERIFY_KEYS.includes(verdict.verifiedState) ? verdict.verifiedState : 'unverified';

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
      {/* header: STT status + synthetic flag + time */}
      <div className="flex items-center gap-2">
        <span className={['rounded-full px-2 py-0.5 text-[10px]', TONE_BADGE[v.tone]].join(' ')}>{t(v.statusKey)}</span>
        {item.synthetic ? (
          <span className="rounded-full bg-fuchsia-500/20 px-2 py-0.5 text-[10px] text-fuchsia-300" title={t('transcript.syntheticNote')}>
            {t('transcript.synthetic')}
          </span>
        ) : null}
        {v.at ? <span className="ml-auto font-mono text-[10px] text-slate-500">{hhmm(v.at)}</span> : null}
      </div>

      {/* transcript text — PLAIN TEXT only (React escapes; never dangerouslySetInnerHTML) */}
      {v.showText && v.text ? (
        <p className="mt-2 break-words text-sm text-slate-200">{v.text}</p>
      ) : v.status === 'none' ? (
        <p className="mt-2 text-sm text-slate-500">{t('transcript.status.none')}</p>
      ) : null}

      {v.notApplied ? <p className="mt-1 text-[11px] text-amber-300/80">{t('transcript.notApplied')}</p> : null}

      {/* failure / unavailable → hint + retry */}
      {v.retryable ? (
        <div className="mt-2 space-y-1">
          <p className="text-[11px] text-slate-400">
            {v.status === 'failed' ? t('transcript.failedHint') : t('transcript.unavailableHint')}
            {v.errorText ? <span className="ml-1 font-mono text-slate-500">({v.errorText})</span> : null}
          </p>
          {onRetry ? (
            <button
              type="button"
              onClick={() => void retry()}
              disabled={retrying}
              className="rounded-md border border-slate-700 px-2 py-0.5 text-[11px] text-slate-200 transition-colors hover:border-slate-500 disabled:opacity-50"
            >
              {retrying ? t('transcript.retrying') : t('transcript.retry')}
            </button>
          ) : null}
          {retryError ? <p className="text-[10px] text-rose-300">{t('transcript.retryFailed')}: {retryError}</p> : null}
        </div>
      ) : null}

      {/* STT metadata — the STT confidence is labelled and kept separate from the verdict */}
      {(v.provider || v.model || v.language || v.sttConfidence != null) && v.status !== 'none' ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-500">
          {v.provider ? <span>{t('transcript.provider')}: {v.provider}</span> : null}
          {v.model ? <span>{t('transcript.model')}: {v.model}</span> : null}
          {v.language ? <span>{t('transcript.language')}: {v.language}</span> : null}
          {v.sttConfidence != null ? (
            <span className="tabular-nums">{t('transcript.sttConfidence')}: {pct(v.sttConfidence)}</span>
          ) : null}
        </div>
      ) : null}

      {/* provenance chain: 语音 → 主张(声称, LLM1) → 判决(核实, S2 only) */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-slate-800/70 pt-2 text-[10px]">
        <span className="rounded bg-slate-800 px-1.5 py-0.5 text-slate-400">{t('transcript.chain.voice')}</span>
        <span aria-hidden className="text-slate-600">→</span>
        {claim ? (
          <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-sky-300" title={t('transcript.claim')}>
            {t('transcript.chain.claim')}: {claim.taskType ? `${claim.taskType} · ` : ''}
            {claim.claimedState}
          </span>
        ) : (
          <span className="rounded bg-slate-800 px-1.5 py-0.5 text-slate-500">{t('transcript.noClaim')}</span>
        )}
        <span aria-hidden className="text-slate-600">→</span>
        {verdict ? (
          <span className={['rounded-full px-2 py-0.5', VERIFY_BADGE[verifyState]].join(' ')} title={t('transcript.verdict')}>
            {t('transcript.chain.verdict')}: {t(`verify.${verifyState}`)}
            {verdict.verificationScore != null ? ` · ${t('transcript.verifyConfidence')} ${pct(verdict.verificationScore)}` : ''}
          </span>
        ) : (
          <span className="rounded bg-slate-800 px-1.5 py-0.5 text-slate-500">{t('transcript.noVerdict')}</span>
        )}
      </div>
    </div>
  );
}
