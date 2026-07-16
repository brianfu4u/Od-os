import { describe, it, expect } from 'vitest';
import {
  classifyMime,
  detectObjectType,
  detectSubKind,
  fileExtension,
  looksExecutable,
  validateUpload,
  SIZE_LIMITS,
} from './uploads.validation';

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

  it('enforces the per-category extension allowlist when a filename is given', () => {
    expect(validateUpload('image/png', 1024, 'photo.png')).toBeNull();
    expect(validateUpload('audio/mp4', 1024, 'note.m4a')).toBeNull();
    expect(validateUpload('application/pdf', 1024, 'report.pdf')).toBeNull();
    // Right MIME, wrong/disallowed extension → rejected (defense in depth against spoofing).
    expect(validateUpload('image/png', 1024, 'evil.exe')).toMatch(/extension/);
    expect(validateUpload('image/png', 1024, 'noext')).toMatch(/extension/);
    expect(validateUpload('application/pdf', 1024, 'macro.docm')).toMatch(/extension/);
  });

  it('rejects executable payloads by magic bytes even with an allowed type + extension', () => {
    const pe = Buffer.from([0x4d, 0x5a, 0x90, 0x00]); // 'MZ' Windows PE
    const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46]); // ELF
    expect(validateUpload('image/png', 1024, 'photo.png', pe)).toMatch(/executable/);
    expect(validateUpload('application/pdf', 1024, 'report.pdf', elf)).toMatch(/executable/);
    // A benign PNG buffer with an allowed name passes all four checks.
    expect(validateUpload('image/png', 1024, 'photo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });
});

describe('fileExtension / looksExecutable', () => {
  it('extracts a lower-cased extension', () => {
    expect(fileExtension('a.PNG')).toBe('png');
    expect(fileExtension('archive.tar.gz')).toBe('gz');
    expect(fileExtension('noext')).toBe('');
    expect(fileExtension('.hidden')).toBe('');
    expect(fileExtension(undefined)).toBe('');
  });
  it('flags executables and shebangs, not media', () => {
    expect(looksExecutable(Buffer.from([0x4d, 0x5a, 0x00, 0x00]))).toBe(true); // MZ
    expect(looksExecutable(Buffer.from('#!/bin/sh\n'))).toBe(true); // shebang
    expect(looksExecutable(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(false); // PNG
    expect(looksExecutable(Buffer.from([0x00]))).toBe(false); // too short
    expect(looksExecutable(undefined)).toBe(false);
  });
});
