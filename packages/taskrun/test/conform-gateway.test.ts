import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { gateStatus } from "@maycombhq/naysayer";
import { conformChange, CONFORM_GATE } from "../src/index.js";
import { FIXTURES, git } from "./helpers.js";

/**
 * Eighth UX walk: "Let tellers lock a card from the branch" built its tasks, and the code-against-
 * design check (ADR 0114) said three things were missing that the branches had: the Apigee
 * `LockCard` flow in the gateway proxy, and the teller app's `config.getUri("core-gateway") +
 * path` call. The repos were read into facts at their base commits; the task branches changed
 * the very files those facts cite, so the scan of each branch carried none of them (or only an
 * unrelated config fact) and nobody had read the new code. Rule 4 (ADR 0074, 0124): facts decide;
 * the built-in readers are a cross-check. So a check that has no facts for the files the branch
 * changed can't say a call is missing: it says it couldn't confirm it, as a step a person checks,
 * never a blocking finding. When the facts cover the branch's commit, they decide: what they
 * have is found, what they lack is missing. On the invented Forge estate of
 * fixtures/link-estate/gateway-questions with fixtures/conform-gateway; files and local git only.
 */

const T = 300_000;
const GQ = join(FIXTURES, "link-estate/gateway-questions");
const CG = join(FIXTURES, "conform-gateway");
const CHANGE = "let-tellers-lock-a-card";
const PROXY = "forge-proxy-core-v1";
const TELLER = "forge-teller-app";
/** The short commits the gateway-questions facts were written at. */
const FACT_COMMIT: Record<string, string> = {
  "forge-ledger-core": "e5e0001",
  "forge-card-vault": "f6f0001",
  [PROXY]: "d4d0001",
  [TELLER]: "a7a0001",
};
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_TERMINAL_PROMPT: "0",
};
const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: ENV,
  }).trim();

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

/**
 * The estate as a metarepo: each repo's base clone at its base commit, its facts read there, the
 * change's target flows and stories, and each task's branch with `after` laid over (the files
 * of fixtures/conform-gateway/after/<repo>, or the ones given).
 */
function estate(after: Record<string, Record<string, string>> = {}) {
  const root = mkdtempSync(join(tmpdir(), "atticus-conform-gateway-"));
  temps.push(root);
  cpSync(join(GQ, "org-pack"), join(root, "org-pack"), { recursive: true });
  cpSync(join(GQ, "questions"), join(root, "questions"), { recursive: true });
  cpSync(join(CG, "change"), join(root, "openspec/changes", CHANGE), { recursive: true });
  sh(root, "init", "-q");
  mkdirSync(join(root, "facts"), { recursive: true });
  const base: Record<string, string> = {};
  const branch: Record<string, string> = {};
  const tasks: Record<string, string> = { [PROXY]: "2.1", [TELLER]: "3.1" };
  for (const repo of Object.keys(FACT_COMMIT)) {
    const dir = join(root, "workspace", repo);
    cpSync(join(GQ, "repos", repo), dir, { recursive: true });
    sh(dir, "init", "-q", "-b", "main");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-q", "-m", "base");
    base[repo] = sh(dir, "rev-parse", "HEAD");
    writeFileSync(
      join(root, "facts", `${repo}.jsonl`),
      readFileSync(join(GQ, "facts", `${repo}.jsonl`), "utf8").replaceAll(
        `"commit":"${FACT_COMMIT[repo]}"`,
        `"commit":"${base[repo]}"`,
      ),
    );
    const task = tasks[repo];
    if (!task) continue;
    sh(dir, "checkout", "-q", "-b", `task/${CHANGE}/${task}`);
    const files = after[repo] ?? {};
    if (!after[repo]) cpSync(join(CG, "after", repo), dir, { recursive: true });
    for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
    sh(dir, "add", "-A");
    sh(dir, "commit", "-q", "-m", `task ${task}`);
    branch[repo] = sh(dir, "rev-parse", "HEAD");
    sh(dir, "checkout", "-q", "main");
  }
  return { root, base, branch };
}

const COULD_NOT_CONFIRM = /couldn't confirm .* from the code; check it by hand/;

describe("the code-against-design check rests on facts; a reader alone never says missing (eighth UX walk)", () => {
  it(
    "says the Apigee LockCard flow and its forward couldn't be confirmed, not missing, when no fact covers the changed proxy",
    async () => {
      const { root } = estate();
      const run = await conformChange(root, CHANGE, {
        task: "2.1",
        git,
        now: "2026-11-08T19:22:00Z",
      });
      const r = run.results[0]!;
      expect(r.repo).toBe(PROXY);
      expect(r.items.filter((i) => i.status === "missing")).toEqual([]);
      expect(r.counts.missing).toBe(0);
      const unconfirmed = r.unchecked.filter((u) => COULD_NOT_CONFIRM.test(u.why));
      expect(unconfirmed.map((u) => [u.flow, u.item ?? 0])).toEqual([
        ["proxy-core-v1.lock-card", 0],
        ["proxy-core-v1.lock-card", 2],
      ]);
      // The note names what wasn't read and how to read it.
      expect(unconfirmed[0]!.why).toContain("apiproxy/proxies/default.xml");
      expect(unconfirmed[0]!.why).toContain(`/atticus-map ${PROXY}`);
      const gate = await gateStatus(root, CHANGE, CONFORM_GATE);
      expect(gate.open.blocking).toBe(0);
    },
    T,
  );

  it(
    "says the teller app's config.getUri call couldn't be confirmed, not missing, when its facts cite the changed file",
    async () => {
      const { root } = estate();
      const run = await conformChange(root, CHANGE, { task: "3.1", git });
      const r = run.results[0]!;
      expect(r.repo).toBe(TELLER);
      expect(r.counts.missing).toBe(0);
      // Every teller fact cites TellerClient.java, which the task changed: none is carried, so
      // the readers stand in, and they are only a cross-check.
      const u = r.unchecked.find((x) => x.item === 2)!;
      expect(u.why).toMatch(COULD_NOT_CONFIRM);
      expect(u.why).toContain(`${TELLER} hasn't been read into facts at this commit`);
      expect(u.why).toContain(`/atticus-map ${TELLER}`);
      expect((await gateStatus(root, CHANGE, CONFORM_GATE)).open.blocking).toBe(0);
    },
    T,
  );

  it(
    "keeps a blocking missing call when the facts cover the branch's commit and have no such call",
    async () => {
      // The task branch touches nothing the facts cite (a README beside the code), so every
      // fact is carried to the branch's commit and no changed source file is left unread: the
      // facts say the teller app makes no lock call.
      const { root } = estate({ [TELLER]: { "README.md": "# Teller app\n" } });
      const run = await conformChange(root, CHANGE, { task: "3.1", git });
      const r = run.results[0]!;
      expect(r.items.filter((i) => i.status === "missing").map((i) => i.what)).toEqual([
        "teller-app makes no call to proxy-core-v1 PUT /forge/core/v1/cards/{id}/lock (item 2 of target-flows/teller-app.lock-card.yaml).",
      ]);
      expect((await gateStatus(root, CHANGE, CONFORM_GATE)).open.blocking).toBe(1);
    },
    T,
  );
});
