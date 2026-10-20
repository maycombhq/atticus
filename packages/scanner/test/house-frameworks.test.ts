import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanEstate } from "../src/index.js";

/**
 * The scan names house frameworks no model covers, and models that read nothing in the repos
 * that use them (ADR 0066). The invented Harbor estate: two services on the Harbor kit.
 */
const CASE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/onboard-eval/harbor-kit",
);
const T = 120_000;

async function estate(model?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-harbor-"));
  const op = join(root, "org-pack");
  await mkdir(join(op, "profiles/harbor"), { recursive: true });
  await writeFile(
    join(op, "pack.yaml"),
    "schemaVersion: 1\nname: harbor\nversion: 0.1.0\nowner: team-platform\n",
  );
  await writeFile(
    join(op, "profiles/harbor/repos.manifest.yaml"),
    [
      "schemaVersion: 1",
      "platform: harbor",
      "repos:",
      ...["harbor-orders", "harbor-billing"].flatMap((id) => [
        `  - id: ${id}`,
        `    url: https://git.example.com/harbor/${id}.git`,
        "    type: spring-boot",
        "    owner: team-harbor",
      ]),
      "",
    ].join("\n"),
  );
  if (model) {
    await mkdir(join(op, "frameworks"));
    await writeFile(join(op, "frameworks/harbor-kit.yaml"), model);
  }
  return root;
}

const scan = (root: string) =>
  scanEstate({
    root,
    repoDir: (id) => join(CASE, "repos", id),
    repoState: async () => ({ commit: "a".repeat(40), dirty: false }),
    cache: null,
    inputsDir: null,
    scannedAt: "2026-10-20T12:00:00Z",
  });

describe("house frameworks in the scan (ADR 0066)", () => {
  it(
    "names a house framework several repos import that no model covers, with the command",
    async () => {
      const s = await scan(await estate());
      expect(s.unmodelled).toEqual([
        {
          framework: "harbor.kit",
          name: "harbor-kit",
          language: "java",
          repos: ["harbor-billing", "harbor-orders"],
          modules: ["harbor.kit.http", "harbor.kit.web"],
        },
      ]);
      expect(s.coverage.map((c) => c.redraftFrameworks)).toEqual([[], []]);
    },
    T,
  );

  it(
    "says nothing once a model covers it and reads something there",
    async () => {
      const s = await scan(await estate(await readFile(join(CASE, "reference.yaml"), "utf8")));
      expect(s.problems).toEqual([]);
      expect(s.unmodelled).toEqual([]);
      expect(s.coverage.map((c) => [c.repo, c.redraftFrameworks])).toEqual([
        ["harbor-orders", []],
        ["harbor-billing", []],
      ]);
    },
    T,
  );

  it(
    "lists a model for re-drafting where it reads nothing in a repo that imports its packages",
    async () => {
      // The kit renamed @HarborApi and Dock since this model was written: it reads nothing.
      const stale = [
        "schemaVersion: 1",
        "name: harbor-kit",
        "packages: [harbor.kit]",
        "annotations:",
        "  - { name: HarborService, means: [RestController, RequestMapping], attributes: { base: path }, source: { kind: person, ref: '@harbor-platform' } }",
        "",
      ].join("\n");
      const s = await scan(await estate(stale));
      expect(s.unmodelled).toEqual([]);
      expect(s.coverage.map((c) => [c.repo, c.redraftFrameworks])).toEqual([
        ["harbor-orders", [{ framework: "harbor-kit", why: "reads-nothing" }]],
        ["harbor-billing", [{ framework: "harbor-kit", why: "reads-nothing" }]],
      ]);
    },
    T,
  );
});
