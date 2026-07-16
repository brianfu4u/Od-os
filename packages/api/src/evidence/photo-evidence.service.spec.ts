import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoragePort } from '../storage/storage.provider';
import { EventLogRepository } from './event-log.repository';
import { PhotoEvidenceService } from './photo-evidence.service';

function jpegWithExif(): Buffer {
  const payload = Buffer.from('Exif\x00\x00GPS-secret', 'binary');
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, payload.length + 2]),
    payload,
    Buffer.from([0xff, 0xda, 0x00, 0x03, 0x01, 0x11, 0x22, 0xff, 0xd9]),
  ]);
}

describe('PhotoEvidenceService', () => {
  const put = vi.fn();
  const remove = vi.fn();
  const appendPhoto = vi.fn();
  const storage = {
    put,
    delete: remove,
    getSignedUrl: vi.fn(),
    head: vi.fn(),
    read: vi.fn(),
  } as unknown as StoragePort;
  const repo = { appendPhoto } as unknown as EventLogRepository;
  const service = new PhotoEvidenceService(storage, repo);
  const tenant = '11111111-1111-1111-1111-111111111111';

  beforeEach(() => {
    vi.clearAllMocks();
    put.mockResolvedValue(undefined);
    remove.mockResolvedValue(undefined);
    appendPhoto.mockResolvedValue({
      eventId: '22222222-2222-2222-2222-222222222222',
      terminalId: 'ipad-1',
      eventType: 'evidence.photo.received',
      seq: 7,
      occurredAt: '2026-07-16T03:00:00.000Z',
      receivedAt: '2026-07-16T03:00:01.000Z',
    });
  });

  it('stores stripped bytes and appends only a structural, neutral event payload', async () => {
    const input = jpegWithExif();
    const receipt = await service.receive(
      tenant,
      { subject: 'staff', tenantId: tenant, staffId: 'staff-1', staffHandle: 'never-copy-me' },
      { originalname: 'capture.jpg', mimetype: 'image/jpeg', size: 1, buffer: input },
      { terminalId: 'ipad-1', seq: '7', occurredAt: '2026-07-16T03:00:00Z' },
    );

    expect(put).toHaveBeenCalledOnce();
    const stored = put.mock.calls[0]![0] as {
      storageKey: string;
      contentType: string;
      bytes: Buffer;
    };
    expect(stored.storageKey).toMatch(new RegExp(`^tenant/${tenant}/event-log/.+\\.jpg$`));
    expect(stored.contentType).toBe('image/jpeg');
    expect(stored.bytes.includes(Buffer.from('GPS-secret'))).toBe(false);

    const appended = appendPhoto.mock.calls[0]![1] as Record<string, unknown> & {
      payload: Record<string, unknown>;
      subjectHints: Record<string, unknown>;
    };
    expect(Object.keys(appended.payload).sort()).toEqual(['mime', 'sha256', 'size', 'storageKey']);
    expect(appended.payload.storageKey).toBe(stored.storageKey);
    expect(appended.payload.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(appended.payload.size).toBe(stored.bytes.length);
    expect(appended.subjectHints).toEqual({ staffId: 'staff-1' });
    expect(JSON.stringify(appended)).not.toContain('never-copy-me');
    expect(JSON.stringify(appended)).not.toContain('GPS-secret');
    expect(receipt.eventType).toBe('evidence.photo.received');
    expect(receipt.sha256).toBe(appended.payload.sha256);
    expect(receipt.size).toBe(stored.bytes.length);
  });

  it('rejects non-JPEG input before storage', async () => {
    await expect(
      service.receive(
        tenant,
        { subject: 'staff', tenantId: tenant, staffId: 'staff-1' },
        {
          originalname: 'capture.png',
          mimetype: 'image/png',
          size: 4,
          buffer: Buffer.from('nope'),
        },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(put).not.toHaveBeenCalled();
    expect(appendPhoto).not.toHaveBeenCalled();
  });

  it('removes the stored photo when the immutable event insert fails', async () => {
    appendPhoto.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(
      service.receive(
        tenant,
        { subject: 'manager', tenantId: tenant, managerId: 'manager-1', role: 'manager' },
        { originalname: 'capture.jpeg', mimetype: 'image/jpeg', size: 99, buffer: jpegWithExif() },
      ),
    ).rejects.toThrow('database unavailable');
    expect(remove).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith(
      (put.mock.calls[0]![0] as { storageKey: string }).storageKey,
    );
  });
});
