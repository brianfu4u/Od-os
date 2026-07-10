/**
 * Shared, PURE lexicon + resolvers for LLM1. Used by the deterministic HeuristicListener AND by the
 * DeepSeek adapter's output normalizer (so even a free-form LLM answer is coerced into the same
 * canonical S0-7 vocabulary). No I/O, no state — trivially testable, trilingual (zh/en/ja).
 */
import type { ListenDomain, ListenEventType, ListenLocale, ListenSeverity } from './listener.types';

/** The 5 MVP S0-7 task types LLM1 will map free text onto. */
export const KNOWN_TASK_TYPES = [
  'room_turnover',
  'pretest_done',
  'dilation_started',
  'inventory_reorder',
  'equipment_calibration',
] as const;

/** Expected/claimed state each task type resolves to when a "done"-style claim is detected. */
export const TASK_DONE_STATE: Record<string, string> = {
  room_turnover: 'ready',
  pretest_done: 'done',
  dilation_started: 'started',
  inventory_reorder: 'ordered',
  equipment_calibration: 'calibrated',
};

const TASK_PATTERNS: Array<{ type: string; re: RegExp }> = [
  { type: 'room_turnover', re: /(turnover|turn over|清房|整备|整備|周转|房间清理|号房|号诊室|番診|room\s*ready)/i },
  { type: 'pretest_done', re: /(pretest|pre-test|预检|預檢|検査前|术前检查)/i },
  { type: 'dilation_started', re: /(dilation|dilate|散瞳|散瞳開始|扩瞳)/i },
  { type: 'inventory_reorder', re: /(reorder|re-order|restock|补货|補貨|下单|下單|库存|庫存|在庫|発注|order\s+supplies)/i },
  { type: 'equipment_calibration', re: /(calibrat|校准|校正|較正|标定|キャリブ)/i },
];

const DONE_RE = /(备好|準備好|准备好|好了|完成|做好|清好|搞定|ready|done|finished|complete|完了|終わ|できました|整いました)/i;
const STARTED_RE = /(开始|開始|started|begin|start|着手)/i;

const DOMAIN_PATTERNS: Array<{ domain: ListenDomain; re: RegExp }> = [
  { domain: 'patient_flow', re: /(患者|病人|房|诊室|診察|room|patient|turnover|pretest|dilation|散瞳|预检)/i },
  { domain: 'inventory', re: /(库存|庫存|在庫|补货|補貨|耗材|stock|inventory|supply|supplies|reorder|发注|発注)/i },
  { domain: 'equipment', re: /(设备|設備|仪器|儀器|机器|機器|器械|equipment|machine|device|calibrat|校准|校正)/i },
  { domain: 'financial', re: /(账单|賬單|发票|發票|收款|付款|invoice|payment|billing|financial|請求|支払)/i },
  { domain: 'marketing', re: /(评价|評價|口碑|口コミ|营销|營銷|review|marketing|campaign|reputation)/i },
  { domain: 'staff', re: /(打卡|上班|下班|出勤|退勤|排班|轮班|シフト|shift|clock|staff|人手)/i },
];

const CLOCK_IN_RE = /(上班|出勤|打卡上班|clock\s*in|check\s*in|出社)/i;
const CLOCK_OUT_RE = /(下班|退勤|打卡下班|clock\s*out|check\s*out|退社)/i;
const SUPPORT_RE = /(支援|求助|帮忙|幫忙|需要人手|help|assist|support|応援|手伝)/i;
const ANOMALY_RE = /(故障|坏了|壞了|异常|異常|事故|漏|溢|摔|broken|error|down|fault|malfunction|leak|spill|トラブル|不具合)/i;

export function detectLocale(text: string): ListenLocale {
  if (/[぀-ヿ]/.test(text)) return 'ja'; // hiragana/katakana
  if (/[一-鿿]/.test(text)) return 'zh'; // Han
  return 'en';
}

/** Map any free-form/LLM-provided task hint to a canonical S0-7 type, else null. */
export function canonicalTaskType(hint: string | null | undefined, text = ''): string | null {
  if (hint && (KNOWN_TASK_TYPES as readonly string[]).includes(hint)) return hint;
  const hay = `${hint ?? ''} ${text}`;
  for (const { type, re } of TASK_PATTERNS) if (re.test(hay)) return type;
  return null;
}

/** Parse a room label like "3号房" / "room 3" / "3番診察室" → { room:'3', label:'Room 3' }. */
export function parseRoomLabel(text: string): { room: string; label: string } | null {
  const m =
    text.match(/(\d+)\s*号\s*(?:房|房间|诊室|診察室)?/) ||
    text.match(/room\s*#?\s*(\d+)/i) ||
    text.match(/(\d+)\s*番\s*(?:室|診察室)?/);
  if (!m) return null;
  return { room: m[1]!, label: `Room ${m[1]}` };
}

export function detectDoneOrStarted(text: string): 'done' | 'started' | null {
  if (STARTED_RE.test(text) && !DONE_RE.test(text)) return 'started';
  if (DONE_RE.test(text)) return 'done';
  return null;
}

export function detectDomain(text: string, taskType: string | null): ListenDomain {
  if (taskType) {
    if (['room_turnover', 'pretest_done', 'dilation_started'].includes(taskType)) return 'patient_flow';
    if (taskType === 'inventory_reorder') return 'inventory';
    if (taskType === 'equipment_calibration') return 'equipment';
  }
  for (const { domain, re } of DOMAIN_PATTERNS) if (re.test(text)) return domain;
  return 'general';
}

export function detectEventType(
  text: string,
  reportType: string | null | undefined,
  opts: { hasClaim: boolean; hasAttachments?: boolean; hasScans?: boolean },
): ListenEventType {
  const rt = (reportType ?? '').toLowerCase();
  if (rt === 'clock_in' || CLOCK_IN_RE.test(text)) return 'clock_in';
  if (rt === 'clock_out' || CLOCK_OUT_RE.test(text)) return 'clock_out';
  if (SUPPORT_RE.test(text)) return 'support_request';
  if (ANOMALY_RE.test(text)) return 'anomaly';
  if (opts.hasScans) return 'scan';
  if (opts.hasClaim) return 'task_update';
  if (opts.hasAttachments) return 'evidence';
  if (text.trim().length > 0) return 'report';
  return 'other';
}

export function severityFor(eventType: ListenEventType): ListenSeverity {
  if (eventType === 'anomaly') return 'high';
  if (eventType === 'support_request') return 'medium';
  if (eventType === 'task_update' || eventType === 'scan' || eventType === 'evidence') return 'low';
  return 'info';
}

/** Map the broad ListenDomain to one of the 6 orchestrator DomainName values (general → staff). */
export function toDomainName(d: ListenDomain): 'patient_flow' | 'staff' | 'inventory' | 'equipment' | 'financial' | 'marketing' {
  return d === 'general' ? 'staff' : d;
}
