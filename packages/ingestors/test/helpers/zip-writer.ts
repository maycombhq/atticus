import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

/**
 * A tiny ZIP writer for tests only: it lets the Office and Visio fixtures live in the repo as
 * small readable XML files and be packed into real archives in the test setup. It can also
 * write deliberately broken archives (lying sizes, odd names, flags) for the negative cases.
 */
export interface ZipInput {
  name: string;
  data: Uint8Array | string;
  method?: "store" | "deflate";
  /** Write this uncompressed size instead of the real one (to test a lying header). */
  declaredSize?: number;
  /** General-purpose flags; bit 0 marks the entry encrypted. */
  flags?: number;
  /** Write this compression method number instead of the real one. */
  methodNumber?: number;
  /** Write this CRC instead of the real one. */
  crc?: number;
}

export function writeZip(entries: ZipInput[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = typeof e.data === "string" ? Buffer.from(e.data, "utf8") : Buffer.from(e.data);
    const deflate = (e.method ?? "deflate") === "deflate";
    const body = deflate ? deflateRawSync(raw) : raw;
    const name = Buffer.from(e.name, "utf8");
    const crc = e.crc ?? crc32(raw);
    const method = e.methodNumber ?? (deflate ? 8 : 0);
    const size = e.declaredSize ?? raw.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(e.flags ?? 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}

/** Pack a fixture folder into a ZIP, entries in sorted path order with "/" separators. */
export function zipFolder(dir: string): Uint8Array {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(dir);
  return writeZip(
    files.map((p) => ({ name: relative(dir, p).split(sep).join("/"), data: readFileSync(p) })),
  );
}
