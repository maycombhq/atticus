import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanEstate } from "../src/index.js";

const MESSY = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/messy");

describe("a framework model is used only while its own tests pass (ADR 0055)", () => {
  it("leaves out a model whose test fails, says why, and reads nothing through it", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-gate-"));
    const pack = join(root, "org-pack");
    await cp(join(MESSY, "metarepo/org-pack"), pack, { recursive: true });
    const file = join(pack, "frameworks/tide-lantern.yaml");
    const yaml = await readFile(file, "utf8");
    await writeFile(file, yaml.replace('"endpoint POST /limits"', '"endpoint PUT /limits"'));
    const scan = await scanEstate({
      root,
      orgPack: pack,
      repos: ["tide-web"],
      repoDir: (id) => join(MESSY, "repos", id),
      repoState: async () => ({ commit: "b".repeat(40), dirty: false }),
      cache: null,
      scannedAt: "2026-10-19T12:00:00Z",
    });
    expect(scan.problems.map((p) => `${p.source}: ${p.message}`)).toEqual([
      'framework tide-lantern: test "the BFF\'s routes": expected "endpoint PUT /limits"; got: endpoint GET /statements/{id} inferred, endpoint POST /limits inferred; the model is not used',
    ]);
    expect(scan.records.filter((r) => r.kind === "Unresolved")).toEqual([]);
  }, 120_000);
});
