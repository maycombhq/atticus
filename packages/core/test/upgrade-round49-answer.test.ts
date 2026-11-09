import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { migrateQuestions } from "../src/index.js";

// Review round 49 (upgrade): an answer that lands while `atticus upgrade` rewrites the question
// is never lost. The hook runs once, right after the migration has read the file.
const hook = vi.hoisted(() => ({
  after: undefined as undefined | ((path: string) => Promise<void>),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const m = await importOriginal<typeof import("node:fs/promises")>();
  const readFile = (async (...a: Parameters<typeof m.readFile>) => {
    const r = await m.readFile(...a);
    const h = hook.after;
    if (h) await h(String(a[0]));
    return r;
  }) as typeof m.readFile;
  return { ...m, default: { ...m, readFile }, readFile };
});

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

describe("migrateQuestions and an answer landing meanwhile (round 49)", () => {
  it("keeps the answer", async () => {
    const v1 = await readFile(join(FIXTURES, "context/questions/q-0f1e2d3c4b5a.yaml"), "utf8");
    const root = await mkdtemp(join(tmpdir(), "atticus-r49-"));
    await mkdir(join(root, "org-pack"), { recursive: true });
    await mkdir(join(root, "questions"), { recursive: true });
    const file = join(root, "questions", "q-0f1e2d3c4b5a.yaml");
    await writeFile(file, v1);
    const answered = v1.replace(
      "Northwind Pay runs it, through its screening API",
      "The risk team runs it now",
    );
    hook.after = async (path) => {
      if (resolve(path) !== resolve(file)) return;
      hook.after = undefined;
      await writeFile(file, answered);
    };
    await migrateQuestions(root);
    hook.after = undefined;
    const now = await readFile(file, "utf8");
    expect(now).toContain("The risk team runs it now");
    expect(now).toMatch(/schemaVersion: 6/);
  });
});
