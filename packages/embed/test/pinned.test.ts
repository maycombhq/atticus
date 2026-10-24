import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  checkMaterialized,
  checkPinned,
  fetchSource,
  materialize,
  sha256Of,
  type Pins,
} from "../src/index.js";

// ADR 0116 addendum: the model's and the runtime's files, each from a pinned source and checked
// against a committed sha256, through a cache so a second run downloads nothing. Invented local
// bytes and a getter that counts its calls stand in for the network: no test downloads.

const bytes = (s: string) => new TextEncoder().encode(s);

/** A tiny npm-style .tgz (package/<name> entries), written here so no tarball is committed. */
function tgz(files: Record<string, string>): Uint8Array {
  const blocks: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, "utf8");
    const h = Buffer.alloc(512);
    h.write(`package/${name}`, 0, "utf8");
    h.write("0000644\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    h.write("00000000000\0", 136);
    h.write("        ", 148);
    h.write("0", 156);
    h.write("ustar\0", 257);
    h.write("00", 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

describe("pinned files", () => {
  it("refuses bytes that aren't the pinned ones", () => {
    const b = bytes("model weights");
    expect(() => checkPinned(b, sha256Of(b), "model.onnx")).not.toThrow();
    expect(() => checkPinned(b, "0".repeat(64), "model.onnx")).toThrow(
      /model.onnx has sha256 [0-9a-f]{64}, not the pinned 0{64}: refused/,
    );
  });

  it("downloads a source once, checks it, and reads it from the cache after", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "atticus-pinned-cache-"));
    const b = bytes("tokenizer json");
    const calls: string[] = [];
    const get = async (url: string) => (calls.push(url), b);
    const src = { url: "https://example.invalid/tokenizer.json", sha256: sha256Of(b) };
    expect((await fetchSource(src, { cacheDir, get })).cached).toBe(false);
    expect((await fetchSource(src, { cacheDir, get })).cached).toBe(true);
    expect(calls).toEqual(["https://example.invalid/tokenizer.json"]);
    // A cache entry that no longer matches is fetched again; offline, it is an error instead.
    await writeFile(join(cacheDir, src.sha256), "tampered");
    await expect(fetchSource(src, { cacheDir, get, offline: true })).rejects.toThrow(
      /isn't in the cache and this run may not download/,
    );
    expect((await fetchSource(src, { cacheDir, get })).cached).toBe(false);
    // A download that isn't the pinned bytes is refused and not cached.
    const bad = { url: "https://example.invalid/other", sha256: "1".repeat(64) };
    await expect(fetchSource(bad, { cacheDir, get })).rejects.toThrow(/refused/);
    await expect(readFile(join(cacheDir, bad.sha256))).rejects.toThrow();
  });

  it("writes a package's files from whole sources and from tarball entries, each checked", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "atticus-pinned-cache-"));
    const dir = await mkdtemp(join(tmpdir(), "atticus-pinned-pkg-"));
    const licence = bytes("MIT License, invented for the test");
    const archive = tgz({
      "dist/index.js": "module.exports = 1;\n",
      "bin/napi-v6/x/y/binding.node": "native bytes",
    });
    const pins: Pins = {
      sources: {
        tgz: { url: "https://example.invalid/pkg.tgz", sha256: sha256Of(archive) },
        licence: { url: "https://example.invalid/LICENSE", sha256: sha256Of(licence) },
      },
      files: [
        {
          path: "dist/index.js",
          source: "tgz",
          entry: "dist/index.js",
          sha256: sha256Of(bytes("module.exports = 1;\n")),
        },
        {
          path: "bin/napi-v6/x/y/binding.node",
          source: "tgz",
          entry: "bin/napi-v6/x/y/binding.node",
          sha256: sha256Of(bytes("native bytes")),
        },
        { path: "LICENSE", source: "licence", sha256: sha256Of(licence) },
      ],
    };
    const get = async (url: string) => (url.endsWith(".tgz") ? archive : licence);
    expect(await checkMaterialized(dir, pins)).toEqual([
      "dist/index.js",
      "bin/napi-v6/x/y/binding.node",
      "LICENSE",
    ]);
    const r = await materialize(dir, pins, { cacheDir, get });
    expect(r.written).toHaveLength(3);
    expect(r.downloaded).toHaveLength(2);
    expect(await checkMaterialized(dir, pins)).toEqual([]);
    expect(await readFile(join(dir, "bin/napi-v6/x/y/binding.node"), "utf8")).toBe("native bytes");
    // Again: everything from the cache, nothing downloaded.
    const again = await materialize(dir, pins, { cacheDir, offline: true });
    expect(again.downloaded).toEqual([]);
    // An entry whose bytes differ from its pin is refused.
    const wrong: Pins = { ...pins, files: [{ ...pins.files[0]!, sha256: "2".repeat(64) }] };
    await expect(materialize(dir, wrong, { cacheDir, offline: true })).rejects.toThrow(
      /dist\/index.js has sha256/,
    );
    await expect(
      materialize(
        dir,
        { ...pins, files: [{ path: "../x", source: "licence", sha256: pins.files[2]!.sha256 }] },
        { cacheDir, offline: true },
      ),
    ).rejects.toThrow(/leaves the package/);
  });
});
