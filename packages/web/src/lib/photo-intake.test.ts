import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nextPhotoMetadata, parseStoredPhotoSeq } from './photo-intake';

describe('photo intake envelope', () => {
  it('parses only safe non-negative sequence counters', () => {
    expect(parseStoredPhotoSeq('17')).toBe(17);
    expect(parseStoredPhotoSeq(null)).toBe(0);
    expect(parseStoredPhotoSeq('-1')).toBe(0);
    expect(parseStoredPhotoSeq('1.5')).toBe(0);
    expect(parseStoredPhotoSeq('999999999999999999999')).toBe(0);
  });

  it('keeps a terminal id and advances seq when Web Storage is unavailable', () => {
    const one = nextPhotoMetadata(new Date('2026-07-16T03:00:00.000Z'));
    const two = nextPhotoMetadata(new Date('2026-07-16T03:00:01.000Z'));
    expect(one.terminalId).toMatch(/^terminal-/);
    expect(two.terminalId).toBe(one.terminalId);
    expect(two.seq).toBe(one.seq + 1);
    expect(one.occurredAt).toBe('2026-07-16T03:00:00.000Z');
  });
});

describe('PhotoIntake privacy guard', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/components/console/PhotoIntake.tsx'),
    'utf8',
  );

  it('uses an embedded rear camera and immediate JPEG upload', () => {
    expect(source).toContain('getUserMedia');
    expect(source).toContain("facingMode: { ideal: 'environment' }");
    expect(source).toContain("'image/jpeg'");
    expect(source).toContain('api.uploadPhoto');
    expect(source).toContain('track.stop()');
  });

  it('contains no album/file-picker or persistent image path', () => {
    expect(source).not.toContain('type="file"');
    expect(source).not.toContain('createObjectURL');
    expect(source).not.toContain('localStorage');
    expect(source).not.toContain('indexedDB');
    expect(source).not.toContain('download=');
    expect(source).not.toContain('setFile(');
  });
});
