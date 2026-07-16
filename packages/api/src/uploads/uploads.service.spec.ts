import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { UploadsService, type UploadFileInput } from './uploads.service';
import type { UploadsRepository } from './uploads.repository';
import type { RealtimeService } from '../objects/realtime.service';
import type { StoragePort } from '../storage/storage.provider';

/**
 * P0-3 test (b): the upload endpoint rejects a disallowed type/extension/executable with a 4xx
 * (BadRequestException) BEFORE any storage write. The fake StoragePort records whether put ran — it
 * must stay false on every rejection.
 */
function makeService() {
  let putCalled = false;
  const storage = {
    put: async () => { putCalled = true; },
    read: async () => Buffer.alloc(0),
    head: async () => ({ exists: false, size: 0 }),
    getSignedUrl: async () => ({ url: '', expiresAt: '' }),
    delete: async () => undefined,
  } as unknown as StoragePort;
  // These must never be reached on a rejected upload; throwing surfaces any ordering regression.
  const repo = {
    findBySha256: async () => { throw new Error('repo must not be touched on a rejected upload'); },
  } as unknown as UploadsRepository;
  const realtime = { publish: () => undefined } as unknown as RealtimeService;
  const svc = new UploadsService(storage, repo, realtime);
  return { svc, put: () => putCalled };
}

const file = (over: Partial<UploadFileInput>): UploadFileInput => ({
  originalname: 'photo.png',
  mimetype: 'image/png',
  size: 1024,
  buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  ...over,
});

describe('UploadsService — validation rejects before any storage write', () => {
  it('rejects a disallowed content type', async () => {
    const { svc, put } = makeService();
    await expect(
      svc.upload('t1', file({ mimetype: 'application/x-msdownload', originalname: 'x.exe' })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(put()).toBe(false);
  });

  it('rejects an allowed type with a disallowed extension', async () => {
    const { svc, put } = makeService();
    await expect(svc.upload('t1', file({ originalname: 'evil.exe' }))).rejects.toBeInstanceOf(BadRequestException);
    expect(put()).toBe(false);
  });

  it('rejects executable bytes even under an allowed type + extension', async () => {
    const { svc, put } = makeService();
    await expect(
      svc.upload('t1', file({ buffer: Buffer.from([0x4d, 0x5a, 0x90, 0x00]) })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(put()).toBe(false);
  });

  it('rejects an oversize file before writing', async () => {
    const { svc, put } = makeService();
    await expect(svc.upload('t1', file({ size: 100 * 1024 * 1024 }))).rejects.toBeInstanceOf(BadRequestException);
    expect(put()).toBe(false);
  });
});
