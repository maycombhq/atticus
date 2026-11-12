import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parseFacts } from "@maycombhq/core";
import { scanEstate, writeFactsSlot } from "../src/index.js";

/**
 * A check at a later commit (the code-against-design check on a task branch, ADR 0114) scans
 * with `carryFacts`: the facts snapshot `verify --write` took at the base commit is carried to
 * the branch's commit as verify carries facts, so a fact citing a file the branch changed never
 * speaks for it, and `basis` names the changed files no fact covers (rule 4, eighth UX walk).
 * Every writer builds the snapshot as it was taken (ADR 0195 point 2). The invented Forge proxy
 * of fixtures/link-estate/gateway-questions; files and local git only.
 */

const GQ = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/link-estate/gateway-questions",
);
const REPO = "forge-proxy-core-v1";
const FLOW = "apiproxy/proxies/default.xml";
const T = 120_000;
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
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

/** The proxy read into facts at its base commit, then a commit that changes `file`. */
async function branch(file: string) {
  const root = mkdtempSync(join(tmpdir(), "atticus-scan-carry-"));
  temps.push(root);
  cpSync(join(GQ, "org-pack"), join(root, "org-pack"), { recursive: true });
  const dir = join(root, "workspace", REPO);
  cpSync(join(GQ, "repos", REPO), dir, { recursive: true });
  sh(dir, "init", "-q");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", "base");
  const base = sh(dir, "rev-parse", "HEAD");
  const text = readFileSync(join(GQ, "facts", `${REPO}.jsonl`), "utf8").replaceAll(
    '"commit":"d4d0001"',
    `"commit":"${base}"`,
  );
  const parsed = parseFacts(text);
  if (!parsed.ok) throw new Error("the fixture's facts don't read");
  await writeFactsSlot(root, { repo: REPO, commit: base, facts: parsed.facts, contracts: null });
  if (file.endsWith(".xml")) appendFileSync(join(dir, file), "<!-- changed on the branch -->\n");
  else writeFileSync(join(dir, file), "# Forge core proxy\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", "task");
  const head = sh(dir, "rev-parse", "HEAD");
  const scan = (carryFacts: boolean) =>
    scanEstate({
      root,
      repos: [REPO],
      repoDir: () => dir,
      repoState: async () => ({ commit: head, dirty: false }),
      cache: null,
      inputsDir: null,
      scannedAt: "2026-11-12T09:00:00Z",
      ...(carryFacts ? { carryFacts: true } : {}),
    });
  return { scan };
}

/** The records projected from facts that cite `file`. */
const citing = (records: { evidence?: { by?: string; path?: string }[] }[], file: string) =>
  records.filter((r) => (r.evidence ?? []).some((e) => e.by === "assistant" && e.path === file));

describe("a scan with carryFacts carries the facts snapshot to the commit read", () => {
  it(
    "leaves out the facts citing a file changed since, and says that file is unread",
    async () => {
      const { scan } = await branch(FLOW);
      const asTaken = await scan(false);
      expect(asTaken.basis?.[REPO]).toEqual({ from: "facts", unread: [] });
      expect(citing(asTaken.records, FLOW).length).toBeGreaterThan(0);
      const carried = await scan(true);
      expect(carried.basis?.[REPO]).toEqual({ from: "facts", unread: [FLOW] });
      expect(citing(carried.records, FLOW)).toEqual([]);
      // The facts citing only files the branch didn't change are carried (the target server).
      expect(citing(carried.records, "edge/env/prod/targetservers.json").length).toBeGreaterThan(0);
    },
    T,
  );

  it(
    "carries every fact, with nothing unread, when the branch changed no file they cite",
    async () => {
      const { scan } = await branch("README.md");
      const carried = await scan(true);
      expect(carried.basis?.[REPO]).toEqual({ from: "facts", unread: [] });
      expect(citing(carried.records, FLOW).length).toBeGreaterThan(0);
    },
    T,
  );
});
