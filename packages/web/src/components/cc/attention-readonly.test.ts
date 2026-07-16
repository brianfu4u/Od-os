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

    it(`${file}: its only <button> is the passive refetch (no action buttons)`, () => {
      const buttons = src.match(/<button\b/g) ?? [];
      expect(buttons.length, `${file} should have exactly one button (refresh)`).toBe(1);
      // The single button must call the loader, never a mutation.
      expect(src).toMatch(/onClick=\{\(\)\s*=>\s*void load\(\)\}/);
    });

    it(`${file}: never renders a verification / confidence / verdict field`, () => {
      expect(src).not.toMatch(/verificationResult|verificationScore|verdict/i);
    });
  }

  it('positive control: AssignPanel IS the adjudication surface (decideTask present)', () => {
    const assign = read('AssignPanel.tsx');
    expect(assign).toMatch(/\bdecideTask\b/);
  });
});
