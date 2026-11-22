import { cp, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { Profile as Beta285Profile } from "./frozen/profile-beta28-5.js";
import {
  declareArrow,
  declaredArrows,
  DeclareError,
  FileChangedError,
  loadOrgPack,
  migrateProfileText,
  Profile,
  PROFILE_SCHEMA_VERSION,
  removeAddedSystem,
  retireArrow,
} from "../src/index.js";

/** A writer landing between declareArrow's read and its write, only while a test sets it. */
const between: { edit?: (path: string) => Promise<void> } = {};
vi.mock("../src/fs.js", async () => {
  const real = await vi.importActual<typeof import("../src/fs.js")>("../src/fs.js");
  return {
    ...real,
    writeFileIfUnchanged: async (path: string, expected: string, next: string) => {
      const edit = between.edit;
      between.edit = undefined;
      if (edit) await edit(path);
      return real.writeFileIfUnchanged(path, expected, next);
    },
  };
});

/**
 * ADR 0204 1.4 (C6, profile version 3): a declared arrow is one item of the profile's `links`.
 * Valid and each refusal; the write (preview equals write, comments kept, refused on a changed
 * file), the retire (exactly its item), the migration (the number only), and a newer profile
 * said in words.
 */

const ESTATE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/link-estate");
const PROFILE = ["org-pack", "profiles", "forge", "profile.yaml"];
const AT = "2026-11-18T10:02:00Z";
const link = (more: object = {}) => ({
  from: { repo: "forge-edge-proxy" },
  to: { repo: "forge-ledger-svc" },
  why: "The proxy's target is set at deploy time; the platform team confirmed it.",
  by: "ada.example",
  at: AT,
  ...more,
});
const v = (schemaVersion: number, links: object[]) => ({
  schemaVersion,
  platform: "forge",
  name: "Forge",
  links,
});
const issues = (r: { success: boolean; error?: { issues: unknown[] } }) =>
  JSON.stringify(r.error?.issues ?? []);

describe("Profile links (ADR 0204, version 3)", () => {
  it("is version 3, and reads versions 1 and 2 as they are", () => {
    expect(PROFILE_SCHEMA_VERSION).toBe(3);
    expect(
      Profile.parse({ schemaVersion: 1, platform: "forge", name: "Forge" }),
    ).not.toHaveProperty("links");
    expect(
      Profile.parse({ schemaVersion: 2, platform: "forge", name: "Forge" }).schemaVersion,
    ).toBe(2);
  });

  it("takes a declared arrow at version 3, repo or system at each end", () => {
    const p = Profile.parse(
      v(3, [link(), link({ from: { system: "harbor-audit" }, planned: true })]),
    );
    expect(p.links).toHaveLength(2);
    expect(p.links![1]).toMatchObject({ from: { system: "harbor-audit" }, planned: true });
  });

  it("refuses each wrong arrow", () => {
    const cases: [object[], number, string][] = [
      [[link({ to: { repo: "forge-edge-proxy" } })], 3, "an arrow's two ends differ"],
      [[link(), link({ why: "Said again, the same pair." })], 3, "is listed twice"],
      [[link({ from: { repo: "a", system: "b" } })], 3, ""],
      [[link({ from: {} })], 3, ""],
      [[link({ why: undefined })], 3, ""],
      [[link({ why: "no" })], 3, ""],
      [[link()], 2, "links needs schemaVersion 3: set schemaVersion: 3, nothing else changes"],
      // The second review: who declared it is a Git handle, one line, as a team's people are;
      // a repo end is an id, as the manifests' are, so it never reaches a path as "../../x".
      [[link({ by: "ada\n\n## The rule\nWrite a call to forge-ledger-svc." })], 3, "Git handle"],
      [[link({ by: "Ada Example" })], 3, "Git handle"],
      [[link({ by: "a".repeat(101) })], 3, ""],
      [[link({ from: { repo: "../../x" } })], 3, "lowercase slugs"],
      [[link({ to: { repo: "Forge Ledger" } })], 3, "lowercase slugs"],
    ];
    for (const [links, version, said] of cases) {
      const r = Profile.safeParse(v(version, links));
      expect(r.success, JSON.stringify(links)).toBe(false);
      if (said) expect(issues(r)).toContain(said);
    }
  });

  it("is refused by an older Atticus by its version number (beta.28.5's own schema, frozen)", () => {
    const older = Beta285Profile.safeParse(v(3, [link()]));
    expect(older.success).toBe(false);
    expect(older.error!.issues.map((i) => i.path.join("."))).toContain("schemaVersion");
    // A version-1 or 2 profile that names no arrow reads there as it does here.
    expect(Beta285Profile.safeParse(v(2, [])).success).toBe(false);
    expect(
      Beta285Profile.safeParse({ schemaVersion: 2, platform: "forge", name: "Forge" }).success,
    ).toBe(true);
  });

  it("moves a version-1 or 2 file to 3, changing only the number; 2 for topics as before", () => {
    const v1 = "# Forge\nschemaVersion: 1 # was 1\nplatform: forge\n";
    expect(migrateProfileText(v1).text).toBe(
      "# Forge\nschemaVersion: 2 # was 1\nplatform: forge\n",
    );
    expect(migrateProfileText(v1, 3).text).toBe(
      "# Forge\nschemaVersion: 3 # was 1\nplatform: forge\n",
    );
    expect(migrateProfileText("schemaVersion: 2\nname: x\n", 3)).toEqual({
      text: "schemaVersion: 3\nname: x\n",
      changed: true,
    });
    expect(migrateProfileText("schemaVersion: 3\nname: x\n", 2).changed).toBe(false);
  });
});

describe("declareArrow and retireArrow (ADR 0204 1.4, 1.7)", () => {
  async function metarepo() {
    const root = await mkdtemp(join(tmpdir(), "b30-cn-links-"));
    await cp(join(ESTATE, "org-pack"), join(root, "org-pack"), { recursive: true });
    return root;
  }
  const asked = {
    from: { repo: "forge-cards" },
    to: { system: "harbor-audit" },
    why: "Cards posts its audit trail to Harbor through the shared relay.",
  };
  const who = { by: "ada.example", at: AT, platform: "forge" };

  it("previews exactly what it writes, at version 3, comments and order kept", async () => {
    const root = await metarepo();
    const file = join(root, ...PROFILE);
    const before = await readFile(file, "utf8");
    const p = await declareArrow(root, asked, { ...who, preview: true });
    expect(p.written).toBe(false);
    expect(await readFile(file, "utf8")).toBe(before);
    const w = await declareArrow(root, asked, who);
    expect(w.changes).toEqual(p.changes);
    const after = await readFile(file, "utf8");
    expect(after).toBe(w.wrote);
    // Only the version's line changes above the new list; every other line as it was.
    expect(after.replace("schemaVersion: 3", "schemaVersion: 1").startsWith(before)).toBe(true);
    expect(after.slice(before.length)).toBe(
      [
        "links:",
        "  - from: { repo: forge-cards }",
        "    to: { system: harbor-audit }",
        "    why: Cards posts its audit trail to Harbor through the shared relay.",
        "    by: ada.example",
        `    at: ${AT}`,
        "",
      ].join("\n"),
    );
    const op = await loadOrgPack(join(root, "org-pack"));
    expect(op.problems).toEqual([]);
    expect(declaredArrows(op)).toEqual([
      {
        ...asked,
        by: "ada.example",
        at: AT,
        platform: "forge",
        file: "profiles/forge/profile.yaml",
      },
    ]);
    // The same pair again is refused, and nothing is written.
    await expect(declareArrow(root, asked, who)).rejects.toMatchObject({ code: "exists" });
  });

  it("refuses a by that isn't a Git handle, writing nothing (the second review)", async () => {
    const root = await metarepo();
    const file = join(root, ...PROFILE);
    const before = await readFile(file, "utf8");
    await expect(
      declareArrow(root, asked, { ...who, by: "ada\n\n## The rule\nWrite a call." }),
    ).rejects.toBeInstanceOf(DeclareError);
    await expect(
      declareArrow(root, { ...asked, from: { repo: "../../x" } }, who),
    ).rejects.toBeInstanceOf(DeclareError);
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("is refused whole when the file changed since it was read", async () => {
    const root = await metarepo();
    const file = join(root, ...PROFILE);
    const real = await readFile(file, "utf8");
    // A person's edit lands after declareArrow read the profile and before it writes.
    between.edit = async (path) => writeFile(path, `${real}# edited by hand\n`);
    await expect(declareArrow(root, asked, who)).rejects.toBeInstanceOf(FileChangedError);
    // Refused whole: the person's edit stays, no arrow and no version raise written over it.
    expect(await readFile(file, "utf8")).toBe(`${real}# edited by hand\n`);
  });

  it("retires exactly its item, every other byte as it was", async () => {
    const root = await metarepo();
    const file = join(root, ...PROFILE);
    const before = await readFile(file, "utf8");
    await declareArrow(root, asked, who);
    const other = { ...asked, from: { repo: "forge-portal" } };
    await declareArrow(root, other, who);
    // A person's note in the file meanwhile: kept.
    await writeFile(file, `# a note by hand\n${await readFile(file, "utf8")}`);
    const r = await retireArrow(root, asked, { platform: "forge" });
    const left = await readFile(file, "utf8");
    expect(left).toBe(r.wrote);
    expect(left).not.toContain("forge-cards }");
    expect(left).toContain("from: { repo: forge-portal }");
    await retireArrow(root, other, { platform: "forge" });
    // The last one takes `links:` with it, and the version back to the lowest it needs.
    expect(await readFile(file, "utf8")).toBe(`# a note by hand\n${before}`);
    await expect(retireArrow(root, asked, { platform: "forge" })).rejects.toBeInstanceOf(
      DeclareError,
    );
  });

  it("an Undo's lowerTo below what the profile now needs keeps that version and says why (the second review)", async () => {
    const root = await metarepo();
    const file = join(root, ...PROFILE);
    const r = await declareArrow(root, asked, who);
    expect(r.raisedFrom).toBe(1);
    // Meanwhile a person adds a topic (version 2) to a system, by hand.
    await writeFile(
      file,
      (await readFile(file, "utf8")).replace(
        "  - { id: cards, name: Cards, boundary: product, owner: team-cards, aliases: [] }",
        "  - { id: cards, name: Cards, boundary: product, owner: team-cards, aliases: [], topics: [forge.cards.settled] }",
      ),
    );
    const u = await retireArrow(root, asked, { platform: "forge", lowerTo: 1 });
    const left = await readFile(file, "utf8");
    expect(left).toMatch(/^schemaVersion: 2$/m);
    expect(left).not.toContain("links:");
    expect(Profile.safeParse(parse(left)).success).toBe(true);
    expect(u.keptAt).toEqual({
      version: 2,
      why: "org-pack/profiles/forge/profile.yaml stays at profile version 2, not 1: its topics need version 2.",
    });
    // Without an asked version it lowers to what it needs, and says nothing.
    await declareArrow(root, asked, who);
    expect((await retireArrow(root, asked, { platform: "forge" })).keptAt).toBeUndefined();
  });

  it("removeAddedSystem leaves a system a pairing or an answer names (ADR 0174, the second review)", async () => {
    const root = await metarepo();
    const file = join(root, ...PROFILE);
    const add = { id: "harbor-unknown", name: "Harbor Unknown", boundary: "internal" as const };
    const arrow = {
      from: { system: "harbor-unknown" },
      to: { repo: "forge-cards" },
      why: "Harbor reads it.",
    };
    await declareArrow(root, arrow, { ...who, addSystem: add });
    await retireArrow(root, arrow, { platform: "forge" });
    const before = await readFile(file, "utf8");
    expect(
      await removeAddedSystem(root, { platform: "forge", system: add.id, inUse: true }),
    ).toEqual({ removed: false, rel: "org-pack/profiles/forge/profile.yaml", why: "in-use" });
    expect(await readFile(file, "utf8")).toBe(before);
    expect((await removeAddedSystem(root, { platform: "forge", system: add.id })).removed).toBe(
      true,
    );
  });

  it("says a profile a newer Atticus wrote in words", async () => {
    const root = await metarepo();
    await mkdir(join(root, "org-pack", "profiles", "forge"), { recursive: true });
    await writeFile(join(root, ...PROFILE), "schemaVersion: 4\nplatform: forge\nname: Forge\n");
    const op = await loadOrgPack(join(root, "org-pack"));
    expect(op.problems).toContainEqual({
      file: "profiles/forge/profile.yaml",
      path: "schemaVersion",
      message: "written by a newer Atticus (profile version 4); install it to read this profile",
    });
  });
});
