import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { writeStartingPack } from "@maycombhq/adopt";
import { starterPersonaFiles } from "@maycombhq/assistant-files";
import * as core from "@maycombhq/core";
import {
  ChangeTypes,
  DEFAULT_CHANGE_TYPES,
  loadOrgPack,
  QUICK_CHANGE_TYPE,
  quickPathOf,
} from "@maycombhq/core";
import { main } from "../src/main.js";
import { initCommand } from "../src/setup-commands.js";
import {
  contentOf,
  MIGRATIONS,
  STAMP_FILE,
  starterPersonasStep,
  upgradeCheck,
  upgradeCommand,
} from "../src/upgrade.js";

/**
 * ADR 0201: an org pack as 2.0.0-beta.28.5 left it gains the quick change type and the starter
 * personas, and loses nothing: every other byte of change-types.yaml is kept, a type `quick` of
 * its own and a persona file that is there are left alone, and a second run changes nothing.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "../../../fixtures");
const B285 = "2.0.0-beta.28.5";
const B30 = "2.0.0-beta.30";
const NEW_STEPS = ["change-types-quick", "starter-personas"];
const T = 120_000;

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], {
    cwd,
    encoding: "utf8",
  });

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};

/** change-types.yaml as beta.28.5's `atticus init` wrote it, then edited by the organisation. */
const TYPES_B285 = [
  "# Built-in default written out by Atticus. Change it through a pull request; delete the file to go back to the default.",
  stringify(
    {
      schemaVersion: 2,
      types: DEFAULT_CHANGE_TYPES.types.filter((t) => t.id !== QUICK_CHANGE_TYPE.id),
    },
    { lineWidth: 0 },
  ).trimEnd(),
  "  # Forge's own: a pipeline change, reviewed by the platform team.",
  "  - id: forge-pipeline",
  "    name: 'Pipeline change'   # keep the quotes",
  "    phases: [ define, plan, build ]",
  "    artifacts: [proposal, tasks]",
  "",
].join("\n");

/**
 * The Forge metarepo as beta.28.5 left it after its own `atticus upgrade`: every step that
 * Atticus knew is in the stamp, and nothing of beta.30 is there.
 */
async function b285Metarepo(types: string | null = TYPES_B285): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-upgrade-b30-"));
  await cp(join(FIXTURES, "forge/metarepo"), root, { recursive: true });
  if (types !== null) await writeFile(join(root, "org-pack/change-types.yaml"), types);
  await writeFile(join(root, ".gitignore"), "/workspace/\n/.atticus/*\n!/.atticus/metarepo.yaml\n");
  await mkdir(join(root, ".atticus"), { recursive: true });
  // Bring it to what this Atticus's older steps write, then stamp it as beta.28.5 did.
  expect(await upgradeCommand(root, { by: "pat" }, io().io, B285)).toBe(0);
  if (types !== null) await writeFile(join(root, "org-pack/change-types.yaml"), types);
  for (const f of (await starterPersonaFiles()).map((x) => x.path))
    await rm(join(root, "org-pack", f), { force: true });
  const stampFile = join(root, ".atticus/metarepo.yaml");
  const stamp = parse(await readFile(stampFile, "utf8")) as { migrations: string[] };
  stamp.migrations = stamp.migrations.filter((m) => !NEW_STEPS.includes(m));
  await writeFile(stampFile, stringify(stamp));
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "as beta.28.5 left it");
  return root;
}

/** A small starter of the test's own, as the step takes it: each file's org-pack path and its text. */
const FIXTURE_STARTERS = [
  {
    path: "agents/developer-naysayer.md",
    text: "---\nname: developer-naysayer\n---\n\nA fixture naysayer.\n",
  },
  { path: "agents/developer.md", text: "---\nname: developer\n---\n\nA fixture developer.\n" },
  {
    path: "skills/define-change/SKILL.md",
    text: "---\nname: define-change\n---\n\nA fixture skill.\n",
  },
];
/**
 * The same starter as a folder, read by the walker the installed one is read by, with what a
 * starter folder may hold beside its files: a README of its own and one in each folder.
 */
let fixtureDir: Promise<string> | undefined;
const fixtureStarters = async () => {
  fixtureDir ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-starter-b30-"));
    const files = [
      ...FIXTURE_STARTERS,
      { path: "README.md", text: "Not copied: only agents/ and skills/ go into an org pack.\n" },
      { path: "agents/README.md", text: "About the starter's agents.\n" },
      { path: "skills/README.md", text: "About the starter's skills.\n" },
      { path: "skills/define-change/notes.md", text: "Notes on the skill.\n" },
    ];
    for (const f of files) {
      await mkdir(dirname(join(dir, f.path)), { recursive: true });
      await writeFile(join(dir, f.path), f.text);
    }
    return dir;
  })();
  return starterPersonaFiles(await fixtureDir);
};

const changed = (root: string) =>
  git(root, "status", "--porcelain=v1", "--untracked-files=all")
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3))
    .filter((f) => !f.startsWith(".atticus/"))
    .sort();

describe("atticus upgrade to beta.30: the quick change type (change-types-quick)", () => {
  it("comes after change-types-v2 in the steps", () => {
    const ids = MIGRATIONS.map((m) => m.id);
    expect(ids.indexOf("change-types-quick")).toBe(ids.indexOf("change-types-v2") + 1);
    expect(ids).toContain("starter-personas");
  });

  it(
    "adds the one entry, keeps every other byte, and a second run changes nothing",
    async () => {
      const root = await b285Metarepo();
      const file = join(root, "org-pack/change-types.yaml");
      const c = await upgradeCheck(root, B30);
      expect(c.pending.find((p) => p.id === "change-types-quick")?.files).toEqual([
        "org-pack/change-types.yaml",
      ]);
      const before = await contentOf(root, ["org-pack", "catalog", "openspec"]);
      expect(await upgradeCommand(root, { by: "pat" }, io().io, B30)).toBe(0);

      const text = await readFile(file, "utf8");
      expect(text.startsWith(TYPES_B285)).toBe(true);
      const added = text.slice(TYPES_B285.length);
      expect(added.split("\n")[0]).toBe("  - id: quick");
      expect(parse(`types:\n${added}`)).toEqual({
        types: [
          {
            id: "quick",
            name: "Quick path",
            description: QUICK_CHANGE_TYPE.description,
            phases: ["plan", "build", "release"],
            artifacts: ["proposal", "specs", "design", "tasks"],
            lenses: ["true", "complete", "safe", "ship"],
          },
        ],
      });
      const types = ChangeTypes.parse(parse(text)).types;
      expect(types.map((t) => t.id)).toEqual([
        "feature",
        "integration",
        "bug-fix",
        "emergency-fix",
        "config-change",
        "tech-debt",
        "small-change",
        "forge-pipeline",
        "quick",
      ]);
      expect(types.filter(quickPathOf).map((t) => t.id)).toEqual(["quick"]);
      // The org pack still loads, with the type.
      expect(
        (await loadOrgPack(join(root, "org-pack"))).changeTypes.types.some((t) => t.id === "quick"),
      ).toBe(true);
      // It loses nothing: every file that was there is there, and only change-types.yaml changed.
      const after = await contentOf(root, ["org-pack", "catalog", "openspec"]);
      for (const [f, hash] of before)
        if (f !== "org-pack/change-types.yaml") expect(after.get(f), f).toBe(hash);
      // The file as it was is in the backup.
      const backups = join(root, ".atticus/backups");
      const kept = (await contentOf(root, [".atticus/backups"])).keys();
      expect([...kept].some((f) => f.endsWith("/org-pack/change-types.yaml"))).toBe(true);
      expect(existsSync(backups)).toBe(true);

      // A second run: nothing pending, no byte changed.
      expect((await upgradeCheck(root, B30)).pending).toEqual([]);
      const once = await contentOf(root, ["org-pack"]);
      const again = io();
      expect(await upgradeCommand(root, { by: "pat" }, again.io, B30)).toBe(0);
      expect(await contentOf(root, ["org-pack"])).toEqual(once);
      expect(await upgradeCommand(root, { check: true }, io().io, B30)).toBe(0);
    },
    T,
  );

  it(
    "leaves a type quick of the organisation's own alone, and never puts back one it deleted",
    async () => {
      const own = `${TYPES_B285}  - id: quick\n    name: Forge quick\n    phases: [define, build]\n    artifacts: [proposal, tasks]\n`;
      const root = await b285Metarepo(own);
      const c = await upgradeCheck(root, B30);
      expect(c.pending.map((p) => p.id)).not.toContain("change-types-quick");
      expect(await upgradeCommand(root, { by: "pat" }, io().io, B30)).toBe(0);
      expect(await readFile(join(root, "org-pack/change-types.yaml"), "utf8")).toBe(own);

      // Deleted after the step ran (the stamp names it): it stays deleted.
      await writeFile(join(root, "org-pack/change-types.yaml"), TYPES_B285);
      expect((await upgradeCheck(root, B30)).pending.map((p) => p.id)).not.toContain(
        "change-types-quick",
      );
    },
    T,
  );

  it(
    "needs nothing for an org pack with no change-types.yaml: the built-in list has the type",
    async () => {
      const root = await b285Metarepo(null);
      expect((await upgradeCheck(root, B30)).pending.map((p) => p.id)).not.toContain(
        "change-types-quick",
      );
      expect(await upgradeCommand(root, { by: "pat" }, io().io, B30)).toBe(0);
      expect(existsSync(join(root, "org-pack/change-types.yaml"))).toBe(false);
      expect(
        (await loadOrgPack(join(root, "org-pack"))).changeTypes.types.some((t) => t.id === "quick"),
      ).toBe(true);
    },
    T,
  );
});

describe("atticus upgrade to beta.30: the starter personas (starter-personas)", () => {
  it(
    "writes each starter file where none is, never over one that is there, and not again once stamped",
    async () => {
      const root = await b285Metarepo();
      // The organisation already has a developer persona of its own.
      const mine = "---\nname: developer\n---\n\nForge's own developer persona.\n";
      await mkdir(join(root, "org-pack/agents"), { recursive: true });
      await writeFile(join(root, "org-pack/agents/developer.md"), mine);
      const before = await contentOf(root, ["org-pack"]);

      const step = starterPersonasStep(fixtureStarters);
      const want = [
        "org-pack/agents/developer-naysayer.md",
        "org-pack/skills/define-change/SKILL.md",
      ];
      expect(await step.pending(root)).toEqual(want);
      expect(step.creates).toBe(true);
      expect(await step.apply(root)).toEqual(want);
      for (const f of want)
        expect(await readFile(join(root, f), "utf8")).toBe(
          FIXTURE_STARTERS.find((s) => `org-pack/${s.path}` === f)!.text,
        );
      expect(await readFile(join(root, "org-pack/agents/developer.md"), "utf8")).toBe(mine);
      // Only the starter's agents and skills: its READMEs and a skill's notes stay where they are.
      for (const f of ["README.md", "agents/README.md", "skills/README.md"])
        expect(existsSync(join(root, "org-pack", f)), f).toBe(false);
      expect(existsSync(join(root, "org-pack/skills/define-change/notes.md"))).toBe(false);
      // It lost nothing.
      const after = await contentOf(root, ["org-pack"]);
      for (const [f, hash] of before) expect(after.get(f), f).toBe(hash);
      expect(changed(root)).toEqual(["org-pack/agents/developer.md", ...want].sort());
      // Applied twice: nothing more to write.
      expect(await step.pending(root)).toEqual([]);
      expect(await step.apply(root)).toEqual([]);

      // Once the stamp names the step, a file the organisation deleted is not written again.
      expect(await upgradeCommand(root, { by: "pat" }, io().io, B30)).toBe(0);
      const stampFile = join(root, ".atticus/metarepo.yaml");
      const stamp = parse(await readFile(stampFile, "utf8")) as { migrations: string[] };
      stamp.migrations = [...new Set([...stamp.migrations, "starter-personas"])];
      await writeFile(stampFile, stringify(stamp));
      await rm(join(root, "org-pack/skills/define-change/SKILL.md"));
      expect(await step.pending(root)).toEqual([]);
      expect(await step.apply(root)).toEqual([]);
    },
    T,
  );

  it(
    "runs with the upgrade: the installed starter's files, whatever it holds, and a second run changes nothing",
    async () => {
      const root = await b285Metarepo();
      const starters = (await starterPersonaFiles()).map((f) => `org-pack/${f.path}`);
      const c = await upgradeCheck(root, B30);
      expect(c.pending.find((p) => p.id === "starter-personas")?.files ?? []).toEqual(starters);
      expect(await upgradeCommand(root, { by: "pat" }, io().io, B30)).toBe(0);
      for (const f of starters) expect(existsSync(join(root, f)), f).toBe(true);
      expect(changed(root)).toEqual(["org-pack/change-types.yaml", ...starters].sort());
      const once = await contentOf(root, ["org-pack"]);
      expect((await upgradeCheck(root, B30)).pending).toEqual([]);
      expect(await upgradeCommand(root, { by: "pat" }, io().io, B30)).toBe(0);
      expect(await contentOf(root, ["org-pack"])).toEqual(once);
    },
    T,
  );
});

describe("atticus upgrade to beta.30: what a step can't do is said, and waits", () => {
  it(
    "doesn't stamp starter-personas while the starter holds no file, so the files arrive later",
    async () => {
      const root = await b285Metarepo();
      const none = starterPersonasStep(async () => []);
      expect(await none.pending(root)).toEqual([]);
      expect(await none.unavailable!(root)).toBe(true);
      expect(await starterPersonasStep(fixtureStarters).unavailable!(root)).toBe(false);
      // Through the command: the installed starter decides whether the stamp names the step.
      const installed = (await starterPersonaFiles()).length > 0;
      expect(await upgradeCommand(root, { by: "pat" }, io().io, B30)).toBe(0);
      const stamp = parse(await readFile(join(root, ".atticus/metarepo.yaml"), "utf8")) as {
        migrations: string[];
      };
      expect(stamp.migrations.includes("starter-personas")).toBe(installed);
      expect(stamp.migrations).toContain("change-types-quick");
      // Not stamped, the files are written by a later upgrade, once the starter has them.
      if (!installed) {
        const later = starterPersonasStep(fixtureStarters);
        expect(await later.pending(root)).toEqual([
          "org-pack/agents/developer-naysayer.md",
          "org-pack/agents/developer.md",
          "org-pack/skills/define-change/SKILL.md",
        ]);
      }
    },
    T,
  );

  it(
    "says what to add by hand when change-types.yaml keeps its types on one line",
    async () => {
      const flow =
        "schemaVersion: 2\ntypes: [{ id: feature, name: New feature, phases: [define, plan, build], artifacts: [proposal, tasks] }]\n";
      const root = await b285Metarepo(flow);
      const c = await upgradeCheck(root, B30);
      expect(c.pending.map((p) => p.id)).not.toContain("change-types-quick");
      expect(c.problems).toEqual([
        'org-pack/change-types.yaml: its types are written on one line ([ … ]), so the quick change type wasn\'t added. Add it to the list by hand: { id: quick, name: Quick path, phases: [plan, build, release], artifacts: [proposal, specs, design, tasks], lenses: ["true", complete, safe, ship] }',
      ]);
      const r = io();
      expect(await upgradeCommand(root, { by: "pat" }, r.io, B30)).toBe(0);
      expect(r.err.join("\n")).toContain("so the quick change type wasn't added");
      expect(await readFile(join(root, "org-pack/change-types.yaml"), "utf8")).toBe(flow);
      // Said until it is there; a person's own entry ends it.
      expect((await upgradeCheck(root, B30)).problems).toHaveLength(1);
      await writeFile(
        join(root, "org-pack/change-types.yaml"),
        flow.replace(
          "]\n",
          ", { id: quick, name: Quick path, phases: [plan, build], artifacts: [proposal, tasks] }]\n",
        ),
      );
      expect((await upgradeCheck(root, B30)).problems).toBeUndefined();
    },
    T,
  );
});

describe("a new metarepo's org pack", () => {
  it("is seeded with the quick type and the starter personas, never over a file that is there", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-pack-b30-"));
    await mkdir(join(dir, "agents"), { recursive: true });
    await writeFile(join(dir, "agents/developer.md"), "mine\n");
    const written = await writeStartingPack(dir, {
      name: "forge",
      platform: "forge",
      owner: "pat",
      sources: { schemaVersion: 1 },
      defaults: true,
    });
    const starters = (await starterPersonaFiles()).map((f) => f.path);
    expect(starters).toHaveLength(16);
    // No README is seeded from the starter: the org pack has none of its own at its top, and
    // the one in agents/ is the org pack's own.
    expect(starters.filter((f) => /readme/i.test(f))).toEqual([]);
    expect(existsSync(join(dir, "README.md"))).toBe(false);
    expect(await readFile(join(dir, "agents/README.md"), "utf8")).toMatch(/^# Agents\n/);
    expect(written).toEqual(
      expect.arrayContaining([
        ...starters.filter((f) => f !== "agents/developer.md"),
        "change-types.yaml",
      ]),
    );
    expect(written).not.toContain("agents/developer.md");
    expect(await readFile(join(dir, "agents/developer.md"), "utf8")).toBe("mine\n");
    const pack = await loadOrgPack(dir);
    expect(pack.changeTypes.types.filter(quickPathOf).map((t) => t.id)).toEqual(["quick"]);
    // A new metarepo has nothing left for the upgrade's quick-type step to add.
    const { addQuickTypeText } = await import("@maycombhq/core");
    expect(addQuickTypeText(await readFile(join(dir, "change-types.yaml"), "utf8")).changed).toBe(
      false,
    );
    // Without the defaults (a pack copied from elsewhere), nothing is seeded.
    const bare = await mkdtemp(join(tmpdir(), "atticus-pack-b30-"));
    const none = await writeStartingPack(bare, {
      name: "forge",
      platform: "forge",
      owner: "pat",
      sources: { schemaVersion: 1 },
      defaults: false,
    });
    expect(none.some((f) => f.startsWith("skills/") || starters.includes(f))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// The acceptance tests of slice 1, written before the code.
// ---------------------------------------------------------------------------------------------

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

const TYPES_28_5 = join(HERE, "upgrade-b30", "change-types-28.5.yaml");
const NOW = new Date("2026-11-18T09:00:00Z");
const STEPS = ["change-types-quick", "starter-personas"];

/**
 * ADR 0201 part 7 as amended (point 6): seven personas, a naysayer for each, the spec writer and
 * one skill: 16 files.
 */
const PERSONAS = [
  "product-owner",
  "application-architect",
  "domain-architect",
  "ux-analyst",
  "developer",
  "qa",
  "security",
];
const SPEC_WRITER = "agents/spec-writer.md";
const AGENTS = [
  ...PERSONAS.flatMap((p) => [`agents/${p}.md`, `agents/${p}-naysayer.md`]),
  SPEC_WRITER,
];
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
  it("gains the quick type and the 16 starters, loses nothing, and a second run changes nothing", async () => {
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
        // The amendment's point 4: `edit`, so a persona can write the section it owns.
        for (const t of tools) expect(t).toMatch(/^(read|search|edit|atticus\/[a-z][a-z_-]*)$/);
        expect(
          tools.some((t) => t.startsWith("atticus/")),
          `${fm.name} asks no map tool`,
        ).toBe(true);
      }
      // A naysayer owns the table under its persona's heading.
      expect(naysayer.owns).toBe(persona.owns);
    }
    // The spec writer (the amendment's point 6): no role and no hand-off; it may edit.
    const writer = frontmatter(after.get(SPEC_WRITER)!.toString("utf8"));
    expect(writer.name).toBe("spec-writer");
    expect(Object.keys(writer).sort()).toEqual(["description", "name", "owns", "tools"]);
    expect(writer.tools).toContain("edit");
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
