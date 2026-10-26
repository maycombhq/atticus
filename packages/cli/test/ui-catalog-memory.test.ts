import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { catalogMayHaveChanged } from "../src/ui-commands.js";

/**
 * ADR 0119: the app's server keeps the catalog it read until a file change it hears could change
 * it. A file elsewhere (doctor's probe in .atticus/, a run, a question) leaves it kept: reading a
 * large catalog again for nothing made the Set up screen slow (M5's budget, perf.test.ts).
 */
describe("which changed files make the server read the catalog again", () => {
  it("is a file in the catalog, the catalog folder itself, or a folder above it", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-catalog-memory-"));
    for (const p of [
      "catalog/generated/system/ledger.yaml",
      "catalog/curated/curateddecision/cur-1.yaml",
      "catalog/generated",
      "catalog",
    ])
      expect(catalogMayHaveChanged(root, p), p).toBe(true);
    for (const p of [
      ".atticus/.doctor-123",
      ".atticus/me.yaml",
      ".atticus/history/2026-10-26.jsonl",
      "openspec/changes/add-limit/proposal.md",
      "questions/q-1.yaml",
      "catalogue-notes.md",
      "catalog-old/generated/system/ledger.yaml",
    ])
      expect(catalogMayHaveChanged(root, p), p).toBe(false);
  });

  it("is any file in the org pack, whose sources.yaml can move the catalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-catalog-memory-"));
    expect(catalogMayHaveChanged(root, "org-pack/sources.yaml")).toBe(true);
    expect(catalogMayHaveChanged(root, "org-pack")).toBe(true);
  });

  it("follows the catalog where the org pack's layout puts it", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-catalog-memory-"));
    await mkdir(join(root, "org-pack"), { recursive: true });
    await writeFile(
      join(root, "org-pack", "sources.yaml"),
      "schemaVersion: 2\nlayout:\n  catalog: docs/catalog\n",
    );
    expect(catalogMayHaveChanged(root, "docs/catalog/generated/system/ledger.yaml")).toBe(true);
    expect(catalogMayHaveChanged(root, "docs")).toBe(true);
    expect(catalogMayHaveChanged(root, "catalog/generated/system/ledger.yaml")).toBe(false);
  });
});
