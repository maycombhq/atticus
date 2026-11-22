import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The lint script `scripts/check-frozen-files.mjs` (docs/plan/v31.md), tested as a module.
 * The estate join's heuristics (`packages/core/src/facts-join*.ts`) may not grow: an arrow the
 * join reads wrongly is fixed by a reading rule, a pairing or a person's correction, which live
 * in the metarepo, not by more matching code in Atticus.
 */

interface Problem {
  file: string;
  lines: number;
  ceiling: number;
  missing?: boolean;
  files?: string[];
}
interface Lint {
  FROZEN: { file: string; ceiling: number; why: string }[];
  check(root?: string): Problem[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "../../../scripts/check-frozen-files.mjs");
const lint = async () => (await import(pathToFileURL(SCRIPT).href)) as Lint;

const text = (lines: number) =>
  Array.from({ length: lines }, (_, i) => `// line ${i + 1}`).join("\n") + "\n";
async function repoWith(lines: number, more: Record<string, number> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "b31-frozen-"));
  await mkdir(join(root, "packages/core/src"), { recursive: true });
  if (lines >= 0) await writeFile(join(root, "packages/core/src/facts-join.ts"), text(lines));
  for (const [name, n] of Object.entries(more))
    await writeFile(join(root, "packages/core/src", name), text(n));
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
      {
        file: "packages/core/src/facts-join.ts",
        lines: ceiling + 1,
        ceiling,
        files: ["packages/core/src/facts-join.ts"],
      },
    ]);
    // CRLF line ends count the same.
    const crlf = await repoWith(-1);
    await writeFile(
      join(crlf, "packages/core/src/facts-join.ts"),
      text(ceiling + 1).replace(/\n/g, "\r\n"),
    );
    expect(check(crlf)).toHaveLength(1);
  });

  it("counts code moved into a new facts-join-*.ts with the file, and not other files", async () => {
    const { FROZEN, check } = await lint();
    const ceiling = FROZEN.find((f) => f.file === "packages/core/src/facts-join.ts")!.ceiling;
    const moved = await repoWith(ceiling - 10, { "facts-join-routes.ts": 11 });
    expect(check(moved)).toEqual([
      {
        file: "packages/core/src/facts-join.ts",
        lines: ceiling + 1,
        ceiling,
        files: ["packages/core/src/facts-join-routes.ts", "packages/core/src/facts-join.ts"],
      },
    ]);
    expect(check(await repoWith(ceiling, { "facts.ts": 500 }))).toEqual([]);
  });

  it("fails when the frozen file is gone, so a rename updates the list on purpose", async () => {
    const { check } = await lint();
    expect(check(await repoWith(-1, { "join-renamed.ts": 10 }))).toEqual([
      { file: "packages/core/src/facts-join.ts", lines: 0, ceiling: 5424, missing: true },
    ]);
  });

  it("the repo as it is passes", async () => {
    const { check } = await lint();
    expect(check()).toEqual([]);
  });
});
