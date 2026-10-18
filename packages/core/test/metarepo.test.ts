import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { changesDirOf, changesRelOf } from "../src/index.js";

function metarepo(orgPack: string, sources?: string): string {
  const root = mkdtempSync(join(tmpdir(), "atticus-metarepo-"));
  mkdirSync(join(root, ...orgPack.split("/")), { recursive: true });
  if (sources) writeFileSync(join(root, ...orgPack.split("/"), "sources.yaml"), sources);
  return root;
}

describe("change folders through the layout", () => {
  it("is openspec/changes in a metarepo made by init", () => {
    const root = metarepo("org-pack");
    expect(changesRelOf(root)).toBe("openspec/changes");
    expect(changesDirOf(root)).toBe(join(root, "openspec", "changes"));
  });

  it("follows sources.yaml layout.openspec in a repo adopted in place", () => {
    const root = metarepo(
      ".atticus/org-pack",
      "schemaVersion: 1\nlayout:\n  openspec: .atticus/openspec\n  catalog: .atticus/catalog\n",
    );
    expect(changesRelOf(root)).toBe(".atticus/openspec/changes");
    expect(changesDirOf(root)).toBe(join(root, ".atticus", "openspec", "changes"));
  });

  it("uses the repo's own OpenSpec folder when the layout points at it", () => {
    const root = metarepo(
      ".atticus/org-pack",
      "schemaVersion: 1\nlayout:\n  openspec: docs/openspec\n",
    );
    expect(changesRelOf(root)).toBe("docs/openspec/changes");
  });
});
