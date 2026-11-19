import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { starterPersonaFiles, writeStartingPack } from "@maycombhq/adopt";
import {
  ChangeTypes,
  DEFAULT_CHANGE_TYPES,
  loadOrgPack,
  QUICK_CHANGE_TYPE,
  quickPathOf,
} from "@maycombhq/core";
import {
  contentOf,
  MIGRATIONS,
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
const STARTER = join(HERE, "fixtures/starter-personas");
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
  for (const f of (await starterPersonaFiles()).map((x) => x.rel))
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

/** The fixture starter folder as the step takes it: each file's org-pack path and its text. */
const fixtureStarters = async () =>
  (await starterPersonaFiles(STARTER)).map((f) => ({ path: f.rel, text: f.bytes }));

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
        expect(
          (await readFile(join(root, f))).equals(
            await readFile(join(STARTER, f.replace("org-pack/", ""))),
          ),
        ).toBe(true);
      expect(await readFile(join(root, "org-pack/agents/developer.md"), "utf8")).toBe(mine);
      // Only what the starter's agents/ and skills/ hold: its README stays where it is.
      expect(existsSync(join(root, "org-pack/README.md"))).toBe(false);
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
      const starters = (await starterPersonaFiles()).map((f) => `org-pack/${f.rel}`);
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
      starterPersonas: STARTER,
    });
    expect(written).toEqual(
      expect.arrayContaining([
        "agents/developer-naysayer.md",
        "skills/define-change/SKILL.md",
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
      starterPersonas: STARTER,
    });
    expect(none.some((f) => f.startsWith("skills/"))).toBe(false);
  });
});
