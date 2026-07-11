'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { parseScanCode } from '../../lib/scan-code';

/** Minimal typings for the native BarcodeDetector API (not in TS DOM lib yet) — avoids `any`. */
interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
type BarcodeDetectorCtor = new (opts?: { formats?: string[] }) => BarcodeDetectorLike;

type ScanState = 'starting' | 'scanning' | 'unsupported' | 'denied' | 'error';

function getBarcodeDetector(): BarcodeDetectorCtor | null {
  if (typeof window === 'undefined') return null;
  const ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  return typeof ctor === 'function' ? ctor : null;
}

/**
 * T2 · real camera QR/barcode scanner. Uses the browser-native BarcodeDetector (zero dependencies)
 * with the rear camera. Degrades gracefully: no camera / permission denied / unsupported browser
 * (e.g. iOS Safari, which lacks BarcodeDetector) → a clear message + an always-present manual-input
 * fallback, never a blank screen or crash. Every device call is wrapped so a restricted webview
 * (sandboxed iframe, etc.) can't throw its way to a white screen. The scanned payload is normalized
 * by parseScanCode and handed to `onResult`; the caller resolves it against the backend.
 */
export function CameraScanner({
  onResult,
  onClose,
}: {
  onResult: (code: string) => void;
  onClose?: () => void;
}) {
  const t = useTranslations();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const detectorRef = useRef<BarcodeDetectorLike | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(true);
  const [state, setState] = useState<ScanState>('starting');
  const [manual, setManual] = useState('');
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const stop = useCallback(() => {
    activeRef.current = false;
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    try {
      streamRef.current?.getTracks().forEach((tk) => tk.stop());
    } catch {
      /* ignore */
    }
    streamRef.current = null;
  }, []);

  const emit = useCallback(
    (raw: string) => {
      const code = parseScanCode(raw);
      if (!code) return;
      stop();
      onResult(code);
    },
    [onResult, stop],
  );

  const start = useCallback(async () => {
    setErrMsg(null);
    const Ctor = getBarcodeDetector();
    const hasMedia =
      typeof navigator !== 'undefined' && !!navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function';
    if (!Ctor || !hasMedia) {
      setState('unsupported');
      return;
    }
    setState('starting');
    activeRef.current = true;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    } catch (e) {
      const name = (e as { name?: string })?.name;
      setState(name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError' ? 'denied' : 'error');
      if (name !== 'NotAllowedError') setErrMsg(e instanceof Error ? e.message : String(e));
      return;
    }
    if (!activeRef.current) {
      // unmounted while awaiting permission
      stream.getTracks().forEach((tk) => tk.stop());
      return;
    }
    streamRef.current = stream;
    try {
      detectorRef.current = new Ctor({ formats: ['qr_code', 'code_128', 'ean_13', 'code_39', 'data_matrix'] });
    } catch {
      try {
        detectorRef.current = new Ctor();
      } catch {
        setState('unsupported');
        stop();
        return;
      }
    }

    const video = videoRef.current;
    if (!video) {
      setState('error');
      stop();
      return;
    }
    video.srcObject = stream;
    try {
      await video.play();
    } catch {
      /* autoplay can reject; detection still works once frames arrive */
    }
    setState('scanning');

    const loop = async (): Promise<void> => {
      if (!activeRef.current) return;
      const v = videoRef.current;
      const det = detectorRef.current;
      if (v && det && v.readyState >= 2) {
        try {
          const codes = await det.detect(v);
          const val = codes[0]?.rawValue;
          if (val) {
            emit(String(val));
            return;
          }
        } catch {
          /* transient detect error → keep polling */
        }
      }
      timerRef.current = setTimeout(() => void loop(), 300);
    };
    void loop();
  }, [emit, stop]);

  useEffect(() => {
    void start();
    return () => stop();
    // Mount-only: start the camera once and stop it on unmount. `start`/`stop` are
    // intentionally excluded so re-renders don't restart the camera stream.
    // eslint-disable-next-line
  }, []);

  const submitManual = (e: React.FormEvent): void => {
    e.preventDefault();
    const code = parseScanCode(manual);
    if (code) {
      stop();
      onResult(code);
    }
  };

  const degraded = state === 'unsupported' || state === 'denied' || state === 'error';

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{t('scan.title')}</h2>
        {onClose ? (
          <button
            type="button"
            onClick={() => {
              stop();
              onClose();
            }}
            className="rounded-lg border border-slate-700 px-2 py-1 text-[11px] text-slate-300 active:bg-slate-800"
          >
            {t('scan.close')}
          </button>
        ) : null}
      </div>

      {!degraded ? (
        <div className="mt-3">
          <video ref={videoRef} muted playsInline className="aspect-square w-full rounded-xl bg-black object-cover" />
          <p className="mt-2 text-center text-xs text-slate-400">
            {state === 'starting' ? t('scan.starting') : t('scan.aim')}
          </p>
        </div>
      ) : (
        <div className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          <p>{state === 'unsupported' ? t('scan.unsupported') : state === 'denied' ? t('scan.denied') : t('scan.error')}</p>
          {errMsg && state === 'error' ? <p className="mt-1 break-all text-amber-400/70">{errMsg}</p> : null}
          {state !== 'unsupported' ? (
            <button type="button" onClick={() => void start()} className="mt-2 rounded-md border border-amber-400/40 px-2 py-0.5 text-[11px] text-amber-100 active:bg-amber-500/20">
              {t('scan.retry')}
            </button>
          ) : null}
        </div>
      )}

      {/* Manual fallback — always available so a scan is never a dead end. */}
      <form onSubmit={submitManual} className="mt-3 flex gap-2">
        <input
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          placeholder={t('scan.manualPlaceholder')}
          className="min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-500"
        />
        <button type="submit" className="shrink-0 rounded-xl border border-slate-600 px-3 py-2 text-sm text-slate-200 active:bg-slate-800">
          {t('scan.manualSubmit')}
        </button>
      </form>
      <p className="mt-1 text-[11px] text-slate-500">{t('scan.manualHint')}</p>
    </div>
  );
}
