import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanEstate } from "../src/index.js";

const MESSY = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/messy");

describe("modules listed in the manifest (ADR 0057)", () => {
  it("take their components and hosts from the manifest instead of being found", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-modules-"));
    const pack = join(root, "org-pack");
    await cp(join(MESSY, "metarepo/org-pack"), pack, { recursive: true });
    const file = join(pack, "profiles/tide/repos.manifest.yaml");
    await writeFile(
      file,
      (await readFile(file, "utf8")).replace(
        "    system: accounts\n",
        `    system: accounts
    modules:
      - { path: accounts-api, component: accounts-svc, hosts: [accounts-api] }
      - { path: accounts-jobs, component: accounts-batch }
`,
      ),
    );
    const scan = await scanEstate({
      root,
      orgPack: pack,
      repos: ["tide-accounts"],
      repoDir: (id) => join(MESSY, "repos", id),
      repoState: async () => ({ commit: "b".repeat(40), dirty: false }),
      cache: null,
      scannedAt: "2026-10-19T12:00:00Z",
    });
    expect(scan.problems).toEqual([]);
    const recs = scan.records as unknown as Record<string, string>[];
    expect(
      recs
        .filter((r) => r.kind === "Component")
        .map((r) => r.id)
        .sort(),
    ).toEqual(["accounts-batch", "accounts-svc", "tide-accounts"]);
    // The call's host is the module's declared host, so it joins that module's component.
    expect(
      recs.filter((r) => r.kind === "Interface").map((r) => `${r.from}->${r.to} ${r.confidence}`),
    ).toEqual(["accounts-batch->accounts-svc verified"]);
  }, 120_000);
});
