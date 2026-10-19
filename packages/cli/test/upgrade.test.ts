import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { doctorChecks } from "../src/doctor.js";
import { upgradeCheck, upgradeCommand } from "../src/upgrade.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

/** A metarepo as an earlier Atticus left it: a version-1 record, no local ignore, no stamp. */
async function oldMetarepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-upgrade-"));
  await cp(join(FIXTURES, "forge/metarepo"), root, { recursive: true });
  const f = join(root, "catalog/generated/system/ledger.yaml");
  await mkdir(dirname(f), { recursive: true });
  await writeFile(
    f,
    [
      "schemaVersion: 1",
      "kind: System",
      "id: ledger",
      "status: current",
      "confidence: asserted",
      "name: Ledger",
      "boundary: internal",
      "evidence:",
      "  - source: manual",
      "    by: ari",
      "",
    ].join("\n"),
  );
  await writeFile(join(root, ".gitignore"), "/workspace/\n");
  return root;
}

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};

describe("atticus upgrade", () => {
  it("lists what an older metarepo needs, and --check exits 1 until it is done", async () => {
    const root = await oldMetarepo();
    const c = await upgradeCheck(root, "1.0.0");
    expect(c.newer).toBe(false);
    expect(c.pending.map((p) => [p.id, p.files])).toEqual([
      ["catalog-schema-v2", ["catalog/generated/system/ledger.yaml"]],
      ["local-files-ignored", [".atticus/.gitignore"]],
      ["state-folders-ignored", [".gitignore"]],
    ]);
    const r = io();
    expect(await upgradeCommand(root, { check: true }, r.io, "1.0.0")).toBe(1);
    expect(r.out[0]).toMatch(/3 upgrade steps to run/);
    // A dry run changes nothing.
    const before = await readFile(join(root, "catalog/generated/system/ledger.yaml"), "utf8");
    expect(await upgradeCommand(root, { dryRun: true }, io().io, "1.0.0")).toBe(0);
    expect(await readFile(join(root, "catalog/generated/system/ledger.yaml"), "utf8")).toBe(before);
  });

  it("backs up what it changes, upgrades, records the version, and is then up to date", async () => {
    const root = await oldMetarepo();
    const r = io();
    const code = await upgradeCommand(
      root,
      { by: "pat", now: new Date("2026-10-19T10:00:00Z") },
      r.io,
      "1.0.0",
    );
    expect(code).toBe(0);
    expect(r.out.join("\n")).toMatch(/Commit the changes in a pull request/);
    expect(await readFile(join(root, "catalog/generated/system/ledger.yaml"), "utf8")).toMatch(
      /^schemaVersion: 2/m,
    );
    const backup = join(root, ".atticus/backups/20261019-100000");
    expect(await readFile(join(backup, "catalog/generated/system/ledger.yaml"), "utf8")).toMatch(
      /^schemaVersion: 1/m,
    );
    expect(await readFile(join(root, ".gitignore"), "utf8")).toMatch(/\/\.index\//);
    expect(await readFile(join(root, ".atticus/.gitignore"), "utf8")).toMatch(/^backups\/$/m);
    const stamp = parse(await readFile(join(root, ".atticus/metarepo.yaml"), "utf8"));
    expect(stamp).toMatchObject({
      atticus: "1.0.0",
      upgradedBy: "pat",
      upgradedAt: "2026-10-19T10:00:00Z",
    });
    expect(stamp.migrations).toEqual([
      "catalog-schema-v2",
      "local-files-ignored",
      "state-folders-ignored",
    ]);
    expect((await upgradeCheck(root, "1.0.0")).pending).toEqual([]);
    expect(await upgradeCommand(root, { check: true }, io().io, "1.0.0")).toBe(0);
    expect(await readdir(join(root, ".atticus/backups"))).toEqual(["20261019-100000"]);
  });

  it("refuses when a newer Atticus upgraded the metarepo, and doctor says so", async () => {
    const root = await oldMetarepo();
    await upgradeCommand(root, { by: "pat" }, io().io, "2.1.0");
    const r = io();
    expect(await upgradeCommand(root, {}, r.io, "1.0.0")).toBe(1);
    expect(r.err[0]).toMatch(
      /upgraded by Atticus 2\.1\.0; this is 1\.0\.0\. Install 2\.1\.0 or later/,
    );
    const doctor = await doctorChecks(root, {
      openspecVersion: async () => "1.14.0",
      portFree: async () => true,
    });
    // The installed CLI reports its own version (1.0.0-rc.1 here), older than 2.1.0.
    expect(doctor.find((c) => c.id === "upgrade")).toMatchObject({ status: "fail" });
  });
});
