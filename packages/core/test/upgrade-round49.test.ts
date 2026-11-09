import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  catalogDirOf,
  layoutOf,
  listQuestions,
  loadOrgPack,
  migrateChangeTypesText,
  migrateGatesText,
  migrateQuestions,
  migrateRolesText,
  migrateRuntimeText,
  orgPackDirOf,
  parseRecord,
  readQuestion,
  Sources,
} from "../src/index.js";

// Review round 49 (upgrade): what `atticus upgrade` and the readers do with files an earlier or a
// later Atticus wrote.

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const V1 = () => readFile(join(FIXTURES, "context/questions/q-0f1e2d3c4b5a.yaml"), "utf8");

async function withQuestions(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-r49-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  await mkdir(join(root, "questions"), { recursive: true });
  for (const [n, t] of Object.entries(files)) await writeFile(join(root, "questions", n), t);
  return root;
}

describe("migrateQuestions writes back the file it read (round 49)", () => {
  it("leaves a stale copy alone and never writes it over the live question", async () => {
    const v1 = await V1();
    const live = v1.replace("schemaVersion: 1", "schemaVersion: 6").replace("pat", "sam");
    const root = await withQuestions({
      "q-0f1e2d3c4b5a.yaml": live,
      "q-0f1e2d3c4b5a copy.yaml": v1,
    });
    const problems: { file: string; message: string }[] = [];
    expect(await migrateQuestions(root, { dryRun: true, problems })).toEqual([]);
    expect(problems.map((p) => p.file)).toEqual(["questions/q-0f1e2d3c4b5a copy.yaml"]);
    expect(problems[0]!.message).toMatch(/q-0f1e2d3c4b5a\.yaml/);
    expect(await migrateQuestions(root)).toEqual([]);
    expect(await readFile(join(root, "questions/q-0f1e2d3c4b5a.yaml"), "utf8")).toBe(live);
    expect(await readFile(join(root, "questions/q-0f1e2d3c4b5a copy.yaml"), "utf8")).toBe(v1);
  });

  it("makes no duplicate of a renamed file, and a second run has nothing to do", async () => {
    const v1 = await V1();
    const root = await withQuestions({ "old-copy.yaml": v1 });
    expect(await migrateQuestions(root)).toEqual([]);
    expect(await readdir(join(root, "questions"))).toEqual(["old-copy.yaml"]);
    expect(await migrateQuestions(root, { dryRun: true })).toEqual([]);
  });

  it("still rewrites a question whose file is named by its id", async () => {
    const v1 = await V1();
    const root = await withQuestions({ "q-0f1e2d3c4b5a.yaml": v1 });
    expect(await migrateQuestions(root)).toEqual(["questions/q-0f1e2d3c4b5a.yaml"]);
    expect(await readFile(join(root, "questions/q-0f1e2d3c4b5a.yaml"), "utf8")).toMatch(
      /schemaVersion: 6/,
    );
  });
});

describe("a file from a newer Atticus is said as one (round 49)", () => {
  it("a question at a version above this one's", async () => {
    const v9 = (await V1()).replace("schemaVersion: 1", "schemaVersion: 9");
    const root = await withQuestions({ "q-0f1e2d3c4b5a.yaml": v9 });
    await expect(readQuestion(root, "q-0f1e2d3c4b5a")).rejects.toThrow(
      /written by a newer Atticus \(question version 9\); install it/,
    );
    const l = await listQuestions(root);
    expect(l.problems).toHaveLength(1);
    expect(l.problems[0]!.message).toMatch(
      /^written by a newer Atticus \(question version 9\); install it/,
    );
  });

  it("a catalog record at a version above this one's", () => {
    const r = parseRecord({ schemaVersion: 9, kind: "System", id: "ledger", extra: 1 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues).toEqual([
      {
        path: "schemaVersion",
        message: "written by a newer Atticus (record version 9); install it to read this record",
      },
    ]);
  });
});

describe("sources.yaml: a wiki's ref and the layout (round 49)", () => {
  const wiki = (ref: string) => ({
    schemaVersion: 3,
    wikis: [{ id: "team-wiki", type: "git", location: "https://git.example/w.git", ref }],
  });

  it("takes the refs git takes, as beta.18 did", () => {
    for (const ref of ["v2.1+hotfix", "release_1", "feature@x", "_tmp", "+main", "a/b-c.d"])
      expect(Sources.safeParse(wiki(ref)).success, ref).toBe(true);
  });

  it("refuses what git refuses, and anything that reads as an option", () => {
    for (const ref of [
      "",
      "-x",
      "--upload-pack=x",
      "a..b",
      "a b",
      "a\tb",
      "a~1",
      "a^",
      "a:b",
      "a?",
      "a*",
      "a[b",
      "a\\b",
      "a@{1}",
      "@",
      "a/.b",
      "a.lock",
      "a/",
      "a.",
      "a//b",
      "/a",
    ])
      expect(Sources.safeParse(wiki(ref)).success, JSON.stringify(ref)).toBe(false);
  });

  async function withSources(text: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "atticus-r49-"));
    await mkdir(join(root, "org-pack"), { recursive: true });
    await writeFile(join(root, "org-pack/sources.yaml"), text);
    return root;
  }

  it("reads the layout of a beta.18 file with a ref like v2.1+hotfix", async () => {
    const root = await withSources(
      "schemaVersion: 3\nlayout:\n  catalog: kb/catalog\n  openspec: openspec\nwikis:\n  - id: team-wiki\n    type: git\n    location: https://git.example/forge/wiki.git\n    ref: v2.1+hotfix\n",
    );
    expect(layoutOf(root)).toEqual({ catalog: "kb/catalog", openspec: "openspec" });
    expect(catalogDirOf(root)).toBe(join(root, "kb", "catalog"));
  });

  it("keeps the layout when another field is wrong, and orgpack validate says so", async () => {
    const root = await withSources(
      "schemaVersion: 3\nlayout:\n  catalog: kb/catalog\n  openspec: docs/openspec\nwikis:\n  - id: team-wiki\n    type: carrier-pigeon\n    location: x\n",
    );
    expect(layoutOf(root)).toEqual({ catalog: "kb/catalog", openspec: "docs/openspec" });
    const op = await loadOrgPack(orgPackDirOf(root));
    expect(op.problems.some((p) => p.file.endsWith("sources.yaml"))).toBe(true);
  });

  it("a bad layout path on its own falls back for that folder only", async () => {
    const root = await withSources(
      "schemaVersion: 3\nlayout:\n  catalog: ../outside\n  openspec: docs/openspec\n",
    );
    expect(layoutOf(root)).toEqual({ catalog: "catalog", openspec: "docs/openspec" });
  });
});

describe("migrations keep long lines as they are (round 49)", () => {
  const long = `A description long enough that the YAML library would fold it onto a second line if it were given its default line width of eighty characters.`;
  it.each([
    [
      "change-types",
      migrateChangeTypesText,
      `schemaVersion: 1\ntypes:\n  - id: feature\n    description: ${long}\n`,
    ],
    [
      "gates",
      migrateGatesText,
      `schemaVersion: 1\ngates:\n  - id: g\n    description: ${long}\n    maxAuthorRounds: 2\n`,
    ],
    ["runtime", migrateRuntimeText, `{ schemaVersion: 1, note: "${long}" }\n`],
    ["roles", migrateRolesText, `{ schemaVersion: 1, note: "${long}" }\n`],
  ])("%s", (_n, migrate, text) => {
    const r = migrate(text);
    expect(r.changed).toBe(true);
    expect(r.text).toContain(long);
  });
});
