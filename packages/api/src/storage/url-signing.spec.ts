import { describe, it, expect } from 'vitest';
import { signContentUrl, verifyContentSig } from './url-signing';

function params(url: string): URLSearchParams {
  return new URLSearchParams(url.split('?')[1] ?? '');
}

describe('content URL signing', () => {
  it('verifies a freshly signed URL', () => {
    const now = Date.now();
    const { url } = signContentUrl('tenant/t1/abc.png', 'image/png', 300, now);
    const p = params(url);
    expect(
      verifyContentSig(p.get('key')!, p.get('ct')!, Number(p.get('exp')), p.get('sig')!, now),
    ).toBe(true);
  });

  it('rejects a tampered signature, a wrong content-type, and an expired URL', () => {
    const now = Date.now();
    const { url } = signContentUrl('tenant/t1/abc.png', 'image/png', 300, now);
    const p = params(url);
    const key = p.get('key')!;
    const ct = p.get('ct')!;
    const exp = Number(p.get('exp'));
    const sig = p.get('sig')!;

    expect(verifyContentSig(key, ct, exp, 'deadbeef', now)).toBe(false);
    expect(verifyContentSig(key, 'image/jpeg', exp, sig, now)).toBe(false);
    expect(verifyContentSig(key, ct, exp, sig, (exp + 5) * 1000)).toBe(false); // past expiry
  });
});
