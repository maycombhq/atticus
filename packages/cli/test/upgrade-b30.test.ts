import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import * as core from "@maycombhq/core";
import { loadOrgPack } from "@maycombhq/core";
import { main } from "../src/main.js";
import { initCommand } from "../src/setup-commands.js";
import { STAMP_FILE, upgradeCheck, upgradeCommand } from "../src/upgrade.js";

/**
 * ADR 0201 (2.0.0-beta.30, slice 1): an org pack as beta.28.5 left it gains the `quick` change
 * type (the step `change-types-quick`) and the starter personas, their naysayers and the
 * define-change skill (the step `starter-personas`), and loses nothing. Each step leaves alone
 * what the organisation wrote, and never runs twice.
 *
 * The beta.28.5 shape: the metarepo `atticus init` makes, with change-types.yaml as beta.28.5
 * wrote it (upgrade-b30/change-types-28.5.yaml: the seven built-in types, and two comments the
 * organisation added), no persona and no skill, and a stamp that names neither step.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const TYPES_28_5 = join(HERE, "upgrade-b30", "change-types-28.5.yaml");
const NOW = new Date("2026-11-18T09:00:00Z");
const STEPS = ["change-types-quick", "starter-personas"];

/** ADR 0201 part 7: seven personas, a naysayer for each, and one skill: 15 files. */
const PERSONAS = [
  "product-owner",
  "application-architect",
  "domain-architect",
  "ux-analyst",
  "developer",
  "qa",
  "security",
];
const AGENTS = PERSONAS.flatMap((p) => [`agents/${p}.md`, `agents/${p}-naysayer.md`]);
const SKILL = "skills/define-change/SKILL.md";
const STARTERS = [...AGENTS, SKILL];

/** ADR 0201 part 1: the entry, as the type list holds it. */
const QUICK = {
  id: "quick",
  name: "Quick path",
  description:
    "From a requirements file to a plain OpenSpec change: proposal, spec deltas, design and tasks, written by your personas and grounded in the map. No stage runs. One hand-off before build.",
  phases: ["plan", "build", "release"],
  artifacts: ["proposal", "specs", "design", "tasks"],
  lenses: ["true", "complete", "safe", "ship"],
};
const BUILT_IN = [
  "feature",
  "integration",
  "bug-fix",
  "emergency-fix",
  "config-change",
  "tech-debt",
  "small-change",
];

const made: string[] = [];
afterAll(async () => {
  for (const d of made.splice(0)) await rm(d, { recursive: true, force: true });
});

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};
const quiet = { out: () => undefined, err: () => undefined };

const pack = (root: string, rel: string) => join(root, "org-pack", ...rel.split("/"));

/** A metarepo as beta.28.5 left it. */
async function metarepo285(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "atticus-upgrade-b30-"));
  made.push(dir);
  const root = join(dir, "forge");
  expect(await initCommand(root, { name: "forge", platform: "github", owner: "pat" }, quiet)).toBe(
    0,
  );
  await writeFile(pack(root, "change-types.yaml"), await readFile(TYPES_28_5));
  for (const f of AGENTS) await rm(pack(root, f), { force: true });
  await rm(pack(root, "skills/define-change"), { recursive: true, force: true });
  const stampFile = join(root, STAMP_FILE);
  const stamp = parse(await readFile(stampFile, "utf8")) as {
    atticus: string;
    migrations: string[];
  };
  await writeFile(
    stampFile,
    stringify({
      ...stamp,
      atticus: "2.0.0-beta.28.5",
      migrations: stamp.migrations.filter((m) => !STEPS.includes(m)),
    }),
  );
  return root;
}

/** Every file of the org pack, by its path with forward slashes. */
async function packFiles(root: string): Promise<Map<string, Buffer>> {
  const base = join(root, "org-pack");
  const out = new Map<string, Buffer>();
  for (const e of await readdir(base, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const file = join(e.parentPath, e.name);
    out.set(file.slice(base.length + 1).replace(/\\/g, "/"), await readFile(file));
  }
  return out;
}

const upgrade = async (root: string) => {
  const c = capture();
  const code = await upgradeCommand(root, { by: "pat", now: NOW }, c.io);
  return { code, ...c };
};
const pendingSteps = async (root: string) =>
  (await upgradeCheck(root)).pending
    .map((p) => p.id)
    .filter((id) => STEPS.includes(id))
    .sort();
const stampSteps = async (root: string) =>
  (parse(await readFile(join(root, STAMP_FILE), "utf8")) as { migrations: string[] }).migrations;

/** A Markdown file's frontmatter, whatever its line ends. */
function frontmatter(text: string): Record<string, unknown> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text.replace(/\r\n/g, "\n"));
  expect(m, "no frontmatter").not.toBeNull();
  return parse(m![1]!) as Record<string, unknown>;
}

describe("atticus upgrade on a beta.28.5 org pack (ADR 0201)", () => {
  it("gains the quick type and the 15 starters, loses nothing, and a second run changes nothing", async () => {
    const root = await metarepo285();
    const before = await packFiles(root);
    const typesBefore = before.get("change-types.yaml")!.toString("utf8");
    expect(await pendingSteps(root)).toEqual(STEPS);
    // --check and --dry-run say it and write nothing.
    const check = await upgradeCheck(root);
    expect(check.pending.find((p) => p.id === "change-types-quick")!.files).toEqual([
      "org-pack/change-types.yaml",
    ]);
    expect(check.pending.find((p) => p.id === "starter-personas")!.files.sort()).toEqual(
      STARTERS.map((f) => `org-pack/${f}`).sort(),
    );

    const first = await upgrade(root);
    expect(first.code, first.err.join("\n")).toBe(0);
    expect(await stampSteps(root)).toEqual(expect.arrayContaining(STEPS));

    // ---- nothing is lost: every file is there with its bytes, but for the one list entry
    const after = await packFiles(root);
    for (const [rel, bytes] of before) {
      expect(after.has(rel), `${rel} is gone`).toBe(true);
      if (rel !== "change-types.yaml") expect(after.get(rel)!.equals(bytes), rel).toBe(true);
    }
    expect([...after.keys()].filter((k) => !before.has(k)).sort()).toEqual([...STARTERS].sort());

    // ---- the type: added at the end of the list; every other byte kept, comments too
    const typesAfter = after.get("change-types.yaml")!.toString("utf8");
    expect(typesAfter.startsWith(typesBefore)).toBe(true);
    expect(typesAfter).toContain("# Forge: small changes are for one repo only.");
    const types = (parse(typesAfter) as { types: { id: string }[] }).types;
    expect(types.map((t) => t.id)).toEqual([...BUILT_IN, "quick"]);
    expect(types.slice(0, -1)).toEqual((parse(typesBefore) as { types: unknown[] }).types);
    expect(types.at(-1)).toMatchObject(QUICK);

    // ---- it reads, and only the new type has the quick path's shape
    const loaded = (await loadOrgPack(join(root, "org-pack"))).changeTypes.types;
    expect(loaded.map((t) => t.id)).toEqual([...BUILT_IN, "quick"]);
    const quickPathOf = (core as Record<string, unknown>).quickPathOf as
      ((type: unknown) => boolean) | undefined;
    expect(typeof quickPathOf, "core exports no quickPathOf").toBe("function");
    expect(loaded.filter((t) => quickPathOf!(t)).map((t) => t.id)).toEqual(["quick"]);

    // ---- the starters: each persona says who it is, what it owns and the map tools it asks
    for (const p of PERSONAS) {
      const persona = frontmatter(after.get(`agents/${p}.md`)!.toString("utf8"));
      const naysayer = frontmatter(after.get(`agents/${p}-naysayer.md`)!.toString("utf8"));
      expect(persona.name).toBe(p);
      expect(naysayer.name).toBe(`${p}-naysayer`);
      for (const fm of [persona, naysayer]) {
        expect(String(fm.description ?? "").trim(), `${fm.name}: description`).not.toBe("");
        expect(String(fm.description)).not.toContain("\n");
        expect(String(fm.role ?? "").trim(), `${fm.name}: role`).not.toBe("");
        expect(String(fm.owns ?? "").trim(), `${fm.name}: owns`).not.toBe("");
        expect(Array.isArray(fm.tools), `${fm.name}: tools`).toBe(true);
        const tools = fm.tools as string[];
        for (const t of tools) expect(t).toMatch(/^(read|search|atticus\/[a-z][a-z-]*)$/);
        expect(
          tools.some((t) => t.startsWith("atticus/")),
          `${fm.name} asks no map tool`,
        ).toBe(true);
      }
      // A naysayer owns the table under its persona's heading.
      expect(naysayer.owns).toBe(persona.owns);
    }
    // The domain architect is a template to copy under the organisation's own name.
    for (const f of ["agents/domain-architect.md", "agents/domain-architect-naysayer.md"])
      expect(after.get(f)!.toString("utf8")).toContain("payments-architect");
    const skill = after.get(SKILL)!.toString("utf8");
    for (const p of PERSONAS) expect(skill, `the skill's order lacks ${p}`).toContain(p);
    for (const words of [
      "atticus change new --from",
      "--check",
      "(after",
      "atticus change handoff",
      "Question",
      "Evidence",
      "Asked by",
      "Answered by",
      "Answer",
      "State",
    ])
      expect(skill).toContain(words);

    // ---- a second run changes nothing
    expect(await pendingSteps(root)).toEqual([]);
    const second = await upgrade(root);
    expect(second.code, second.err.join("\n")).toBe(0);
    const again = await packFiles(root);
    expect([...again.keys()].sort()).toEqual([...after.keys()].sort());
    for (const [rel, bytes] of after) expect(again.get(rel)!.equals(bytes), rel).toBe(true);
  }, 120_000);

  it("leaves alone a type quick of the organisation's own and a persona it wrote", async () => {
    const root = await metarepo285();
    const own = [
      "  - id: quick",
      "    name: Quick fix",
      "    phases: [build, release]",
      "    artifacts: [brief, tasks]",
      '    lenses: ["true"]',
      "",
    ].join("\n");
    const types = (await readFile(TYPES_28_5, "utf8")) + own;
    await writeFile(pack(root, "change-types.yaml"), types);
    const developer = "---\nname: developer\ndescription: Forge's own developer\n---\n\nOurs.\n";
    await mkdir(pack(root, "agents"), { recursive: true });
    await writeFile(pack(root, "agents/developer.md"), developer);

    const check = await upgradeCheck(root);
    expect(check.pending.some((p) => p.id === "change-types-quick")).toBe(false);
    expect(check.pending.find((p) => p.id === "starter-personas")!.files.sort()).toEqual(
      STARTERS.filter((f) => f !== "agents/developer.md")
        .map((f) => `org-pack/${f}`)
        .sort(),
    );

    const r = await upgrade(root);
    expect(r.code, r.err.join("\n")).toBe(0);
    expect(await readFile(pack(root, "change-types.yaml"), "utf8")).toBe(types);
    expect(await readFile(pack(root, "agents/developer.md"), "utf8")).toBe(developer);
    for (const f of STARTERS) expect(existsSync(pack(root, f)), f).toBe(true);
  }, 120_000);

  it("gives nothing back that was deleted after its step ran", async () => {
    const root = await metarepo285();
    expect((await upgrade(root)).code).toBe(0);
    // The organisation takes the type out again and deletes a persona and the skill.
    await writeFile(pack(root, "change-types.yaml"), await readFile(TYPES_28_5));
    await rm(pack(root, "agents/qa.md"));
    await rm(pack(root, "skills/define-change"), { recursive: true });

    expect(await pendingSteps(root)).toEqual([]);
    const r = await upgrade(root);
    expect(r.code, r.err.join("\n")).toBe(0);
    expect(
      (await readFile(pack(root, "change-types.yaml"))).equals(await readFile(TYPES_28_5)),
    ).toBe(true);
    expect(existsSync(pack(root, "agents/qa.md"))).toBe(false);
    expect(existsSync(pack(root, SKILL))).toBe(false);
  }, 120_000);

  it("an org pack with no change-types.yaml has the built-in list and needs no type added", async () => {
    const root = await metarepo285();
    await rm(pack(root, "change-types.yaml"));
    expect(await pendingSteps(root)).toEqual(["starter-personas"]);
    const r = await upgrade(root);
    expect(r.code, r.err.join("\n")).toBe(0);
    expect(existsSync(pack(root, "change-types.yaml"))).toBe(false);
    // The built-in list has the type.
    expect((await loadOrgPack(join(root, "org-pack"))).changeTypes.types.map((t) => t.id)).toEqual([
      ...BUILT_IN,
      "quick",
    ]);
  }, 120_000);

  it("change new --from says to upgrade before the upgrade, and works after it", async () => {
    const root = await metarepo285();
    const file = join(dirname(root), "requirements.md");
    await writeFile(file, "# Rotate the audit key\n\nThe audit key is a year old.\n");
    const args = ["change", "new", "--from", file, "--by", "pat", "--root", root];
    const run = async () => {
      const c = capture();
      return { code: await main(args, c.io, { quiet: true }), ...c };
    };

    const refused = await run();
    expect(refused.code).toBe(1);
    expect(refused.err).toEqual([
      "This org pack has no change type quick: run atticus upgrade, or pass --type <type>.",
    ]);
    expect(existsSync(join(root, "openspec/changes/rotate-the-audit-key"))).toBe(false);

    expect((await upgrade(root)).code).toBe(0);
    const created = await run();
    expect(created.err).toEqual([]);
    expect(created.code).toBe(0);
    expect(
      created.out.some((l) => l.startsWith("Created rotate-the-audit-key (quick, from ")),
    ).toBe(true);
  }, 120_000);
});
