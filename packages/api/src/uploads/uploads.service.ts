import { BadRequestException, Inject, Injectable, Optional } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import type { UploadResult } from '@clearview/shared';
import { STORAGE_PORT, type StoragePort } from '../storage/storage.provider';
import { UploadsRepository } from './uploads.repository';
import { RealtimeService } from '../objects/realtime.service';
import { VERIFICATION_HOOK, type VerificationHook } from '../verification/verification.hook';
import { TRANSCRIPTION_HOOK, type TranscriptionHook } from '../transcription/transcription.hook';
import { detectObjectType, detectSubKind, validateUpload } from './uploads.validation';
import { stripImageMetadata } from './image-metadata';

/** Minimal shape of a multer file (avoids an @types/multer dependency). */
export interface UploadFileInput {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

@Injectable()
export class UploadsService {
  constructor(
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    private readonly repo: UploadsRepository,
    private readonly realtime: RealtimeService,
    @Optional() @Inject(VERIFICATION_HOOK) private readonly verification?: VerificationHook,
    @Optional() @Inject(TRANSCRIPTION_HOOK) private readonly transcription?: TranscriptionHook,
  ) {}

  async upload(
    tenantId: string,
    file: UploadFileInput,
    opts: { kind?: string; linkTo?: string; relation?: string } = {},
  ): Promise<UploadResult> {
    // Validate (MIME + size + extension + magic bytes) BEFORE any storage write.
    const error = validateUpload(file?.mimetype, file?.size, file?.originalname, file?.buffer);
    if (error) throw new BadRequestException(error);

    const objectType = detectObjectType(file.mimetype);
    const kind = detectSubKind(file.mimetype, opts.kind);
    // Strip privacy metadata (EXIF/GPS) from images BEFORE storing or hashing.
    const bytes = stripImageMetadata(file.mimetype, file.buffer);
    const sha256 = createHash('sha256').update(bytes).digest('hex');

    // Dedup: identical bytes already stored for this tenant → return the existing object.
    const existing = await this.repo.findBySha256(tenantId, sha256);
    if (existing) return { ...existing, deduped: true };

    // Store bytes OUTSIDE any DB transaction, at a tenant-prefixed key.
    const storageKey = `tenant/${tenantId}/${randomUUID()}${extname(file.originalname) || ''}`;
    await this.storage.put({ storageKey, contentType: file.mimetype, bytes });

    const properties = {
      kind,
      mime: file.mimetype,
      size: bytes.length,
      storageKey,
      originalName: file.originalname,
      sha256,
    };
    const { id } = await this.repo.createEvidence(tenantId, {
      objectType,
      properties,
      linkTo: opts.linkTo,
      relation: opts.relation,
    });

    // Realtime (post-commit, tenant-filtered): the command center sees evidence land live.
    this.realtime.publish({ kind: 'created', tenantId, objectId: id, type: objectType, at: new Date().toISOString() });

    // Event-driven re-score: new evidence linked to an object → re-verify it (S2). Best-effort.
    if (opts.linkTo && this.verification) {
      try {
        await this.verification.verifyObject(tenantId, opts.linkTo);
      } catch {
        /* re-verification is best-effort; never fail the upload */
      }
    }

    // P7 · T4 + P0-3: a voice clip → enqueue transcription DURABLY. We await only the persistence of
    // the 'pending' job row (a fast DB insert), never the STT call itself — the transcript lands
    // later as a derived field on this Document and is fed to LLM1. Persisting before processing means
    // a crash mid-transcription no longer loses the work (it is recoverable). enqueueTranscription
    // swallows its own errors so the upload response is never blocked or failed by STT.
    if (kind === 'voice' && this.transcription) {
      await this.transcription.enqueueTranscription(tenantId, id).catch(() => undefined);
    }

    return {
      objectId: id,
      objectType,
      kind,
      mime: file.mimetype,
      size: bytes.length,
      storageKey,
      originalName: file.originalname,
      sha256,
      deduped: false,
    };
  }
}
