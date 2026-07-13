/**
 * The synthetic demo-clinic PLAN — pure, deterministic data (NO PHI, NO secrets). The runner
 * (db/seed-demo.ts) executes it under withTenant/RLS: it writes ONLY claims + evidence + links +
 * append-only events, then calls the REAL S2 engine to derive each task's verdict. Nothing here (or
 * in the runner) writes verified_state — `targetVerdict` is only the EXPECTED S2 outcome, asserted by
 * the integration test, so a drift in the scorer is caught rather than masked.
 *
 * Verdict recipes (aligned to verification/sop-config.ts + the deterministic scorer):
 *   verified   — claim matches expected + the required evidence is attached (e.g. snapshot ⇒ 0.855 ≥ 0.85)
 *   conflict   — claim matches expected, required evidence MISSING + a timing anomaly (§4 Room-3)
 *   pending    — claim matches expected, required evidence MISSING, no anomaly (missing_required)
 *   unverified — no claim at all
 */

export type VerdictColor = 'verified' | 'conflict' | 'pending' | 'unverified';
export type EvidenceKind = 'snapshot' | 'document';

/** expectedState per task type — MUST match verification/sop-config.ts DEFAULT_SOP. */
export const SOP_EXPECTED: Record<string, string> = {
  room_turnover: 'ready',
  pretest_done: 'done',
  dilation_started: 'started',
  inventory_reorder: 'ordered',
  equipment_calibration: 'calibrated',
};
/** requiredEvidence per task type — MUST match verification/sop-config.ts DEFAULT_SOP. */
export const SOP_REQUIRED: Record<string, EvidenceKind[]> = {
  room_turnover: ['snapshot'],
  pretest_done: ['document'],
  inventory_reorder: ['document'],
  equipment_calibration: ['document'],
};

export interface DemoStaff {
  seedKey: string;
  staffHandle: string;
  displayName: string;
  role: string;
}
export interface DemoRoom {
  seedKey: string;
  code: string;
  label: string;
}
export interface DemoEquipment {
  seedKey: string;
  code: string;
  label: string;
  status: string;
}
export interface DemoEvidence {
  kind: EvidenceKind;
  seedKey: string;
  caption: string;
}
export interface DemoTiming {
  startedMinAgo: number;
  claimedMinAgo: number;
  expectedDurationMin: number;
}
export interface DemoTask {
  seedKey: string;
  taskType: string;
  label: string;
  expectedState: string;
  /** claimed_state; null ⇒ unverified (no claim yet). */
  claim: string | null;
  requiredEvidence: EvidenceKind[];
  attach: DemoEvidence[];
  assignToStaffKey?: string;
  roomKey?: string;
  timing?: DemoTiming;
  /** The verdict S2 is EXPECTED to derive (asserted by the integration test; never written here). */
  targetVerdict: VerdictColor;
}
export interface DemoComm {
  seedKey: string;
  author: string;
  text: string;
  refsTaskKey?: string;
  refsRoomKey?: string;
}
export interface DemoVoice {
  seedKey: string;
  transcript: string;
  language: string;
  refsTaskKey?: string;
}
export interface DemoPlan {
  staff: DemoStaff[];
  rooms: DemoRoom[];
  equipment: DemoEquipment[];
  tasks: DemoTask[];
  comms: DemoComm[];
  voice: DemoVoice[];
}

/** Does the attached evidence satisfy every required kind? (required missing ⇒ pending/conflict.) */
export function requiredSatisfied(task: DemoTask): boolean {
  const kinds = new Set(task.attach.map((a) => a.kind));
  return task.requiredEvidence.every((k) => kinds.has(k));
}

export function buildDemoPlan(): DemoPlan {
  const staff: DemoStaff[] = [
    { seedKey: 'demo:staff:reception', staffHandle: 'reception-01', displayName: '前台 · Riley', role: 'front_desk' },
    { seedKey: 'demo:staff:tech', staffHandle: 'tech-01', displayName: '技师 · Tao', role: 'tech' },
    { seedKey: 'demo:staff:nurse', staffHandle: 'nurse-01', displayName: '护理 · Nadia', role: 'nurse' },
  ];
  const rooms: DemoRoom[] = [
    { seedKey: 'demo:room:1', code: 'ROOM-1', label: 'Room 1' },
    { seedKey: 'demo:room:2', code: 'ROOM-2', label: 'Room 2' },
    { seedKey: 'demo:room:3', code: 'ROOM-3', label: 'Room 3' },
  ];
  const equipment: DemoEquipment[] = [
    { seedKey: 'demo:equip:oct1', code: 'EQ-OCT-1', label: 'OCT #1', status: 'ready' },
    { seedKey: 'demo:equip:ar1', code: 'EQ-AR-1', label: 'Auto-refractor', status: 'ready' },
  ];

  const tasks: DemoTask[] = [
    {
      seedKey: 'demo:task:verified-turnover',
      taskType: 'room_turnover',
      label: '整备 3 号房（下一位患者）',
      expectedState: SOP_EXPECTED.room_turnover!,
      claim: SOP_EXPECTED.room_turnover!,
      requiredEvidence: SOP_REQUIRED.room_turnover!,
      attach: [{ kind: 'snapshot', seedKey: 'demo:ev:snap-room3', caption: 'Room 3 整备完成' }],
      assignToStaffKey: 'demo:staff:tech',
      roomKey: 'demo:room:3',
      targetVerdict: 'verified',
    },
    {
      seedKey: 'demo:task:conflict-turnover',
      taskType: 'room_turnover',
      label: '整备 2 号房（快速周转）',
      expectedState: SOP_EXPECTED.room_turnover!,
      claim: SOP_EXPECTED.room_turnover!,
      requiredEvidence: SOP_REQUIRED.room_turnover!,
      attach: [], // required snapshot missing
      assignToStaffKey: 'demo:staff:nurse',
      roomKey: 'demo:room:2',
      timing: { startedMinAgo: 2, claimedMinAgo: 0, expectedDurationMin: 6 }, // 2min < 6min ⇒ anomaly
      targetVerdict: 'conflict',
    },
    {
      seedKey: 'demo:task:pending-pretest',
      taskType: 'pretest_done',
      label: '术前检查 · 1 号位',
      expectedState: SOP_EXPECTED.pretest_done!,
      claim: SOP_EXPECTED.pretest_done!,
      requiredEvidence: SOP_REQUIRED.pretest_done!,
      attach: [], // required document missing, no timing anomaly
      assignToStaffKey: 'demo:staff:tech',
      targetVerdict: 'pending',
    },
    {
      seedKey: 'demo:task:unverified-reorder',
      taskType: 'inventory_reorder',
      label: '补货 · 隐形眼镜护理液',
      expectedState: SOP_EXPECTED.inventory_reorder!,
      claim: null, // no claim yet ⇒ unverified
      requiredEvidence: SOP_REQUIRED.inventory_reorder!,
      attach: [],
      assignToStaffKey: 'demo:staff:reception',
      targetVerdict: 'unverified',
    },
    {
      seedKey: 'demo:task:verified-calibration',
      taskType: 'equipment_calibration',
      label: '校准 OCT #1',
      expectedState: SOP_EXPECTED.equipment_calibration!,
      claim: SOP_EXPECTED.equipment_calibration!,
      requiredEvidence: SOP_REQUIRED.equipment_calibration!,
      // The required document (strength 0.55) alone lands the claim at 0.50 + (1−0.50)·0.55 = 0.775 < 0.85 →
      // pending, NOT verified. A calibration is proven by BOTH the signed cert (document) AND a photo of the
      // calibrated instrument (snapshot): 0.775 + (1−0.775)·(0.71·0.85) = 0.911 ≥ 0.85 → verified. The snapshot
      // is corroborating (not a NEW required kind), so requiredSatisfied still only depends on the document.
      attach: [
        { kind: 'document', seedKey: 'demo:ev:doc-cal-oct1', caption: 'OCT #1 校准证书' },
        { kind: 'snapshot', seedKey: 'demo:ev:snap-cal-oct1', caption: 'OCT #1 校准后读数照片' },
      ],
      assignToStaffKey: 'demo:staff:tech',
      targetVerdict: 'verified',
    },
  ];

  const comms: DemoComm[] = [
    { seedKey: 'demo:comm:room3-ready', author: '前台 · Riley', text: '3 号房已为下一位患者备好', refsTaskKey: 'demo:task:verified-turnover', refsRoomKey: 'demo:room:3' },
    { seedKey: 'demo:comm:room2-fast', author: '护理 · Nadia', text: '2 号房我很快弄好了', refsTaskKey: 'demo:task:conflict-turnover', refsRoomKey: 'demo:room:2' },
  ];
  const voice: DemoVoice[] = [
    { seedKey: 'demo:voice:room3', transcript: '3 号房整理完毕，可以接诊下一位。', language: 'zh', refsTaskKey: 'demo:task:verified-turnover' },
  ];

  return { staff, rooms, equipment, tasks, comms, voice };
}

/** Pure self-consistency check: unique seed keys + recipe-vs-targetVerdict + valid references. */
export function checkPlan(plan: DemoPlan): string[] {
  const problems: string[] = [];
  const keys = new Set<string>();
  const addKey = (k: string, what: string): void => {
    if (keys.has(k)) problems.push(`duplicate seedKey: ${k} (${what})`);
    keys.add(k);
  };
  for (const s of plan.staff) addKey(s.seedKey, 'staff');
  for (const r of plan.rooms) addKey(r.seedKey, 'room');
  for (const e of plan.equipment) addKey(e.seedKey, 'equipment');
  for (const t of plan.tasks) {
    addKey(t.seedKey, 'task');
    for (const a of t.attach) addKey(a.seedKey, 'evidence');
  }
  for (const c of plan.comms) addKey(c.seedKey, 'comm');
  for (const v of plan.voice) addKey(v.seedKey, 'voice');

  const staffKeys = new Set(plan.staff.map((s) => s.seedKey));
  const roomKeys = new Set(plan.rooms.map((r) => r.seedKey));
  const taskKeys = new Set(plan.tasks.map((t) => t.seedKey));

  for (const t of plan.tasks) {
    if (SOP_EXPECTED[t.taskType] === undefined) problems.push(`task ${t.seedKey}: unknown taskType ${t.taskType}`);
    else if (t.expectedState !== SOP_EXPECTED[t.taskType]) problems.push(`task ${t.seedKey}: expectedState must equal SOP (${SOP_EXPECTED[t.taskType]})`);
    if (t.assignToStaffKey && !staffKeys.has(t.assignToStaffKey)) problems.push(`task ${t.seedKey}: unknown assignToStaffKey ${t.assignToStaffKey}`);
    if (t.roomKey && !roomKeys.has(t.roomKey)) problems.push(`task ${t.seedKey}: unknown roomKey ${t.roomKey}`);

    const satisfied = requiredSatisfied(t);
    switch (t.targetVerdict) {
      case 'unverified':
        if (t.claim !== null) problems.push(`task ${t.seedKey}: unverified recipe must have claim=null`);
        break;
      case 'verified':
        if (t.claim === null) problems.push(`task ${t.seedKey}: verified recipe needs a claim`);
        if (!satisfied) problems.push(`task ${t.seedKey}: verified recipe must attach the required evidence`);
        if (t.timing) problems.push(`task ${t.seedKey}: verified recipe must NOT have a timing anomaly`);
        break;
      case 'conflict':
        if (t.claim === null) problems.push(`task ${t.seedKey}: conflict recipe needs a claim`);
        if (satisfied) problems.push(`task ${t.seedKey}: conflict recipe must leave required evidence MISSING`);
        if (!t.timing) problems.push(`task ${t.seedKey}: conflict recipe needs a timing anomaly`);
        break;
      case 'pending':
        if (t.claim === null) problems.push(`task ${t.seedKey}: pending recipe needs a claim`);
        if (satisfied) problems.push(`task ${t.seedKey}: pending recipe must leave required evidence MISSING`);
        if (t.timing) problems.push(`task ${t.seedKey}: pending recipe must NOT have a timing anomaly`);
        break;
      default:
        problems.push(`task ${t.seedKey}: unknown targetVerdict`);
    }
  }
  for (const c of plan.comms) {
    if (c.refsTaskKey && !taskKeys.has(c.refsTaskKey)) problems.push(`comm ${c.seedKey}: unknown refsTaskKey ${c.refsTaskKey}`);
    if (c.refsRoomKey && !roomKeys.has(c.refsRoomKey)) problems.push(`comm ${c.seedKey}: unknown refsRoomKey ${c.refsRoomKey}`);
  }
  for (const v of plan.voice) {
    if (v.refsTaskKey && !taskKeys.has(v.refsTaskKey)) problems.push(`voice ${v.seedKey}: unknown refsTaskKey ${v.refsTaskKey}`);
  }
  return problems;
}
