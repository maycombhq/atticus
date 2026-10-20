import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readTarGz, TarError } from "../src/index.js";

/** A ustar entry: header and padded data. Type "x" is a pax header. */
function entry(name: string, data: string | Buffer, type = "0"): Buffer {
  const body = typeof data === "string" ? Buffer.from(data) : data;
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, 100, "utf8");
  h.write("0000644\0", 100);
  h.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
  h.write("        ", 148);
  h.write(type, 156);
  h.write("ustar\0", 257);
  h.write("00", 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return Buffer.concat([h, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}
const tgz = (...entries: Buffer[]) => gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
const pax = (key: string, value: string) => {
  const rec = (len: number) => `${len} ${key}=${value}\n`;
  let len = rec(0).length;
  while (rec(len).length !== len) len = rec(len).length;
  return rec(len);
};

describe("readTarGz: published npm packages, read defensively", () => {
  it("reads files, drops npm's package/ folder, and takes long names from pax headers", () => {
    const long = `dist/${"deep/".repeat(30)}index.d.ts`;
    const a = readTarGz(
      tgz(
        entry("package/package.json", '{"name":"@tide/lantern"}'),
        entry("package/dist", "", "5"),
        entry("PaxHeader", pax("path", `package/${long}`), "x"),
        entry("package/ignored-short-name", "export {};"),
      ),
    );
    expect(a.names).toEqual(["package.json", long]);
    expect(a.text("package.json")).toBe('{"name":"@tide/lantern"}');
    expect(a.has(long)).toBe(true);
  });

  it("refuses names that climb out, input that isn't gzip, and stops a bomb at the cap", () => {
    expect(() => readTarGz(tgz(entry("package/../../etc/x", "x")))).toThrow(TarError);
    expect(() => readTarGz(Buffer.from("not gzip"))).toThrow(TarError);
    const big = tgz(entry("package/a", Buffer.alloc(200_000)));
    expect(() => readTarGz(big, { maxTotalBytes: 100_000 })).toThrow(/larger than/);
  });
});
