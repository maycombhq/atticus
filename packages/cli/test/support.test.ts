import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { acquireLock, logFileOf } from "@maycombhq/core";
import { main } from "../src/main.js";
import { supportBundleCommand } from "../src/support.js";
import type { DoctorDeps } from "../src/doctor.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
let root: string;

const deps: DoctorDeps = {
  env: { PATH: "", HTTPS_PROXY: "http://pat:s3cret@proxy.example.com:8080" },
  openspecVersion: async () => "1.14.0",
  portFree: async () => true,
  freeBytes: async () => 10 * 1024 ** 3,
};

/** The files of a zip, by reading its central directory. */
function unzip(buf: Buffer): Record<string, string> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const lname = buf.readUInt16LE(local + 26);
    const data = buf.subarray(local + 30 + lname, local + 30 + lname + size);
    out[name] = inflateRawSync(data).toString("utf8");
    p += 46 + nameLen;
  }
  return out;
}

const run = async (...args: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main([...args, "--root", root], {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-support-"));
  await cp(join(FIXTURES, "forge/metarepo"), root, { recursive: true });
});

describe("the local log of commands", () => {
  it("records each command with its flag names, never their values", async () => {
    await run("change", "list", "--json", "--by", "secret-person");
    const lines = (await readFile(logFileOf(root), "utf8")).trim().split("\n");
    const last = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
    expect(last).toMatchObject({
      event: "command",
      command: "change list",
      flags: ["json", "by", "root"],
    });
    expect(lines.join("\n")).not.toMatch(/secret-person/);
  });
});

describe("one scan at a time", () => {
  it("refuses a scan while another holds the lock", async () => {
    const held = await acquireLock(root, "scan", "scan");
    try {
      const r = await run("scan");
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/Another scan is running/);
    } finally {
      await held.release();
    }
  });
});

describe("atticus support bundle", () => {
  it("writes a zip of versions, checks, counts and the redacted log, with no secret or path", async () => {
    await writeFile(
      logFileOf(root),
      `${await readFile(logFileOf(root), "utf8")}{"event":"note","msg":"token=abc123 at ${root}/catalog"}\n`,
    );
    const out: string[] = [];
    const file = join(root, "bundle.zip");
    const code = await supportBundleCommand(
      root,
      { out: file, now: new Date("2026-10-19T09:00:00Z") },
      { out: (l) => out.push(l), err: () => undefined },
      deps,
    );
    expect(code).toBe(0);
    const files = unzip(await readFile(file));
    expect(Object.keys(files)).toEqual([
      "README.txt",
      "about.json",
      "doctor.json",
      "setup.json",
      "org-pack.json",
      "counts.json",
      "atticus.log",
    ]);
    const all = Object.values(files).join("\n");
    expect(all).not.toMatch(/s3cret|abc123/);
    expect(all).not.toContain(root);
    expect(files["atticus.log"]).toMatch(/<metarepo>\/catalog/);
    expect(JSON.parse(files["about.json"]!)).toMatchObject({ layout: "metarepo", ai: "on" });
    // Counts, never names.
    expect(files["counts.json"]).not.toMatch(/ledger|forge-/);
    expect(out[0]).toMatch(/nothing sent anywhere/);
  });
});
