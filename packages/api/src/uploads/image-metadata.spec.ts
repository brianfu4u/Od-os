import { describe, it, expect } from 'vitest';
import { stripImageMetadata } from './image-metadata';

function seg(marker: number, payload: Buffer): Buffer {
  const len = payload.length + 2;
  return Buffer.concat([Buffer.from([0xff, marker, (len >> 8) & 0xff, len & 0xff]), payload]);
}

function jpegWithExif(): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  const app0 = seg(0xe0, Buffer.from('JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00', 'binary')); // keep
  const app1 = seg(0xe1, Buffer.from('Exif\x00\x00GPSDATA-secret-location', 'binary')); // drop
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x03, 0x01, 0x11, 0x22, 0x33]); // + fake scan data
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([soi, app0, app1, sos, eoi]);
}

describe('stripImageMetadata', () => {
  it('removes JPEG APP1/EXIF (GPS) while keeping the image', () => {
    const withExif = jpegWithExif();
    expect(withExif.includes(Buffer.from('GPSDATA-secret-location'))).toBe(true);

    const stripped = stripImageMetadata('image/jpeg', withExif);
    expect(stripped.includes(Buffer.from('GPSDATA-secret-location'))).toBe(false);
    expect(stripped[0]).toBe(0xff);
    expect(stripped[1]).toBe(0xd8);
    expect(stripped.includes(Buffer.from([0x11, 0x22, 0x33]))).toBe(true); // scan data preserved

    let hasApp1 = false;
    for (let i = 0; i + 1 < stripped.length; i += 1) {
      if (stripped[i] === 0xff && stripped[i + 1] === 0xe1) hasApp1 = true;
    }
    expect(hasApp1).toBe(false);
  });

  it('passes non-JPEG bytes through unchanged', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    expect(stripImageMetadata('image/png', png).equals(png)).toBe(true);
  });
});
