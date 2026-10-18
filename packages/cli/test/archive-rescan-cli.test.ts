import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { changeStore } from "@maycombhq/changes";
import type { GitRunner } from "@maycombhq/workspace";
import { changeArchive } from "../src/change-commands.js";

/**
 * Archive rescans: the change's repos are brought up to date where their base clones are
 * here and the estate is scanned again, so the catalog shows what was released; when none is
 * here, the exact commands are printed instead.
 */

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

/** Updating a base clone without a network: every git call succeeds and nothing changes. */
const offlineGit: GitRunner = async (args) => ({
  stdout: args[0] === "rev-parse" ? "a".repeat(40) : "",
  stderr: "",
});

async function released(o: { clones: boolean }): Promise<string> {
  const top = await mkdtemp(join(tmpdir(), "atticus-archive-rescan-"));
  await cp(join(FIXTURES, "forge"), top, { recursive: true });
  const root = join(top, "metarepo");
  if (o.clones)
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
    state: "released",
    history: [
      ...c.history,
      { from: c.state, to: "released", at: "2026-10-21T09:00:00Z", by: "dana" },
    ],
  });
  return root;
}

describe("atticus change archive and the catalog", () => {
  it(
    "rescans the estate after archiving when the change's repos are in base clones",
    async () => {
      const root = await released({ clones: true });
      expect(existsSync(join(root, "catalog/generated/component/ledger-api.yaml"))).toBe(false);
      const c = capture();
      const code = await changeArchive(root, CHANGE, { by: "dana" }, c.io, {
        now: "2026-10-21T10:00:00Z",
        git: offlineGit,
      });
      expect(c.err).toEqual([]);
      expect(code).toBe(0);
      expect(c.out[0]).toBe(`Archived ${CHANGE}.`);
      expect(c.out[1]).toMatch(new RegExp(`^Rescanning for ${CHANGE}'s repos: .*forge-ledger`));
      expect(c.out.some((l) => /^Scanned \d+ repos/.test(l))).toBe(true);
      expect(existsSync(join(root, "catalog/generated/component/ledger-api.yaml"))).toBe(true);
      expect((await changeStore(root).list()).find((x) => x.id === CHANGE)?.state).toBe("archived");
    },
    T,
  );

  it(
    "says the exact commands when the repos aren't here, and can be told not to rescan",
    async () => {
      const root = await released({ clones: false });
      const c = capture();
      expect(await changeArchive(root, CHANGE, { by: "dana" }, c.io)).toBe(0);
      expect(c.out[0]).toBe(`Archived ${CHANGE}.`);
      expect(c.out[1]).toMatch(
        /^The change's repos aren't in base clones here, so the catalog wasn't rescanned\. Run: atticus workspace sync --repos [a-z0-9,-]*forge-ledger[a-z0-9,-]* && atticus scan$/,
      );
      expect(existsSync(join(root, "catalog/generated"))).toBe(false);

      const quiet = await released({ clones: true });
      const q = capture();
      expect(await changeArchive(quiet, CHANGE, { by: "dana", rescan: false }, q.io)).toBe(0);
      expect(q.out).toEqual([`Archived ${CHANGE}.`]);
    },
    T,
  );
});
