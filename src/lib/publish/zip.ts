/**
 * M9 — deterministic ZIP writer (§7, publication packages).
 *
 * A minimal, dependency-free ZIP writer in STORED (uncompressed) mode with
 * FIXED timestamps: the same input files always produce byte-identical
 * archives (deterministic packaging requirement). Entries are written in the
 * order given (callers sort for determinism). CRC-32 is IEEE (zip standard).
 * Integrity is verified by tests with an independent unzip implementation.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Fixed MS-DOS timestamp used for EVERY entry (2000-01-01 00:00:00) — determinism. */
const DOS_TIME = 0; // 00:00:00
const DOS_DATE = ((2000 - 1980) << 9) | (1 << 5) | 1; // 2000-01-01

export interface ZipEntry {
  /** Archive path (forward slashes, no leading slash). */
  name: string;
  /** File content (deterministic packaging uses bytes read by the caller). */
  data: Uint8Array;
}

export interface ZipBuildResult {
  buffer: Uint8Array;
  entries: { name: string; bytes: number; crc32: string }[];
}

/**
 * Build a STORED zip. No directories are implied — include explicit entries
 * (e.g. "manifest.json", "video/youtube_shorts.mp4").
 */
export function buildZip(entries: ZipEntry[]): ZipBuildResult {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  const report: ZipBuildResult["entries"] = [];
  let offset = 0;

  const push = (arr: Uint8Array) => {
    chunks.push(arr);
    offset += arr.length;
  };

  const u16 = (v: number): Uint8Array => new Uint8Array([v & 0xff, (v >>> 8) & 0xff]);
  const u32 = (v: number): Uint8Array => new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);

  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    if (nameBytes.length > 240) throw new Error(`zip entry name too long: ${entry.name}`);
    if (entry.name.startsWith("/") || entry.name.includes("..")) throw new Error(`unsafe zip entry name: ${entry.name}`);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header signature
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, 0, true); // method: STORED
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true); // compressed (same as stored)
    lv.setUint32(22, size, true); // uncompressed
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    push(local);
    push(entry.data);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); // central directory signature
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset - size - nameBytes.length - 30, true); // local header offset
    cd.set(nameBytes, 46);
    central.push(cd);

    report.push({ name: entry.name, bytes: size, crc32: crc.toString(16).padStart(8, "0") });
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const c of central) {
    centralSize += c.length;
    push(c);
  }

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralOffset, true);
  push(eocd);

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const buffer = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    buffer.set(c, pos);
    pos += c.length;
  }
  return { buffer, entries: report };
}
