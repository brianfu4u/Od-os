/**
 * DeepSeek adapter — the first real LlmListenerPort. DeepSeek is OpenAI-compatible, so we POST to
 * {baseUrl}/chat/completions with model `deepseek-chat` and response_format json_object. The API key
 * comes from the DEEPSEEK_API_KEY env var and is NEVER logged or committed.
 *
 * Two safety properties:
 *  1) MOAT enforcement is structural: `normalize()` maps the model's answer onto our fixed schema
 *     and CANNOT emit a verified_state — there is no field for it. A hallucinated/hostile answer
 *     therefore still can't cross the moat.
 *  2) Resilience: any transport/parse error falls back to the deterministic HeuristicListener, so a
 *     DeepSeek outage degrades gracefully to keyword analysis instead of dropping the event.
 */
import { Logger } from '@nestjs/common';
import type {
  ListenAnalysis,
  ListenCue,
  ListenDomain,
  ListenEventType,
  ListenInput,
  ListenLocale,
  ListenSeverity,
  ListenSummary,
  LlmListenerPort,
  SummaryInput,
} from './listener.types';
import { buildAnalyzeMessages, buildSummarizeMessages } from './prompts';
import { canonicalTaskType, detectLocale } from './listen-lex';
import { metrics } from '../ops/metrics.registry';

const DOMAINS: ListenDomain[] = ['patient_flow', 'staff', 'inventory', 'equipment', 'financial', 'marketing', 'general'];
const EVENT_TYPES: ListenEventType[] = ['clock_in', 'clock_out', 'task_update', 'report', 'evidence', 'scan', 'support_request', 'anomaly', 'other'];
const SEVERITIES: ListenSeverity[] = ['info', 'low', 'medium', 'high'];

export class DeepSeekListener implements LlmListenerPort {
  readonly name = 'deepseek';
  private readonly logger = new Logger(DeepSeekListener.name);

  constructor(
    private readonly apiKey: string,
    private readonly fallback: LlmListenerPort,
    private readonly baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    private readonly model = process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    private readonly timeoutMs = Number(process.env.DEEPSEEK_TIMEOUT_MS || 12000),
  ) {}

  async analyze(input: ListenInput): Promise<ListenAnalysis> {
    const locale: ListenLocale = input.locale ?? detectLocale(input.text ?? '');
    try {
      const { system, user } = buildAnalyzeMessages(input);
      const raw = await this.chat(system, user);
      return this.normalize(raw, input, locale);
    } catch (err) {
      this.logger.warn(`DeepSeek analyze failed, falling back to heuristic: ${err instanceof Error ? err.message : String(err)}`);
      return this.fallback.analyze(input);
    }
  }

  async summarize(input: SummaryInput): Promise<ListenSummary> {
    try {
      const { system, user } = buildSummarizeMessages(input);
      const raw = await this.chat(system, user);
      const text = typeof raw?.text === 'string' && raw.text.trim() ? raw.text.trim() : null;
      if (!text) throw new Error('no text field');
      const base = await this.fallback.summarize(input); // reuse deterministic counts
      return { ...base, text };
    } catch (err) {
      this.logger.warn(`DeepSeek summarize failed, falling back to heuristic: ${err instanceof Error ? err.message : String(err)}`);
      return this.fallback.summarize(input);
    }
  }

  private async chat(system: string, user: string): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    // Observability only (read-only counters): every DeepSeek API attempt + any failure. The API key
    // is never recorded. A failure here is rethrown so analyze()/summarize() still fall back.
    metrics.recordLlmCall();
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.2,
          stream: false,
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content ?? '';
      return JSON.parse(content) as Record<string, unknown>;
    } catch (err) {
      metrics.recordLlmFailure();
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Coerce a free-form model answer into our fixed schema. This is where the moat is enforced
   * structurally: we read claim/classification/cues ONLY, and there is no path to a verified_state.
   */
  private normalize(raw: Record<string, unknown>, input: ListenInput, locale: ListenLocale): ListenAnalysis {
    const cls = (raw.classification ?? {}) as Record<string, unknown>;
    const domain = pick(cls.domain, DOMAINS, 'general');
    const eventType = pick(cls.eventType, EVENT_TYPES, 'report');
    const severity = pick(cls.severity, SEVERITIES, 'low');
    const taskType = canonicalTaskType(typeof cls.taskType === 'string' ? cls.taskType : null, input.text ?? '');

    let claim: ListenAnalysis['claim'] = null;
    const rawClaim = raw.claim as Record<string, unknown> | null | undefined;
    if (rawClaim && typeof rawClaim.claimedState === 'string' && rawClaim.claimedState.trim()) {
      const loc = (rawClaim.locator ?? {}) as Record<string, unknown>;
      claim = {
        taskType: canonicalTaskType(typeof rawClaim.taskType === 'string' ? rawClaim.taskType : null, input.text ?? ''),
        claimedState: rawClaim.claimedState.trim(),
        locator: {
          room: typeof loc.room === 'string' ? loc.room : undefined,
          label: typeof loc.label === 'string' ? loc.label : undefined,
        },
      };
    }

    const candidateCues: ListenCue[] = Array.isArray(raw.candidateCues)
      ? (raw.candidateCues as Array<Record<string, unknown>>).slice(0, 3).map((c) => ({
          domain: pick(c.domain, DOMAINS, domain),
          title: typeof c.title === 'string' ? c.title : 'cue',
          detail: typeof c.detail === 'string' ? c.detail : undefined,
          severity: pick(c.severity, SEVERITIES, 'low'),
        }))
      : [];

    const confidence = clamp01(typeof raw.confidence === 'number' ? raw.confidence : 0.5);
    const summary = typeof raw.summary === 'string' && raw.summary.trim() ? raw.summary.trim() : (input.text ?? '').slice(0, 80);

    return { summary, claim, classification: { domain, taskType, eventType, severity }, candidateCues, confidence, locale };
  }
}

function pick<T extends string>(v: unknown, allowed: T[], fallback: T): T {
  return typeof v === 'string' && (allowed as string[]).includes(v) ? (v as T) : fallback;
}
function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5;
}
