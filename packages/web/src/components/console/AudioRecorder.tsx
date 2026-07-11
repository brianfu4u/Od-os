'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { audioExt, bareMime, formatDuration, pickSupportedMime } from '../../lib/audio-recording';

type RecState = 'idle' | 'recording' | 'recorded' | 'unsupported' | 'denied' | 'error';

const DEFAULT_MAX_MS = 120_000; // 2 min cap — well under the 20MB backend limit for opus, prevents abuse

/**
 * T3 · on-terminal audio recording via the browser-native MediaRecorder (zero dependencies, same
 * approach as T2's BarcodeDetector). Record → stop → preview → hand a normalized File to the parent,
 * which uploads it as kind='voice' through the existing T4 pipeline (STT → claim → LLM1). Degrades
 * gracefully: no mic / permission denied / unsupported browser / restricted webview → a clear
 * message, never a crash — recording is an enhancement, so its absence must not block other reports.
 * Every device call is guarded; the mic is released on stop and on unmount.
 */
export function AudioRecorder({
  onComplete,
  disabled,
  maxMs = DEFAULT_MAX_MS,
}: {
  onComplete: (file: File) => void;
  disabled?: boolean;
  maxMs?: number;
}) {
  const t = useTranslations();
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startTsRef = useRef(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const urlRef = useRef<string | null>(null);

  const [state, setState] = useState<RecState>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const clearTimers = useCallback(() => {
    if (tickRef.current != null) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    if (maxTimerRef.current != null) {
      clearTimeout(maxTimerRef.current);
      maxTimerRef.current = null;
    }
  }, []);

  const releaseStream = useCallback(() => {
    try {
      streamRef.current?.getTracks().forEach((tk) => tk.stop());
    } catch {
      /* ignore */
    }
    streamRef.current = null;
  }, []);

  const revokePreview = useCallback(() => {
    if (urlRef.current) {
      try {
        URL.revokeObjectURL(urlRef.current);
      } catch {
        /* ignore */
      }
      urlRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    clearTimers();
    try {
      if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
    } catch {
      releaseStream();
    }
  }, [clearTimers, releaseStream]);

  const start = useCallback(async () => {
    setErrMsg(null);
    revokePreview();
    setPreviewUrl(null);
    setFile(null);
    const hasMedia =
      typeof navigator !== 'undefined' && !!navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function';
    const hasRecorder = typeof window !== 'undefined' && typeof window.MediaRecorder !== 'undefined';
    if (!hasMedia || !hasRecorder) {
      setState('unsupported');
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      const name = (e as { name?: string })?.name;
      setState(name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError' ? 'denied' : 'error');
      if (name !== 'NotAllowedError') setErrMsg(e instanceof Error ? e.message : String(e));
      return;
    }
    streamRef.current = stream;

    const mime = pickSupportedMime((m) => window.MediaRecorder.isTypeSupported(m));
    let recorder: MediaRecorder;
    try {
      recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch {
      try {
        recorder = new MediaRecorder(stream);
      } catch (e) {
        setState('error');
        setErrMsg(e instanceof Error ? e.message : String(e));
        releaseStream();
        return;
      }
    }
    recorderRef.current = recorder;
    chunksRef.current = [];

    recorder.ondataavailable = (ev: BlobEvent) => {
      if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
    };
    recorder.onstop = () => {
      clearTimers();
      releaseStream();
      const type = bareMime(recorder.mimeType || mime || 'audio/webm');
      const blob = new Blob(chunksRef.current, { type });
      chunksRef.current = [];
      if (blob.size === 0) {
        setState('error');
        setErrMsg('empty recording');
        return;
      }
      const f = new File([blob], `recording-${Date.now()}.${audioExt(type)}`, { type });
      setFile(f);
      try {
        const url = URL.createObjectURL(blob);
        urlRef.current = url;
        setPreviewUrl(url);
      } catch {
        /* preview is optional */
      }
      setState('recorded');
    };

    try {
      recorder.start();
    } catch (e) {
      setState('error');
      setErrMsg(e instanceof Error ? e.message : String(e));
      releaseStream();
      return;
    }
    startTsRef.current = Date.now();
    setElapsed(0);
    setState('recording');
    tickRef.current = setInterval(() => setElapsed(Date.now() - startTsRef.current), 250);
    maxTimerRef.current = setTimeout(() => stop(), maxMs);
  }, [clearTimers, maxMs, releaseStream, revokePreview, stop]);

  const reset = useCallback(() => {
    revokePreview();
    setPreviewUrl(null);
    setFile(null);
    setElapsed(0);
    setState('idle');
  }, [revokePreview]);

  const submit = useCallback(() => {
    if (file) {
      onComplete(file);
      reset();
    }
  }, [file, onComplete, reset]);

  useEffect(() => {
    return () => {
      clearTimers();
      releaseStream();
      revokePreview();
    };
  }, [clearTimers, releaseStream, revokePreview]);

  const degraded = state === 'unsupported' || state === 'denied' || state === 'error';

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide text-slate-500">{t('rec.title')}</span>
        <span className="font-mono text-xs text-slate-400">
          {formatDuration(state === 'recording' ? elapsed : file ? elapsed : 0)} / {formatDuration(maxMs)}
        </span>
      </div>

      {state === 'idle' ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => void start()}
          className="mt-2 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-rose-500/50 bg-rose-500/10 px-4 py-2 text-sm font-medium text-rose-200 active:bg-rose-500/20 disabled:opacity-50"
        >
          🎙️ {t('rec.start')}
        </button>
      ) : null}

      {state === 'recording' ? (
        <button
          type="button"
          onClick={() => stop()}
          className="mt-2 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-rose-500 px-4 py-2 text-sm font-semibold text-white active:bg-rose-600"
        >
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-white" /> {t('rec.stop')}
        </button>
      ) : null}

      {state === 'recorded' ? (
        <div className="mt-2 space-y-2">
          {previewUrl ? <audio controls src={previewUrl} className="w-full" /> : null}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={disabled}
              onClick={submit}
              className="min-h-11 flex-1 rounded-xl bg-emerald-500 px-3 py-2 text-sm font-semibold text-white active:bg-emerald-600 disabled:opacity-50"
            >
              {t('rec.send')}
            </button>
            <button
              type="button"
              onClick={reset}
              className="min-h-11 rounded-xl border border-slate-600 px-3 py-2 text-sm text-slate-200 active:bg-slate-800"
            >
              {t('rec.again')}
            </button>
          </div>
        </div>
      ) : null}

      {degraded ? (
        <div className="mt-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          <p>{state === 'unsupported' ? t('rec.unsupported') : state === 'denied' ? t('rec.denied') : t('rec.error')}</p>
          {errMsg && state === 'error' ? <p className="mt-1 break-all text-amber-400/70">{errMsg}</p> : null}
          {state !== 'unsupported' ? (
            <button type="button" onClick={() => void start()} className="mt-2 rounded-md border border-amber-400/40 px-2 py-0.5 text-[11px] text-amber-100 active:bg-amber-500/20">
              {t('rec.retry')}
            </button>
          ) : null}
        </div>
      ) : null}

      <p className="mt-1 text-[11px] text-slate-500">{t('rec.hint')}</p>
    </div>
  );
}
