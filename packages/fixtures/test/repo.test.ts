import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("repository hygiene", () => {
  it("no package is hidden by .gitignore", () => {
    const packages = readdirSync(join(REPO, "packages"));
    const ignored = packages.filter((p) => {
      try {
        execFileSync("git", ["check-ignore", "-q", `packages/${p}/package.json`], { cwd: REPO, stdio: "pipe" });
        return true;
      } catch {
        return false;
      }
    });
    expect(ignored).toEqual([]);
  });
});
