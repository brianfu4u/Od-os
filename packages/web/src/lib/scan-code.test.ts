import { describe, expect, it } from 'vitest';
import { looksLikeUuid, parseScanCode } from './scan-code';

const UUID = '11111111-2222-3333-4444-555555555555';

describe('parseScanCode', () => {
  it('passes a raw UUID through', () => {
    expect(parseScanCode(UUID)).toBe(UUID);
    expect(parseScanCode(`  ${UUID}  `)).toBe(UUID);
  });

  it('extracts the id from a clearview:<type>:<id> scheme', () => {
    expect(parseScanCode(`clearview:room:${UUID}`)).toBe(UUID);
    expect(parseScanCode('clearview:room:R-3')).toBe('R-3');
    expect(parseScanCode(`clearview:${UUID}`)).toBe(UUID);
  });

  it('extracts from a URL path (/objects/<id>) or query (?code=/?object=/?id=)', () => {
    expect(parseScanCode(`https://app.example.com/zh/objects/${UUID}`)).toBe(UUID);
    expect(parseScanCode('https://app.example.com/s?code=ROOM-3')).toBe('ROOM-3');
    expect(parseScanCode('https://app.example.com/s?object=R7')).toBe('R7');
  });

  it('treats a bare business code as the token', () => {
    expect(parseScanCode('ROOM-3')).toBe('ROOM-3');
    expect(parseScanCode('设备-12')).toBe('设备-12');
  });

  it('rejects empty / whitespace / oversized payloads', () => {
    expect(parseScanCode('')).toBeNull();
    expect(parseScanCode('   ')).toBeNull();
    expect(parseScanCode('x'.repeat(600))).toBeNull();
  });

  it('looksLikeUuid', () => {
    expect(looksLikeUuid(UUID)).toBe(true);
    expect(looksLikeUuid('ROOM-3')).toBe(false);
  });
});
