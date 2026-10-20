import { gunzipSync } from "node:zlib";
import type { ZipArchive, ZipLimits } from "./zip-read.js";
import { ZIP_LIMITS } from "./zip-read.js";

/**
 * A small reader for gzipped tar archives, for published npm packages (`npm pack` output, a
 * registry .tgz), the way the ZIP reader serves JARs. Same defences: the uncompressed size is
 * capped before anything is parsed (gunzip stops at the cap), entry counts and sizes are capped,
 * names that climb out of the archive are refused, and nothing is extracted to disk. npm's
 * `package/` folder is dropped from names. Regular files only; long names come from pax (`x`)
 * and GNU (`L`) headers.
 */
export class TarError extends Error {
  override name = "TarError";
}

const safe = (n: string) =>
  !n.startsWith("/") &&
  !/^[a-zA-Z]:/.test(n) &&
  !n.includes("\0") &&
  !n.split("/").some((s) => s === "..");

const text = (b: Buffer, from: number, len: number) => {
  const s = b.subarray(from, from + len);
  const end = s.indexOf(0);
  return s.subarray(0, end < 0 ? s.length : end).toString("utf8");
};

export function readTarGz(bytes: Uint8Array, limits: Partial<ZipLimits> = {}): ZipArchive {
  const lim = { ...ZIP_LIMITS, ...limits };
  let tar: Buffer;
  try {
    tar = gunzipSync(bytes, { maxOutputLength: lim.maxTotalBytes });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new TarError(
      code === "ERR_BUFFER_TOO_LARGE"
        ? `the archive is larger than ${lim.maxTotalBytes} bytes uncompressed`
        : "not a gzipped tar archive",
    );
  }
  const files = new Map<string, Buffer>();
  let next: string | undefined;
  for (let at = 0; at + 512 <= tar.length;) {
    const h = tar.subarray(at, at + 512);
    if (h.every((b) => b === 0)) break;
    const size = parseInt(text(h, 124, 12).trim() || "0", 8);
    if (!Number.isFinite(size) || size < 0 || at + 512 + size > tar.length)
      throw new TarError("a tar entry runs past the end of the archive");
    if (size > lim.maxEntryBytes)
      throw new TarError(`an entry is larger than ${lim.maxEntryBytes} bytes`);
    const type = String.fromCharCode(h[156]!);
    const data = tar.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      next = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString("utf8"))?.[1] ?? next;
      continue;
    }
    if (type === "L") {
      next = text(data, 0, data.length);
      continue;
    }
    const prefix = text(h, 345, 155);
    const raw = next ?? (prefix ? `${prefix}/${text(h, 0, 100)}` : text(h, 0, 100));
    next = undefined;
    if (type !== "0" && type !== "\0") continue;
    const name = raw
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .replace(/^package\//, "");
    if (!safe(name)) throw new TarError(`the archive has an unsafe name: ${raw}`);
    if (files.size >= lim.maxEntries)
      throw new TarError(`the archive has more than ${lim.maxEntries} entries`);
    files.set(name, Buffer.from(data));
  }
  return {
    names: [...files.keys()],
    has: (n) => files.has(n),
    read: (n) => files.get(n),
    text: (n) =>
      files
        .get(n)
        ?.toString("utf8")
        .replace(/^\uFEFF/, ""),
  };
}
