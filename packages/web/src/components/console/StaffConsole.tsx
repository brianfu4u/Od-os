'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import type { MyTaskSummary, StaffReportType } from '@clearview/shared';
import { makeApi, type Api } from '../../lib/api';
import { hhmm, pct } from '../../lib/format';
import { DEV_TENANTS, IS_STAGING } from '../../lib/config';
import { LocaleSwitcher } from '../LocaleSwitcher';
import { safeStorage } from '../../lib/safe-storage';
import { CameraScanner } from './CameraScanner';
import { AudioRecorder } from './AudioRecorder';
import { MyTasks } from './MyTasks';
import {
  clearStaffToken,
  fetchMe,
  loadStaffToken,
  saveStaffToken,
  staffDevLogin,
  staffStagingLogin,
  type Session,
} from '../../lib/session';

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
type ClockState = { type: 'clock_in' | 'clock_out'; at: string } | null;

// clock_in/clock_out are dedicated buttons; the picker covers the rest.
const REPORT_TYPES: StaffReportType[] = ['task_update', 'event', 'evidence', 'scan'];

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

const INPUT =
  'w-full rounded-xl border border-slate-700 bg-slate-950/60 px-3 py-3 text-base text-slate-100 outline-none focus:border-sky-500';
const CARD = 'rounded-2xl border border-slate-800 bg-slate-900/60 p-4';
const BTN_PRIMARY =
  'w-full min-h-12 rounded-xl bg-emerald-500 px-4 py-3 text-base font-semibold text-white transition-colors hover:bg-emerald-400 active:bg-emerald-600 disabled:opacity-50';

/**
 * Staff terminal — mobile-first, usable on a phone browser (incl. WeChat's built-in browser). T1:
 * it authenticates via a real session (dev: staff dev-login; staging: password-gated staff
 * staging-login) so /reports + /uploads work on staging (NODE_ENV=production) instead of 401ing on
 * the dev X-Tenant-Id shim. Supports clock in/out and real rear-camera capture. T2 adds real
 * camera QR/barcode scan-to-locate: scan a code → resolve it (tenant-scoped, RLS) → set the subject
 * so a report/evidence attaches to the right object. The report AUTHOR is the session's staff (the
 * server ignores any client-supplied handle in prod).
 */
export function StaffConsole() {
  const t = useTranslations();
  const locale = useLocale();

  // ── session ──
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [name, setName] = useState('A · Front Desk');
  const [password, setPassword] = useState('');
  const [tenantId, setTenantId] = useState(DEV_TENANTS[0]!.id);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const storageAvailable = useMemo(() => safeStorage.isAvailable(), []);

  const api: Api | null = useMemo(() => (session ? makeApi({ token: session.token }) : null), [session]);

  useEffect(() => {
    const token = loadStaffToken();
    if (!token) {
      setReady(true);
      return;
    }
    let cancelled = false;
    void fetchMe(token).then((identity) => {
      if (cancelled) return;
      if (identity && identity.subject !== 'manager') setSession({ token, identity });
      else clearStaffToken();
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function signIn(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setAuthBusy(true);
    setAuthError(null);
    try {
      const handle = name.trim().toLowerCase().replace(/\s+/g, '_') || 'staff';
      const display = name.trim() || undefined;
      const s = IS_STAGING ? await staffStagingLogin(password, handle, display) : await staffDevLogin(tenantId, handle, display);
      saveStaffToken(s.token);
      setSession(s);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : String(err));
    } finally {
      setAuthBusy(false);
    }
  }
  function signOut(): void {
    clearStaffToken();
    setSession(null);
  }

  // ── terminal state (after login) ──
  const [objects, setObjects] = useState<ObjRow[]>([]);
  const [subjectId, setSubjectId] = useState('');
  const [log, setLog] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [reportType, setReportType] = useState<StaffReportType>('task_update');
  const [text, setText] = useState('3号房已为下一位患者备好');
  const [scanSubject, setScanSubject] = useState(true);
  const [kind, setKind] = useState('photo');
  const [linkUpload, setLinkUpload] = useState(true);
  const [clock, setClock] = useState<ClockState>(null);
  const [fileName, setFileName] = useState<string>('');
  const [showScanner, setShowScanner] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const pushLog = useCallback((ok: boolean, msg: string) => {
    setLog((prev) => [{ at: new Date().toISOString(), ok, text: msg }, ...prev].slice(0, 12));
  }, []);

  const loadObjects = useCallback(async () => {
    if (!api) return;
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
    if (api) void loadObjects();
  }, [api, loadObjects]);

  const subject = objects.find((o) => o.id === subjectId);

  // T2 · resolve a scanned code to an object in THIS tenant and make it the subject. The backend
  // does the RLS-scoped resolution (a code from another tenant resolves to nothing).
  const onScan = useCallback(
    async (code: string): Promise<void> => {
      setShowScanner(false);
      if (!api) return;
      setScanBusy(true);
      try {
        const { resolved } = await api.resolveScan(code);
        if (resolved) {
          const row: ObjRow = {
            id: resolved.objectId,
            type: resolved.type,
            properties: { label: resolved.label },
            verifiedState: resolved.verifiedState,
            confidence: resolved.confidence,
          };
          setObjects((prev) => (prev.some((o) => o.id === row.id) ? prev : [row, ...prev]));
          setSubjectId(resolved.objectId);
          setScanSubject(true);
          pushLog(true, `${t('scan.located')}: ${resolved.type} · ${resolved.label}`);
        } else {
          pushLog(false, `${t('scan.notFound')} (${code.slice(0, 24)})`);
        }
      } catch (e) {
        pushLog(false, `${t('scan.title')}: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setScanBusy(false);
      }
    },
    [api, pushLog, t],
  );

  // T5 · pick a task from "My tasks" as the current subject, so report/photo/scan/recording target it.
  const pickTask = useCallback(
    (task: MyTaskSummary) => {
      const row: ObjRow = {
        id: task.taskId,
        type: 'Task',
        properties: { label: task.label, taskType: task.taskType ?? undefined },
        verifiedState: task.verifiedState,
        confidence: task.confidence,
      };
      setObjects((prev) => (prev.some((o) => o.id === row.id) ? prev : [row, ...prev]));
      setSubjectId(task.taskId);
      pushLog(true, `${t('mytasks.picked')}: ${task.label}`);
    },
    [pushLog, t],
  );

  async function clockPunch(type: 'clock_in' | 'clock_out'): Promise<void> {
    if (!api) return;
    setBusy(true);
    try {
      await api.postReport({
        clientMessageId: newId(),
        reportType: type,
        text: type === 'clock_in' ? '上班打卡' : '下班打卡',
        at: new Date().toISOString(),
      });
      const at = new Date().toISOString();
      setClock({ type, at });
      pushLog(true, `${t(`comms.reportTypes.${type}`)} · ${hhmm(at)}`);
    } catch (e) {
      pushLog(false, `${t(`comms.reportTypes.${type}`)}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function submitReport(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!api) return;
    setBusy(true);
    try {
      const res = await api.postReport({
        clientMessageId: newId(),
        reportType,
        text: text || undefined,
        at: new Date().toISOString(),
        scans:
          scanSubject && subject
            ? [{ scannedObjectType: subject.type, scannedObjectId: subject.id, at: new Date().toISOString() }]
            : undefined,
      });
      pushLog(true, `${t('console.report')} → ${res.deduped ? t('console.deduped') : t('console.created')} (${res.communicationId.slice(0, 8)})`);
      await loadObjects();
    } catch (e) {
      pushLog(false, `${t('console.report')}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function submitUpload(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!api) return;
    const file = fileRef.current?.files?.[0];
    if (!file) {
      pushLog(false, t('console.noFile'));
      return;
    }
    setBusy(true);
    try {
      const res = await api.upload(file, { kind, linkTo: linkUpload && subject ? subject.id : undefined });
      pushLog(true, `${t('console.upload')} → ${res.objectType}/${res.kind} ${res.deduped ? `(${t('console.deduped')})` : ''} ${res.objectId.slice(0, 8)}`);
      if (fileRef.current) fileRef.current.value = '';
      setFileName('');
      await loadObjects();
    } catch (e) {
      pushLog(false, `${t('console.upload')}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  // T3 · upload a recorded audio blob as voice evidence — reuses the T4 pipeline (STT → claim →
  // LLM1). Linked to the current subject when set, so it also attaches as evidence to that object.
  async function submitRecording(file: File): Promise<void> {
    if (!api) return;
    setBusy(true);
    try {
      const res = await api.upload(file, { kind: 'voice', linkTo: subject ? subject.id : undefined });
      pushLog(true, `${t('rec.title')} → ${res.deduped ? t('console.deduped') : t('console.created')} ${res.objectId.slice(0, 8)} · ${t('rec.transcribing')}`);
      await loadObjects();
    } catch (e) {
      pushLog(false, `${t('rec.title')}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function forceVerify(): Promise<void> {
    if (!api || !subject) return;
    setBusy(true);
    try {
      const res = await api.verify(subject.id);
      pushLog(true, `${t('console.verify')} → ${res.verifiedState} ${pct(res.confidence)}`);
      await loadObjects();
    } catch (e) {
      pushLog(false, `${t('console.verify')}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function runSweep(): Promise<void> {
    if (!api) return;
    setBusy(true);
    try {
      const res = await api.sweep();
      pushLog(true, `${t('console.sweep')} → ${t('console.sweepDone', { n: res.created })}`);
    } catch (e) {
      pushLog(false, `${t('console.sweep')}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  // ── login screen ──
  if (!session) {
    return (
      <main className="min-h-screen bg-slate-950 text-slate-100">
        <div className="mx-auto flex max-w-md items-center justify-between px-4 pt-3">
          <span className="text-sm font-semibold">{t('console.title')}</span>
          <LocaleSwitcher />
        </div>
        <div className="mx-auto flex min-h-[70vh] max-w-md items-center px-4">
          <form onSubmit={signIn} className={`w-full ${CARD}`}>
            <h1 className="text-lg font-bold">{t('console.auth.title')}</h1>
            <p className="mt-1 text-xs text-slate-500">{IS_STAGING ? t('console.auth.stagingHint') : t('console.auth.devHint')}</p>

            <label className="mt-5 block text-xs font-medium text-slate-400">{t('console.auth.name')}</label>
            <input className={`mt-1 ${INPUT}`} value={name} onChange={(e) => setName(e.target.value)} placeholder="front_desk" />

            {IS_STAGING ? (
              <>
                <label className="mt-4 block text-xs font-medium text-slate-400">{t('console.auth.password')}</label>
                <input
                  type="password"
                  autoComplete="current-password"
                  className={`mt-1 ${INPUT}`}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                />
              </>
            ) : (
              <>
                <label className="mt-4 block text-xs font-medium text-slate-400">{t('console.auth.tenant')}</label>
                <select className={`mt-1 ${INPUT}`} value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
                  {DEV_TENANTS.map((tn) => (
                    <option key={tn.id} value={tn.id}>
                      {tn.label}
                    </option>
                  ))}
                </select>
              </>
            )}

            {authError ? <p className="mt-3 rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{authError}</p> : null}
            {!ready ? <p className="mt-3 text-xs text-slate-500">{t('shell.loading')}</p> : null}

            <button type="submit" disabled={authBusy} className={`mt-5 ${BTN_PRIMARY}`}>
              {authBusy ? t('console.auth.signingIn') : t('console.auth.signIn')}
            </button>
            {!storageAvailable ? <p className="mt-3 text-[11px] text-amber-400/80">{t('login.storageWarning')}</p> : null}
          </form>
        </div>
      </main>
    );
  }

  const clockLabel =
    clock?.type === 'clock_in'
      ? t('console.clock.inAt', { at: hhmm(clock.at) })
      : clock?.type === 'clock_out'
        ? t('console.clock.outAt', { at: hhmm(clock.at) })
        : t('console.clock.none');

  // ── terminal (logged in) ──
  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      {/* sticky mobile top bar */}
      <header className="sticky top-0 z-10 border-b border-slate-800 bg-slate-950/90 px-4 py-2.5 backdrop-blur">
        <div className="mx-auto flex max-w-md items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-bold">{t('console.title')}</p>
            <p className="truncate text-[11px] text-slate-500">{t('console.who', { name: session.identity.displayName ?? 'staff' })}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <LocaleSwitcher />
            <button type="button" onClick={signOut} className="rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] text-slate-300 active:bg-slate-800">
              {t('console.logout')}
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-md space-y-4 px-4 py-4">
        {/* clock in/out */}
        <section className={CARD}>
          <h2 className="text-sm font-semibold">{t('console.clock.title')}</h2>
          <p className="mt-1 text-xs text-slate-400">{clockLabel}</p>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <button type="button" disabled={busy} onClick={() => void clockPunch('clock_in')} className={BTN_PRIMARY}>
              {t('console.clock.in')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void clockPunch('clock_out')}
              className="min-h-12 rounded-xl border border-slate-600 px-4 py-3 text-base font-semibold text-slate-200 transition-colors active:bg-slate-800 disabled:opacity-50"
            >
              {t('console.clock.out')}
            </button>
          </div>
        </section>

        {/* subject */}
        <section className={CARD}>
          <label className="text-xs uppercase tracking-wide text-slate-500">{t('console.subject')}</label>
          <select className={`mt-1 ${INPUT}`} value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
            {objects.length === 0 ? <option value="">{t('console.noObjects')}</option> : null}
            {objects.map((o) => (
              <option key={o.id} value={o.id}>
                {o.type} · {labelOf(o)} {o.verifiedState ? `· ${o.verifiedState} ${pct(o.confidence ?? undefined)}` : ''}
              </option>
            ))}
          </select>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setShowScanner((s) => !s)}
              disabled={busy || scanBusy}
              className="min-h-11 flex-1 rounded-xl border border-sky-500/50 bg-sky-500/10 px-3 py-2 text-sm font-medium text-sky-200 active:bg-sky-500/20 disabled:opacity-50"
            >
              📷 {t('scan.locate')}
            </button>
            <button type="button" onClick={() => void forceVerify()} disabled={busy || !subject} className="min-h-11 rounded-xl bg-sky-500 px-3 py-2 text-sm font-medium text-white active:bg-sky-600 disabled:opacity-50">
              {t('console.reverify')}
            </button>
            <button type="button" onClick={() => void loadObjects()} disabled={busy} className="min-h-11 rounded-xl border border-slate-700 px-3 py-2 text-sm text-slate-300 active:bg-slate-800 disabled:opacity-50">
              {t('console.refresh')}
            </button>
            <button type="button" onClick={() => void runSweep()} disabled={busy} className="min-h-11 rounded-xl bg-emerald-600/80 px-3 py-2 text-sm font-medium text-white active:bg-emerald-700 disabled:opacity-50">
              {t('console.sweep')}
            </button>
          </div>
          {showScanner ? (
            <div className="mt-3">
              <CameraScanner onResult={(c) => void onScan(c)} onClose={() => setShowScanner(false)} />
            </div>
          ) : null}
        </section>

        {/* T5 · my tasks — the staff's assigned queue; pick one to make it the current subject */}
        {api ? <MyTasks api={api} onPick={pickTask} /> : null}

        {/* report */}
        <form className={CARD} onSubmit={(e) => void submitReport(e)}>
          <h2 className="text-sm font-semibold">{t('console.reportCard')}</h2>
          <p className="mt-1 text-xs text-slate-500">{t('console.reportHint')}</p>
          <div className="mt-3 space-y-3">
            <select className={INPUT} value={reportType} onChange={(e) => setReportType(e.target.value as StaffReportType)}>
              {REPORT_TYPES.map((rt) => (
                <option key={rt} value={rt}>
                  {t(`comms.reportTypes.${rt}`)}
                </option>
              ))}
            </select>
            <input className={INPUT} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('console.message')} />
            <label className="flex items-center gap-2 py-1 text-sm text-slate-300">
              <input type="checkbox" className="h-5 w-5" checked={scanSubject} onChange={(e) => setScanSubject(e.target.checked)} />
              {t('console.scanSubject')}
            </label>
            <button type="submit" disabled={busy} className={BTN_PRIMARY}>
              {t('console.sendReport')}
            </button>
          </div>
        </form>

        {/* photo / evidence — real rear camera on phones */}
        <form className={CARD} onSubmit={(e) => void submitUpload(e)}>
          <h2 className="text-sm font-semibold">{t('console.uploadCard')}</h2>
          <p className="mt-1 text-xs text-slate-500">{t('console.camera.hint')}</p>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => setFileName(e.target.files?.[0]?.name ?? '')}
          />
          <div className="mt-3 space-y-3">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-sky-500/50 bg-sky-500/10 px-4 py-3 text-base font-medium text-sky-200 active:bg-sky-500/20"
            >
              📷 {t('console.camera.take')}
            </button>
            {fileName ? <p className="truncate text-xs text-slate-400">{t('console.camera.chosen', { name: fileName })}</p> : null}
            <select className={INPUT} value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="photo">{t('console.kinds.photo')}</option>
              <option value="screenshot">{t('console.kinds.screenshot')}</option>
              <option value="document">{t('console.kinds.document')}</option>
            </select>
            <label className="flex items-center gap-2 py-1 text-sm text-slate-300">
              <input type="checkbox" className="h-5 w-5" checked={linkUpload} onChange={(e) => setLinkUpload(e.target.checked)} />
              {t('console.linkUpload')}
            </label>
            <button type="submit" disabled={busy} className={BTN_PRIMARY}>
              {t('console.sendUpload')}
            </button>
          </div>
        </form>

        {/* live audio recording — real mic; transcribes via the existing STT pipeline (T4) */}
        <section className={CARD}>
          <h2 className="text-sm font-semibold">{t('rec.card')}</h2>
          <p className="mt-1 text-xs text-slate-500">{t('rec.cardHint')}</p>
          <div className="mt-3">
            <AudioRecorder onComplete={(f) => void submitRecording(f)} disabled={busy} />
          </div>
        </section>

        {/* activity */}
        <section className={CARD}>
          <h2 className="text-sm font-semibold">{t('console.activity')}</h2>
          <div className="mt-2 space-y-1.5">
            {log.length === 0 ? (
              <p className="text-xs text-slate-500">{t('console.activityEmpty')}</p>
            ) : (
              log.map((l, i) => (
                <div key={i} className="flex items-start gap-2 text-xs">
                  <span className="font-mono text-slate-600">{hhmm(l.at)}</span>
                  <span className={l.ok ? 'text-emerald-400' : 'text-rose-400'}>{l.ok ? '✓' : '✕'}</span>
                  <span className="break-all text-slate-300">{l.text}</span>
                </div>
              ))
            )}
          </div>
        </section>

        <a href={`/${locale}`} className="block py-2 text-center text-xs text-slate-500 active:text-slate-300">
          {t('console.back')}
        </a>
      </div>
    </main>
  );
}
