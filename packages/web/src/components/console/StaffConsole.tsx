'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import type { StaffReportType } from '@clearview/shared';
import { makeApi } from '../../lib/api';
import { hhmm, pct } from '../../lib/format';

interface ObjRow {
  id: string;
  type: string;
  properties: Record<string, unknown>;
  verifiedState: string | null;
  confidence: number | null;
}

interface LogEntry {
  at: string;
  ok: boolean;
  text: string;
}

const REPORT_TYPES: StaffReportType[] = ['task_update', 'event', 'evidence', 'scan', 'clock_in', 'clock_out'];

function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `dev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function labelOf(o: ObjRow): string {
  const p = o.properties ?? {};
  return (
    (typeof p.label === 'string' && p.label) ||
    (typeof p.name === 'string' && p.name) ||
    (typeof p.taskType === 'string' && p.taskType) ||
    o.type
  );
}

/**
 * Staff console — a browser stand-in for the WeChat Mini Program staff terminal. It POSTs
 * the exact same report/upload/scan payloads the Mini Program will (over the dev-only
 * X-Tenant-Id path; production swaps in a wx.login/openid session, S0-3). Use it to drive
 * the loop live and watch the command center react over SSE.
 */
export function StaffConsole() {
  const t = useTranslations();
  const locale = useLocale();
  const api = useMemo(() => makeApi(), []);

  const [objects, setObjects] = useState<ObjRow[]>([]);
  const [subjectId, setSubjectId] = useState<string>('');
  const [log, setLog] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState(false);

  // report form
  const [reportType, setReportType] = useState<StaffReportType>('task_update');
  const [text, setText] = useState('3号房已为下一位患者备好');
  const [staffName, setStaffName] = useState('A · Front Desk');
  const [scanSubject, setScanSubject] = useState(true);

  // upload form
  const [kind, setKind] = useState('photo');
  const [linkUpload, setLinkUpload] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);

  const pushLog = useCallback((ok: boolean, text: string) => {
    setLog((prev) => [{ at: new Date().toISOString(), ok, text }, ...prev].slice(0, 12));
  }, []);

  const loadObjects = useCallback(async () => {
    try {
      const rows = (await api.objects()) as unknown as ObjRow[];
      const subjects = rows.filter((r) => ['Task', 'Room', 'InventoryItem', 'Equipment'].includes(r.type));
      setObjects(subjects);
      setSubjectId((cur) => cur || subjects[0]?.id || '');
    } catch (e) {
      pushLog(false, `${t('console.loadFailed')}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [api, pushLog, t]);

  useEffect(() => {
    void loadObjects();
  }, [loadObjects]);

  const subject = objects.find((o) => o.id === subjectId);

  async function submitReport(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api.postReport({
        clientMessageId: newId(),
        reportType,
        text: text || undefined,
        staffHandle: staffName.toLowerCase().replace(/\s+/g, '_'),
        staffDisplayName: staffName,
        at: new Date().toISOString(),
        scans:
          scanSubject && subject
            ? [{ scannedObjectType: subject.type, scannedObjectId: subject.id, at: new Date().toISOString() }]
            : undefined,
      });
      pushLog(
        true,
        `${t('console.report')} → ${res.deduped ? t('console.deduped') : t('console.created')} (comm ${res.communicationId.slice(0, 8)})`,
      );
      await loadObjects();
    } catch (e) {
      pushLog(false, `${t('console.report')}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function submitUpload(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) {
      pushLog(false, t('console.noFile'));
      return;
    }
    setBusy(true);
    try {
      const res = await api.upload(file, { kind, linkTo: linkUpload && subject ? subject.id : undefined });
      pushLog(
        true,
        `${t('console.upload')} → ${res.objectType}/${res.kind} ${res.deduped ? `(${t('console.deduped')})` : ''} ${res.objectId.slice(0, 8)}`,
      );
      if (fileRef.current) fileRef.current.value = '';
      await loadObjects();
    } catch (e) {
      pushLog(false, `${t('console.upload')}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function forceVerify(): Promise<void> {
    if (!subject) return;
    setBusy(true);
    try {
      const res = await api.verify(subject.id);
      pushLog(true, `${t('console.verify')} → ${res.verifiedState} ${pct(res.confidence)} — ${res.reason}`);
      await loadObjects();
    } catch (e) {
      pushLog(false, `${t('console.verify')}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const inputCls =
    'w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-500';
  const cardCls = 'rounded-xl border border-slate-800 bg-slate-900/60 p-4';

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-4xl space-y-5 px-[5%] py-8">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold text-slate-50">{t('console.title')}</h1>
            <p className="mt-1 text-sm text-slate-400">{t('console.subtitle')}</p>
          </div>
          <a
            href={`/${locale}`}
            className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300 transition-colors hover:border-slate-500 hover:text-white"
          >
            {t('console.back')}
          </a>
        </header>

        <div className={cardCls}>
          <label className="text-xs uppercase tracking-wide text-slate-500">{t('console.subject')}</label>
          <select className={`mt-1 ${inputCls}`} value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
            {objects.length === 0 ? <option value="">{t('console.noObjects')}</option> : null}
            {objects.map((o) => (
              <option key={o.id} value={o.id}>
                {o.type} · {labelOf(o)} {o.verifiedState ? `· ${o.verifiedState} ${pct(o.confidence ?? undefined)}` : ''}
              </option>
            ))}
          </select>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => void forceVerify()}
              disabled={busy || !subject}
              className="rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-sky-400 disabled:opacity-50"
            >
              {t('console.reverify')}
            </button>
            <button
              type="button"
              onClick={() => void loadObjects()}
              disabled={busy}
              className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition-colors hover:border-slate-500 disabled:opacity-50"
            >
              {t('console.refresh')}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          {/* report */}
          <form className={cardCls} onSubmit={(e) => void submitReport(e)}>
            <h2 className="text-sm font-semibold text-slate-100">{t('console.reportCard')}</h2>
            <p className="mt-1 text-xs text-slate-500">{t('console.reportHint')}</p>
            <div className="mt-3 space-y-3">
              <div>
                <label className="text-xs text-slate-500">{t('console.reportType')}</label>
                <select
                  className={`mt-1 ${inputCls}`}
                  value={reportType}
                  onChange={(e) => setReportType(e.target.value as StaffReportType)}
                >
                  {REPORT_TYPES.map((rt) => (
                    <option key={rt} value={rt}>
                      {t(`comms.reportTypes.${rt}`)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-slate-500">{t('console.message')}</label>
                <input className={`mt-1 ${inputCls}`} value={text} onChange={(e) => setText(e.target.value)} />
              </div>
              <div>
                <label className="text-xs text-slate-500">{t('console.staffName')}</label>
                <input className={`mt-1 ${inputCls}`} value={staffName} onChange={(e) => setStaffName(e.target.value)} />
              </div>
              <label className="flex items-center gap-2 text-xs text-slate-400">
                <input type="checkbox" checked={scanSubject} onChange={(e) => setScanSubject(e.target.checked)} />
                {t('console.scanSubject')}
              </label>
              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-lg bg-emerald-500 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-400 disabled:opacity-50"
              >
                {t('console.sendReport')}
              </button>
            </div>
          </form>

          {/* upload */}
          <form className={cardCls} onSubmit={(e) => void submitUpload(e)}>
            <h2 className="text-sm font-semibold text-slate-100">{t('console.uploadCard')}</h2>
            <p className="mt-1 text-xs text-slate-500">{t('console.uploadHint')}</p>
            <div className="mt-3 space-y-3">
              <div>
                <label className="text-xs text-slate-500">{t('console.file')}</label>
                <input
                  ref={fileRef}
                  type="file"
                  className="mt-1 block w-full text-xs text-slate-400 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-800 file:px-3 file:py-2 file:text-slate-200"
                />
              </div>
              <div>
                <label className="text-xs text-slate-500">{t('console.kind')}</label>
                <select className={`mt-1 ${inputCls}`} value={kind} onChange={(e) => setKind(e.target.value)}>
                  <option value="photo">{t('console.kinds.photo')}</option>
                  <option value="screenshot">{t('console.kinds.screenshot')}</option>
                  <option value="document">{t('console.kinds.document')}</option>
                  <option value="pdf">{t('console.kinds.pdf')}</option>
                </select>
              </div>
              <label className="flex items-center gap-2 text-xs text-slate-400">
                <input type="checkbox" checked={linkUpload} onChange={(e) => setLinkUpload(e.target.checked)} />
                {t('console.linkUpload')}
              </label>
              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-lg bg-emerald-500 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-400 disabled:opacity-50"
              >
                {t('console.sendUpload')}
              </button>
            </div>
          </form>
        </div>

        {/* activity log */}
        <div className={cardCls}>
          <h2 className="text-sm font-semibold text-slate-100">{t('console.activity')}</h2>
          <div className="mt-2 space-y-1.5">
            {log.length === 0 ? (
              <p className="text-xs text-slate-500">{t('console.activityEmpty')}</p>
            ) : (
              log.map((l, i) => (
                <div key={i} className="flex items-start gap-2 text-xs">
                  <span className="font-mono text-slate-600">{hhmm(l.at)}</span>
                  <span className={l.ok ? 'text-emerald-400' : 'text-rose-400'}>{l.ok ? '✓' : '✕'}</span>
                  <span className="text-slate-300">{l.text}</span>
                </div>
              ))
            )}
          </div>
        </div>

        <p className="text-xs text-slate-600">{t('console.devNote')}</p>
      </div>
    </main>
  );
}
