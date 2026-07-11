import { describe, it, expect } from 'vitest';
import { classifyMime, detectObjectType, detectSubKind, validateUpload, SIZE_LIMITS } from './uploads.validation';

describe('classifyMime', () => {
  it('categorizes allowed types and rejects others', () => {
    expect(classifyMime('image/png')).toBe('image');
    expect(classifyMime('audio/amr')).toBe('audio');
    expect(classifyMime('application/pdf')).toBe('doc');
    expect(classifyMime('application/x-msdownload')).toBeNull();
    expect(classifyMime(undefined)).toBeNull();
  });

  it('strips codec parameters (T3 MediaRecorder output) and is case-insensitive', () => {
    expect(classifyMime('audio/webm;codecs=opus')).toBe('audio');
    expect(classifyMime('audio/mp4; codecs="mp4a.40.2"')).toBe('audio');
    expect(classifyMime('AUDIO/WEBM')).toBe('audio');
    expect(classifyMime('audio/ogg')).toBe('audio');
  });
});

describe('detectObjectType / detectSubKind', () => {
  it('maps images to Snapshot and others to Document', () => {
    expect(detectObjectType('image/jpeg')).toBe('Snapshot');
    expect(detectObjectType('audio/mpeg')).toBe('Document');
    expect(detectObjectType('audio/webm;codecs=opus')).toBe('Document');
    expect(detectObjectType('application/pdf')).toBe('Document');
  });
  it('derives the semantic sub-kind, honoring a valid hint', () => {
    expect(detectSubKind('image/png')).toBe('photo');
    expect(detectSubKind('image/png', 'screenshot')).toBe('screenshot');
    expect(detectSubKind('audio/amr')).toBe('voice');
    expect(detectSubKind('audio/webm;codecs=opus')).toBe('voice'); // T3 recording → voice
    expect(detectSubKind('application/pdf')).toBe('pdf');
    expect(detectSubKind('image/png', 'bogus')).toBe('photo'); // invalid hint ignored
  });
});

describe('validateUpload', () => {
  it('accepts allowed types within the per-kind cap', () => {
    expect(validateUpload('image/png', 1024)).toBeNull();
    expect(validateUpload('audio/amr', SIZE_LIMITS.audio)).toBeNull();
    expect(validateUpload('audio/webm;codecs=opus', 2 * 1024 * 1024)).toBeNull();
  });
  it('rejects unsupported types, empty, and oversize (per kind)', () => {
    expect(validateUpload('application/x-msdownload', 10)).toMatch(/unsupported/);
    expect(validateUpload('image/png', 0)).toMatch(/empty/);
    expect(validateUpload('image/png', SIZE_LIMITS.image + 1)).toMatch(/exceeds/);
    // an audio file at 15MB is fine (20MB cap) though it would exceed the image cap
    expect(validateUpload('audio/mpeg', 15 * 1024 * 1024)).toBeNull();
    expect(validateUpload('audio/webm;codecs=opus', SIZE_LIMITS.audio + 1)).toMatch(/exceeds/);
  });
});
