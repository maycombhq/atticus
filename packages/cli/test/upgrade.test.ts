import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { CHECKLISTS_README, STARTER_CHECKLISTS_README } from "@maycombhq/adopt";
import { starterReviewText } from "@maycombhq/naysayer";
import { GENERATED_MARK } from "@maycombhq/changes";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { doctorChecks } from "../src/doctor.js";
import { main } from "../src/main.js";
import {
  proposePlan,
  recordUpgraded,
  relativeInside,
  scopeDirs,
  upgradedPaths,
} from "../src/propose.js";
import { contentOf, upgradeCheck, upgradeCommand } from "../src/upgrade.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], {
    cwd,
    encoding: "utf8",
  });

/** Every path Git sees changed, added or removed, "/"-separated (renames as two paths). */
const changedPaths = (root: string) =>
  git(root, "-c", "core.quotePath=false", "status", "--porcelain=v1", "-z", "--untracked-files=all")
    .split("\0")
    .filter((e) => e.length > 3)
    .map((e) => e.slice(3))
    .sort();

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
  // A flow at schema version 1 (ADR 0095).
  await mkdir(join(root, "specs/forge-web"), { recursive: true });
  await cp(
    join(FIXTURES, "estate/specs/forge-web/forge-web.save-customer.yaml"),
    join(root, "specs/forge-web/forge-web.save-customer.yaml"),
  );
  // A question at schema version 1 (ADR 0117).
  await mkdir(join(root, "questions"), { recursive: true });
  await cp(
    join(FIXTURES, "context/questions/q-0f1e2d3c4b5a.yaml"),
    join(root, "questions/q-0f1e2d3c4b5a.yaml"),
  );
  return root;
}

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};

describe("atticus upgrade: OpenSpec's org-flow schema (ADR 0006 addendum)", () => {
  it("moves an org-flow version 1 schema to version 2, Atticus 1's templates removed", async () => {
    const root = await oldMetarepo();
    const dir = join(root, "openspec/schemas/org-flow");
    await mkdir(join(dir, "templates"), { recursive: true });
    await writeFile(join(root, "openspec/config.yaml"), "schema: org-flow\n");
    await writeFile(join(dir, "schema.yaml"), "name: org-flow\nversion: 1\nartifacts: []\n");
    await writeFile(join(dir, "templates/snow.md"), "# snow\n");
    const c = await upgradeCheck(root, "1.0.0");
    expect(c.pending.find((p) => p.id === "org-flow-v2")?.files).toEqual([
      "openspec/schemas/org-flow/schema.yaml",
    ]);
    expect(await upgradeCommand(root, {}, io().io, "1.0.0")).toBe(0);
    const schema = parse(await readFile(join(dir, "schema.yaml"), "utf8")) as {
      version: number;
      artifacts: { id: string }[];
    };
    expect(schema.version).toBe(2);
    expect(schema.artifacts.map((a) => a.id)).toEqual([
      "proposal",
      "design",
      "stories",
      "specs",
      "tasks",
    ]);
    expect(await readdir(join(dir, "templates"))).not.toContain("snow.md");
    expect((await upgradeCheck(root, "1.0.0")).pending.map((p) => p.id)).not.toContain(
      "org-flow-v2",
    );
  });
});

describe("atticus upgrade", () => {
  it("lets the stamp it asks a person to commit be committed: init's whole-folder ignore becomes all but it (B-place)", async () => {
    const root = await oldMetarepo();
    await writeFile(join(root, ".gitignore"), "/workspace/\n/.index/\n/.runs/\n/.atticus/\n");
    const c = await upgradeCheck(root, "1.0.0");
    expect(c.pending.find((p) => p.id === "stamp-committed")?.files).toEqual([".gitignore"]);
    expect(await upgradeCommand(root, {}, io().io, "1.0.0")).toBe(0);
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(
      "/workspace/\n/.index/\n/.runs/\n/.atticus/*\n!/.atticus/metarepo.yaml\n",
    );
    expect((await upgradeCheck(root, "1.0.0")).pending).toEqual([]);
  });

  it("lists what an older metarepo needs, and --check exits 1 until it is done", async () => {
    const root = await oldMetarepo();
    const c = await upgradeCheck(root, "1.0.0");
    expect(c.newer).toBe(false);
    expect(c.pending.map((p) => [p.id, p.files])).toEqual([
      ["catalog-schema-v2", ["catalog/generated/system/ledger.yaml"]],
      ["local-files-ignored", [".atticus/.gitignore"]],
      ["state-folders-ignored", [".gitignore"]],
      // ADR 0087: the Forge pack's gates.yaml is at version 1.
      ["gates-v2", ["org-pack/gates.yaml"]],
      ["flow-schema-v2", ["specs/forge-web/forge-web.save-customer.yaml"]],
      ["questions-v3", ["questions/q-0f1e2d3c4b5a.yaml"]],
      // The Forge pack's sources.yaml is at version 1.
      ["sources-v2", ["org-pack/sources.yaml"]],
      // ADR 0132: and on to version 3, in the same run.
      ["sources-v3", ["org-pack/sources.yaml"]],
      // ADR 0121 addendum: and its runtime.yaml.
      ["runtime-v2", ["org-pack/runtime.yaml"]],
      // ADR 0140: roles.yaml's number, so it can name the teams that own repos.
      ["roles-v2", ["org-pack/roles.yaml"]],
      // ADR 0128: the manifest's number, so a repo can say what it is.
      ["manifest-schema-v2", ["org-pack/profiles/forge/repos.manifest.yaml"]],
      // ADR 0134: and on to version 3, in the same run, so a repo can give its base path.
      ["manifest-schema-v3", ["org-pack/profiles/forge/repos.manifest.yaml"]],
    ]);
    // The questions step writes version 6 now (ADR 0191: what a question asks, its re-routing), and says so.
    expect(c.pending.find((p) => p.id === "questions-v3")?.summary).toMatch(
      /^Questions at schema version 6: .*reopened.*\(ADR 0162\).*role.*\(ADR 0181\).*re-routing.*\(ADR 0191\)$/,
    );
    const r = io();
    expect(await upgradeCommand(root, { check: true }, r.io, "1.0.0")).toBe(1);
    // ADR 0195 (CS2): and the step that adopts its catalog into source slots, shown first.
    expect(r.out[0]).toMatch(/13 upgrade steps to run/);
    expect(r.out.join("\n")).toMatch(/Adopt the catalog into source slots \(ADR 0195\)/);
    // A dry run changes nothing.
    const before = await readFile(join(root, "catalog/generated/system/ledger.yaml"), "utf8");
    expect(await upgradeCommand(root, { dryRun: true }, io().io, "1.0.0")).toBe(0);
    expect(await readFile(join(root, "catalog/generated/system/ledger.yaml"), "utf8")).toBe(before);
  });

  it("backs up a change's whole folder before writing its stories again, and stops on a rewrite that fails", async () => {
    const root = await oldMetarepo();
    const ch = join(root, "openspec/changes/add-limit");
    await mkdir(join(ch, "stage"), { recursive: true });
    await mkdir(join(ch, "stories"), { recursive: true });
    // A kept answer that doesn't read, a long story, and a person's edit of tasks.md.
    await writeFile(join(ch, "stage/stories-answer.yaml"), "not: [a, stories, answer\n");
    await writeFile(
      join(ch, "stories/s1.md"),
      "# S1\n\nPrompt for Copilot or Claude Code:\n\nDo it.\n",
    );
    await writeFile(join(ch, "tasks.md"), "- [ ] 1.1 my own wording\n");
    const r = io();
    await expect(
      upgradeCommand(root, { by: "pat", now: new Date("2026-10-19T10:00:00Z") }, r.io, "1.0.0"),
    ).rejects.toThrow(
      /The stories of add-limit couldn.t be written again .* The files as they were before this upgrade are in .atticus\/backups\/20261019-100000/,
    );
    const backup = join(root, ".atticus/backups/20261019-100000/openspec/changes/add-limit");
    expect(await readFile(join(backup, "tasks.md"), "utf8")).toBe("- [ ] 1.1 my own wording\n");
    expect(await readFile(join(backup, "stories/s1.md"), "utf8")).toContain("Prompt for Copilot");
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
    // A version-1 record is written at the current version (5, ADR 0181) by the version-2 step.
    expect(await readFile(join(root, "catalog/generated/system/ledger.yaml"), "utf8")).toMatch(
      /^schemaVersion: 5/m,
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
      "gates-v2",
      "flow-schema-v2",
      "change-types-v2",
      "questions-v3",
      "starter-review",
      "catalog-schema-v3",
      "catalog-schema-v4",
      "sources-v2",
      "sources-v3",
      "stamp-committed",
      "runtime-v2",
      // ADR 0171: nothing here names copilot-acp, so nothing to do, but recorded as done.
      "runtime-v3",
      "roles-v2",
      // ADR 0006 addendum: no OpenSpec here, so nothing to do, but recorded as done.
      "org-flow-v2",
      "stories-b-short",
      "manifest-schema-v2",
      "manifest-schema-v3",
      // ADR 0181: nothing here at catalog 4, naming decide or using corrections v2: recorded as done.
      "catalog-schema-v5",
      "runtime-v4",
      "corrections-v2",
    ]);
    // runtime.yaml at version 2 (ADR 0121 addendum): the number only, every line else as it was,
    // so no step names a model of its own.
    const runtime = await readFile(join(root, "org-pack/runtime.yaml"), "utf8");
    const was = await readFile(join(FIXTURES, "forge/metarepo/org-pack/runtime.yaml"), "utf8");
    expect(runtime).toBe(was.replace(/^schemaVersion: 1$/m, "schemaVersion: 2"));
    expect(parse(runtime).models).toBeUndefined();
    // roles.yaml at version 2 (ADR 0140): the number only, so it names no team yet.
    const roles = await readFile(join(root, "org-pack/roles.yaml"), "utf8");
    const had = await readFile(join(FIXTURES, "forge/metarepo/org-pack/roles.yaml"), "utf8");
    // ADR 0191: roles.yaml goes to version 3, the number only.
    expect(roles).toBe(had.replace(/^schemaVersion: 1$/m, "schemaVersion: 3"));
    // sources.yaml at version 3 (ADR 0132), its wiki as it was: every page still read, ranked as
    // a team's and applying everywhere; only the number changed.
    const sources = await readFile(join(root, "org-pack/sources.yaml"), "utf8");
    const wasSources = await readFile(
      join(FIXTURES, "forge/metarepo/org-pack/sources.yaml"),
      "utf8",
    );
    expect(sources).toBe(wasSources.replace(/^schemaVersion: 1$/m, "schemaVersion: 3"));
    expect(parse(sources).wikis).toEqual([
      {
        id: "forge-wiki",
        type: "markdown-folder",
        location: "../../inputs/wiki",
        owner: "team-platform",
      },
    ]);
    expect(await readFile(join(root, "questions/q-0f1e2d3c4b5a.yaml"), "utf8")).toMatch(
      // ADR 0191: question files at version 6.
      /^schemaVersion: 6$/m,
    );
    expect(
      await readFile(join(root, "specs/forge-web/forge-web.save-customer.yaml"), "utf8"),
    ).toMatch(/^schemaVersion: 2\r?\nkind: Flow/);
    // Each gate keeps the two rounds version 1 gave it; deleting the line makes it unlimited.
    const gates = parse(await readFile(join(root, "org-pack/gates.yaml"), "utf8"));
    expect(gates.schemaVersion).toBe(2);
    expect(gates.gates.map((g: { maxAuthorRounds?: number }) => g.maxAuthorRounds)).toEqual([
      2, 2, 2, 2,
    ]);
    expect((await upgradeCheck(root, "1.0.0")).pending).toEqual([]);
    // ADR 0195 (CS2): the slots step was only shown (it writes with --yes): --check still waits
    // on it. This old metarepo's catalog is a hand-made one, not a scan's (it lacks the profile's
    // other systems a build makes), so --yes refuses and writes nothing, listing the files; the
    // lossless upgrade of a scanned catalog is upgrade-slots-cli.test.ts's.
    expect(r.out.join("\n")).toMatch(/atticus upgrade --yes applies this step/);
    expect(await upgradeCommand(root, { check: true }, io().io, "1.0.0")).toBe(1);
    const y = io();
    expect(
      await upgradeCommand(
        root,
        { by: "pat", yes: true, now: new Date("2026-10-19T10:00:00Z") },
        y.io,
        "1.0.0",
      ),
    ).toBe(1);
    expect(y.err.join("\n")).toMatch(/The first build would change 4 record files/);
    expect(y.err.join("\n")).toMatch(/atticus upgrade --yes --accept-changes 4/);
    expect(existsSync(join(root, "catalog/sources"))).toBe(false);
    expect(await readdir(join(root, ".atticus/backups"))).toEqual(["20261019-100000"]);
    // The changes shown, then accepted with their count (any other count refuses again): the
    // slots, the copy of the catalog as it was, and the first build's catalog are written.
    const before = await readFile(join(root, "catalog/generated/system/ledger.yaml"), "utf8");
    const wrong = io();
    expect(
      await upgradeCommand(root, { by: "pat", yes: true, acceptChanges: 3 }, wrong.io, "1.0.0"),
    ).toBe(1);
    expect(wrong.err.join("\n")).toMatch(/--accept-changes 3 doesn't name the 4 listed/);
    expect(existsSync(join(root, "catalog/sources"))).toBe(false);
    const ok = io();
    expect(
      await upgradeCommand(root, { by: "pat", yes: true, acceptChanges: 4 }, ok.io, "1.0.0"),
    ).toBe(0);
    expect(existsSync(join(root, "catalog/sources/build.json"))).toBe(true);
    expect(
      await readFile(
        join(root, "catalog/sources/legacy/generated-before-upgrade/system/ledger.yaml"),
        "utf8",
      ),
    ).toBe(before);
    // The review: the upgrade leaves its build report, as every writer does (Catalog builds).
    const { readBuildReport } = await import("@maycombhq/scanner");
    const report = await readBuildReport(root);
    expect(report).toMatchObject({
      outcome: "written",
      command: "atticus upgrade --yes --accept-changes 4",
    });
    expect(report!.counts.added + report!.counts.changed + report!.counts.removed).toBe(4);
    expect(report!.slots.length).toBeGreaterThan(0);
    expect(report!.undo).toBeGreaterThan(0);
    const check = io();
    expect(await main(["catalog", "build", "--check", "--root", root], check.io)).toBe(0);
  });

  it("moves a version 1 change-types.yaml to version 2, every type still standard (ADR 0113)", async () => {
    const root = await oldMetarepo();
    await writeFile(
      join(root, "org-pack/change-types.yaml"),
      [
        "# The Forge pack's change types",
        "schemaVersion: 1",
        "types:",
        "  - id: config-change",
        "    name: Configuration change",
        "    phases: [define, plan, build, release]",
        "    artifacts: [proposal, tasks]",
        "",
      ].join("\n"),
    );
    const c = await upgradeCheck(root, "1.0.0");
    expect(c.pending.find((p) => p.id === "change-types-v2")?.files).toEqual([
      "org-pack/change-types.yaml",
    ]);
    expect(await upgradeCommand(root, { by: "pat" }, io().io, "1.0.0")).toBe(0);
    const text = await readFile(join(root, "org-pack/change-types.yaml"), "utf8");
    expect(text).toMatch(/^# The Forge pack's change types/);
    expect(parse(text)).toMatchObject({ schemaVersion: 2, types: [{ id: "config-change" }] });
    expect(parse(text).types[0].size).toBeUndefined();
    expect((await upgradeCheck(root, "1.0.0")).pending).toEqual([]);
  });

  it("moves a runtime.yaml that names copilot-acp to version 3, the number only (ADR 0171)", async () => {
    const root = await oldMetarepo();
    const v2 = [
      "schemaVersion: 2",
      "assistants: { allowed: [copilot], default: copilot }",
      "modes: { allowed: [hand-off, copilot-acp], default: hand-off }",
      "",
    ].join("\n");
    await writeFile(join(root, "org-pack/runtime.yaml"), v2);
    const c = await upgradeCheck(root, "1.0.0");
    expect(c.pending.find((p) => p.id === "runtime-v3")?.files).toEqual(["org-pack/runtime.yaml"]);
    expect(await upgradeCommand(root, { by: "pat" }, io().io, "1.0.0")).toBe(0);
    expect(await readFile(join(root, "org-pack/runtime.yaml"), "utf8")).toBe(
      v2.replace("schemaVersion: 2", "schemaVersion: 3"),
    );
    expect((await upgradeCheck(root, "1.0.0")).pending).toEqual([]);
  });

  it("moves a runtime.yaml that sets decide to version 4, and a corrections line using version 2's fields to 2 (ADR 0181)", async () => {
    const root = await oldMetarepo();
    const v3 = [
      "schemaVersion: 3",
      "assistants: { allowed: [copilot], default: copilot }",
      "decide: { links: auto }",
      "",
    ].join("\n");
    await writeFile(join(root, "org-pack/runtime.yaml"), v3);
    await mkdir(join(root, "facts"), { recursive: true });
    const person =
      '{"schemaVersion":1,"fact":"c1","target":{"kind":"call","file":"A.java","line":3,"value":"/a"},"action":"link","link":{"repo":"forge-ledger","path":"/a"},"by":"pat","at":"2026-11-08T10:00:00.000Z"}';
    const hand = person.replace(
      '"action":"link","link":{"repo":"forge-ledger","path":"/a"}',
      '"action":"unlink"',
    );
    await writeFile(join(root, "facts/forge-web.corrections.jsonl"), `${person}\n${hand}\n`);
    const c = await upgradeCheck(root, "1.0.0");
    expect(c.pending.find((p) => p.id === "runtime-v4")?.files).toEqual(["org-pack/runtime.yaml"]);
    expect(c.pending.find((p) => p.id === "corrections-v2")?.files).toEqual([
      "facts/forge-web.corrections.jsonl",
    ]);
    expect(await upgradeCommand(root, { by: "pat" }, io().io, "1.0.0")).toBe(0);
    expect(await readFile(join(root, "org-pack/runtime.yaml"), "utf8")).toBe(
      v3.replace("schemaVersion: 3", "schemaVersion: 4"),
    );
    // Only the line that uses version 2's fields changes, and only its number.
    expect(await readFile(join(root, "facts/forge-web.corrections.jsonl"), "utf8")).toBe(
      `${person}\n${hand.replace('"schemaVersion":1', '"schemaVersion":2')}\n`,
    );
    expect((await upgradeCheck(root, "1.0.0")).pending).toEqual([]);
  });

  it("moves version-2 catalog records to the current version in their own step, changing only the number (ADR 0125)", async () => {
    const root = await oldMetarepo();
    const v2 = [
      "schemaVersion: 2",
      "kind: Schema",
      "id: ledger-api.post-entries.request",
      "status: current",
      "confidence: verified",
      "evidence:",
      "  - path: src/main/java/forge/ledger/EntryRequest.java",
      "    repo: forge-ledger",
      "    source: code",
      "fields:",
      "  - name: amount",
      "    type: decimal",
      "format: other",
      "ref: ledger-api.post-entries",
      "",
    ].join("\n");
    const f = join(root, "catalog/generated/schema/ledger-api.post-entries.request.yaml");
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, v2);
    const c = await upgradeCheck(root, "1.0.0");
    // each step lists its own files: version 1 under v2, version 2 under v3
    expect(c.pending.find((p) => p.id === "catalog-schema-v2")?.files).toEqual([
      "catalog/generated/system/ledger.yaml",
    ]);
    expect(c.pending.find((p) => p.id === "catalog-schema-v3")).toEqual({
      id: "catalog-schema-v3",
      summary:
        "Catalog records at schema version 3: a Schema field can say whether it is required (ADR 0125)",
      files: ["catalog/generated/schema/ledger-api.post-entries.request.yaml"],
    });
    expect(await upgradeCommand(root, { by: "pat" }, io().io, "1.0.0")).toBe(0);
    expect(await readFile(f, "utf8")).toBe(v2.replace(/^schemaVersion: 2\n/, "schemaVersion: 5\n"));
    expect((await upgradeCheck(root, "1.0.0")).pending).toEqual([]);
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
    // The installed CLI reports its own version (2.0.0-beta.2 here), older than 2.1.0.
    expect(doctor.find((c) => c.id === "upgrade")).toMatchObject({ status: "fail" });
  }, 30_000); // doctor runs every machine check (git, npm, the port): seconds on a busy machine
});

describe("beta against beta (round 38)", () => {
  it("orders pre-releases as semver does", async () => {
    const { newerThan } = await import("../src/upgrade.js");
    expect(newerThan("2.0.0-beta.30", "2.0.0-beta.21")).toBe(true);
    expect(newerThan("2.0.0-beta.21", "2.0.0-beta.9")).toBe(true);
    expect(newerThan("2.0.0-beta.9", "2.0.0-beta.21")).toBe(false);
    expect(newerThan("2.0.0", "2.0.0-beta.30")).toBe(true);
    expect(newerThan("2.0.0-beta.30", "2.0.0")).toBe(false);
    expect(newerThan("2.0.0-rc.1", "2.0.0-beta.30")).toBe(true);
    expect(newerThan("2.0.0-beta.21", "2.0.0-beta.21")).toBe(false);
  });

  it("refuses a metarepo a newer beta upgraded, and keeps its stamp", async () => {
    const root = await oldMetarepo();
    await upgradeCommand(root, { by: "pat" }, io().io, "2.0.0-beta.30");
    const r = io();
    expect(await upgradeCommand(root, {}, r.io, "2.0.0-beta.21")).toBe(1);
    expect(r.err[0]).toMatch(/upgraded by Atticus 2\.0\.0-beta\.30; this is 2\.0\.0-beta\.21/);
    expect(await readFile(join(root, ".atticus", "metarepo.yaml"), "utf8")).toContain(
      "atticus: 2.0.0-beta.30",
    );
  }, 30_000);
});

describe("atticus upgrade and the starter review (ADR 0120)", () => {
  /** An org's own checklist with deterministic rules only: no AI review of its own. */
  const HOUSE = [
    "# The Forge house rules",
    "schemaVersion: 1",
    "name: house",
    "version: 1.0.0",
    "rules:",
    "  - id: house.hop-has-pattern",
    "    title: Every hop names a pattern",
    "    layer: org",
    "    lens: architecture",
    "    appliesTo: { artifacts: [interfaces] }",
    "    severity: risk",
    "    check: { type: deterministic, check: interface-has-pattern }",
    "    waivable: false",
    "    source: Forge architecture review",
    "",
  ].join("\n");

  async function withoutReview(): Promise<string> {
    const root = await oldMetarepo();
    await rm(join(root, "org-pack/checklists"), { recursive: true, force: true });
    await mkdir(join(root, "org-pack/checklists"), { recursive: true });
    await writeFile(join(root, "org-pack/checklists/house.yaml"), HOUSE);
    await writeFile(join(root, "org-pack/checklists/README.md"), CHECKLISTS_README);
    return root;
  }

  it("adds the starter review once, beside the org's own checklist, which it leaves as it was", async () => {
    const root = await withoutReview();
    const c = await upgradeCheck(root, "1.0.0");
    expect(c.pending.find((p) => p.id === "starter-review")?.files).toEqual([
      "org-pack/checklists/README.md",
      "org-pack/checklists/review.yaml",
    ]);
    const r = io();
    expect(
      await upgradeCommand(
        root,
        { by: "pat", now: new Date("2026-10-23T10:00:00Z") },
        r.io,
        "1.0.0",
      ),
    ).toBe(0);
    expect(r.out.join("\n")).toMatch(/Done: The starter review/);
    expect(await readFile(join(root, "org-pack/checklists/review.yaml"), "utf8")).toBe(
      await starterReviewText(),
    );
    expect(await readFile(join(root, "org-pack/checklists/house.yaml"), "utf8")).toBe(HOUSE);
    expect(await readFile(join(root, "org-pack/checklists/README.md"), "utf8")).toBe(
      STARTER_CHECKLISTS_README,
    );
    // Backed up like every migration: the README as it was.
    expect(
      await readFile(
        join(root, ".atticus/backups/20261023-100000/org-pack/checklists/README.md"),
        "utf8",
      ),
    ).toBe(CHECKLISTS_README);
    expect((await upgradeCheck(root, "1.0.0")).pending).toEqual([]);

    // The org turns the starter review off: a later upgrade doesn't add it back.
    await rm(join(root, "org-pack/checklists/review.yaml"));
    expect((await upgradeCheck(root, "1.0.0")).pending).toEqual([]);
    // Nor on another clone, without this machine's stamp: the README says it was there.
    await rm(join(root, ".atticus/metarepo.yaml"));
    expect((await upgradeCheck(root, "1.0.0")).pending.map((p) => p.id)).not.toContain(
      "starter-review",
    );
  });

  it("leaves a pack that already has an AI review, or a review.yaml of its own, alone", async () => {
    // The Forge pack's architecture checklist has AI rules.
    const forge = await oldMetarepo();
    expect((await upgradeCheck(forge, "1.0.0")).pending.map((p) => p.id)).not.toContain(
      "starter-review",
    );
    const own = await withoutReview();
    const theirs = HOUSE.replace("name: house", "name: review");
    await writeFile(join(own, "org-pack/checklists/review.yaml"), theirs);
    expect((await upgradeCheck(own, "1.0.0")).pending.map((p) => p.id)).not.toContain(
      "starter-review",
    );
    await upgradeCommand(own, { by: "pat" }, io().io, "1.0.0");
    expect(await readFile(join(own, "org-pack/checklists/review.yaml"), "utf8")).toBe(theirs);
  });

  it("makes the metarepo an OpenSpec store only with --openspec-store, once (ADR 0126)", async () => {
    const root = await oldMetarepo();
    await mkdir(join(root, "openspec/changes"), { recursive: true });
    await writeFile(join(root, "openspec/config.yaml"), "schema: org-flow\n");
    const marker = join(root, ".openspec-store/store.yaml");
    await upgradeCommand(root, { by: "pat" }, io().io, "1.0.0");
    await expect(readFile(marker, "utf8")).rejects.toThrow();

    const check = io();
    expect(
      await upgradeCommand(root, { check: true, openspecStore: true }, check.io, "1.0.0"),
    ).toBe(1);
    expect(check.out).toContain(
      "  Make this metarepo the OpenSpec store forge (beta): .openspec-store/store.yaml",
    );
    await expect(readFile(marker, "utf8")).rejects.toThrow();

    const run = io();
    expect(await upgradeCommand(root, { by: "pat", openspecStore: true }, run.io, "1.0.0")).toBe(0);
    expect(await readFile(marker, "utf8")).toBe("version: 1\nid: forge\n");
    expect(run.out).toContain(
      "Wrote .openspec-store/store.yaml: this metarepo is the OpenSpec store forge (beta). Commit it; then a developer runs openspec store register <their clone> once to use it from plain OpenSpec.",
    );
    const again = io();
    expect(await upgradeCommand(root, { by: "pat", openspecStore: true }, again.io, "1.0.0")).toBe(
      0,
    );
    expect(again.out).toContain(
      "This metarepo is already the OpenSpec store forge (.openspec-store/store.yaml).",
    );
    expect((await upgradeCheck(root, "1.0.0")).pending).toEqual([]);
  });

  it("leaves a store.yaml naming another store as it is, and refuses an OpenSpec folder away from the root", async () => {
    const root = await oldMetarepo();
    await mkdir(join(root, ".openspec-store"), { recursive: true });
    await writeFile(join(root, ".openspec-store/store.yaml"), "version: 1\nid: forge-specs\n");
    const other = io();
    expect(await upgradeCommand(root, { by: "pat", openspecStore: true }, other.io, "1.0.0")).toBe(
      0,
    );
    expect(other.out).toContain(
      ".openspec-store/store.yaml names the store forge-specs, not forge: left as it is.",
    );
    expect(await readFile(join(root, ".openspec-store/store.yaml"), "utf8")).toBe(
      "version: 1\nid: forge-specs\n",
    );

    const away = await oldMetarepo();
    await writeFile(
      join(away, "org-pack/sources.yaml"),
      "schemaVersion: 1\nlayout:\n  openspec: specs/openspec\n",
    );
    const r = io();
    expect(await upgradeCommand(away, { by: "pat", openspecStore: true }, r.io, "1.0.0")).toBe(1);
    expect(r.err).toEqual([
      "An OpenSpec store keeps openspec/ at its root; this metarepo keeps it in specs/openspec, so it can't be one. Nothing was changed.",
    ]);
  });

  it("keeps an org's own README and still adds the starter review", async () => {
    const root = await withoutReview();
    await writeFile(join(root, "org-pack/checklists/README.md"), "# Our rules\n");
    expect(
      (await upgradeCheck(root, "1.0.0")).pending.find((p) => p.id === "starter-review")?.files,
    ).toEqual(["org-pack/checklists/review.yaml"]);
    await upgradeCommand(root, { by: "pat" }, io().io, "1.0.0");
    expect(await readFile(join(root, "org-pack/checklists/README.md"), "utf8")).toBe(
      "# Our rules\n",
    );
    expect(await readFile(join(root, "org-pack/checklists/review.yaml"), "utf8")).toBe(
      await starterReviewText(),
    );
  });
});

describe("the upgrade panel's Propose (beta.27 review)", () => {
  it("proposes every path the upgrade changed, its stamp with them, and none of the app's other work", async () => {
    const root = await oldMetarepo();
    // A change whose stories are in the long form, with a task prompt Atticus wrote before: the
    // stories step writes the change's files again and removes that prompt.
    const STAGES = join(FIXTURES, "stages");
    for (const r of [
      ...(parse(await readFile(join(FIXTURES, "specs/catalog.yaml"), "utf8")) as unknown[]),
      ...(parse(await readFile(join(STAGES, "catalog-extra.yaml"), "utf8")) as unknown[]),
      ...(parse(await readFile(join(STAGES, "footprint/catalog.yaml"), "utf8")) as unknown[]),
    ]) {
      const p = parseRecord(r);
      if (!p.ok) throw new Error(`bad fixture record: ${JSON.stringify(p.issues)}`);
      const f = join(root, "catalog/generated", recordPath(p.record));
      await mkdir(dirname(f), { recursive: true });
      await writeFile(f, serializeRecord(p.record));
    }
    await cp(join(STAGES, "specs"), join(root, "specs"), { recursive: true });
    const ch = join(root, "openspec/changes/screen-order-consent");
    await cp(join(STAGES, "footprint/screen-order-consent"), ch, { recursive: true });
    const story = join(ch, "stories/s1-place-order.md");
    await writeFile(
      story,
      `${await readFile(story, "utf8")}\nPrompt for Copilot or Claude Code:\n\nDo it.\n`,
    );
    await writeFile(
      join(ch, "stage/stories-answer.yaml"),
      [
        "stories:",
        "  - id: s1-place-order",
        "    title: Screen a consenting customer's order",
        "    asA: buyer",
        "    iWant: my order screened when I consented",
        "    soThat: stolen cards are refused",
        "    tasks:",
        '      - id: "1.1"',
        "        criteria:",
        '          - text: "Given a consenting customer, when the order is placed, then it is screened"',
        "",
      ].join("\n"),
    );
    await mkdir(join(ch, "tasks"), { recursive: true });
    await writeFile(join(ch, "tasks/9.9-old.prompt.md"), `${GENERATED_MARK} -->\n\nOld.\n`);
    git(root, "init", "-q", "-b", "main");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "as an earlier Atticus left it");
    // The app's other pending work, which "Upgrade this metarepo" must never carry.
    const theirs = [
      "catalog/curated/system/billing.yaml",
      "openspec/changes/screen-order-consent/snow.md",
      "org-pack/notes.md",
    ];
    for (const f of theirs) {
      await mkdir(dirname(join(root, f)), { recursive: true });
      await writeFile(join(root, f), "a person's own work\n");
    }
    expect(await upgradeCommand(root, { by: "pat" }, io().io, "1.0.0")).toBe(0);
    const upgraded = changedPaths(root).filter((f) => !theirs.includes(f));
    // What the steps the review named write: both ignore files, the stamp, and the change's
    // stories written again with the old prompt removed.
    expect(upgraded).toEqual(
      expect.arrayContaining([
        ".gitignore",
        ".atticus/.gitignore",
        ".atticus/metarepo.yaml",
        "openspec/changes/screen-order-consent/stories.md",
        "openspec/changes/screen-order-consent/tasks.md",
        "openspec/changes/screen-order-consent/stories/s1-place-order.md",
        "openspec/changes/screen-order-consent/tasks/9.9-old.prompt.md",
      ]),
    );
    const plan = await proposePlan(root, "upgrade");
    expect(plan.title).toBe("Upgrade this metarepo");
    expect(plan.files.map((f) => f.path).sort()).toEqual(upgraded);
    expect(plan.files.find((f) => f.path.endsWith("9.9-old.prompt.md"))?.status).toBe("D");
  }, 120_000);

  it("is the stamp alone before any upgrade ran here", () => {
    expect(scopeDirs("/m", "upgrade")).toEqual([":(literal).atticus/metarepo.yaml"]);
  });

  it("forgets a path once it is committed, so a later edit isn't offered as the upgrade (review of the fix)", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-upgrade-prune-"));
    await mkdir(join(root, "org-pack"), { recursive: true });
    await writeFile(join(root, "org-pack/runtime.yaml"), "schemaVersion: 1\n");
    await writeFile(join(root, "org-pack/notes.md"), "notes\n");
    git(root, "init", "-q", "-b", "main");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "before");
    // The upgrade rewrote runtime.yaml and the notes, and kept both.
    await writeFile(join(root, "org-pack/runtime.yaml"), "schemaVersion: 2\n");
    await writeFile(join(root, "org-pack/notes.md"), "notes, upgraded\n");
    await recordUpgraded(root, { add: ["org-pack/runtime.yaml", "org-pack/notes.md"] });
    expect((await proposePlan(root, "upgrade")).files.map((f) => f.path)).toEqual([
      "org-pack/notes.md",
      "org-pack/runtime.yaml",
    ]);
    // The person commits runtime.yaml themselves and puts the notes back as they were.
    git(root, "add", "org-pack/runtime.yaml");
    git(root, "commit", "-q", "-m", "the upgrade's runtime.yaml");
    git(root, "checkout", "--", "org-pack/notes.md");
    expect((await proposePlan(root, "upgrade")).files).toEqual([]);
    expect(upgradedPaths(root)).toEqual([]);
    // Later, Settings writes runtime.yaml: the person's edit, never offered under Upgrade.
    await writeFile(join(root, "org-pack/runtime.yaml"), "schemaVersion: 2\nadapters: {}\n");
    expect((await proposePlan(root, "upgrade")).files).toEqual([]);
    expect(scopeDirs(root, "upgrade")).toEqual([":(literal).atticus/metarepo.yaml"]);
  });

  it("skips a kept path that is absolute or climbs out, and the panel still answers (review of the fix)", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-upgrade-bad-"));
    await mkdir(join(root, ".index"), { recursive: true });
    await writeFile(
      join(root, ".index/upgraded.json"),
      JSON.stringify({
        files: [
          "/etc/hosts",
          "C:/Windows/win.ini",
          "c:relative",
          "\\\\server\\share\\x",
          "\\rooted",
          "../outside",
          "org-pack/../../outside",
          "org-pack\\..\\x",
          "..",
          5,
          null,
          "",
          "org-pack/runtime.yaml",
          "org-pack\\notes.md",
        ],
      }),
    );
    expect(upgradedPaths(root)).toEqual(["org-pack/runtime.yaml", "org-pack/notes.md"]);
    expect(relativeInside("a/..b/c")).toBe(true);
    await writeFile(join(root, ".index/upgraded.json"), "null");
    expect(upgradedPaths(root)).toEqual([]);
    await writeFile(join(root, ".index/upgraded.json"), '{"files": "org-pack"}');
    expect(upgradedPaths(root)).toEqual([]);
    // What a run changed is read without following a link (review of the fix): a link to a
    // folder above can't loop, and one out of the metarepo is never read.
    await mkdir(join(root, "org-pack/sub"), { recursive: true });
    await writeFile(join(root, "org-pack/sub/a.yaml"), "a: 1\n");
    const outside = await mkdtemp(join(tmpdir(), "atticus-upgrade-outside-"));
    await writeFile(join(outside, "secret.txt"), "not the metarepo's\n");
    let linked = true;
    try {
      await symlink(join(root, "org-pack"), join(root, "org-pack/sub/up"), "junction");
      await symlink(join(outside, "secret.txt"), join(root, "org-pack/sub/out.txt"));
    } catch {
      linked = false; // Windows without the right to make links: nothing to test.
    }
    const seen = await contentOf(root, ["org-pack/sub"]);
    expect([...seen.keys()]).toEqual(["org-pack/sub/a.yaml"]);
    if (linked) expect(await contentOf(root, ["org-pack/sub/out.txt"])).toEqual(new Map());
    // A bad path from a run is never kept either.
    await recordUpgraded(root, { add: ["/etc/hosts", "../x", "org-pack/a.yaml"] });
    expect(upgradedPaths(root)).toEqual(["org-pack/a.yaml"]);
  });
});
