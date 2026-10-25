import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { openIndex, type CatalogIndex } from "../src/index.js";

/**
 * The org knowledge the index holds from a wiki snapshot: only the pages the snapshot lists, and
 * once the knowledge scan has read a source only the pages it read; a comment line in a fenced
 * code block is not a heading. The invented Forge Orders docs folder
 * (packages/knowledge/test/fixtures/forge-docs).
 */

const DOCS = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../knowledge/test/fixtures/forge-docs",
);
const SNAP = "knowledge/snapshots/forge-docs/2026-10-25";
const SHA = (c: string) => c.repeat(64);

async function root(o: { scanned?: string[] } = {}): Promise<string> {
  const r = await mkdtemp(join(tmpdir(), "atticus-wiki-index-"));
  await mkdir(join(r, "org-pack"), { recursive: true });
  await mkdir(join(r, SNAP, "runbooks"), { recursive: true });
  for (const p of ["overview.md", "runbooks/restart.md", "runbooks/queues.md"])
    await writeFile(join(r, SNAP, p), readFileSync(join(DOCS, p), "utf8"));
  // A stray copy the snapshot doesn't list (left by hand, or by an older sync).
  await writeFile(join(r, SNAP, "stray.md"), "# Stray\n\n## Notes\n\nNot in the snapshot.\n");
  await writeFile(
    join(r, SNAP, "snapshot.yaml"),
    [
      "schemaVersion: 1",
      "source: forge-docs",
      "date: 2026-10-25",
      "takenAt: 2026-10-25T09:00:00Z",
      "type: markdown-folder",
      "location: docs",
      "pages:",
      `  - { page: overview.md, file: overview.md, sha256: ${SHA("a")} }`,
      `  - { page: runbooks/restart.md, file: runbooks/restart.md, sha256: ${SHA("b")} }`,
      `  - { page: runbooks/queues.md, file: runbooks/queues.md, sha256: ${SHA("c")} }`,
      "",
    ].join("\n"),
  );
  if (o.scanned)
    await writeFile(
      join(r, "knowledge/scan.yaml"),
      [
        "schemaVersion: 1",
        "scannedAt: 2026-10-25T09:05:00Z",
        "snapshots:",
        "  - source: forge-docs",
        "    date: 2026-10-25",
        "    pages: 3",
        "    hashes:",
        ...o.scanned.map((p) => `      ${p}: ${SHA("a")}`),
        "conflicts: []",
        "superseded: []",
        "injections: []",
        "failed: []",
        "",
      ].join("\n"),
    );
  return r;
}

const sections = (ix: CatalogIndex) =>
  (
    ix.db.prepare("SELECT id FROM nodes WHERE kind = 'WikiSection' ORDER BY id").all() as {
      id: string;
    }[]
  ).map((x) => x.id);

describe("wiki sections from a snapshot", () => {
  it("indexes the pages the snapshot lists, and no comment in a code block as a heading", async () => {
    const ix = await openIndex(await root(), { embeddings: "off" });
    const ids = sections(ix);
    expect(ids.some((id) => id.includes("stray"))).toBe(false);
    const restart = ids.filter((id) => id.startsWith("forge-docs/runbooks/restart.md"));
    expect(restart).toEqual([
      "forge-docs/runbooks/restart.md#After the restart",
      "forge-docs/runbooks/restart.md#Before you restart",
      "forge-docs/runbooks/restart.md#Restart",
    ]);
    // The code block stays in its section's words.
    const body = ix.db
      .prepare("SELECT detail FROM nodes WHERE id = ?")
      .get("forge-docs/runbooks/restart.md#Restart") as { detail: string };
    expect(body.detail).toContain("kubectl rollout restart deploy/forge-orders");
    ix.close();
  });

  it("once the knowledge scan has read the source, indexes only the pages it read", async () => {
    const ix = await openIndex(await root({ scanned: ["overview.md", "runbooks/queues.md"] }), {
      embeddings: "off",
    });
    const pages = [...new Set(sections(ix).map((id) => id.split("#")[0]))];
    expect(pages).toEqual(["forge-docs/overview.md", "forge-docs/runbooks/queues.md"]);
    ix.close();
  });
});
