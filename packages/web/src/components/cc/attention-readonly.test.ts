import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T-09 READ-ONLY GUARDRAIL (the key invariant Brian asked to lock down).
 *
 * StatusBoard and AttentionPanel are manager-facing but must NEVER be a decision surface: the whole
 * three-state adjudication (approve / reject / shelve, via api.decideTask) lives ONLY in AssignPanel.
 * These panels may only LOOK — the sole interactive control is a passive refetch button.
 *
 * We assert this at the source level (no jsdom needed, zero new deps, and it can't be defeated by a
 * conditional render): the component sources must contain NO adjudication verb and NO decide call,
 * and must not import the decision input type. A positive control confirms AssignPanel DOES wire the
 * decision — so the test proves the assertion is meaningful, not vacuous.
 */

const here = dirname(fileURLToPath(import.meta.url));
// Strip comments so the guardrail checks ACTUAL code/JSX, not the explanatory prose in doc-comments
// (which intentionally spell out the words we forbid in real code, e.g. "never a verdict").
function readCode(f: string): string {
  return readFileSync(join(here, f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // line comments (avoid eating http://)
}
const read = (f: string) => readCode(f);

// Case-insensitive adjudication verbs + the decision API call + the decision route.
// Word-boundaried so neutral words (e.g. "approach") never false-positive.
const FORBIDDEN = [
  /\bdecideTask\b/i,
  /\bdecide\s*\(/i,
  /['"]approve['"]/i,
  /['"]reject['"]/i,
  /['"]shelve['"]/i,
  /assignments\/tasks\/[^/]*\/decide/i,
  /TaskDecisionInput/,
];

const READ_ONLY_PANELS = ['StatusBoard.tsx', 'AttentionPanel.tsx'];

describe('T-09 · manager read-only panels carry NO adjudication control', () => {
  for (const file of READ_ONLY_PANELS) {
    const src = read(file);

    it(`${file}: contains no three-state decision verb or decide() call`, () => {
      for (const pat of FORBIDDEN) {
        expect(src, `${file} must not reference ${pat}`).not.toMatch(pat);
      }
    });

    it(`${file}: carries a passive refetch and NO adjudication button`, () => {
      // The refetch loader button must be present and wired to the loader, never a mutation.
      expect(src).toMatch(/onClick=\{\(\)\s*=>\s*void load\(\)\}/);
    });

    it(`${file}: never renders a verification / confidence / verdict field`, () => {
      expect(src).not.toMatch(/verificationResult|verificationConfidence|verificationScore|verdict/i);
    });
  }

  // StatusBoard remains strictly single-button. AttentionPanel gains ONE additional non-adjudicating
  // control in P1-6-f: an audited scan-code reveal. It is manager-side sensitive-data access (records
  // who/when), NOT a decision — it approves/rejects/shelves nothing and mutates no world state.
  it('StatusBoard.tsx: still has exactly one button (passive refetch only)', () => {
    const buttons = read('StatusBoard.tsx').match(/<button\b/g) ?? [];
    expect(buttons.length, 'StatusBoard should have exactly one button (refresh)').toBe(1);
  });

  it('AttentionPanel.tsx: its only non-refetch button is the audited reveal (calls revealScanCode, not a decision)', () => {
    const src = read('AttentionPanel.tsx');
    const buttons = src.match(/<button\b/g) ?? [];
    expect(buttons.length, 'AttentionPanel has the refetch button + the reveal button').toBe(2);
    // The added button reveals a masked code via the audited endpoint — never an adjudication call.
    expect(src).toMatch(/\brevealScanCode\b/);
    for (const pat of FORBIDDEN) {
      expect(src, `reveal button must not be an adjudication (${pat})`).not.toMatch(pat);
    }
  });

  it('positive control: AssignPanel IS the adjudication surface (decideTask present)', () => {
    const assign = read('AssignPanel.tsx');
    expect(assign).toMatch(/\bdecideTask\b/);
  });
});
