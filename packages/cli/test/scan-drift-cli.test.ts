import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { changeStore } from "@maycombhq/changes";
import { scanCommand } from "../src/scan-commands.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const CHANGE = "add-transfer-limit";
const T = 180_000;

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

/** The Forge metarepo with base clones, the forge-change org pack and its change in build. */
async function forgeWithChangeInBuild(): Promise<string> {
  const top = await mkdtemp(join(tmpdir(), "atticus-scan-drift-"));
  await cp(join(FIXTURES, "forge"), top, { recursive: true });
  const root = join(top, "metarepo");
  for (const id of await readdir(join(top, "repos"))) {
    const dir = join(root, "workspace", id);
    await cp(join(top, "repos", id), dir, { recursive: true });
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "fixture");
  }
  await cp(join(FIXTURES, "forge-change/org-pack"), join(root, "org-pack"), { recursive: true });
  await cp(
    join(FIXTURES, "forge-change/openspec/changes", CHANGE),
    join(root, "openspec/changes", CHANGE),
    { recursive: true },
  );
  const store = changeStore(root);
  const c = await store.read(CHANGE);
  await store.write({
    ...c,
    state: "build",
    history: [...c.history, { from: c.state, to: "build", at: "2026-10-21T09:00:00Z", by: "pat" }],
  });
  return root;
}

describe("atticus scan and open changes", () => {
  it(
    "runs the drift check for changes in build after writing the catalog, unless told not to",
    async () => {
      const root = await forgeWithChangeInBuild();
      const off = capture();
      await scanCommand(root, { noDrift: true }, off.io);
      expect(off.out.some((l) => l.startsWith("Drift check"))).toBe(false);

      const on = capture();
      await scanCommand(root, {}, on.io);
      const line = on.out.find((l) => l.startsWith(`Drift check for ${CHANGE} (build)`));
      expect(line, on.out.join("\n")).toBeDefined();
      expect(line).not.toContain("couldn't run");
      if (!line!.endsWith("no drift."))
        expect(existsSync(join(root, "openspec/changes", CHANGE, "review/drift"))).toBe(true);

      // A dry run writes no catalog, so there is nothing to check against.
      const dry = capture();
      await scanCommand(root, { dryRun: true }, dry.io);
      expect(dry.out.some((l) => l.startsWith("Drift check"))).toBe(false);
    },
    T,
  );
});
