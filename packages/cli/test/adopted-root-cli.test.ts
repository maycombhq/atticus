import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { exists, hashTree } from "@maycombhq/adopt";
import { runCritic } from "@maycombhq/naysayer";
import { createGit } from "@maycombhq/workspace";
import { changeNew } from "../src/change-commands.js";
import { critic } from "../src/critic-commands.js";
import { queryCommand } from "../src/index-commands.js";
import { main } from "../src/main.js";
import { scanCommand } from "../src/scan-commands.js";
import { adoptCommand, unadoptCommand } from "../src/setup-commands.js";

/**
 * Commands with --root pointing at a repo adopted in place: they read the org pack from
 * .atticus/org-pack, write the catalog where sources.yaml layout says (.atticus/catalog) and
 * keep local state (the index) in .atticus/. Removing Atticus still leaves the repo as it was.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "../../adopt/test/fixtures");
const made: string[] = [];
afterAll(async () => {
  while (made.length) await rm(made.pop()!, { recursive: true, force: true });
});

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

const RULE = `schemaVersion: 1
name: team-notes
version: 1.0.0
rules:
  - id: brief-names-a-metric
    title: The brief names the metric the change moves
    layer: org
    lens: business
    appliesTo:
      artifacts: [brief]
    severity: risk
    check:
      type: ai
      prompt: Check that the brief names one measurable metric this change is meant to move.
    waivable: false
    source: team notes
`;

describe("commands with --root on an adopted repo", () => {
  it("use .atticus/org-pack, the layout's catalog and .atticus/ state", async () => {
    const base = await mkdtemp(join(tmpdir(), "atticus-adopted-root-"));
    made.push(base);
    const dir = join(base, "catalog-service");
    await cp(join(FIXTURES, "openspec-repo"), dir, { recursive: true });
    const git = createGit();
    await git(["init", "-q", "-b", "main"], dir);
    await git(["add", "-A"], dir);
    await git(
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.com",
        "commit",
        "-q",
        "-m",
        "x",
      ],
      dir,
    );
    const before = await hashTree(dir);
    expect(await adoptCommand(dir, {}, io().io)).toBe(0);

    // orgpack validate with no folder resolves the adopted org pack.
    const v = io();
    expect(await main(["orgpack", "validate", "--root", dir], v.io)).toBe(0);
    expect(v.out.join("\n")).not.toMatch(/defaults/i);

    // scan writes the catalog into .atticus/catalog/generated; query reads it through the index.
    expect(await scanCommand(dir, {}, io().io)).toBe(0);
    expect(
      await exists(join(dir, ".atticus/catalog/generated/component/catalog-service.yaml")),
    ).toBe(true);
    expect(await exists(join(dir, "catalog"))).toBe(false);
    const q = io();
    expect(await queryCommand(dir, "kind:component", {}, q.io)).toBe(0);
    expect(q.out.join("\n")).toContain("catalog-service");
    expect(await exists(join(dir, ".atticus/.index/catalog.sqlite"))).toBe(true);
    expect(await exists(join(dir, ".index"))).toBe(false);

    // The critic reads the adopted org pack's checklists.
    await mkdir(join(dir, ".atticus/org-pack/checklists"), { recursive: true });
    await writeFile(join(dir, ".atticus/org-pack/checklists/team-notes.yaml"), RULE, "utf8");
    expect(
      await changeNew(
        dir,
        { title: "Add product notes", type: "feature", by: "pat", id: "add-product-notes" },
        io().io,
      ),
    ).toBe(0);
    expect(await critic(dir, "add-product-notes", {}, io().io)).toBeLessThan(2);
    const res = await runCritic(dir, "add-product-notes", { gate: "define" });
    const seen = [...res.rules.ran, ...res.rules.skipped.map((s) => s.rule)];
    expect(seen).toContain("brief-names-a-metric");

    expect(await unadoptCommand(dir, io().io)).toBe(0);
    expect(await hashTree(dir)).toEqual(before);
  });
});
