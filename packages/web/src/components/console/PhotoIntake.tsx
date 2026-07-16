'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { PhotoEvidenceReceipt } from '@clearview/shared';
import type { Api } from '../../lib/api';
import { nextPhotoMetadata } from '../../lib/photo-intake';

type IntakeState =
  'idle' | 'starting' | 'ready' | 'uploading' | 'done' | 'unsupported' | 'denied' | 'error';

const MAX_CAPTURE_DIMENSION = 1920;

function jpegFromCanvas(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('camera produced an empty JPEG'))),
      'image/jpeg',
      0.9,
    );
  });
}

/**
 * T-16 direct photo intake. The rear-camera stream is rendered in-page and one frame is encoded to
 * a metadata-free JPEG in memory, then immediately POSTed. There is no file picker, download, image
 * preview URL, IndexedDB write, or Photos-library operation, so the capture never lands in an album.
 */
export function PhotoIntake({
  api,
  onComplete,
  onError,
}: {
  api: Api;
  onComplete?: (receipt: PhotoEvidenceReceipt) => void;
  onError?: (message: string) => void;
}) {
  const t = useTranslations('console.photoIntake');
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const mountedRef = useRef(true);
  const cameraRequestedRef = useRef(false);
  const [state, setState] = useState<IntakeState>('idle');
  const [message, setMessage] = useState<string | null>(null);

  const stopCamera = useCallback(() => {
    cameraRequestedRef.current = false;
    try {
      streamRef.current?.getTracks().forEach((track) => track.stop());
    } catch {
      /* camera release is best-effort */
    }
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopCamera();
    };
  }, [stopCamera]);

  const fail = useCallback(
    (nextState: 'unsupported' | 'denied' | 'error', error?: unknown) => {
      stopCamera();
      const detail = error instanceof Error ? error.message : error ? String(error) : null;
      setMessage(detail);
      setState(nextState);
      onError?.(detail ?? t(nextState));
    },
    [onError, stopCamera, t],
  );

  const startCamera = useCallback(async () => {
    stopCamera();
    cameraRequestedRef.current = true;
    setMessage(null);
    const supported =
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function';
    if (!supported) {
      fail('unsupported');
      return;
    }
    setState('starting');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
    } catch (error) {
      const name = (error as { name?: string })?.name;
      fail(
        name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError'
          ? 'denied'
          : 'error',
        error,
      );
      return;
    }
    if (!mountedRef.current || !cameraRequestedRef.current) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    streamRef.current = stream;
    const video = videoRef.current;
    if (!video) {
      fail('error', new Error('camera view is unavailable'));
      return;
    }
    video.srcObject = stream;
    try {
      await video.play();
      setState('ready');
    } catch (error) {
      fail('error', error);
    }
  }, [fail, stopCamera]);

  const captureAndUpload = useCallback(async () => {
    const video = videoRef.current;
    if (!video || video.videoWidth <= 0 || video.videoHeight <= 0) {
      fail('error', new Error('camera frame is not ready'));
      return;
    }
    setState('uploading');
    const capturedAt = new Date();
    try {
      const scale = Math.min(
        1,
        MAX_CAPTURE_DIMENSION / Math.max(video.videoWidth, video.videoHeight),
      );
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('camera canvas is unavailable');
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await jpegFromCanvas(canvas);
      stopCamera();

      // The File exists only in this async scope and is released after upload; it is never put in
      // React state, a preview URL, browser storage, a download, or the device photo library.
      const file = new File([blob], `capture-${Date.now()}.jpg`, { type: 'image/jpeg' });
      const receipt = await api.uploadPhoto(file, nextPhotoMetadata(capturedAt));
      setMessage(receipt.eventId.slice(0, 8));
      setState('done');
      onComplete?.(receipt);
    } catch (error) {
      fail('error', error);
    }
  }, [api, fail, onComplete, stopCamera]);

  const degraded = state === 'unsupported' || state === 'denied' || state === 'error';

  return (
    <section className="rounded-2xl border border-emerald-700/40 bg-emerald-950/20 p-4">
      <h2 className="text-sm font-semibold">{t('title')}</h2>
      <p className="mt-1 text-xs text-slate-400">{t('hint')}</p>

      {state === 'ready' || state === 'uploading' || state === 'starting' ? (
        <div className="mt-3">
          <video
            ref={videoRef}
            muted
            playsInline
            className="aspect-[4/3] w-full rounded-xl bg-black object-cover"
          />
          <p className="mt-2 text-center text-xs text-slate-400">
            {state === 'starting'
              ? t('starting')
              : state === 'uploading'
                ? t('uploading')
                : t('ready')}
          </p>
        </div>
      ) : (
        <video ref={videoRef} muted playsInline className="hidden" />
      )}

      {state === 'idle' || state === 'done' || degraded ? (
        <button
          type="button"
          onClick={() => void startCamera()}
          className="mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-emerald-500/50 bg-emerald-500/10 px-4 py-3 text-base font-semibold text-emerald-200 active:bg-emerald-500/20"
        >
          📷 {state === 'done' ? t('again') : degraded ? t('retry') : t('start')}
        </button>
      ) : null}

      {state === 'ready' ? (
        <button
          type="button"
          onClick={() => void captureAndUpload()}
          className="mt-3 min-h-12 w-full rounded-xl bg-emerald-500 px-4 py-3 text-base font-semibold text-white active:bg-emerald-600"
        >
          {t('capture')}
        </button>
      ) : null}

      {state === 'starting' || state === 'ready' ? (
        <button
          type="button"
          onClick={() => {
            stopCamera();
            setState('idle');
            setMessage(null);
          }}
          className="mt-2 min-h-11 w-full rounded-xl border border-slate-700 px-3 py-2 text-sm text-slate-300 active:bg-slate-800"
        >
          {t('cancel')}
        </button>
      ) : null}

      {state === 'done' ? (
        <p className="mt-2 rounded-lg bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
          {t('received', { id: message ?? '' })}
        </p>
      ) : null}
      {degraded ? (
        <div className="mt-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          <p>{t(state)}</p>
          {message ? <p className="mt-1 break-all text-amber-400/70">{message}</p> : null}
        </div>
      ) : null}
      <p className="mt-2 text-[11px] text-slate-500">{t('privacy')}</p>
    </section>
  );
}
