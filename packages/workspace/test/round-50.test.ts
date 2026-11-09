import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cloneUrlKey, ensureGitignore, nearRepos } from "../src/index.js";

/** Review round 50 (getting started): the onboarding fixes that live in workspace. */

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "atticus-ws-r50-"));
  dirs.push(d);
  return d;
};

describe("the metarepo .gitignore keeps its line endings (round 50, 8)", () => {
  it("adds the local-state folders to a CRLF file in CRLF", async () => {
    const root = temp();
    writeFileSync(join(root, ".gitignore"), "node_modules/\r\n*.log\r\n");
    await ensureGitignore(root);
    const text = readFileSync(join(root, ".gitignore"), "utf8");
    expect(text.startsWith("node_modules/\r\n*.log\r\n")).toBe(true);
    // Every line ends CRLF: no bare LF anywhere.
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
    expect(text).toContain("/workspace/\r\n");
  });

  it("still writes LF to an LF file", async () => {
    const root = temp();
    writeFileSync(join(root, ".gitignore"), "node_modules/\n");
    await ensureGitignore(root);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).not.toContain("\r");
  });
});

describe("repo ids: shared by repo add and repos discover (round 50, 7)", () => {
  it("tells one repo's URLs apart from another repo's", () => {
    expect(cloneUrlKey("https://dev.azure.com/forgeorg/Forge%20Payments/_git/forge-ledger")).toBe(
      cloneUrlKey("https://dev.azure.com/forgeorg/Forge%20Payments/_git/forge-ledger.git/"),
    );
    expect(cloneUrlKey("git@git.example.com:forge/ledger.git")).toBe(
      cloneUrlKey("https://git.example.com/forge/ledger"),
    );
    expect(cloneUrlKey("./ledger")).toBeUndefined();
    expect(
      nearRepos({ id: "ledger", url: "https://git.example.com/forge/ledger.git" }, [
        { id: "forge-ledger", url: "https://git.example.com/forge/ledger" },
      ]),
    ).toEqual([{ id: "forge-ledger", why: "it has the same clone URL" }]);
  });
});
