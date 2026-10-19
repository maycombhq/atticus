import { crc32, deflateRawSync } from "node:zlib";

/**
 * A plain zip writer (deflate, UTF-8 names, Unix modes): for the support bundle and the offline
 * install bundle. Every unzip tool reads it, Windows Explorer and Expand-Archive included.
 * Not zip64: under 65,535 entries and 4 GB, which both bundles are far from.
 */

export interface ZipEntry {
  /** Forward slashes; a trailing slash makes a folder entry. */
  name: string;
  data: string | Uint8Array;
  /** Unix mode bits, e.g. 0o755 for a script; default 0o644. */
  mode?: number;
}

export function zip(entries: ZipEntry[], at = new Date()): Buffer {
  if (entries.length > 0xffff)
    throw new Error(`Too many files for a plain zip (${entries.length}).`);
  const dosTime = (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1);
  const dosDate = ((at.getFullYear() - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const data = typeof e.data === "string" ? Buffer.from(e.data, "utf8") : Buffer.from(e.data);
    const dir = e.name.endsWith("/");
    const packed = dir ? Buffer.alloc(0) : deflateRawSync(data);
    const crc = dir ? 0 : crc32(data);
    const method = dir ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(dir ? 0 : data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix, so the modes below are read
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(dir ? 0 : data.length, 24);
    central.writeUInt16LE(name.length, 28);
    const mode = (dir ? 0o040755 : 0o100000 | (e.mode ?? 0o644)) >>> 0;
    central.writeUInt32LE(((mode << 16) | (dir ? 0x10 : 0)) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
