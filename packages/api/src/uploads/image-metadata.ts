/**
 * Strips privacy-sensitive metadata on image ingest. For JPEG (the format phones/WeChat
 * produce, and the one that carries GPS EXIF) we drop APP1 (EXIF/GPS), APP13 (IPTC), and
 * COM comment segments while preserving the image itself. PNG/WebP metadata stripping is a
 * follow-on. Clinic photos must never leak location data.
 */
export function stripImageMetadata(mime: string, bytes: Buffer): Buffer {
  if (mime === 'image/jpeg') return stripJpegSegments(bytes);
  return bytes;
}

function stripJpegSegments(buf: Buffer): Buffer {
  if (buf.length < 2 || buf[0] !== 0xff || buf[1] !== 0xd8) return buf; // not a JPEG
  const out: Buffer[] = [Buffer.from([0xff, 0xd8])];
  let i = 2;
  while (i + 1 < buf.length) {
    if (buf[i] !== 0xff) {
      out.push(buf.subarray(i));
      break;
    }
    const marker = buf[i + 1];
    if (marker === 0xd9) {
      // End of Image
      out.push(Buffer.from([0xff, 0xd9]));
      break;
    }
    if (marker === 0xda) {
      // Start of Scan → copy the rest (entropy-coded data) verbatim.
      out.push(buf.subarray(i));
      break;
    }
    if (i + 3 >= buf.length) {
      out.push(buf.subarray(i));
      break;
    }
    const len = buf.readUInt16BE(i + 2); // includes the 2 length bytes
    const segEnd = i + 2 + len;
    if (segEnd > buf.length) {
      out.push(buf.subarray(i));
      break;
    }
    // Drop EXIF (APP1=0xE1), Photoshop/IPTC (APP13=0xED), and comments (COM=0xFE).
    const drop = marker === 0xe1 || marker === 0xed || marker === 0xfe;
    if (!drop) out.push(buf.subarray(i, segEnd));
    i = segEnd;
  }
  return Buffer.concat(out);
}
