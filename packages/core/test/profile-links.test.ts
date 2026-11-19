import { cp, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  declareArrow,
  declaredArrows,
  DeclareError,
  FileChangedError,
  loadOrgPack,
  migrateProfileText,
  Profile,
  PROFILE_SCHEMA_VERSION,
  retireArrow,
} from "../src/index.js";

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
  by: "Ada Example",
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
    ];
    for (const [links, version, said] of cases) {
      const r = Profile.safeParse(v(version, links));
      expect(r.success, JSON.stringify(links)).toBe(false);
      if (said) expect(issues(r)).toContain(said);
    }
  });

  it("is refused by an older Atticus by its version number (beta.28.5's schemaVersion rule)", () => {
    // What beta.28.5 reads a profile's version with: 1 or 2.
    const older = z.object({ schemaVersion: z.union([z.literal(1), z.literal(2)]) });
    expect(older.safeParse(v(3, [link()])).success).toBe(false);
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
  const who = { by: "Ada Example", at: AT, platform: "forge" };

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
        "    by: Ada Example",
        `    at: ${AT}`,
        "",
      ].join("\n"),
    );
    const op = await loadOrgPack(join(root, "org-pack"));
    expect(op.problems).toEqual([]);
    expect(declaredArrows(op)).toEqual([
      {
        ...asked,
        by: "Ada Example",
        at: AT,
        platform: "forge",
        file: "profiles/forge/profile.yaml",
      },
    ]);
    // The same pair again is refused, and nothing is written.
    await expect(declareArrow(root, asked, who)).rejects.toMatchObject({ code: "exists" });
  });

  it("is refused whole when the file changed since it was read", async () => {
    const root = await metarepo();
    const file = join(root, ...PROFILE);
    const real = await readFile(file, "utf8");
    // A writer landing between the read and the write: the write sees other bytes.
    const { writeFileIfUnchanged } = await import("../src/fs.js");
    await expect(writeFileIfUnchanged(file, `${real}# edited\n`, "x")).rejects.toBeInstanceOf(
      FileChangedError,
    );
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
    // The last one takes `links:` with it; the version stays 3.
    expect(await readFile(file, "utf8")).toBe(
      `# a note by hand\n${before.replace("schemaVersion: 1", "schemaVersion: 3")}`,
    );
    await expect(retireArrow(root, asked, { platform: "forge" })).rejects.toBeInstanceOf(
      DeclareError,
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
