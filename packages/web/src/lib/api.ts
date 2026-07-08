/**
 * Typed browser client for the Clearview OD API.
 *
 * Auth is DEV-ONLY: the tenant travels as the `X-Tenant-Id` header (and as a `tenantId`
 * query param for SSE, which cannot set headers). Production replaces both with a
 * wx.login/openid-derived session (S0-3); nothing here should trust a client tenant then.
 */
import type {
  OverviewResult,
  RecommendationRecord,
  RecommendationStatus,
  OperatingTempo,
  StaffReportInput,
  StaffReportResult,
  UploadResult,
  VerificationResult,
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

function headers(tenantId: string, extra?: Record<string, string>): Record<string, string> {
  return { 'X-Tenant-Id': tenantId, ...(extra ?? {}) };
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) detail = Array.isArray(body.message) ? body.message.join(', ') : body.message;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, detail);
  }
  return (await res.json()) as T;
}

export function makeApi(tenantId: string = DEV_TENANT_ID) {
  return {
    tenantId,
    base: API_BASE,

    /** SSE endpoint — EventSource carries the tenant as a query param (no custom headers). */
    streamUrl(): string {
      return `${API_BASE}/objects/stream?tenantId=${encodeURIComponent(tenantId)}`;
    },

    async overview(signal?: AbortSignal): Promise<OverviewResult> {
      return json(await fetch(`${API_BASE}/overview`, { headers: headers(tenantId), signal }));
    },

    async recommendations(status: RecommendationStatus = 'open', signal?: AbortSignal): Promise<RecommendationRecord[]> {
      return json(
        await fetch(`${API_BASE}/recommendations?status=${status}`, { headers: headers(tenantId), signal }),
      );
    },

    async tempo(signal?: AbortSignal): Promise<OperatingTempo> {
      return json(await fetch(`${API_BASE}/recommendations/tempo`, { headers: headers(tenantId), signal }));
    },

    /** Human-in-the-loop: records intent + emits an event. No world write until S4. */
    async act(id: string, action: 'approve' | 'dismiss' | 'snooze'): Promise<RecommendationRecord> {
      return json(await fetch(`${API_BASE}/recommendations/${id}/${action}`, { method: 'POST', headers: headers(tenantId) }));
    },

    /** Run the six-domain recommendation sweep (advise-only) — lights up every domain's cues. */
    async sweep(): Promise<{ created: number; ids: string[] }> {
      return json(await fetch(`${API_BASE}/recommendations/sweep`, { method: 'POST', headers: headers(tenantId) }));
    },

    // ---- staff-console (WeChat Mini Program stand-in) ----

    async postReport(input: StaffReportInput): Promise<StaffReportResult> {
      return json(
        await fetch(`${API_BASE}/reports`, {
          method: 'POST',
          headers: headers(tenantId, { 'Content-Type': 'application/json' }),
          body: JSON.stringify(input),
        }),
      );
    },

    async upload(file: File, opts?: { linkTo?: string; kind?: string }): Promise<UploadResult> {
      const form = new FormData();
      form.append('file', file);
      if (opts?.linkTo) form.append('linkTo', opts.linkTo);
      if (opts?.kind) form.append('kind', opts.kind);
      return json(await fetch(`${API_BASE}/uploads`, { method: 'POST', headers: headers(tenantId), body: form }));
    },

    /** Force a re-verification of one object (drives the loop in the demo). */
    async verify(objectId: string): Promise<VerificationResult> {
      return json(await fetch(`${API_BASE}/objects/${objectId}/verify`, { method: 'POST', headers: headers(tenantId) }));
    },

    async objects(type?: string, signal?: AbortSignal): Promise<Array<Record<string, unknown>>> {
      const q = type ? `?type=${encodeURIComponent(type)}` : '';
      return json(await fetch(`${API_BASE}/objects${q}`, { headers: headers(tenantId), signal }));
    },
  };
}

export type Api = ReturnType<typeof makeApi>;
