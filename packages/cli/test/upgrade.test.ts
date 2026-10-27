import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { CHECKLISTS_README, STARTER_CHECKLISTS_README } from "@maycombhq/adopt";
import { starterReviewText } from "@maycombhq/naysayer";
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
      ["questions-v2", ["questions/q-0f1e2d3c4b5a.yaml"]],
      // The Forge pack's sources.yaml is at version 1.
      ["sources-v2", ["org-pack/sources.yaml"]],
      // ADR 0130: and on to version 3, in the same run.
      ["sources-v3", ["org-pack/sources.yaml"]],
      // ADR 0121 addendum: and its runtime.yaml.
      ["runtime-v2", ["org-pack/runtime.yaml"]],
      // ADR 0128: the manifest's number, so a repo can say what it is.
      ["manifest-schema-v2", ["org-pack/profiles/forge/repos.manifest.yaml"]],
    ]);
    const r = io();
    expect(await upgradeCommand(root, { check: true }, r.io, "1.0.0")).toBe(1);
    expect(r.out[0]).toMatch(/10 upgrade steps to run/);
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
    // A version-1 record is written at the current version (3, ADR 0125) by the version-2 step.
    expect(await readFile(join(root, "catalog/generated/system/ledger.yaml"), "utf8")).toMatch(
      /^schemaVersion: 3/m,
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
      "questions-v2",
      "starter-review",
      "catalog-schema-v3",
      "sources-v2",
      "sources-v3",
      "stamp-committed",
      "runtime-v2",
      // ADR 0006 addendum: no OpenSpec here, so nothing to do, but recorded as done.
      "org-flow-v2",
      "stories-b-short",
      "manifest-schema-v2",
    ]);
    // runtime.yaml at version 2 (ADR 0121 addendum): the number only, every line else as it was,
    // so no step names a model of its own.
    const runtime = await readFile(join(root, "org-pack/runtime.yaml"), "utf8");
    const was = await readFile(join(FIXTURES, "forge/metarepo/org-pack/runtime.yaml"), "utf8");
    expect(runtime).toBe(was.replace(/^schemaVersion: 1$/m, "schemaVersion: 2"));
    expect(parse(runtime).models).toBeUndefined();
    // sources.yaml at version 3 (ADR 0130), its wiki as it was: every page still read, ranked as
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
      /^schemaVersion: 2$/m,
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
    expect(await upgradeCommand(root, { check: true }, io().io, "1.0.0")).toBe(0);
    expect(await readdir(join(root, ".atticus/backups"))).toEqual(["20261019-100000"]);
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

  it("moves version-2 catalog records to version 3 in their own step, changing only the number (ADR 0125)", async () => {
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
    expect(await readFile(f, "utf8")).toBe(v2.replace(/^schemaVersion: 2\n/, "schemaVersion: 3\n"));
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
  });
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
