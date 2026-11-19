import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api } from "@maycombhq/core";
import { factsSlotPaths } from "@maycombhq/scanner";
import { baseClonePath } from "@maycombhq/workspace";
import { partWords, reposRun, reposRunHooks } from "../src/repos-run.js";
import { reconnectEstate, type Json, type ReconnectEstate } from "./reconnect-estate.js";

/**
 * ADR 0204 decision 4: three new repos in one go (invented Forge names), every external system
 * behind a mock (hard rule 5): a sync that makes the clone, an assistant that writes the facts,
 * and an Apply that writes the slot. Its parts from disk, Stop between parts and repos, Continue,
 * the hand-off pause where the app can't start the assistant, and one repo failing while the
 * rest go on.
 */

const NEW = ["forge-fx", "forge-rates", "forge-tax"];
const repos = NEW.map((id) => ({
  id,
  url: `https://git.forge.example/forge/${id}.git`,
  type: "spring-boot",
}));
let g: ReconnectEstate;
const quiet = { out: () => undefined, err: () => undefined };
const synced: string[] = [];
const readBy: string[][] = [];
const appliedBy: string[][] = [];
let refuse = new Set<string>();

beforeAll(async () => {
  g = await reconnectEstate("b30-cn-run-");
  reposRunHooks.sync = async (root, [repo]) => {
    if (refuse.has(repo!)) return 1;
    synced.push(repo!);
    mkdirSync(join(baseClonePath(root, repo!), ".git"), { recursive: true });
    return 0;
  };
  reposRunHooks.read = async (root, rs) => {
    readBy.push([...rs]);
    for (const r of rs) writeFileSync(join(root, "facts", `${r}.jsonl`), "");
    return 0;
  };
  reposRunHooks.apply = async (root, rs, _io, onRepo) => {
    appliedBy.push([...rs]);
    for (const r of rs) {
      const f = factsSlotPaths(root, r).facts;
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, "");
      onRepo(r, 0);
    }
    return 0;
  };
}, 300_000);
afterAll(async () => {
  for (const k of Object.keys(reposRunHooks)) delete (reposRunHooks as Json)[k];
  await g?.close();
}, 120_000);

const state = (r: Api.ReposRunResultT, part: string) => r.parts.find((p) => p.part === part);

describe("Sync, read and apply these N (ADR 0204 decision 4)", () => {
  it("says the part, the repo and time left in words", () => {
    expect(partWords("read", "forge-ledger", 2, 5, "about 6 min")).toBe(
      "Part 3 of 4: reading forge-ledger (2 of 5). About 6 min left.",
    );
    expect(partWords("sync", "forge-fx", 1, 3, undefined)).toBe(
      "Part 2 of 4: syncing forge-fx (1 of 3). No estimate yet.",
    );
  });

  it("stops between repos after the sync of the first, and continues from disk", async () => {
    reposRunHooks.canRead = true;
    const ctl = new AbortController();
    const first = reposRunHooks.sync!;
    reposRunHooks.sync = async (root, rs, io, s) => {
      const c = await first(root, rs, io, s);
      ctl.abort();
      return c;
    };
    const lines: string[] = [];
    const r = await reposRun(
      g.root,
      { repos },
      { by: "pat", io: quiet, signal: ctl.signal, progress: (l) => lines.push(l) },
    );
    reposRunHooks.sync = first;
    expect(state(r, "add")?.state).toBe("done");
    expect(state(r, "sync")).toEqual({
      part: "sync",
      state: "stopped",
      repos: [
        { repo: "forge-fx", state: "done" },
        { repo: "forge-rates", state: "stopped" },
        { repo: "forge-tax", state: "stopped" },
      ],
    });
    expect(state(r, "read")).toBeUndefined();
    expect(r).toMatchObject({ done: 0, of: 3 });
    expect(lines[0]).toMatch(/^Part 1 of 4: adding forge-fx \(1 of 3\)\./);
    // The manifest lists them now: what is done stays done.
    const manifest = readFileSync(
      join(g.root, "org-pack", "profiles", "forge", "repos.manifest.yaml"),
      "utf8",
    );
    for (const id of NEW) expect(manifest).toContain(`id: ${id}`);
    // Continue: the same request picks up where it stopped, nothing done again.
    const again = await reposRun(g.root, { repos }, { by: "pat", io: quiet });
    expect(synced).toEqual(["forge-fx", "forge-rates", "forge-tax"]);
    expect(readBy).toEqual([NEW]);
    expect(appliedBy).toEqual([NEW]);
    expect(again.parts.map((p) => [p.part, p.state])).toEqual([
      ["add", "done"],
      ["sync", "done"],
      ["read", "done"],
      ["apply", "done"],
    ]);
    expect(again).toMatchObject({ done: 3, of: 3 });
  }, 300_000);
});

describe("where the app can't start the assistant, and a repo that fails", () => {
  const MORE = ["forge-audit-log", "forge-vat"].map((id) => ({
    id,
    url: `https://git.forge.example/forge/${id}.git`,
  }));
  it("pauses with the command to paste, then goes on to Apply with the repos read; one refused clone is listed", async () => {
    reposRunHooks.canRead = false;
    refuse = new Set(["forge-vat"]);
    const r = await reposRun(g.root, { repos: MORE }, { by: "pat", io: quiet });
    expect(state(r, "sync")?.repos).toEqual([
      { repo: "forge-audit-log", state: "done" },
      { repo: "forge-vat", state: "failed", why: "the clone was refused: see the lines" },
    ]);
    expect(r.handoff).toEqual({ command: "/atticus-map forge-audit-log" });
    expect(state(r, "read")?.state).toBe("waiting");
    expect(state(r, "apply")?.state).toBe("waiting");
    // The built-in readers were not used in its place: no facts were written by Atticus.
    expect(existsSync(join(g.root, "facts", "forge-audit-log.jsonl"))).toBe(false);
    // "I've read them: continue" with the facts not there yet: listed and left for later.
    const early = await reposRun(g.root, { repos: MORE, read: true }, { by: "pat", io: quiet });
    expect(state(early, "read")?.repos).toContainEqual({
      repo: "forge-audit-log",
      state: "failed",
      why: "no facts on file yet: read it, then Continue",
    });
    // The person's assistant read it: continue to Apply.
    writeFileSync(join(g.root, "facts", "forge-audit-log.jsonl"), "");
    const done = await reposRun(g.root, { repos: MORE, read: true }, { by: "pat", io: quiet });
    expect(state(done, "apply")?.repos).toContainEqual({ repo: "forge-audit-log", state: "done" });
    expect(done).toMatchObject({ done: 1, of: 2 });
  }, 300_000);

  it("runs as one local job from the app, its result the parts", async () => {
    const started = await g.call("/api/setup/repos/run", "POST", { repos: MORE, read: true });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    let j: Json = {};
    for (let n = 0; n < 1200; n++) {
      j = (await g.call(`/api/jobs/${String(started.body.jobId)}`)).body;
      if (j.state !== "running" && j.state !== "queued") break;
      await new Promise((res) => setTimeout(res, 50));
    }
    const res = Api.ReposRunResult.parse(j.result);
    expect(res.parts.map((p) => p.part)).toEqual(["add", "sync", "read", "apply"]);
    expect(res).toMatchObject({ done: 1, of: 2 });
  }, 300_000);
});
