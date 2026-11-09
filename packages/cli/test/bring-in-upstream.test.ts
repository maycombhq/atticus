import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bringInMerged, setUpstream } from "../src/propose.js";

/**
 * App-only audit (Bring in what merged): a branch that follows no remote branch said only that,
 * with no fix. When the remote has the same branch, it says so and Set the upstream sets it (a
 * local setting: nothing is sent), after which Bring in works.
 */
const g = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], {
    cwd,
    encoding: "utf8",
  }).trim();

async function metarepo() {
  const base = await mkdtemp(join(tmpdir(), "bring-in-up-"));
  const root = join(base, "meta");
  const remote = join(base, "remote.git");
  g(base, "init", "-q", "--bare", remote);
  g(base, "init", "-q", "-b", "main", root);
  await writeFile(join(root, "a.txt"), "1\n");
  g(root, "add", "-A");
  g(root, "commit", "-q", "-m", "init");
  g(root, "remote", "add", "origin", remote);
  // Pushed without -u: main follows nothing.
  g(root, "push", "-q", "origin", "main");
  return { root, remote, base };
}
const io = (said: string[]) => ({
  out: (l: string) => said.push(l),
  err: (l: string) => said.push(`ERR ${l}`),
});

describe("Bring in what merged on a branch that follows no remote branch (app-only audit)", () => {
  it("names origin/<branch> when the remote has it, sets it on the person's click, then brings in", async () => {
    const { root, remote, base } = await metarepo();
    // Something merged on the host since.
    const other = join(base, "other");
    g(base, "clone", "-q", remote, other);
    await writeFile(join(other, "b.txt"), "2\n");
    g(other, "add", "-A");
    g(other, "commit", "-q", "-m", "merged");
    g(other, "push", "-q", "origin", "main");

    const said: string[] = [];
    expect(await bringInMerged(root, io(said))).toBe(2);
    expect(said.join("\n")).toContain(
      "This branch main follows no remote branch, and origin/main is there: Set the upstream to origin/main, then Bring in what merged again.",
    );
    const set: string[] = [];
    expect(await setUpstream(root, "origin/main", io(set))).toBe(0);
    expect(set).toEqual([
      "main follows origin/main now. Bring in what merged brings in its changes.",
    ]);
    expect(g(root, "rev-parse", "--abbrev-ref", "main@{u}")).toBe("origin/main");
    const again: string[] = [];
    expect(await bringInMerged(root, io(again)), again.join("\n")).toBe(0);
    expect(g(root, "rev-parse", "HEAD")).toBe(g(other, "rev-parse", "HEAD"));
  });

  it("refuses an upstream that isn't this branch on a remote here", async () => {
    const { root } = await metarepo();
    const said: string[] = [];
    expect(await setUpstream(root, "origin/other", io(said))).toBe(1);
    expect(said[0]).toMatch(/^ERR Only origin\/main can be main's upstream here/);
    expect(await setUpstream(root, "--evil", io([]))).toBe(1);
  });
});
