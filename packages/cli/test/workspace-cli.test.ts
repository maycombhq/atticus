import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { main } from "../src/main.js";

const T = 60_000;

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

function git(cwd: string, ...args: string[]) {
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
    cwd,
    stdio: "pipe",
  });
}

describe("atticus openspec", () => {
  it(
    "sets up OpenSpec with the org-flow schema, then checks it",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "atticus-cli-os-"));
      const c = capture();
      expect(await main(["openspec", "setup", "--root", root], c.io)).toBe(0);
      expect(c.out[0]).toMatch(/^OpenSpec 1\.\d+\.\d+ set up with the org-flow schema/);
      expect(existsSync(join(root, "openspec/schemas/org-flow/schema.yaml"))).toBe(true);
      expect(parse(await readFile(join(root, "openspec/config.yaml"), "utf8")).schema).toBe(
        "org-flow",
      );

      const k = capture();
      expect(await main(["openspec", "check", "--root", root], k.io)).toBe(0);
      expect(k.out.at(-1)).toMatch(/0 checked, 0 passed, 0 failed/);
    },
    T,
  );
});

describe("atticus workspace", () => {
  it(
    "syncs, opens a change and prunes it",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "atticus-cli-ws-"));
      const src = join(dir, "src");
      await mkdir(src);
      git(src, "init", "-q", "-b", "main");
      await writeFile(join(src, "README.md"), "ledger\n");
      git(src, "add", "-A");
      git(src, "commit", "-q", "-m", "first");
      const url = join(dir, "forge-ledger.git");
      git(dir, "clone", "-q", "--bare", src, url);

      const root = join(dir, "metarepo");
      await mkdir(join(root, "org-pack/profiles/forge"), { recursive: true });
      await writeFile(
        join(root, "org-pack/profiles/forge/repos.manifest.yaml"),
        `schemaVersion: 1\nplatform: forge\nrepos:\n  - id: forge-ledger\n    url: ${JSON.stringify(url)}\n    type: forge-service\n    owner: team-ledger\n`,
      );

      const s = capture();
      expect(await main(["workspace", "sync", "--root", root], s.io)).toBe(0);
      expect(s.out[0]).toMatch(/^forge-ledger: cloned [0-9a-f]{12}$/);

      const missing = capture();
      expect(
        await main(["workspace", "open", "add-transfer-limit", "--root", root], missing.io),
      ).toBe(2);
      const unknown = capture();
      expect(
        await main(
          ["workspace", "open", "add-transfer-limit", "--repos", "nope", "--root", root],
          unknown.io,
        ),
      ).toBe(2);
      expect(unknown.err[0]).toContain("nope");

      const o = capture();
      expect(
        await main(
          ["workspace", "open", "add-transfer-limit", "--repos", "forge-ledger", "--root", root],
          o.io,
        ),
      ).toBe(0);
      expect(o.out[0]).toBe(
        "forge-ledger: change/add-transfer-limit at workspace/.worktrees/add-transfer-limit/forge-ledger",
      );
      expect(existsSync(join(root, "workspace/add-transfer-limit.code-workspace"))).toBe(true);

      const p = capture();
      expect(await main(["workspace", "prune", "add-transfer-limit", "--root", root], p.io)).toBe(
        0,
      );
      expect(p.out).toEqual(["forge-ledger: kept (no PR yet)"]);
      const all = capture();
      expect(
        await main(["workspace", "prune", "add-transfer-limit", "--all", "--root", root], all.io),
      ).toBe(0);
      expect(all.out).toEqual(["forge-ledger: removed"]);
    },
    T,
  );

  it("says what to do when there is no manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-cli-empty-"));
    const c = capture();
    expect(await main(["workspace", "sync", "--root", root], c.io)).toBe(1);
    expect(c.err[0]).toContain("repos.manifest.yaml");
  });
});
