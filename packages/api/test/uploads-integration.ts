/**
 * S1-3 integration test: UploadsService (+ LocalDiskStorageProvider) against $DATABASE_URL.
 * Proves: upload → Snapshot/Document object, evidence→subject link, byte round-trip,
 * size/type validation, and cross-tenant isolation. Uses random tenants + a temp dir.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { requireDatabaseUrl } from '../db/env';
import { UploadsService } from '../src/uploads/uploads.service';
import { UploadsRepository } from '../src/uploads/uploads.repository';
import { LocalDiskStorageProvider } from '../src/storage/local-disk.provider';
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

async function count(admin: Client, sql: string, params: unknown[]): Promise<number> {
  return (await admin.query<{ n: number }>(sql, params)).rows[0]!.n;
}

async function main(): Promise<void> {
  const url = requireDatabaseUrl();
  process.env.DATABASE_URL = url;
  const storage = new LocalDiskStorageProvider(`/tmp/od-uploads-test-${randomUUID()}`);
  const repo = new UploadsRepository();
  const service = new UploadsService(storage, repo);
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

    const imgBytes = Buffer.from('\x89PNG fake image bytes for the test');
    const up = await service.upload(
      A,
      { originalname: 'evidence.png', mimetype: 'image/png', size: imgBytes.length, buffer: imgBytes },
      { linkTo: taskId },
    );
    check(up.kind === 'Snapshot' && !!up.objectId && up.url === `/uploads/${up.objectId}/content`, 'image upload creates a Snapshot with a content url');

    const obj = await admin.query<{ type: string; properties: Record<string, unknown> }>(
      'SELECT type, properties FROM objects WHERE id = $1',
      [up.objectId],
    );
    check(
      obj.rows[0]!.type === 'Snapshot' &&
        obj.rows[0]!.properties.storageRef === up.storageRef &&
        obj.rows[0]!.properties.size === imgBytes.length,
      'Snapshot object carries storageRef + size',
    );
    check(
      (await count(admin, `SELECT count(*)::int AS n FROM links WHERE from_object=$1 AND to_object=$2 AND relation='references'`, [up.objectId, taskId])) === 1,
      'evidence linked (references) to the task',
    );
    check(
      (await count(admin, `SELECT count(*)::int AS n FROM events WHERE object_id=$1 AND event_type='object.created' AND actor='uploads'`, [up.objectId])) === 1,
      'object.created (uploads) event written',
    );

    const roundtrip = await storage.get(up.storageRef);
    check(roundtrip.equals(imgBytes), 'stored bytes round-trip via storage.get');

    const pdf = await service.upload(
      A,
      { originalname: 'form.pdf', mimetype: 'application/pdf', size: 5, buffer: Buffer.from('%PDF-') },
      {},
    );
    check(pdf.kind === 'Document', 'pdf upload creates a Document');

    let rejectedType = false;
    try {
      await service.upload(A, { originalname: 'x.exe', mimetype: 'application/x-msdownload', size: 10, buffer: Buffer.alloc(10) }, {});
    } catch {
      rejectedType = true;
    }
    check(rejectedType, 'unsupported content type rejected');

    let rejectedSize = false;
    try {
      await service.upload(A, { originalname: 'big.png', mimetype: 'image/png', size: 11 * 1024 * 1024, buffer: Buffer.alloc(1) }, {});
    } catch {
      rejectedSize = true;
    }
    check(rejectedSize, 'oversize upload rejected');

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
