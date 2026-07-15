import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T-11-C · Web 护栏矩阵 (收口).
 *
 * WHY THIS FILE EXISTS:
 *   The employee-side no-leak guard (employee-noverdict.test.ts) and the manager-side read-only guard
 *   (attention-readonly.test.ts) each lock ONE invariant in ONE folder. This matrix restates the
 *   whole front-end contract in a single auditable place — 员工零泄露 · 经理只读 · 裁决单一归属 —
 *   plus a NEW dimension neither existing guard covers: i18n three-language (zh/en/ja) structural
 *   alignment. All assertions are source-level (comments stripped) so no jsdom / testing-library is
 *   needed, matching the existing web-test convention. Positive controls prove each guard is real.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** Read a source file with comments stripped (so doc-prose may freely name forbidden tokens). */
function readCode(rel: string): string {
  return readFileSync(join(here, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // line comments (avoid eating http://)
}

// ── 铁律 A · 员工端零泄露 — employee surfaces never render a verification / verdict field ──
describe('T-11-C · 铁律 A · 员工端零泄露', () => {
  const EMPLOYEE_SURFACES = ['console/EmployeeStatusBar.tsx', 'console/ScanEntry.tsx'];
  const FORBIDDEN = [
    /verificationResult/i,
    /verificationConfidence/i,
    /\bconfidence\b/i,
    /\bverdict\b/i,
    /consistency/i,
    /\binconsistent\b/i,
    /ManagerStatusClaimView/,
  ];
  for (const file of EMPLOYEE_SURFACES) {
    const src = readCode(file);
    it(`${file}: 不渲染任何 verification / confidence / verdict 字段`, () => {
      for (const pat of FORBIDDEN) {
        expect(src, `${file} must not reference ${pat}`).not.toMatch(pat);
      }
    });
  }
  it('positive control: verification 词汇确实存在于经理端 contract (护栏非空转)', () => {
    const contract = readFileSync(join(here, '../../../shared/src/api/employee-status.contract.ts'), 'utf8');
    expect(contract).toMatch(/verificationResult/);
    expect(contract).toMatch(/ManagerStatusClaimView/);
  });
});

// ── 铁律 B · 经理只读 — StatusBoard / AttentionPanel carry NO adjudication control ──
describe('T-11-C · 铁律 B · 经理端只读', () => {
  const READ_ONLY_PANELS = ['cc/StatusBoard.tsx', 'cc/AttentionPanel.tsx'];
  const FORBIDDEN = [
    /\bdecideTask\b/i,
    /\bdecide\s*\(/i,
    /['"]approve['"]/i,
    /['"]reject['"]/i,
    /['"]shelve['"]/i,
    /assignments\/tasks\/[^/]*\/decide/i,
    /TaskDecisionInput/,
  ];
  for (const file of READ_ONLY_PANELS) {
    const src = readCode(file);
    it(`${file}: 无任何三态裁决动词或 decide() 调用`, () => {
      for (const pat of FORBIDDEN) {
        expect(src, `${file} must not reference ${pat}`).not.toMatch(pat);
      }
    });
    it(`${file}: 唯一 <button> 是被动刷新(无动作按钮)`, () => {
      const buttons = src.match(/<button\b/g) ?? [];
      expect(buttons.length, `${file} should have exactly one button (refresh)`).toBe(1);
      expect(src).toMatch(/onClick=\{\(\)\s*=>\s*void load\(\)\}/);
    });
  }
});

// ── 铁律 C · 裁决单一归属 — the three-state decision lives ONLY in AssignPanel ──
describe('T-11-C · 铁律 C · 裁决单一归属', () => {
  it('AssignPanel 是唯一裁决面(decideTask 只在此出现)', () => {
    const assign = readCode('cc/AssignPanel.tsx');
    expect(assign).toMatch(/\bdecideTask\b/);
  });
  it('只读面板均不含 decideTask(裁决不散落到其他面板)', () => {
    for (const f of ['cc/StatusBoard.tsx', 'cc/AttentionPanel.tsx']) {
      expect(readCode(f)).not.toMatch(/\bdecideTask\b/);
    }
  });
});

// ── 铁律 D · i18n 三语结构对齐 (NEW dimension — zh/en/ja must expose the SAME key tree) ──
describe('T-11-C · 铁律 D · i18n 三语对齐', () => {
  const messagesDir = join(here, '../../messages');
  const load = (locale: string): Record<string, unknown> =>
    JSON.parse(readFileSync(join(messagesDir, `${locale}.json`), 'utf8')) as Record<string, unknown>;

  const zh = load('zh');
  const en = load('en');
  const ja = load('ja');

  /** Recursively collect the set of dotted key paths (structure only, values ignored). */
  function keyPaths(obj: unknown, prefix = ''): string[] {
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return [prefix];
    const out: string[] = [];
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out.push(...keyPaths(v, prefix ? `${prefix}.${k}` : k));
    }
    return out.sort();
  }

  const zhPaths = keyPaths(zh);
  const enPaths = keyPaths(en);
  const jaPaths = keyPaths(ja);

  it('三语顶层 namespace 集合完全一致', () => {
    const top = (o: Record<string, unknown>) => Object.keys(o).sort();
    expect(top(en)).toEqual(top(zh));
    expect(top(ja)).toEqual(top(zh));
  });

  it('en 的完整 key 树与 zh 完全一致(无缺失、无多余)', () => {
    expect(enPaths).toEqual(zhPaths);
  });

  it('ja 的完整 key 树与 zh 完全一致(无缺失、无多余)', () => {
    expect(jaPaths).toEqual(zhPaths);
  });

  it('三语 key 数量相等(计数护栏)', () => {
    expect(enPaths.length).toBe(zhPaths.length);
    expect(jaPaths.length).toBe(zhPaths.length);
  });
});
