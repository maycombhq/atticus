import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The lint script `scripts/check-frozen-files.mjs` (v31 plan, section 0), tested as a module.
 * The estate join's heuristics (`packages/core/src/facts-join.ts`) may not grow: an arrow the
 * join reads wrongly is fixed by a reading rule, a pairing or a person's correction, which live
 * in the metarepo, not by more matching code in Atticus.
 */

interface Problem {
  file: string;
  lines: number;
  ceiling: number;
}
interface Lint {
  FROZEN: { file: string; ceiling: number; why: string }[];
  check(root?: string): Problem[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "../../../scripts/check-frozen-files.mjs");
const lint = async () => (await import(pathToFileURL(SCRIPT).href)) as Lint;

async function repoWith(lines: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "b31-frozen-"));
  await mkdir(join(root, "packages/core/src"), { recursive: true });
  await writeFile(
    join(root, "packages/core/src/facts-join.ts"),
    Array.from({ length: lines }, (_, i) => `// line ${i + 1}`).join("\n") + "\n",
  );
  return root;
}

describe("frozen files may not grow", () => {
  it("lists the estate join, with a ceiling and the reason", async () => {
    const { FROZEN } = await lint();
    const join_ = FROZEN.find((f) => f.file === "packages/core/src/facts-join.ts");
    expect(join_).toBeDefined();
    expect(join_!.ceiling).toBeGreaterThan(0);
    expect(join_!.why.length).toBeGreaterThan(20);
  });

  it("passes at the ceiling and below, and fails one line over it", async () => {
    const { FROZEN, check } = await lint();
    const ceiling = FROZEN.find((f) => f.file === "packages/core/src/facts-join.ts")!.ceiling;
    expect(check(await repoWith(ceiling))).toEqual([]);
    expect(check(await repoWith(ceiling - 40))).toEqual([]);
    expect(check(await repoWith(ceiling + 1))).toEqual([
      { file: "packages/core/src/facts-join.ts", lines: ceiling + 1, ceiling },
    ]);
  });

  it("the repo as it is passes", async () => {
    const { check } = await lint();
    expect(check()).toEqual([]);
  });
});
