import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileHeldError, fsHooks } from "@maycombhq/core";
import { verifyCommand } from "../src/verify-commands.js";

/**
 * Beta.28.5, the owner's field report: a run over forty repos ended on an EPERM renaming over
 * `<repo>.rejected.jsonl`, a file of a repo whose facts had not changed. Verify wrote the
 * rejected file again on every run, with the lines it had: one whose bytes are the ones to write
 * is left alone now (its time too), and the files are written in an order that loses nothing
 * when one can't be: the rejected file (what leaves the facts file) first. The facts file and
 * the report stay written by every run: other commands read their times.
 */

const fixtures = join(__dirname, "..", "..", "verify", "test", "fixtures");
const good = readFileSync(join(fixtures, "forge-ledger.facts.jsonl"), "utf8");
const bad = readFileSync(join(fixtures, "redteam.facts.jsonl"), "utf8");

function adoptedRepo(facts: string): string {
  const root = mkdtempSync(join(tmpdir(), "atticus-verify-files-"));
  cpSync(join(fixtures, "repo"), root, { recursive: true });
  mkdirSync(join(root, ".atticus", "org-pack"), { recursive: true });
  mkdirSync(join(root, ".atticus", "facts"), { recursive: true });
  writeFileSync(join(root, ".atticus", "facts", "forge-ledger.jsonl"), facts);
  return root;
}
const quiet = { out: () => undefined, err: () => undefined };
const at = (root: string, name: string) => join(root, ".atticus", "facts", name);
/** A file's time set to long ago, so a write of it shows. */
function old(path: string): number {
  const t = new Date("2026-01-01T00:00:00Z");
  utimesSync(path, t, t);
  return statSync(path).mtimeMs;
}

afterEach(() => {
  for (const k of Object.keys(fsHooks)) delete (fsHooks as Record<string, unknown>)[k];
});

describe("verify leaves the rejected file alone when its lines are the ones to write", () => {
  it("the facts file and the report are written by every run: their times say a verify ran", async () => {
    const root = adoptedRepo(good);
    expect(await verifyCommand(root, "forge-ledger", { commit: "0123abc" }, quiet)).toBe(0);
    const facts = readFileSync(at(root, "forge-ledger.jsonl"), "utf8");
    const t = old(at(root, "forge-ledger.jsonl"));
    const report = old(at(root, "forge-ledger.verify.yaml"));
    expect(await verifyCommand(root, "forge-ledger", { commit: "0123abc" }, quiet)).toBe(0);
    // A gaps plan is read once the facts file is newer than it (answer-reopen.ts), and a
    // waiting map --all takes the report's time as "verify ran" (map-all.ts).
    expect(statSync(at(root, "forge-ledger.jsonl")).mtimeMs).toBeGreaterThan(t);
    expect(statSync(at(root, "forge-ledger.verify.yaml")).mtimeMs).toBeGreaterThan(report);
    expect(readFileSync(at(root, "forge-ledger.jsonl"), "utf8")).toBe(facts);
  });

  it("the rejected file of a run that rejects the same lines again is left alone", async () => {
    const root = adoptedRepo(good + bad);
    await verifyCommand(root, "forge-ledger", { commit: "0123abc", write: true }, quiet);
    const rejected = readFileSync(at(root, "forge-ledger.rejected.jsonl"), "utf8");
    const t = old(at(root, "forge-ledger.rejected.jsonl"));
    await verifyCommand(root, "forge-ledger", { commit: "0123abc", write: true }, quiet);
    expect(readFileSync(at(root, "forge-ledger.rejected.jsonl"), "utf8")).toBe(rejected);
    expect(statSync(at(root, "forge-ledger.rejected.jsonl")).mtimeMs).toBe(t);
  });

  it("a rejected file that can't be replaced leaves the facts file as it was: no fact is lost", async () => {
    const root = adoptedRepo(good + bad);
    const before = readFileSync(at(root, "forge-ledger.jsonl"), "utf8");
    writeFileSync(at(root, "forge-ledger.rejected.jsonl"), "an older run's\n");
    fsHooks.platform = "win32";
    fsHooks.sleep = async () => undefined;
    fsHooks.say = () => undefined;
    fsHooks.rename = async (from, to) => {
      if (to.endsWith("forge-ledger.rejected.jsonl"))
        throw Object.assign(
          new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`),
          {
            code: "EPERM",
          },
        );
      const { rename } = await import("node:fs/promises");
      await rename(from, to);
    };
    const e = await verifyCommand(root, "forge-ledger", { commit: "0123abc" }, quiet).catch(
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(FileHeldError);
    // Every fact the run would have moved out is still in the facts file.
    expect(readFileSync(at(root, "forge-ledger.jsonl"), "utf8")).toBe(before);
    expect(readFileSync(at(root, "forge-ledger.rejected.jsonl"), "utf8")).toBe("an older run's\n");
    expect(readdirSync(join(root, ".atticus", "facts")).filter((n) => n.endsWith(".tmp"))).toEqual(
      [],
    );
  });
});

describe("a run over several repos goes on past a repo whose file is held (beta.28.5)", () => {
  it("verify --all says the repo is not verified, why, and its own command, and verifies the others", async () => {
    const root = adoptedRepo(good);
    for (const other of ["forge-atlas", "forge-zeta"])
      writeFileSync(at(root, `${other}.jsonl`), readFileSync(at(root, "forge-ledger.jsonl")));
    fsHooks.platform = "win32";
    fsHooks.sleep = async () => undefined;
    fsHooks.say = () => undefined;
    fsHooks.rename = async (from, to) => {
      if (to.endsWith("forge-ledger.verify.yaml"))
        throw Object.assign(
          new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`),
          { code: "EPERM" },
        );
      const { rename } = await import("node:fs/promises");
      await rename(from, to);
    };
    const { verifyAllCommand } = await import("../src/verify-commands.js");
    const out: string[] = [];
    const err: string[] = [];
    const codes: [string, number][] = [];
    const code = await verifyAllCommand(
      root,
      { commit: "0123abc", onRepo: (repo, c) => codes.push([repo, c]) },
      { out: (l) => out.push(l), err: (l) => err.push(l), progress: () => undefined },
    );
    expect(code).toBe(1);
    expect(codes).toEqual([
      ["forge-atlas", 0],
      ["forge-ledger", 1],
      ["forge-zeta", 0],
    ]);
    expect(err).toEqual([
      `forge-ledger: not verified: ${at(root, "forge-ledger.verify.yaml")} is open in another program (an editor, an assistant's session or a virus scan) or can't be written, and it stayed so for 45 s. Nothing was lost: the file is as it was. Close it there, then run the command again. Run it once that is put right: atticus verify forge-ledger`,
    ]);
    expect(out.at(-1)).toBe("Verified 3 repos: 2 passed, 1 with something to fix (forge-ledger).");
  });
});
