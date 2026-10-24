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

describe("atticus upgrade", () => {
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
    ]);
    const r = io();
    expect(await upgradeCommand(root, { check: true }, r.io, "1.0.0")).toBe(1);
    expect(r.out[0]).toMatch(/6 upgrade steps to run/);
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
      "gates-v2",
      "flow-schema-v2",
      "change-types-v2",
      "questions-v2",
      "starter-review",
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
