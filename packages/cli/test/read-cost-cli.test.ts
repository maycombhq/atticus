import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { StepFact } from "../src/commands.js";
import { mapCommand } from "../src/map-commands.js";
import {
  loadReadPlan,
  mapSpent,
  migrateReadPlan,
  readCostOf,
  readCostWords,
  readPlanProgress,
} from "../src/map-parts.js";
import { verifyCommand } from "../src/verify-commands.js";

/**
 * Plan item P6 (ADR 0141): what each repo's read cost, recorded honestly. Atticus can't meter the
 * tokens an assistant spends in Copilot agent mode or Claude Code, so the read plan records what
 * it can know: --estimate's estimate (tokens counted from the source) for every repo, the parts
 * the facts account for as `atticus verify` first sees them, and what the reader reports with
 * `atticus map <repo> --spent`, each kept apart and said for what it is. No model, no network.
 */

const fixtures = join(__dirname, "..", "..", "verify", "test", "fixtures");
const REPO = "forge-ledger";
const COMMIT = "0123abc";
const NOW = () => new Date("2026-10-31T09:00:00.000Z");
const PLAN = ".atticus/facts/forge-ledger.read-plan.yaml";

const write = (root: string, path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const rows = (n: number, line: (i: number) => string) =>
  Array.from({ length: n }, (_, i) => line(i)).join("\n") + "\n";

function smallRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "atticus-cost-small-"));
  cpSync(join(fixtures, "repo"), root, { recursive: true });
  mkdirSync(join(root, ".atticus", "org-pack"), { recursive: true });
  return root;
}

/** The Forge ledger with four modules past one session, so it is read in parts. */
function bigRepo(): string {
  const root = smallRepo();
  for (const m of ["accounts", "payments", "reports", "statements"])
    for (let c = 0; c < 10; c++)
      write(
        root,
        `${m}/src/main/java/forge/${m}/Part${c}.java`,
        `package forge.${m};\n\npublic class Part${c} {\n${rows(400, (i) => `  private final int value${i} = ${i}; // ${m}`)}}\n`,
      );
  return root;
}

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
      report: (_f: StepFact) => {},
    },
  };
};

/** The reader's facts for the ledger's own code, and every other folder reviewed. */
function readAll(root: string, paths: readonly string[]) {
  write(
    root,
    `.atticus/facts/${REPO}.jsonl`,
    readFileSync(join(fixtures, "forge-ledger.facts.jsonl"), "utf8"),
  );
  appendFileSync(
    join(root, ".atticus", "facts", `${REPO}.reviewed.jsonl`),
    paths.map((p) => `${JSON.stringify({ path: p, why: "read; no fact to record" })}\n`).join(""),
  );
}

describe("what a read cost, recorded in the read plan (P6, ADR 0141)", () => {
  it("records --estimate's estimate for a repo one session reads, with no parts and no ledger", async () => {
    const root = smallRepo();
    expect(await mapCommand(root, REPO, { estimate: true, commit: COMMIT }, io().io)).toBe(0);
    const plan = parse(await readFile(join(root, PLAN), "utf8"));
    expect(plan.schemaVersion).toBe(2);
    expect(plan.parts).toEqual([]);
    expect(plan.estimate).toMatchObject({ sessions: 1 });
    expect(plan.estimate.tokens).toBeGreaterThan(0);
    expect(plan.estimate.files).toBeGreaterThan(0);
    // No parts: atticus next and --estimate keep saying nothing of a ledger.
    expect(await readPlanProgress(root, REPO)).toBeUndefined();
  });

  it("records the estimate of a read in parts, its sessions the parts planned", async () => {
    const root = bigRepo();
    await mapCommand(root, REPO, { estimate: true, commit: COMMIT }, io().io);
    const plan = (await loadReadPlan(root, REPO))!;
    expect(plan.parts.length).toBeGreaterThan(1);
    expect(plan.estimate!.sessions).toBe(plan.parts.length);
    expect(plan.estimate!.tokens).toBe(plan.parts.reduce((n, p) => n + p.tokens, 0));
  });

  it("reads a v1 plan as v2 with nothing recorded, and --estimate writes it as v2 keeping its parts", async () => {
    const v1 = {
      schemaVersion: 1,
      repo: REPO,
      commit: COMMIT,
      session: 150_000,
      plannedAt: "2026-10-26T09:00:00Z",
      parts: [{ part: 1, paths: ["src/**"], files: 3, tokens: 9000 }],
    };
    expect(migrateReadPlan(v1)).toEqual({ ...v1, schemaVersion: 2 });
    expect(migrateReadPlan({ ...v1, schemaVersion: 3 })).toBeUndefined();
    const root = bigRepo();
    await mapCommand(root, REPO, { estimate: true, commit: COMMIT }, io().io);
    // The same plan, as an older Atticus wrote it.
    const now = parse(await readFile(join(root, PLAN), "utf8"));
    // An older Atticus wrote no estimate (ADR 0141) and no rules (ADR 0167).
    const { estimate: _e, rules: _r, ...rest } = now;
    write(
      root,
      PLAN,
      JSON.stringify({
        ...rest,
        schemaVersion: 1,
        plannedAt: "2026-10-26T09:00:00Z",
      }),
    );
    await mapCommand(root, REPO, { estimate: true, commit: COMMIT }, io().io);
    const after = parse(await readFile(join(root, PLAN), "utf8"));
    expect(after.schemaVersion).toBe(2);
    expect(after.plannedAt).toBe("2026-10-26T09:00:00Z");
    expect(after.parts).toEqual(now.parts);
    expect(after.estimate).toEqual(now.estimate);
  });

  it("stamps each part when verify first finds it in the facts, and the whole read once all are", async () => {
    const root = bigRepo();
    await mapCommand(root, REPO, { estimate: true, commit: COMMIT }, io().io);
    const plan = (await loadReadPlan(root, REPO))!;
    const [first, ...rest] = plan.parts;
    readAll(root, first!.paths);
    expect(await verifyCommand(root, REPO, { commit: COMMIT, now: NOW }, io().io)).toBe(0);
    const once = (await loadReadPlan(root, REPO))!;
    expect(once.parts[0]!.read).toEqual({ at: "2026-10-31T09:00:00Z", commit: COMMIT });
    expect(once.parts.filter((p) => p.read)).toHaveLength(
      (await readPlanProgress(root, REPO))!.done,
    );
    expect(once.read).toBeUndefined();
    expect(readCostOf(once).read).toMatchObject({ of: plan.parts.length });
    // Every part read: the whole read is stamped, its sessions the parts it took as planned.
    appendFileSync(
      join(root, ".atticus", "facts", `${REPO}.reviewed.jsonl`),
      rest
        .flatMap((p) => p.paths)
        .map((p) => `${JSON.stringify({ path: p, why: "read; no fact to record" })}\n`)
        .join(""),
    );
    const later = () => new Date("2026-11-02T09:00:00.000Z");
    await verifyCommand(root, REPO, { commit: COMMIT, now: later }, io().io);
    const done = (await loadReadPlan(root, REPO))!;
    expect(done.read).toEqual({
      at: "2026-11-02T09:00:00Z",
      commit: COMMIT,
      sessions: plan.parts.length,
    });
    // The first part's stamp didn't move.
    expect(done.parts[0]!.read!.at).toBe("2026-10-31T09:00:00Z");
    expect(readCostOf(done).read).toEqual({
      parts: plan.parts.length,
      of: plan.parts.length,
      at: "2026-11-02T09:00:00Z",
    });
    // Verified again: nothing changes.
    const text = await readFile(join(root, PLAN), "utf8");
    await verifyCommand(root, REPO, { commit: COMMIT, now: () => new Date() }, io().io);
    expect(await readFile(join(root, PLAN), "utf8")).toBe(text);
  });

  it("stamps a one-session read once verify keeps its facts, and leaves a plan of another commit alone", async () => {
    const root = smallRepo();
    await mapCommand(root, REPO, { estimate: true, commit: COMMIT }, io().io);
    readAll(root, []);
    expect(await verifyCommand(root, REPO, { commit: COMMIT, now: NOW }, io().io)).toBe(0);
    expect((await loadReadPlan(root, REPO))!.read).toEqual({
      at: "2026-10-31T09:00:00Z",
      commit: COMMIT,
      sessions: 1,
    });
    // Planned at another commit: verifying at this one stamps nothing.
    const other = smallRepo();
    await mapCommand(other, REPO, { estimate: true, commit: "fedcba9" }, io().io);
    readAll(other, []);
    await verifyCommand(other, REPO, { commit: COMMIT, now: NOW }, io().io);
    expect((await loadReadPlan(other, REPO))!.read).toBeUndefined();
  });

  it("records what the reader reports with --spent, as reported, beside the estimate", async () => {
    const root = bigRepo();
    await mapCommand(root, REPO, { estimate: true, commit: COMMIT }, io().io);
    const o = io();
    expect(await mapSpent(root, REPO, { spent: "84k", sessions: "2", by: "pat" }, o.io)).toBe(0);
    expect(await mapSpent(root, REPO, { spent: "61,000", part: "2" }, io().io)).toBe(0);
    const plan = (await loadReadPlan(root, REPO))!;
    expect(plan.reported).toEqual([
      { at: expect.any(String), commit: COMMIT, tokens: 84_000, sessions: 2, by: "pat" },
      { at: expect.any(String), commit: COMMIT, tokens: 61_000, part: 2 },
    ]);
    const cost = readCostOf(plan);
    expect(cost.reported).toEqual({ tokens: 145_000, sessions: 2, reports: 2 });
    expect(cost.estimated!.sessions).toBe(plan.parts.length);
    const words = readCostWords(cost);
    expect(words).toMatch(
      /^estimated about \d+K tokens in \d+ sessions; 0 of \d+ parts read; reported 145K tokens in 2 sessions$/,
    );
    expect(o.out[0]).toMatch(
      /^Recorded in \.atticus\/facts\/forge-ledger\.read-plan\.yaml, as reported \(Atticus meters nothing\): /,
    );
    // A re-plan at the same commit keeps the reports.
    await mapCommand(root, REPO, { estimate: true, commit: COMMIT, maxTokens: 136_000 }, io().io);
    expect((await loadReadPlan(root, REPO))!.reported).toHaveLength(2);
  });

  it("refuses a report with no plan, a number that isn't one, or a part the plan hasn't", async () => {
    const root = smallRepo();
    const none = io();
    expect(await mapSpent(root, REPO, { spent: "1000" }, none.io)).toBe(2);
    expect(none.err[0]).toContain(`run atticus map ${REPO} --estimate first`);
    await mapCommand(root, REPO, { estimate: true, commit: COMMIT }, io().io);
    const bad = io();
    expect(await mapSpent(root, REPO, { spent: "lots" }, bad.io)).toBe(2);
    expect(bad.err[0]).toBe("--spent is a whole number above 0 (got lots).");
    const part = io();
    expect(await mapSpent(root, REPO, { spent: "1000", part: "2" }, part.io)).toBe(2);
    expect(part.err[0]).toContain("no parts (one session reads it): there is no part 2");
    const nothing = io();
    expect(await mapSpent(root, REPO, {}, nothing.io)).toBe(2);
  });
});
