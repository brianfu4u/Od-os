import { describe, expect, it } from 'vitest';
import { audioExt, bareMime, formatDuration, pickSupportedMime, PREFERRED_AUDIO_MIMES } from './audio-recording';

describe('bareMime', () => {
  it('strips codec params and lower-cases', () => {
    expect(bareMime('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(bareMime('AUDIO/MP4; codecs="mp4a.40.2"')).toBe('audio/mp4');
    expect(bareMime('audio/ogg')).toBe('audio/ogg');
    expect(bareMime('')).toBe('');
  });
});

describe('formatDuration', () => {
  it('formats mm:ss and clamps negatives', () => {
    expect(formatDuration(0)).toBe('00:00');
    expect(formatDuration(5_000)).toBe('00:05');
    expect(formatDuration(65_000)).toBe('01:05');
    expect(formatDuration(600_000)).toBe('10:00');
    expect(formatDuration(-1000)).toBe('00:00');
  });
});

describe('audioExt', () => {
  it('maps mimes (incl. codec params) to an extension', () => {
    expect(audioExt('audio/webm;codecs=opus')).toBe('webm');
    expect(audioExt('audio/mp4')).toBe('m4a');
    expect(audioExt('audio/aac')).toBe('aac');
    expect(audioExt('audio/ogg')).toBe('ogg');
    expect(audioExt('audio/mpeg')).toBe('mp3');
    expect(audioExt('application/octet-stream')).toBe('webm'); // safe default
  });
});

describe('pickSupportedMime', () => {
  it('returns the first supported candidate', () => {
    expect(pickSupportedMime((m) => m === 'audio/mp4')).toBe('audio/mp4');
    expect(pickSupportedMime(() => true)).toBe(PREFERRED_AUDIO_MIMES[0]);
  });
  it('returns "" when nothing is supported (browser default)', () => {
    expect(pickSupportedMime(() => false)).toBe('');
  });
  it('treats a throwing isTypeSupported as unsupported', () => {
    expect(
      pickSupportedMime((m) => {
        if (m.includes('webm')) throw new Error('boom');
        return m === 'audio/mp4';
      }),
    ).toBe('audio/mp4');
  });
});
