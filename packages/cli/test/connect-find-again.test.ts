import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { Api, declareArrow } from "@maycombhq/core";
import { buildAndWrite } from "@maycombhq/scanner";
import { findHooks } from "../src/connect-find.js";
import type { AcpStepRunner } from "../src/copilot-acp-steps.js";
import { verifyConfirmed } from "./seed-slots.js";
import { A, B, reconnectEstate, type ReconnectEstate } from "./reconnect-estate.js";

/**
 * ADR 0204 A.7 end to end (the third review): a find of forge-orders → forge-ledger finds
 * nothing; the panel offers Read again anyway. forge-orders' clone moves on (a commit, local git,
 * no network): the panel offers Find it again, and the find again replaces the report's entry,
 * at the clone's new commit. The assistant is a mock (hard rule 5). Invented Forge names.
 */

let g: ReconnectEstate;
const quiet = { out: () => undefined, err: () => undefined };
const clone = () => join(g.root, "workspace", A);
const git = (...a: string[]) => {
  const r = spawnSync(
    "git",
    [
      "-c",
      "user.name=Forge",
      "-c",
      "user.email=forge@example.com",
      "-c",
      "commit.gpgsign=false",
      ...a,
    ],
    { cwd: clone(), encoding: "utf8" },
  );
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim();
};
const session: AcpStepRunner = async () => {
  writeFileSync(
    join(g.root, "proposals", "find", `${A}--repo-${B}.yaml`),
    JSON.stringify({ looked: [], none: "No line calls the ledger." }),
  );
  return { runId: "run-find-again" } as Awaited<ReturnType<AcpStepRunner>>;
};
const view = async () =>
  Api.ConnectView.parse((await g.call(`/api/connect?from=repo:${A}&to=repo:${B}`)).body);
const find = async () => {
  const r = await g.call("/api/connect/find", "POST", {
    from: A,
    to: { repo: B },
    mode: "copilot-acp",
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return Api.FindResult.parse(r.body);
};
const report = () =>
  (
    parse(readFileSync(join(g.root, "facts", `${A}.find.yaml`), "utf8")) as {
      entries: Api.FindEntryViewT[];
    }
  ).entries;

beforeAll(async () => {
  g = await reconnectEstate("b30-cn-again-");
  // forge-orders' clone is a Git repository, its facts read at its commit.
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-qm", "forge-orders");
  const head = git("rev-parse", "HEAD");
  const facts = join(g.root, "facts", `${A}.jsonl`);
  writeFileSync(
    facts,
    readFileSync(facts, "utf8").replaceAll('"commit":"a11ce01"', `"commit":"${head}"`),
  );
  expect(await verifyConfirmed(g.root, A, { commit: head, dir: clone(), write: true }, quiet)).toBe(
    0,
  );
  await declareArrow(
    g.root,
    { from: { repo: A }, to: { repo: B }, why: "Orders settles each day's holds into the ledger." },
    { by: "pat", at: "2026-11-18T10:02:00Z", platform: "forge" },
  );
  expect(
    (await buildAndWrite(g.root, { command: "atticus catalog build" })).guard.refused,
  ).toBeUndefined();
  findHooks.runner = session;
  // verify --write at the clone's HEAD, its removals confirmed as the person would.
  findHooks.verify = (root, repo, o) =>
    verifyConfirmed(root, repo, { dir: join(root, "workspace", repo), write: true, ...o }, quiet);
}, 300_000);
afterAll(async () => {
  findHooks.runner = undefined;
  findHooks.verify = undefined;
  await g?.close();
}, 120_000);

describe("Find it again after the clone moves (ADR 0204 A.7, the third review)", () => {
  it("offers Read again anyway, then Find it again once the clone moves, and the find again replaces the entry", async () => {
    const first = await find();
    expect(first.entry?.outcome, JSON.stringify(first)).toBe("not-found");
    const was = git("rev-parse", "HEAD");
    expect(was.startsWith(first.entry!.commit!)).toBe(true);
    expect((await view()).findAgain).toBe("anyway");
    // The clone moves on: a commit that touches no file a fact cites.
    writeFileSync(join(clone(), "NOTES.md"), "Settlement runs nightly.\n");
    git("add", "-A");
    git("commit", "-qm", "notes");
    const now = git("rev-parse", "HEAD");
    expect((await view()).findAgain).toBe("again");
    const again = await find();
    expect(again.notBuilt, JSON.stringify(again.notBuilt)).toBeUndefined();
    expect(again.entry?.outcome).toBe("not-found");
    const entries = report();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.at > first.entry!.at).toBe(true);
    // The entry is of the commit the find read at: the clone's new one, so it reads anyway now.
    expect(now.startsWith(entries[0]!.commit!)).toBe(true);
    expect((await view()).findAgain).toBe("anyway");
  }, 300_000);
});
