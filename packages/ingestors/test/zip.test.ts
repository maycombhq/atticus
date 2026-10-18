import { describe, expect, it } from "vitest";
import { readZip, ZipError } from "../src/zip.js";
import { writeZip } from "./helpers/zip-writer.js";

describe("the ZIP reader", () => {
  it("reads stored and deflated entries by name", () => {
    const zip = readZip(
      writeZip([
        { name: "a.txt", data: "stored text", method: "store" },
        { name: "dir/b.xml", data: "<x>deflated</x>".repeat(20), method: "deflate" },
      ]),
    );
    expect(zip.names).toEqual(["a.txt", "dir/b.xml"]);
    expect(zip.has("dir/b.xml")).toBe(true);
    expect(zip.has("missing")).toBe(false);
    expect(zip.text("a.txt")).toBe("stored text");
    expect(zip.text("dir/b.xml")).toBe("<x>deflated</x>".repeat(20));
    expect(zip.text("missing")).toBeUndefined();
  });

  it("rejects bytes that are not a ZIP archive", () => {
    expect(() => readZip(new TextEncoder().encode("just some text"))).toThrow(ZipError);
    expect(() => readZip(new Uint8Array(0))).toThrow(/not a zip archive/i);
  });

  it("rejects a truncated archive", () => {
    // Pseudo-random bytes barely compress, so the entry data is long enough to damage.
    let seed = 7;
    const noise = Uint8Array.from(
      { length: 2000 },
      () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24,
    );
    const good = writeZip([{ name: "a.txt", data: noise }]);
    const cut = good.slice(0, 20);
    expect(() => readZip(cut)).toThrow(ZipError);
    // Central directory intact but the entry data overwritten with garbage.
    const broken = new Uint8Array(good);
    for (let i = 30 + 5; i < 60; i++) broken[i] = 0xff;
    const zip = readZip(broken);
    expect(() => zip.read("a.txt")).toThrow(ZipError);
  });

  it("guards against zip bombs: entry size, total size, lying headers and entry count", () => {
    const zeros = new Uint8Array(4 * 1024 * 1024);
    const bomb = writeZip([{ name: "big.xml", data: zeros }]);
    expect(bomb.length).toBeLessThan(20_000);
    expect(() => readZip(bomb, { maxEntryBytes: 1024 * 1024 }).read("big.xml")).toThrow(
      /too large/i,
    );
    // The header claims 100 bytes but the data inflates to far more.
    const liar = writeZip([{ name: "x.xml", data: zeros, declaredSize: 100 }]);
    expect(() => readZip(liar).read("x.xml")).toThrow(ZipError);
    // Several entries that are each fine but too much together.
    const many = writeZip(
      [1, 2, 3].map((n) => ({ name: `p${n}.xml`, data: new Uint8Array(600 * 1024) })),
    );
    const zip = readZip(many, { maxTotalBytes: 1024 * 1024 });
    zip.read("p1.xml");
    expect(() => zip.read("p2.xml")).toThrow(/too large/i);
    expect(() =>
      readZip(writeZip([1, 2, 3].map((n) => ({ name: `f${n}`, data: "x" }))), { maxEntries: 2 }),
    ).toThrow(/too many/i);
  });

  it("rejects entry names that climb out of the archive", () => {
    for (const name of [
      "../evil.xml",
      "a/../../evil.xml",
      "/etc/passwd",
      "C:\\evil.xml",
      "a\\..\\..\\b",
    ])
      expect(() => readZip(writeZip([{ name, data: "x" }])), name).toThrow(/unsafe path/i);
  });

  it("rejects encrypted entries, unknown methods and bad checksums when read", () => {
    expect(() => readZip(writeZip([{ name: "a", data: "x", flags: 1 }])).read("a")).toThrow(
      /encrypted/i,
    );
    expect(() =>
      readZip(writeZip([{ name: "a", data: "x", method: "store", methodNumber: 14 }])).read("a"),
    ).toThrow(/compression method/i);
    expect(() => readZip(writeZip([{ name: "a", data: "hello", crc: 1234 }])).read("a")).toThrow(
      /checksum/i,
    );
  });
});
