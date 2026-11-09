import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { changeStore } from "@maycombhq/changes";
import { createOpenSpec } from "@maycombhq/openspec-adapter";
import type { GitRunner } from "@maycombhq/workspace";
import { changeArchive } from "../src/change-commands.js";
import { changeSteps, readNextState } from "../src/next-commands.js";

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

async function released(o: { clones: boolean; openspec?: boolean }): Promise<string> {
  const top = await mkdtemp(join(tmpdir(), "atticus-archive-rescan-"));
  await cp(join(FIXTURES, "forge"), top, { recursive: true });
  const root = join(top, "metarepo");
  if (o.openspec) await createOpenSpec({ root }).init();
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
  if (o.openspec) {
    // every task built: OpenSpec archives only a change whose tasks.md is ticked
    const tasks = join(root, "openspec/changes", CHANGE, "tasks.md");
    await writeFile(tasks, (await readFile(tasks, "utf8")).replaceAll("- [ ]", "- [x]"));
  }
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

  // App-only audit: a MODIFIED delta for a spec openspec/specs doesn't have passed validate and
  // failed at the archive with a bare 500, leaving change.yaml archived and the folder unmoved.
  it(
    "refuses an archive OpenSpec would refuse, with its words and what to do, changing nothing",
    async () => {
      const root = await released({ clones: false, openspec: true });
      const spec = join(root, "openspec/changes", CHANGE, "specs/transfer-limits/spec.md");
      await writeFile(
        spec,
        (await readFile(spec, "utf8")).replace("## ADDED Requirements", "## MODIFIED Requirements"),
      );
      const c = capture();
      const code = await changeArchive(root, CHANGE, { by: "dana" }, c.io);
      expect(code).toBe(1);
      const said = c.err.join("\n");
      expect(said).toContain(`${CHANGE} doesn't pass openspec validate --strict.`);
      expect(said).toContain("target spec does not exist");
      expect(said).toContain('takes "## ADDED Requirements" only');
      expect((await changeStore(root).read(CHANGE)).state).toBe("released");
      expect(existsSync(join(root, "openspec/changes", CHANGE))).toBe(true);
      expect(existsSync(join(root, "openspec/specs/transfer-limits"))).toBe(false);
    },
    T,
  );

  // Round 49: OpenSpec moves the change's folder to openspec/changes/archive/<date>-<id>/, so
  // the rescan works out the change's repos before archiving rather than reading it after.
  it(
    "rescans after OpenSpec has moved the change into its archive",
    async () => {
      const root = await released({ clones: true, openspec: true });
      const c = capture();
      const code = await changeArchive(root, CHANGE, { by: "dana" }, c.io, {
        now: "2026-10-21T10:00:00Z",
        git: offlineGit,
      });
      expect(c.err).toEqual([]);
      expect(code).toBe(0);
      expect(c.out[0]).toBe(`Archived ${CHANGE}.`);
      expect(existsSync(join(root, "openspec/changes", CHANGE))).toBe(false);
      expect(c.out[1]).toMatch(new RegExp(`^Rescanning for ${CHANGE}'s repos: .*forge-ledger`));
      expect(existsSync(join(root, "catalog/generated/component/ledger-api.yaml"))).toBe(true);
    },
    T,
  );

  // Round 49: next mapped released to done and never offered the archive.
  it(
    "next offers the archive of a released change, from its archive gate",
    async () => {
      const root = await released({ clones: false });
      const c = (await readNextState(root)).changes.find((x) => x.id === CHANGE)!;
      expect(c.released).toEqual({ blockers: [] });
      expect(changeSteps(c)[0]).toMatchObject({
        step: "archive",
        command: `atticus change archive ${CHANGE}`,
      });
    },
    T,
  );
});
