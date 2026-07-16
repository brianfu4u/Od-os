import { describe, expect, it } from 'vitest';
import {
  parsePhotoMetadata,
  sourceTypeFor,
  subjectHintsFor,
  validatePhotoFile,
  type PhotoFileInput,
} from './photo-evidence.validation';

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x03, 0x01, 0x11, 0x22, 0xff, 0xd9]);

function file(overrides: Partial<PhotoFileInput> = {}): PhotoFileInput {
  return {
    originalname: 'capture.jpg',
    mimetype: 'image/jpeg',
    size: jpeg.length,
    buffer: jpeg,
    ...overrides,
  };
}

describe('T-16 photo validation', () => {
  it('accepts a JPEG and rejects MIME/extension/magic-byte spoofing', () => {
    expect(validatePhotoFile(file())).toBeNull();
    expect(validatePhotoFile(file({ mimetype: 'image/heic' }))).toMatch(/JPEG/i);
    expect(validatePhotoFile(file({ originalname: 'capture.png' }))).toMatch(/\.jpg/i);
    expect(validatePhotoFile(file({ buffer: Buffer.from('not a jpeg') }))).toMatch(/bytes/i);
  });

  it('uses the actual buffer length for the 10 MB boundary', () => {
    expect(
      validatePhotoFile(file({ size: 1, buffer: Buffer.alloc(10 * 1024 * 1024 + 1, 0xff) })),
    ).toMatch(/limit/i);
  });

  it('normalizes multipart metadata and defaults seq/occurredAt', () => {
    const now = new Date('2026-07-16T03:00:00.000Z');
    expect(parsePhotoMetadata({ terminalId: '  ipad-front-1  ', seq: '7' }, now)).toEqual({
      value: { terminalId: 'ipad-front-1', seq: 7, occurredAt: now.toISOString() },
    });
    expect(parsePhotoMetadata({}, now)).toEqual({
      value: { terminalId: null, seq: 0, occurredAt: now.toISOString() },
    });
  });

  it('rejects malformed terminal, sequence, and timestamp values', () => {
    expect(parsePhotoMetadata({ terminalId: '' }).error).toMatch(/terminalId/);
    expect(parsePhotoMetadata({ seq: '-1' }).error).toMatch(/seq/);
    expect(parsePhotoMetadata({ seq: '1.5' }).error).toMatch(/seq/);
    expect(parsePhotoMetadata({ occurredAt: 'yesterday-ish' }).error).toMatch(/occurredAt/);
  });

  it('derives source and non-sensitive subject hints from the server session only', () => {
    expect(sourceTypeFor({ subject: 'staff', tenantId: 'tenant-a', staffId: 'staff-a' })).toBe(
      'staff.terminal',
    );
    expect(
      subjectHintsFor({
        subject: 'staff',
        tenantId: 'tenant-a',
        staffId: 'staff-a',
        staffHandle: 'do-not-copy',
      }),
    ).toEqual({ staffId: 'staff-a' });
    expect(
      subjectHintsFor({
        subject: 'manager',
        tenantId: 'tenant-a',
        managerId: 'manager-a',
        role: 'manager',
      }),
    ).toEqual({ managerId: 'manager-a' });
  });
});
