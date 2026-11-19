import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Api } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import type { DoctorDeps } from "../src/doctor.js";
import { bundleFiles } from "../src/support.js";
import { uiSupportRoutes } from "../src/ui-api-support.js";

/**
 * ADR 0202 point 1: POST /api/support/bundle runs what `atticus support bundle` runs and writes
 * the same zip in the same place. Nothing is sent anywhere: the route has no parameter that
 * names a destination, and no call leaves this process (the only fetches are this test's own, to
 * the local server). The Forge metarepo; no network.
 */

const FORGE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/forge/metarepo");
const deps: DoctorDeps = {
  env: { PATH: "" },
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
    out[name] = inflateRawSync(
      buf.subarray(local + 30 + lname, local + 30 + lname + size),
    ).toString("utf8");
    p += 46 + nameLen;
  }
  return out;
}

let root: string;
let srv: RunningServer;
const post = (path: string, body?: unknown) =>
  fetch(srv.url + path, {
    method: "POST",
    headers: { "X-Atticus-Token": srv.token, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-ui-support-"));
  await cp(FORGE, root, { recursive: true });
  srv = await startServer({
    root,
    port: 0,
    user: "pat",
    watch: false,
    extend: (r, ctx) => uiSupportRoutes(r, ctx, { doctor: deps, now: "2026-11-18T10:00:00Z" }),
  });
});
afterAll(async () => {
  await srv.close();
});

describe("POST /api/support/bundle (ADR 0202 point 1)", () => {
  it("writes the zip `atticus support bundle` writes, under .atticus/logs/, and gives it back", async () => {
    const real = globalThis.fetch;
    const outside: string[] = [];
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith(srv.url)) outside.push(url);
      return real(input, init);
    });
    let view: Api.SupportBundleViewT;
    try {
      const r = await post("/api/support/bundle");
      expect(r.status).toBe(200);
      view = Api.SupportBundleView.parse(await r.json());
    } finally {
      spy.mockRestore();
    }
    // Nothing was fetched but this test's own call to the local server.
    expect(outside).toEqual([]);
    expect(view.file).toBe(".atticus/logs/atticus-support-20261118-100000.zip");
    expect(view.name).toBe("atticus-support-20261118-100000.zip");
    expect(existsSync(join(root, view.file))).toBe(true);
    const onDisk = await readFile(join(root, view.file));
    expect(view.bytes).toBe(onDisk.length);
    // The copy for the person to save is the file itself.
    expect(Buffer.from(view.zip!, "base64").equals(onDisk)).toBe(true);
    const want = await bundleFiles(root, deps);
    expect(view.files).toEqual(want.map((f) => f.name));
    const got = unzip(onDisk);
    expect(Object.keys(got)).toEqual(want.map((f) => f.name));
    expect(got["README.txt"]).toBe(want.find((f) => f.name === "README.txt")!.text);
    expect(got["counts.json"]).toBe(want.find((f) => f.name === "counts.json")!.text);
    expect(got["README.txt"]).toContain("Nothing was sent anywhere");
  }, 120_000);

  it("takes nothing that names a destination: a body with one is 400 and nothing is written", async () => {
    const before = existsSync(join(root, "elsewhere.zip"));
    const r = await post("/api/support/bundle", { out: join(root, "elsewhere.zip") });
    expect(r.status).toBe(400);
    expect(existsSync(join(root, "elsewhere.zip"))).toBe(before);
    const to = await post("/api/support/bundle", { to: "https://support.example.com" });
    expect(to.status).toBe(400);
  });
});
