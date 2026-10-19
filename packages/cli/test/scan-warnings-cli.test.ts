import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanCommand } from "../src/scan-commands.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const T = 180_000;
const BIG = "src/api/vendor.min.ts";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

function git(cwd: string, ...args: string[]) {
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "init.defaultBranch=main",
    ].concat(args),
    { cwd, stdio: "pipe" },
  );
}

/** The Forge metarepo with base clones; forge-portal-ui has a committed 5 MB bundle. */
async function forgeWithBigFile(): Promise<string> {
  const top = await mkdtemp(join(tmpdir(), "atticus-scan-warnings-"));
  await cp(join(FIXTURES, "forge"), top, { recursive: true });
  const root = join(top, "metarepo");
  for (const id of await readdir(join(top, "repos"))) {
    const dir = join(root, "workspace", id);
    await cp(join(top, "repos", id), dir, { recursive: true });
    if (id === "forge-portal-ui") await writeFile(join(dir, BIG), "x".repeat(5 * 1024 * 1024 + 1));
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "fixture");
  }
  return root;
}

describe("atticus scan: warnings", () => {
  it(
    "counts warnings without failing the scan, lists them with --warnings, and puts them in --json",
    async () => {
      const root = await forgeWithBigFile();
      const plain = capture();
      expect(await scanCommand(root, { noDrift: true }, plain.io)).toBe(0);
      // How much of what was found is joined, in one line.
      expect(plain.out).toContainEqual(
        expect.stringMatching(/^Joined \d+ of \d+ calls, listeners and endpoints found \(\d+%\)/),
      );
      expect(plain.out).toContainEqual(
        expect.stringMatching(/^\d+ warnings?: atticus scan --warnings lists (it|them)$/),
      );
      const listed = capture();
      expect(await scanCommand(root, { noDrift: true, warnings: true }, listed.io)).toBe(0);
      expect(listed.out).toContain(
        `warning: forge-portal-ui: ${BIG}: left out: ${5 * 1024 * 1024 + 1} bytes is over the 5 MB a file may be`,
      );
      const json = capture();
      expect(await scanCommand(root, { noDrift: true, json: true }, json.io)).toBe(0);
      const r = JSON.parse(json.out.join("\n")) as {
        stats: { warnings: number };
        coverage: { repo: string; joined: number; open: number; unreadFiles: number }[];
        warnings: { repo: string; extractor: string; path?: string; message: string }[];
      };
      expect(r.stats.warnings).toBe(r.warnings.length);
      expect(r.coverage.find((c) => c.repo === "forge-portal-bff")!.joined).toBeGreaterThan(0);
      expect(r.warnings).toContainEqual(
        expect.objectContaining({ repo: "forge-portal-ui", path: BIG }),
      );
    },
    T,
  );
});
