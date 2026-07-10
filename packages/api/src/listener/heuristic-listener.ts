/**
 * Deterministic, zero-dependency LlmListenerPort. It is the KEYLESS fallback (no DEEPSEEK_API_KEY)
 * and the adapter used in every test — so the whole loop is exercisable offline and CI is
 * reproducible. It also backstops the DeepSeek adapter when a live call fails or returns junk.
 *
 * It never performs I/O and never decides "verified" — it only extracts a claim + classifies, the
 * same contract the DeepSeek adapter is normalized to.
 */
import type {
  ListenAnalysis,
  ListenCue,
  ListenInput,
  ListenLocale,
  ListenSummary,
  LlmListenerPort,
  SummaryInput,
} from './listener.types';
import {
  TASK_DONE_STATE,
  canonicalTaskType,
  detectDomain,
  detectDoneOrStarted,
  detectEventType,
  detectLocale,
  parseRoomLabel,
  severityFor,
} from './listen-lex';

export class HeuristicListener implements LlmListenerPort {
  readonly name = 'heuristic';

  async analyze(input: ListenInput): Promise<ListenAnalysis> {
    const text = (input.text ?? '').trim();
    const locale: ListenLocale = input.locale ?? detectLocale(text);

    const room = parseRoomLabel(text);
    const doneOrStarted = detectDoneOrStarted(text);
    // A room reported "ready"/"done" implies a room turnover even without an explicit turnover word
    // (e.g. "Room 3 is ready" / "3号房好了" / "3番 準備できました").
    let taskType = canonicalTaskType(null, `${text} ${input.reportType ?? ''}`);
    if (!taskType && room && doneOrStarted) taskType = 'room_turnover';

    // Build a claim only when we can name a state the staff asserts.
    let claim: ListenAnalysis['claim'] = null;
    if (taskType && doneOrStarted) {
      const claimedState = doneOrStarted === 'started' ? 'started' : TASK_DONE_STATE[taskType] ?? 'done';
      claim = { taskType, claimedState, locator: room ? { room: room.room, label: room.label } : {} };
    }

    const eventType = detectEventType(text, input.reportType, {
      hasClaim: !!claim,
      hasAttachments: input.hasAttachments,
      hasScans: input.hasScans,
    });
    const domain = detectDomain(text, taskType);
    const severity = severityFor(eventType);

    const candidateCues: ListenCue[] = [];
    if (eventType === 'support_request') {
      candidateCues.push({ domain: domain === 'general' ? 'staff' : domain, title: t(locale, 'support'), detail: text.slice(0, 120), severity: 'medium' });
    } else if (eventType === 'anomaly') {
      candidateCues.push({ domain: domain === 'general' ? 'equipment' : domain, title: t(locale, 'anomaly'), detail: text.slice(0, 120), severity: 'high' });
    }

    // Confidence: a recognized claim or a clear non-claim category is high; a bare/ambiguous report
    // is low → the service treats low confidence as "pending" and does NOT touch state.
    const clearCategory = ['clock_in', 'clock_out', 'support_request', 'anomaly', 'scan'].includes(eventType);
    const confidence = claim ? 0.82 : clearCategory ? 0.8 : eventType === 'evidence' ? 0.65 : 0.45;

    return {
      summary: summarize(locale, { eventType, domain, taskType, claim, text }),
      claim,
      classification: { domain, taskType, eventType, severity },
      candidateCues,
      confidence,
      locale,
    };
  }

  async summarize(input: SummaryInput): Promise<ListenSummary> {
    const byEventType: Record<string, number> = {};
    const byDomain: Record<string, number> = {};
    for (const e of input.events) {
      byEventType[e.eventType] = (byEventType[e.eventType] ?? 0) + 1;
      if (e.domain) byDomain[e.domain] = (byDomain[e.domain] ?? 0) + 1;
    }
    const count = input.events.length;
    const text = renderSummary(input.locale, input.scope, input.periodHours, count, byEventType, byDomain);
    return { scope: input.scope, text, locale: input.locale, periodHours: input.periodHours, count, byEventType, byDomain };
  }
}

// ── tiny trilingual label helpers (deterministic; no i18n framework needed server-side) ──
function t(locale: ListenLocale, key: 'support' | 'anomaly'): string {
  const table = {
    support: { zh: '有人申请支援', en: 'Support requested', ja: '応援要請あり' },
    anomaly: { zh: '疑似异常/故障', en: 'Possible anomaly/fault', ja: '異常/不具合の可能性' },
  } as const;
  return table[key][locale];
}

function summarize(
  locale: ListenLocale,
  ctx: { eventType: string; domain: string; taskType: string | null; claim: ListenAnalysis['claim']; text: string },
): string {
  if (ctx.claim) {
    const where = ctx.claim.locator.label ?? ctx.claim.locator.room ?? '';
    if (locale === 'zh') return `声称:${where || ''}${ctx.claim.taskType ?? ''} → ${ctx.claim.claimedState}(待交叉验证)`.trim();
    if (locale === 'ja') return `申告:${where || ''}${ctx.claim.taskType ?? ''} → ${ctx.claim.claimedState}(検証待ち)`.trim();
    return `Claim: ${where ? where + ' ' : ''}${ctx.claim.taskType ?? ''} → ${ctx.claim.claimedState} (pending verification)`.trim();
  }
  const first = ctx.text.slice(0, 80);
  if (locale === 'zh') return `${ctx.domain}·${ctx.eventType}:${first}`;
  if (locale === 'ja') return `${ctx.domain}·${ctx.eventType}:${first}`;
  return `${ctx.domain} · ${ctx.eventType}: ${first}`;
}

function renderSummary(
  locale: ListenLocale,
  scope: string,
  hours: number,
  count: number,
  byEventType: Record<string, number>,
  byDomain: Record<string, number>,
): string {
  const parts = Object.entries(byEventType)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}×${v}`)
    .join(', ');
  const doms = Object.entries(byDomain)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}×${v}`)
    .join(', ');
  if (locale === 'zh') return `范围「${scope}」近${hours}小时共${count}条事件。类型:${parts || '无'}。域:${doms || '无'}。`;
  if (locale === 'ja') return `範囲「${scope}」直近${hours}時間で${count}件のイベント。種類:${parts || 'なし'}。ドメイン:${doms || 'なし'}。`;
  return `Scope "${scope}", last ${hours}h: ${count} events. Types: ${parts || 'none'}. Domains: ${doms || 'none'}.`;
}
