import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadOrgPack } from "../src/index.js";

/**
 * Review round 41: a dialect or checklist pack loaded twice (a copy in a subfolder, say) is a
 * problem naming both files, and only the first is loaded; every problem names the file it is
 * in, not one built from the record's id.
 */
const FORGE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/forge/metarepo/org-pack",
);

async function forgePack(extra: (dir: string) => Promise<void>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "atticus-orgpack-dup-"));
  await cp(FORGE, dir, { recursive: true });
  await extra(dir);
  return dir;
}

async function put(dir: string, rel: string, text: string): Promise<void> {
  await mkdir(dirname(join(dir, rel)), { recursive: true });
  await writeFile(join(dir, rel), text);
}

const lines = (op: { problems: { file: string; path: string; message: string }[] }) =>
  op.problems.map((p) => `${p.file}: ${p.path}: ${p.message}`);

describe("duplicates in the org pack (review round 41)", () => {
  it("loads the Forge pack with no problems to start with", async () => {
    expect((await loadOrgPack(FORGE)).problems).toEqual([]);
  });

  it("keeps the first dialect of a name, and names both files", async () => {
    const forge = await readFile(join(FORGE, "dialects/forge.yaml"), "utf8");
    const op = await loadOrgPack(
      await forgePack((d) => put(d, "dialects/team-b/forge-copy.yaml", forge)),
    );
    expect(op.dialects.map((x) => x.name)).toEqual(["forge"]);
    expect(lines(op)).toEqual([
      "dialects/team-b/forge-copy.yaml: name: dialect forge is also in dialects/forge.yaml; only that one is loaded",
    ]);
  });

  it("keeps the first checklist pack of a name, and names both files", async () => {
    const arch = await readFile(join(FORGE, "checklists/architecture.yaml"), "utf8");
    const op = await loadOrgPack(
      await forgePack((d) => put(d, "checklists/team-b/architecture.yaml", arch)),
    );
    expect(op.checklists.map((c) => c.name)).toEqual(["forge-architecture"]);
    expect(lines(op)).toEqual([
      "checklists/team-b/architecture.yaml: name: checklist pack forge-architecture is also in checklists/architecture.yaml; only that one is loaded",
    ]);
  });

  it("refuses a later pack that reuses a rule id of an earlier one", async () => {
    const arch = await readFile(join(FORGE, "checklists/architecture.yaml"), "utf8");
    const op = await loadOrgPack(
      await forgePack((d) =>
        put(
          d,
          "checklists/team-b/extra.yaml",
          arch.replace("name: forge-architecture", "name: forge-extra"),
        ),
      ),
    );
    expect(op.checklists.map((c) => c.name)).toEqual(["forge-architecture"]);
    const got = lines(op);
    expect(got.length).toBeGreaterThan(0);
    expect(got).toContain(
      "checklists/team-b/extra.yaml: rules.0.id: rule vendor-calls-through-gateway is also in checklists/architecture.yaml; this pack is not loaded",
    );
    expect(got.every((l) => l.startsWith("checklists/team-b/extra.yaml: rules."))).toBe(true);
  });

  it("names the file a problem is in, whatever the file is called", async () => {
    const op = await loadOrgPack(
      await forgePack(async (d) => {
        const forge = await readFile(join(FORGE, "dialects/forge.yaml"), "utf8");
        await put(
          d,
          "dialects/team-c/odd-file.yaml",
          forge
            .replace("name: forge\n", "name: forge-odd\n")
            .replace("extends: []", "extends: [ghost]"),
        );
        await put(
          d,
          "patterns/odd-pattern.yaml",
          "schemaVersion: 1\ncode: X.Y\nname: n\ndefinition: d\ninteraction: sync\nroute: direct\ntargetType: internal\nsource: s\nversion: 1.0.0\nstatus: confirmed\nchecklist: [missing-rule]\n",
        );
        const agent = await readFile(join(FORGE, "agents/story-writer.yaml"), "utf8");
        await put(
          d,
          "agents/team-c/odd-agent.yaml",
          agent
            .replace("id: story-writer", "id: story-teller")
            .replace("checklist: forge-architecture", "checklist: nope"),
        );
      }),
    );
    expect(lines(op)).toEqual(
      expect.arrayContaining([
        "dialects/team-c/odd-file.yaml: extends: no dialect ghost",
        "patterns/odd-pattern.yaml: checklist: no checklist rule missing-rule",
        "agents/team-c/odd-agent.yaml: checklist: no checklist pack named nope",
      ]),
    );
    expect(
      lines(op).some((l) => /dialects\/forge-odd\.yaml|patterns\/X\.Y|story-teller/.test(l)),
    ).toBe(false);
  });
});
