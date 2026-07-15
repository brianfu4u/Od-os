'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { ScanAck } from '@clearview/shared';
import type { Api } from '../../lib/api';
import { hhmm } from '../../lib/format';
import { CameraScanner } from './CameraScanner';

/**
 * T-08 · patient SCAN entry — a standalone "扫患者码" action for the employee.
 *
 * A scan is a NEUTRAL, append-only contact event (principle: 提交不驳回). This surface:
 *   - submits the raw scanned code via api.submitScan and shows only the neutral `ScanAck`
 *     (scanId / patientCode / patientVisitId / visitLinkStatus / scannedAt);
 *   - renders NO business verdict, NO "valid/invalid", NO verification or AI feedback. `visitLinkStatus`
 *     is shown as a plain fact (resolved / unresolved), never as approval or a pass/fail judgment;
 *   - never blocks the employee: an unresolved code is still an accepted, recorded scan.
 *
 * Deliberately independent of the report/subject scanner in StaffConsole: this is the dedicated
 * patient-contact scan, reusing the same CameraScanner device component.
 */

export function ScanEntry({ api }: { api: Api }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ack, setAck] = useState<ScanAck | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const onScanned = useCallback(
    async (code: string) => {
      setOpen(false);
      setBusy(true);
      setErr(null);
      try {
        const result = await api.submitScan({ patientCode: code });
        setAck(result);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [api],
  );

  return (
    <section aria-label={t('scanEntry.title')} data-testid="scan-entry" className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-slate-100">{t('scanEntry.title')}</h2>
        {busy ? <span className="text-[11px] text-slate-400">{t('scanEntry.submitting')}</span> : null}
      </div>
      <p className="mt-1 text-[11px] text-slate-500">{t('scanEntry.hint')}</p>

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        className="mt-3 min-h-12 w-full rounded-xl border border-sky-500/50 bg-sky-500/10 px-4 py-3 text-base font-semibold text-sky-200 active:bg-sky-500/20 disabled:opacity-50"
      >
        📷 {t('scanEntry.scan')}
      </button>

      {open ? (
        <div className="mt-3">
          <CameraScanner onResult={(c) => void onScanned(c)} onClose={() => setOpen(false)} />
        </div>
      ) : null}

      {/* Neutral acknowledgement only — a receipt, not a verdict. */}
      {ack ? (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-xl border border-slate-800 bg-slate-950/40 p-3 text-[11px]">
          <dt className="text-slate-500">{t('scanEntry.ack.code')}</dt>
          <dd className="font-mono text-slate-300">{ack.patientCode ?? '—'}</dd>
          <dt className="text-slate-500">{t('scanEntry.ack.visit')}</dt>
          <dd className="font-mono text-slate-300">{ack.patientVisitId ?? '—'}</dd>
          <dt className="text-slate-500">{t('scanEntry.ack.link')}</dt>
          <dd className="text-slate-300">{t(`scanEntry.linkStatus.${ack.visitLinkStatus}`)}</dd>
          <dt className="text-slate-500">{t('scanEntry.ack.at')}</dt>
          <dd className="font-mono text-slate-400">{hhmm(ack.scannedAt)}</dd>
        </dl>
      ) : null}

      {err ? <p className="mt-2 text-xs text-rose-300">{err}</p> : null}
    </section>
  );
}
