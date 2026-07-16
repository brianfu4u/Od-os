import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  S3StorageProvider,
  presignGetUrl,
  resolveEndpoint,
  signRequest,
  type S3Config,
} from './s3.provider';

const CFG: S3Config = {
  endpoint: 'https://s3.example.com',
  region: 'us-east-1',
  bucket: 'mybucket',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'SECRETKEY',
  forcePathStyle: true,
};
const KEY = 'tenant/t1/abc.png';
const FIXED = new Date('2026-01-02T03:04:05.000Z');

/**
 * P0-3 test (a) — S3 driver. The global fetch is mocked (no network); these assert the provider
 * signs every request (SigV4), targets the right URL/method, and that upload/read/delete/head go
 * through the abstraction. Signing helpers are also checked directly for determinism.
 */
describe('S3 SigV4 signing helpers', () => {
  it('builds a path-style URL + host', () => {
    const r = resolveEndpoint(CFG, KEY);
    expect(r.url.toString()).toBe('https://s3.example.com/mybucket/tenant/t1/abc.png');
    expect(r.host).toBe('s3.example.com');
    expect(r.canonicalUri).toBe('/mybucket/tenant/t1/abc.png');
  });

  it('builds a virtual-host URL + host when forcePathStyle=false', () => {
    const r = resolveEndpoint({ ...CFG, forcePathStyle: false }, KEY);
    expect(r.host).toBe('mybucket.s3.example.com');
    expect(r.canonicalUri).toBe('/tenant/t1/abc.png');
  });

  it('produces a deterministic Authorization header', () => {
    const a = signRequest(CFG, { method: 'GET', storageKey: KEY, payloadHash: 'e3b0c442...', now: FIXED });
    const b = signRequest(CFG, { method: 'GET', storageKey: KEY, payloadHash: 'e3b0c442...', now: FIXED });
    expect(a.headers.Authorization).toBe(b.headers.Authorization);
    expect(a.headers.Authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260102\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
  });

  it('presigns a GET URL with a signature and expiry', () => {
    const url = presignGetUrl(CFG, KEY, 300, FIXED);
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://s3.example.com/mybucket/tenant/t1/abc.png');
    expect(u.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(u.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(u.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    // A different key yields a different signature.
    const other = new URL(presignGetUrl(CFG, 'tenant/t1/other.png', 300, FIXED));
    expect(other.searchParams.get('X-Amz-Signature')).not.toBe(u.searchParams.get('X-Amz-Signature'));
  });
});

describe('S3StorageProvider (fetch mocked)', () => {
  afterEach(() => vi.unstubAllGlobals());

  function mockFetch(impl: (url: string, init: RequestInit) => Response) {
    const spy = vi.fn(async (url: string, init: RequestInit) => impl(url, init));
    vi.stubGlobal('fetch', spy);
    return spy;
  }

  it('put issues a signed PUT with the bytes as the body', async () => {
    const fetchSpy = mockFetch(() => new Response(null, { status: 200 }));
    const provider = new S3StorageProvider(CFG);
    const bytes = Buffer.from('PNGDATA');
    await provider.put({ storageKey: KEY, contentType: 'image/png', bytes });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://s3.example.com/mybucket/tenant/t1/abc.png');
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(bytes);
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^AWS4-HMAC-SHA256 /);
    expect((init.headers as Record<string, string>)['content-type']).toBe('image/png');
  });

  it('read GETs and returns the bytes', async () => {
    mockFetch(() => new Response(Buffer.from('BYTES'), { status: 200 }));
    const out = await new S3StorageProvider(CFG).read(KEY);
    expect(out.toString()).toBe('BYTES');
  });

  it('head reports existence + size, and 404 → not found', async () => {
    mockFetch(() => new Response(null, { status: 200, headers: { 'content-length': '42' } }));
    expect(await new S3StorageProvider(CFG).head(KEY)).toEqual({ exists: true, size: 42 });

    mockFetch(() => new Response(null, { status: 404 }));
    expect(await new S3StorageProvider(CFG).head(KEY)).toEqual({ exists: false, size: 0 });
  });

  it('delete issues a signed DELETE and tolerates 404 (idempotent)', async () => {
    const spy = mockFetch(() => new Response(null, { status: 404 }));
    await expect(new S3StorageProvider(CFG).delete(KEY)).resolves.toBeUndefined();
    expect(spy.mock.calls[0]![1].method).toBe('DELETE');
  });

  it('throws when the backend rejects a put', async () => {
    mockFetch(() => new Response('denied', { status: 403 }));
    await expect(
      new S3StorageProvider(CFG).put({ storageKey: KEY, contentType: 'image/png', bytes: Buffer.from('x') }),
    ).rejects.toThrow(/S3 put failed \(403\)/);
  });
});
