import { constants, crc32, inflateRawSync } from "node:zlib";

/**
 * A small ZIP reader for .vsdx, .docx, .pptx, .xlsx and .jar files (no ZIP library is available
 * and none is needed). It reads the central directory, then stored or deflated entries on
 * demand. Archives come from people's laptops and shared drives, so it is defensive: sizes are
 * capped per entry and in total (a zip bomb stops at the cap, whatever the header claims),
 * names that climb out of the archive are refused, and checksums are verified.
 */
export class ZipError extends Error {
  override name = "ZipError";
}

export interface ZipLimits {
  /** Most entries an archive may list. */
  maxEntries: number;
  /** Largest uncompressed entry, in bytes. */
  maxEntryBytes: number;
  /** Most uncompressed bytes read from one archive, all entries together. */
  maxTotalBytes: number;
}

export const ZIP_LIMITS: ZipLimits = {
  maxEntries: 10_000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
};

export interface ZipArchive {
  /** Entry names in central-directory order (folders left out). */
  readonly names: string[];
  has(name: string): boolean;
  /** The entry's bytes, or undefined if there is no such entry. Throws ZipError if it is bad. */
  read(name: string): Uint8Array | undefined;
  /** The entry as UTF-8 text (a byte-order mark is dropped). */
  text(name: string): string | undefined;
}

interface Entry {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** True when a name is safe to use as a path inside the archive. */
function safeName(name: string): boolean {
  const n = name.replace(/\\/g, "/");
  if (n.startsWith("/") || /^[a-zA-Z]:/.test(n) || n.includes("\0")) return false;
  return !n.split("/").some((seg) => seg === "..");
}

export function readZip(bytes: Uint8Array, limits: Partial<ZipLimits> = {}): ZipArchive {
  const lim = { ...ZIP_LIMITS, ...limits };
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 22 || buf.readUInt32LE(0) !== LOCAL) {
    // An empty archive is only an end record; anything else must start with a local header.
    if (!(buf.length >= 22 && buf.readUInt32LE(0) === EOCD))
      throw new ZipError("not a zip archive");
  }
  // The end-of-central-directory record is in the last 64 KiB + 22 bytes.
  let eocd = -1;
  for (let p = buf.length - 22; p >= Math.max(0, buf.length - 22 - 0xffff); p--) {
    if (buf.readUInt32LE(p) === EOCD) {
      eocd = p;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("not a zip archive: no end of central directory");
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff)
    throw new ZipError("ZIP64 archives are not supported");
  if (count > lim.maxEntries) throw new ZipError(`too many entries (${count})`);
  if (cdOffset + cdSize > eocd) throw new ZipError("corrupt zip: central directory out of range");

  const entries = new Map<string, Entry>();
  const names: string[] = [];
  let p = cdOffset;
  for (let k = 0; k < count; k++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== CENTRAL)
      throw new ZipError("corrupt zip: bad central directory entry");
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    if (p + 46 + nameLen > eocd) throw new ZipError("corrupt zip: name out of range");
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (!safeName(name)) throw new ZipError(`unsafe path in zip: ${name}`);
    const entry: Entry = {
      name: name.replace(/\\/g, "/"),
      flags: buf.readUInt16LE(p + 8),
      method: buf.readUInt16LE(p + 10),
      crc: buf.readUInt32LE(p + 16),
      compressedSize: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      localOffset: buf.readUInt32LE(p + 42),
    };
    if (entry.compressedSize === 0xffffffff || entry.size === 0xffffffff)
      throw new ZipError("ZIP64 archives are not supported");
    if (!entry.name.endsWith("/")) {
      if (!entries.has(entry.name)) names.push(entry.name);
      entries.set(entry.name, entry);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }

  let total = 0;
  const read = (name: string): Uint8Array | undefined => {
    const e = entries.get(name);
    if (!e) return undefined;
    if (e.flags & 1) throw new ZipError(`${name} is encrypted`);
    if (e.size > lim.maxEntryBytes) throw new ZipError(`${name} is too large`);
    if (total + e.size > lim.maxTotalBytes) throw new ZipError("archive content is too large");
    const lp = e.localOffset;
    if (lp + 30 > buf.length || buf.readUInt32LE(lp) !== LOCAL)
      throw new ZipError(`corrupt zip: bad local header for ${name}`);
    const start = lp + 30 + buf.readUInt16LE(lp + 26) + buf.readUInt16LE(lp + 28);
    const end = start + e.compressedSize;
    if (end > buf.length) throw new ZipError(`corrupt zip: ${name} is truncated`);
    const raw = buf.subarray(start, end);
    let out: Buffer;
    if (e.method === 0) out = Buffer.from(raw);
    else if (e.method === 8) {
      // Cap the output at what the header claims (and the limits allow): a lying header or a
      // bomb stops here instead of filling memory.
      const cap = Math.min(e.size, lim.maxEntryBytes, lim.maxTotalBytes - total);
      try {
        out = inflateRawSync(raw, { maxOutputLength: Math.max(cap, 1) });
      } catch (err) {
        const tooBig = err instanceof RangeError || /buffer|length/i.test(String(err));
        throw new ZipError(
          tooBig ? `${name} is too large for its header` : `corrupt zip: ${name} does not inflate`,
        );
      }
    } else
      throw new ZipError(`${name} uses compression method ${e.method}, which is not supported`);
    if (out.length !== e.size) throw new ZipError(`corrupt zip: ${name} has the wrong size`);
    if (crc32(out) >>> 0 !== e.crc >>> 0)
      throw new ZipError(`corrupt zip: ${name} checksum does not match`);
    total += out.length;
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  };

  return {
    names,
    has: (name) => entries.has(name),
    read,
    text(name) {
      const b = read(name);
      if (!b) return undefined;
      const s = Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("utf8");
      return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
    },
  };
}

/**
 * Peek at the start of a ZIP for sniffing: the first entry's name and as much of its content
 * as the head holds ([Content_Types].xml comes first in Office and Visio files). Never throws.
 */
export function peekZip(head: Uint8Array): { name: string; content: string } | undefined {
  try {
    const b = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
    if (b.length < 30 || b.readUInt32LE(0) !== LOCAL) return undefined;
    const method = b.readUInt16LE(8);
    const nameLen = b.readUInt16LE(26);
    const extraLen = b.readUInt16LE(28);
    const name = b.toString("utf8", 30, Math.min(b.length, 30 + nameLen));
    const data = b.subarray(Math.min(b.length, 30 + nameLen + extraLen));
    let content = "";
    if (method === 0) content = data.toString("utf8");
    else if (method === 8 && data.length) {
      content = inflateRawSync(data, {
        finishFlush: constants.Z_SYNC_FLUSH,
        maxOutputLength: 64 * 1024,
      }).toString("utf8");
    }
    return { name, content };
  } catch {
    return undefined;
  }
}
