import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { addCreatedToUndoCopy, applyUndo, planUndo, takeUndoCopy } from "../src/index.js";

/**
 * ADR 0210 part 3: a write that kept hand edits as curated decisions puts the decisions it made
 * into its own undo copy, so `atticus catalog undo` takes them away with the write. Invented
 * Forge files; no network.
 */
const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

describe("addCreatedToUndoCopy", () => {
  it("lists a file the command created in its copy, and an undo removes it", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-undo-add-"));
    roots.push(root);
    const undoDir = join(root, ".index", "undo");
    const rec = join(root, "catalog", "generated", "component", "payments-api.yaml");
    await mkdir(join(root, "catalog", "generated", "component"), { recursive: true });
    await writeFile(rec, "id: payments-api\n");
    const n = await takeUndoCopy(root, undoDir, "atticus verify forge-payments --write", [
      { path: rec, text: "id: payments-api\nruntime: openshift\n" },
    ]);
    expect(n).toBe(1);
    await writeFile(rec, "id: payments-api\nruntime: openshift\n");
    const dec = join(root, "catalog", "curated", "curateddecision", "cd-edit-assert-x.yaml");
    await mkdir(join(root, "catalog", "curated", "curateddecision"), { recursive: true });
    await writeFile(dec, "id: cd-edit-assert-x\n");
    await addCreatedToUndoCopy(root, undoDir, n!, [dec]);
    const plan = await planUndo(undoDir);
    if ("problem" in plan) throw new Error(plan.problem);
    expect(plan.files.map((f) => [f.path, f.to])).toEqual([
      ["catalog/curated/curateddecision/cd-edit-assert-x.yaml", "absent"],
      ["catalog/generated/component/payments-api.yaml", "file"],
    ]);
    await applyUndo(root, undoDir, plan, "atticus catalog undo");
    expect(existsSync(dec)).toBe(false);
    expect(await readFile(rec, "utf8")).toBe("id: payments-api\n");
  });
});
