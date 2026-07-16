import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T-08 NO-LEAK GUARDRAIL (the invariant Brian asked to lock down).
 *
 * The employee surfaces (EmployeeStatusBar, ScanEntry) must NEVER render an evaluative / verification
 * / AI-judgment field back to the employee. Principle: 员工端提交不驳回 + AI输出只给经理参考 — the
 * consistency verdict is manager-side only and must not leak into the console UI.
 *
 * We assert at the source level (comments stripped, so explanatory prose can freely name the very
 * fields we forbid in code). A positive control on the manager-side ManagerStatusClaimView contract
 * proves the forbidden field names really do exist somewhere — so a green test is meaningful.
 */

const here = dirname(fileURLToPath(import.meta.url));
function readCode(rel: string): string {
  return readFileSync(join(here, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// Verification / confidence / verdict / AI-feedback field references that must NEVER appear in the
// employee UI code. Word-boundaried where needed so neutral tokens can't false-positive.
const FORBIDDEN = [
  /verificationResult/i,
  /verificationScore/i,
  /\bconfidence\b/i,
  /\bverdict\b/i,
  /consistency/i,
  /\binconsistent\b/i,
  /ManagerStatusClaimView/,
];

const EMPLOYEE_SURFACES = ['EmployeeStatusBar.tsx', 'ScanEntry.tsx'];

describe('T-08 · employee surfaces never render a verification / confidence / verdict field', () => {
  for (const file of EMPLOYEE_SURFACES) {
    const src = readCode(file);
    it(`${file}: contains no verification / confidence / verdict / AI-judgment reference`, () => {
      for (const pat of FORBIDDEN) {
        expect(src, `${file} must not reference ${pat}`).not.toMatch(pat);
      }
    });
  }

  it('positive control: the verification vocabulary DOES exist manager-side (so the guard is real)', () => {
    const contract = readFileSync(
      join(here, '../../../../shared/src/api/employee-status.contract.ts'),
      'utf8',
    );
    expect(contract).toMatch(/verificationResult/);
    expect(contract).toMatch(/verificationScore/);
    expect(contract).toMatch(/ManagerStatusClaimView/);
  });
});
