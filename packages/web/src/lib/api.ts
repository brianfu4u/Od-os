/**
 * Typed browser client for the Clearview OD API.
 *
 * Auth (P3): the command center signs in via a P1 manager session and sends the token as
 * `Authorization: Bearer` (and `?session=` for SSE, which can't set headers) — the SESSION drives
 * the tenant, so nothing here self-reports a tenant. A dev fallback (`{ tenantId }`, or a bare
 * tenantId string) still sends the non-production `X-Tenant-Id` shim so the staff-console harness
 * keeps working locally; production ignores it.
 */
import type {
  ActionLogRecord,
  AssignmentOverview,
  AssignmentResult,
  CreateTaskInput,
  TaskDecisionInput,
  TaskDecisionResult,
  MyTaskSummary,
  ObjectTimeline,
  OntologyObject,
  OpsSummary,
  OverviewResult,
  RecommendationRecord,
  RecommendationStatus,
  OperatingTempo,
  ScanResolveResult,
  StaffReportInput,
  StaffReportResult,
  UploadResult,
  VerificationResult,
  VoiceFeedRecord,
} from '@clearview/shared';
import { API_BASE, DEV_TENANT_ID } from './config';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiAuth {
  token?: string;
  tenantId?: string;
}

/** Result of POST /transcription/:id/retry (P7/T4). */
export interface TranscriptionRetryResult {
  objectId: string;
  status: string;
}

function normalize(auth?: string | ApiAuth): ApiAuth {
  if (auth === undefined) return { tenantId: DEV_TENANT_ID };
  if (typeof auth === 'string') return { tenantId: auth };
  return auth;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { message?: string | string[] };
      if (body?.message) detail = Array.isArray(body.message) ? body.message.join(', ') : body.message;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, detail);
  }
  return (await res.json()) as T;
}

export function makeApi(auth?: string | ApiAuth) {
  const a = normalize(auth);
  const authHeaders = (extra?: Record<string, string>): Record<string, string> => ({
    ...(a.token ? { Authorization: `Bearer ${a.token}` } : {}),
    ...(!a.token && a.tenantId ? { 'X-Tenant-Id': a.tenantId } : {}),
    ...(extra ?? {}),
  });

  return {
    auth: a,
    base: API_BASE,

    /** SSE endpoint — EventSource carries the session (or dev tenant) as a query param. */
    streamUrl(): string {
      const q = a.token
        ? `session=${encodeURIComponent(a.token)}`
        : `tenantId=${encodeURIComponent(a.tenantId ?? DEV_TENANT_ID)}`;
      return `${API_BASE}/objects/stream?${q}`;
    },

    async overview(signal?: AbortSignal): Promise<OverviewResult> {
      return json(await fetch(`${API_BASE}/overview`, { headers: authHeaders(), signal }));
    },

    async recommendations(status: RecommendationStatus = 'open', signal?: AbortSignal): Promise<RecommendationRecord[]> {
      return json(
        await fetch(`${API_BASE}/recommendations?status=${status}&limit=50`, { headers: authHeaders(), signal }),
      );
    },

    async tempo(signal?: AbortSignal): Promise<OperatingTempo> {
      return json(await fetch(`${API_BASE}/recommendations/tempo`, { headers: authHeaders(), signal }));
    },

    /** Approve → runs the P2/S4 write-back layer; returns the updated record incl. execution state. */
    async approve(id: string): Promise<RecommendationRecord> {
      return json(await fetch(`${API_BASE}/recommendations/${id}/approve`, { method: 'POST', headers: authHeaders() }));
    },

    /** Undo a previously executed write-back and reopen the cue. */
    async undo(id: string): Promise<RecommendationRecord> {
      return json(await fetch(`${API_BASE}/recommendations/${id}/undo`, { method: 'POST', headers: authHeaders() }));
    },

    async act(id: string, action: 'dismiss' | 'snooze'): Promise<RecommendationRecord> {
      return json(await fetch(`${API_BASE}/recommendations/${id}/${action}`, { method: 'POST', headers: authHeaders() }));
    },

    /** The append-only action_log for a cue (what its approval did). */
    async actionLog(id: string, signal?: AbortSignal): Promise<ActionLogRecord[]> {
      return json(await fetch(`${API_BASE}/recommendations/${id}/actions`, { headers: authHeaders(), signal }));
    },

    /** Run the six-domain recommendation sweep (advise-only) — lights up every domain's cues. */
    async sweep(): Promise<{ created: number; ids: string[] }> {
      return json(await fetch(`${API_BASE}/recommendations/sweep`, { method: 'POST', headers: authHeaders() }));
    },

    /** List objects of a type. Returns the ontology shape the API maps (camelCase state triplet). */
    async objects(type?: string, signal?: AbortSignal): Promise<OntologyObject[]> {
      const q = type ? `?type=${encodeURIComponent(type)}` : '';
      return json(await fetch(`${API_BASE}/objects${q}`, { headers: authHeaders(), signal }));
    },

    /**
     * T2 · resolve a scanned QR/barcode payload to one object in this tenant (read-only, RLS-scoped).
     * Returns { resolved: null } when nothing matches (including a code that belongs to another tenant).
     */
    async resolveScan(code: string, signal?: AbortSignal): Promise<{ resolved: ScanResolveResult | null }> {
      return json(
        await fetch(`${API_BASE}/objects/resolve?code=${encodeURIComponent(code)}`, { headers: authHeaders(), signal }),
      );
    },

    /**
     * T5 · read-only list of Tasks assigned to the current staff (session-scoped + RLS). The server
     * resolves the caller's staff from the session; nothing here self-reports a staff id.
     */
    async myTasks(signal?: AbortSignal): Promise<MyTaskSummary[]> {
      return json(await fetch(`${API_BASE}/tasks/mine`, { headers: authHeaders(), signal }));
    },

    /** P3 drill-down: an object's full story (object + events + verification ledger). */
    async timeline(objectId: string, signal?: AbortSignal): Promise<ObjectTimeline> {
      return json(await fetch(`${API_BASE}/objects/${objectId}/timeline`, { headers: authHeaders(), signal }));
    },

    /**
     * P7/T4: read-only, tenant-scoped voice-transcript feed (voice evidence + each transcript's
     * verdict, joined server-side). Lets the command center render the voice panel without pulling
     * every Document + Task.
     */
    async transcripts(limit?: number, signal?: AbortSignal): Promise<VoiceFeedRecord[]> {
      const q = limit ? `?limit=${encodeURIComponent(String(limit))}` : '';
      return json(await fetch(`${API_BASE}/transcription/feed${q}`, { headers: authHeaders(), signal }));
    },

    /**
     * Ops observability: manager-only, read-only summary (deploy version + DB health + process
     * metrics + recent errors + tenant-scoped activity counts). Server enforces manager via RolesGuard.
     */
    async opsSummary(signal?: AbortSignal): Promise<OpsSummary> {
      return json(await fetch(`${API_BASE}/ops/summary`, { headers: authHeaders(), signal }));
    },

    /**
     * Manager task assignment (manager-only): this tenant's tasks (+ current assignee) and the staff
     * they can be assigned to. Server enforces manager via RolesGuard + scopes by RLS.
     */
    async assignmentOverview(signal?: AbortSignal): Promise<AssignmentOverview> {
      return json(await fetch(`${API_BASE}/assignments/overview`, { headers: authHeaders(), signal }));
    },

    /** Assign/reassign a task to a staff member in this tenant (manager-only). */
    async assignTask(taskId: string, staffId: string): Promise<AssignmentResult> {
      return json(
        await fetch(`${API_BASE}/assignments/assign`, {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ taskId, staffId }),
        }),
      );
    },

    /** Create a task, optionally assigning it immediately (manager-only). Never writes verified_state. */
    async createTask(input: CreateTaskInput): Promise<AssignmentResult> {
      return json(
        await fetch(`${API_BASE}/assignments/tasks`, {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(input),
        }),
      );
    },

    /**
     * Manager single-authority THREE-STATE decision on a task flow (manager-only). approve closes the
     * flow (terminal); reject keeps it open with a structured reason the employee sees; shelve leaves
     * it silently in the queue. Server enforces manager via RolesGuard + scopes by RLS.
     */
    async decideTask(taskId: string, input: TaskDecisionInput): Promise<TaskDecisionResult> {
      return json(
        await fetch(`${API_BASE}/assignments/tasks/${taskId}/decide`, {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(input),
        }),
      );
    },

    // ---- staff-console (WeChat Mini Program stand-in; dev tenant shim) ----

    async postReport(input: StaffReportInput): Promise<StaffReportResult> {
      return json(
        await fetch(`${API_BASE}/reports`, {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(input),
        }),
      );
    },

    async upload(file: File, opts?: { linkTo?: string; kind?: string }): Promise<UploadResult> {
      const form = new FormData();
      form.append('file', file);
      if (opts?.linkTo) form.append('linkTo', opts.linkTo);
      if (opts?.kind) form.append('kind', opts.kind);
      return json(await fetch(`${API_BASE}/uploads`, { method: 'POST', headers: authHeaders(), body: form }));
    },

    async verify(objectId: string): Promise<VerificationResult> {
      return json(await fetch(`${API_BASE}/objects/${objectId}/verify`, { method: 'POST', headers: authHeaders() }));
    },

    /**
     * P7/T4: re-run STT for a voice evidence object (used by the failed/unavailable retry entry).
     * Tenant-authed via the same session/dev shim; the STT key stays on the backend only.
     */
    async retryTranscription(objectId: string): Promise<TranscriptionRetryResult> {
      return json(await fetch(`${API_BASE}/transcription/${objectId}/retry`, { method: 'POST', headers: authHeaders() }));
    },
  };
}

export type Api = ReturnType<typeof makeApi>;
