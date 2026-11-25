import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { main } from "../src/main.js";

/**
 * ADR 0210 part 6, review of item 7: the readers are off for a new pack, and an existing user
 * keeps them. A metarepo whose catalog has slots the readers wrote is upgraded to `readers: on`
 * and scans as before; a new pack's scan with nothing to build is no failure and says to read
 * with atticus map. On the invented Forge fixture; no network.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const made: string[] = [];
afterAll(async () => {
  while (made.length) await rm(made.pop()!, { recursive: true, force: true });
});
const temp = async (p: string) => {
  const d = await mkdtemp(join(tmpdir(), p));
  made.push(d);
  return d;
};
const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=forge", "-c", "user.email=forge@example.com", ...a], {
    cwd,
    stdio: "pipe",
  });
async function atticus(root: string, ...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main([...args, "--root", root], {
    out: (l: string) => out.push(l),
    err: (l: string) => err.push(l),
  });
  return { code, out, err, all: () => [...out, ...err].join("\n") };
}
function files(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p).split("\\").join("/")] = readFileSync(p, "utf8");
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/** The Forge fixture, every repo a base clone; `scanned`: scanned once with the readers on. */
async function forge(o: { scanned: boolean }): Promise<string> {
  const top = await temp("atticus-readers-");
  await cp(FORGE, top, { recursive: true });
  const root = join(top, "metarepo");
  for (const id of await readdir(join(top, "repos"))) {
    const dir = join(root, "workspace", id);
    await cp(join(top, "repos", id), dir, { recursive: true });
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "fixture");
  }
  if (o.scanned) expect((await atticus(root, "scan", "--no-drift")).code).toBe(0);
  // Before beta.33 a pack had no word on the readers: they ran.
  await rm(join(root, "org-pack", "conventions.yaml"));
  return root;
}

describe(
  "the readers for an existing user and a new pack (ADR 0210 part 6)",
  { timeout: 120_000 },
  () => {
    it("an upgrade keeps the readers on where the catalog has their slots, and the scan is unchanged", async () => {
      const root = await forge({ scanned: true });
      const before = files(join(root, "catalog"));
      const up = await atticus(root, "upgrade");
      expect(up.code, up.all()).toBe(0);
      expect(up.all()).toMatch(/readers: "on"/);
      expect(up.all()).toMatch(/readers: "off"/);
      expect(readFileSync(join(root, "org-pack", "conventions.yaml"), "utf8")).toMatch(
        /^schemaVersion: 3\nreaders: "on"\n/m,
      );
      const s = await atticus(root, "scan", "--no-drift");
      expect(s.code, s.all()).toBe(0);
      const after = files(join(root, "catalog"));
      // Every record and readers slot as it was; only build.json names the org pack's new hash.
      const strip = (x: Record<string, string>) =>
        Object.fromEntries(Object.entries(x).filter(([k]) => !k.endsWith("build.json")));
      expect(strip(after)).toEqual(strip(before));
    });

    it("an upgrade leaves a new pack's readers off", async () => {
      const root = await forge({ scanned: false });
      expect((await atticus(root, "upgrade")).code).toBe(0);
      expect(existsSync(join(root, "org-pack", "conventions.yaml"))).toBe(false);
    });

    it("a new pack's scan with the readers off and no facts is no failure: it says to read with atticus map", async () => {
      const root = await forge({ scanned: false });
      await rm(join(root, "facts"), { recursive: true, force: true });
      await mkdir(join(root, "facts"), { recursive: true });
      await writeFile(join(root, "facts", ".keep"), "");
      const s = await atticus(root, "scan", "--no-drift");
      expect(s.code, s.all()).toBe(0);
      expect(s.all()).toMatch(/The readers are off and no repo has verified facts yet/);
      expect(s.all()).toMatch(/atticus map --all/);
      expect(s.all()).not.toMatch(/atticus onboard/);
    });
  },
);
