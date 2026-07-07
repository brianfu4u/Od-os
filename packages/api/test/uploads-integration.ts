/**
 * S1-3 integration test: UploadsService (+ LocalDiskStorageProvider) against $DATABASE_URL.
 * Proves: upload → Snapshot/Document with {kind,mime,size,storageKey,sha256}; tenant-prefixed
 * keys; EXIF/GPS stripped from JPEGs; signed-URL round-trip; dedup by sha256; link.created +
 * evidence.attached on linked uploads; audio → Document kind=voice; validation; cross-tenant.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { requireDatabaseUrl } from '../db/env';
import { UploadsService } from '../src/uploads/uploads.service';
import { UploadsRepository } from '../src/uploads/uploads.repository';
import { LocalDiskStorageProvider } from '../src/storage/local-disk.provider';
import { RealtimeService } from '../src/objects/realtime.service';
import { verifyContentSig } from '../src/storage/url-signing';
import { closePool } from '../src/database/pool';

let passed = 0;
let failed = 0;
function check(cond: boolean, label: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}
async function count(admin: Client, sql: string, p: unknown[]): Promise<number> {
  return (await admin.query<{ n: number }>(sql, p)).rows[0]!.n;
}
function jpegWithExif(): Buffer {
  const seg = (m: number, pl: Buffer) => Buffer.concat([Buffer.from([0xff, m, ((pl.length + 2) >> 8) & 0xff, (pl.length + 2) & 0xff]), pl]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe1, Buffer.from('Exif\x00\x00GPSDATA-secret-location', 'binary')),
    Buffer.from([0xff, 0xda, 0x00, 0x03, 0x01, 0x11, 0x22, 0x33]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

async function main(): Promise<void> {
  const url = requireDatabaseUrl();
  process.env.DATABASE_URL = url;
  const storage = new LocalDiskStorageProvider(`/tmp/od-uploads-test-${randomUUID()}`);
  const repo = new UploadsRepository();
  const service = new UploadsService(storage, repo, new RealtimeService());
  const admin = new Client({ connectionString: url });
  await admin.connect();
  const A = randomUUID();
  const B = randomUUID();

  try {
    console.log('S1-3 uploads:');

    const task = await admin.query<{ id: string }>(
      `INSERT INTO objects (tenant_id, type, properties) VALUES ($1, 'Task', '{}'::jsonb) RETURNING id`,
      [A],
    );
    const taskId = task.rows[0]!.id;

    // JPEG with EXIF GPS, linked to the task.
    const img = jpegWithExif();
    const up = await service.upload(
      A,
      { originalname: 'evidence.jpg', mimetype: 'image/jpeg', size: img.length, buffer: img },
      { linkTo: taskId },
    );
    check(up.objectType === 'Snapshot' && up.kind === 'photo' && !!up.sha256, 'image → Snapshot (kind=photo) with sha256');
    check(up.storageKey.startsWith(`tenant/${A}/`), 'storage key is tenant-prefixed');
    check(up.deduped === false, 'first upload is not a dedup');

    const obj = await admin.query<{ type: string; properties: Record<string, unknown> }>(
      'SELECT type, properties FROM objects WHERE id = $1',
      [up.objectId],
    );
    check(
      obj.rows[0]!.type === 'Snapshot' &&
        obj.rows[0]!.properties.storageKey === up.storageKey &&
        obj.rows[0]!.properties.kind === 'photo',
      'Snapshot object carries kind + storageKey',
    );

    // EXIF stripped: stored bytes must not contain the GPS marker, and size shrank.
    const stored = await storage.read(up.storageKey);
    check(!stored.includes(Buffer.from('GPSDATA-secret-location')), 'EXIF/GPS stripped from stored image');
    check(up.size < img.length, 'stored size reflects stripped bytes');

    // Signed URL round-trip (RLS lookup → signed url → verify).
    const meta = await repo.getStoredMeta(A, up.objectId);
    check(meta?.storageKey === up.storageKey, 'RLS-scoped metadata lookup succeeds for owner');
    const signed = await storage.getSignedUrl(meta!.storageKey, meta!.mime);
    const q = new URLSearchParams(signed.url.split('?')[1] ?? '');
    check(
      verifyContentSig(q.get('key')!, q.get('ct')!, Number(q.get('exp')), q.get('sig')!),
      'signed download URL verifies',
    );

    // Link + events.
    check(
      (await count(admin, `SELECT count(*)::int AS n FROM links WHERE from_object=$1 AND to_object=$2 AND relation='references'`, [up.objectId, taskId])) === 1,
      'evidence linked (references) to the task',
    );
    check((await count(admin, `SELECT count(*)::int AS n FROM events WHERE object_id=$1 AND event_type='link.created'`, [up.objectId])) === 1, 'link.created event written');
    check((await count(admin, `SELECT count(*)::int AS n FROM events WHERE object_id=$1 AND event_type='evidence.attached'`, [taskId])) === 1, 'evidence.attached event on the task');

    // Dedup: identical bytes again → same object, no new row.
    const dup = await service.upload(A, { originalname: 'again.jpg', mimetype: 'image/jpeg', size: img.length, buffer: img }, {});
    check(dup.deduped === true && dup.objectId === up.objectId, 'identical bytes dedup to the existing object');

    // Audio → Document kind=voice.
    const voice = await service.upload(A, { originalname: 'note.amr', mimetype: 'audio/amr', size: 2048, buffer: Buffer.alloc(2048, 7) }, {});
    check(voice.objectType === 'Document' && voice.kind === 'voice', 'audio → Document (kind=voice)');

    // Validation.
    let badType = false;
    try {
      await service.upload(A, { originalname: 'x.exe', mimetype: 'application/x-msdownload', size: 10, buffer: Buffer.alloc(10) }, {});
    } catch {
      badType = true;
    }
    check(badType, 'unsupported content type rejected');

    let oversize = false;
    try {
      await service.upload(A, { originalname: 'big.png', mimetype: 'image/png', size: 11 * 1024 * 1024, buffer: Buffer.alloc(1) }, {});
    } catch {
      oversize = true;
    }
    check(oversize, 'oversize image rejected (per-kind cap)');

    // Cross-tenant: B cannot read A's evidence metadata (RLS).
    check((await repo.getStoredMeta(B, up.objectId)) === null, 'tenant B cannot read tenant A evidence metadata');
  } finally {
    await admin.end();
    await closePool();
  }

  console.log(`\n${failed === 0 ? '✔' : '✖'} uploads integration: ${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
