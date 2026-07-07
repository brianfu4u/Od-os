import { describe, it, expect } from 'vitest';
import { detectKind, validateUpload, MAX_UPLOAD_BYTES } from './uploads.validation';

describe('detectKind', () => {
  it('maps images to Snapshot, everything else to Document', () => {
    expect(detectKind('image/png')).toBe('Snapshot');
    expect(detectKind('image/jpeg')).toBe('Snapshot');
    expect(detectKind('application/pdf')).toBe('Document');
    expect(detectKind('audio/mpeg')).toBe('Document');
  });
});

describe('validateUpload', () => {
  it('accepts allowed types within the size cap', () => {
    expect(validateUpload('image/png', 1024)).toBeNull();
    expect(validateUpload('application/pdf', MAX_UPLOAD_BYTES)).toBeNull();
  });
  it('rejects missing/unsupported types, empty and oversize files', () => {
    expect(validateUpload(undefined, 10)).toMatch(/content type/);
    expect(validateUpload('application/x-msdownload', 10)).toMatch(/unsupported/);
    expect(validateUpload('image/png', 0)).toMatch(/empty/);
    expect(validateUpload('image/png', MAX_UPLOAD_BYTES + 1)).toMatch(/exceeds/);
  });
});
