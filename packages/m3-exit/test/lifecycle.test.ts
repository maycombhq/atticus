import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  MockGitHost,
  MockServiceDesk,
  MockWorkTracker,
  type Adapters,
  type JournalEntry,
} from "@maycombhq/adapters";
import {
  atticus,
  CHANGE,
  changeDir,
  FORGE_CHANGE,
  forgeEstate,
  json,
  METAREPO,
  OWN,
  readYaml,
  removeTop,
  sh,
  T,
  writeArtifacts,
  type Estate,
} from "./helpers.js";

/**
 * M3 exit: "A seeded fixture feature runs from Define to Release against mocks and the
 * recorded-replay runtime". A team drives the Forge change add-transfer-limit through every
 * phase with the atticus command line (main(), so the wiring is tested too): Define, Design
 * (the critic catches the seeded design problems, the architect fixes them), Plan (stories,
 * story bar, service-desk drafts, work items), Build (hand-down, Run with AI on a recorded
 * answer with a fake build, hand-up, drift, tests, trace), QA and Release, then archive.
 *
 * Outside systems are the C4 mocks runtime.yaml names. A mock lives in one process, so the test
 * shares one instance of each across CLI calls, as a real host keeps its state between them:
 * createAdapters still runs for every command (runtime.yaml → adapter → command); only the
 * instance is the shared one. Reviews on the Git host are what reviewers would do there.
 *
 * Steps share state and run in order. A step written with `gap()` (helpers.ts) asserts what the
 * exit needs where the product falls short today and is expected to fail; none is left here.
 */

const shared = vi.hoisted(() => ({ adapters: {} as Record<string, unknown> }));
vi.mock("@maycombhq/adapters", async (orig) => {
  const real = await orig<typeof import("@maycombhq/adapters")>();
  return {
    ...real,
    createAdapters: (...args: Parameters<typeof real.createAdapters>) => {
      const a: Adapters = real.createAdapters(...args);
      for (const kind of ["gitHost", "workTracker", "serviceDesk"] as const)
        if (args[0].adapters[kind]?.type === "mock" && shared.adapters[kind])
          (a as Record<string, unknown>)[kind] = shared.adapters[kind];
      return a;
    },
  };
});

const FC = join(FORGE_CHANGE, "openspec/changes", CHANGE);
const FIX = join(OWN, "fixes/design");
const OWNERS = [
  "product-owner=pat",
  "architect=ari,avery",
  "business-analyst=bao",
  "team-lead=tia",
  "developer=dev,dee",
  "qa=quinn",
  "delivery-lead=dana",
  "sre=sam",
];
const DESIGN_FILES = ["interfaces.md", "mappings.md", "data.md", "design.md", "ux.md"];

interface Seeded {
  id: string;
  kind: string;
  severity: string;
  layer: string;
  rule: string;
  artifact?: string;
  line?: number;
  record?: string;
}
interface FindingFile {
  id: string;
  kind: string;
  severity: string;
  rule: string;
  artifact: string;
  state: string;
  locator: { line?: number; record?: string };
  evidence: { record?: string }[];
}

function matches(s: Seeded, f: FindingFile): boolean {
  if (f.rule !== s.rule || f.severity !== s.severity || f.kind !== s.kind) return false;
  if (s.artifact && f.artifact !== s.artifact) return false;
  if (s.line && f.locator.line !== s.line) return false;
  if (s.record && f.locator.record !== s.record && !f.evidence.some((v) => v.record === s.record))
    return false;
  return true;
}

async function findingFiles(root: string, gate: string, round: number): Promise<FindingFile[]> {
  const dir = join(changeDir(root), "review", gate, String(round));
  const out: FindingFile[] = [];
  for (const f of (await readdir(dir)).filter((n) => n.endsWith(".yaml")).sort())
    out.push(parse(await readFile(join(dir, f), "utf8")) as FindingFile);
  return out;
}

let e: Estate;
let gh: MockGitHost;
let tracker: MockWorkTracker;
let desk: MockServiceDesk;
const env = { ...process.env };
const made: string[] = [];
const run = (...args: string[]) => atticus(e.root, ...args);

/** A throwaway copy of the metarepo, for gap probes that must not touch the shared state. */
async function probeCopy(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "atticus-m3-probe-"));
  made.push(dir);
  const root = join(dir, "metarepo");
  await cp(e.root, root, {
    recursive: true,
    filter: (src) => !src.split(/[\\/]/).includes("workspace"),
  });
  return root;
}

beforeAll(async () => {
  gh = new MockGitHost([{ repo: METAREPO }]);
  tracker = new MockWorkTracker();
  desk = new MockServiceDesk();
  shared.adapters = { gitHost: gh, workTracker: tracker, serviceDesk: desk };
  e = await forgeEstate();
  // AI steps replay recorded answers: forge-change's and this suite's own (test/fixtures/recordings).
  process.env.ATTICUS_REPLAY_DIR = e.replayDir;
  process.env.ATTICUS_RUNTIME = "replay";
  expect((await run("workspace", "sync")).code).toBe(0);
  expect((await run("scan")).code).toBe(0);
}, T);

afterAll(async () => {
  process.env = env;
  await removeTop(e);
  for (const d of made) await rm(d, { recursive: true, force: true });
});

describe("M3 exit step 2: the seeded feature from Define to Release", () => {
  // ------------------------------------------------------------------ define
  it(
    "the product owner starts the change from the feature template; it is high risk and still holds only the template",
    async () => {
      const r = await run(
        "change",
        "new",
        "Add a daily transfer limit",
        "--type",
        "feature",
        "--by",
        "pat",
        "--id",
        CHANGE,
        ...OWNERS.flatMap((o) => ["--owner", o]),
        ...["audit", "ledger", "northwind-pay", "portal"].flatMap((s) => ["--system", s]),
      );
      expect(r.out).toEqual([
        "Created add-transfer-limit (feature, from the feature template). It is in define.",
        "Write the brief: openspec/changes/add-transfer-limit/brief.md",
      ]);
      // Pin the creation date: Spec Kit hand-down stamps it into spec.md and plan.md, and the
      // recorded AI answers are found by a hash of prompts that include those files.
      const changeFile = join(e.root, "openspec/changes", CHANGE, "change.yaml");
      await writeFile(
        changeFile,
        (await readFile(changeFile, "utf8")).replace(
          /^createdAt: .*$/m,
          "createdAt: 2026-10-18T09:00:00Z",
        ),
      );
      const s = await run("change", "status", CHANGE);
      expect(s.out).toContain("State: define");
      expect(s.text).toMatch(
        /Risk: high \(8\): .*crosses the vendor boundary \(northwind-pay\) \+3/,
      );
      expect(s.out).toContain("  - brief.md still holds only the template.");
    },
    T,
  );

  it(
    "Define: with brief, proposal and spec written the change is ready to hand off (the Forge org pack has no define gate)",
    async () => {
      await writeArtifacts(e.root, FC, ["brief.md", "proposal.md", "specs"]);
      const c = await run("critic", CHANGE, "--gate", "define");
      expect(c.code).toBe(2);
      expect(c.err).toEqual(["There is no gate define. Gates: design, plan, build, release."]);
      expect((await run("change", "status", CHANGE)).out).toContain(
        'Next: Ready to raise "Send to architecture".',
      );
    },
    T,
  );

  it(
    "manual-git-host: with gitHost type manual in runtime.yaml (ADR 0032), the hand-off becomes a step for a person instead of an error",
    async () => {
      const root = await probeCopy();
      const rt = join(root, "org-pack/runtime.yaml");
      await writeFile(
        rt,
        (await readFile(rt, "utf8")).replace(
          "gitHost: { type: mock, settings: { metarepo: forge/forge-metarepo } }",
          "gitHost: { type: manual, settings: { metarepo: forge/forge-metarepo } }",
        ),
      );
      const r = await atticus(root, "change", "handoff", CHANGE, "--approve", "--by", "pat");
      expect(r.code).toBe(0);
      expect((await atticus(root, "todo", "--change", CHANGE)).text).toMatch(/pull request/i);
    },
    T,
  );

  it(
    "Send to architecture: without --approve nothing is sent; the hand-off PR merges once someone else approves it",
    async () => {
      const dry = await run("change", "handoff", CHANGE, "--by", "pat");
      expect(dry.code).toBe(0);
      expect(dry.out[1]).toMatch(/^Nothing was sent\./);
      expect(gh.journal.filter((j) => j.method === "createPullRequest")).toHaveLength(0);
      const h = await run("change", "handoff", CHANGE, "--approve", "--by", "pat");
      expect(h.code).toBe(0);
      expect(h.out[0]).toBe(
        "Hand-off PR #1 (handoff/add-transfer-limit/define) is open: https://git.example.com/forge/forge-metarepo/pull/1",
      );
      const early = await run("change", "sync", CHANGE, "--approve", "--by", "pat");
      expect(early.code).toBe(1);
      expect(early.text).toMatch(/PR #1 isn't approved yet/);
      gh.review(METAREPO, 1, "ari", "approved");
      const s = await run("change", "sync", CHANGE, "--approve", "--by", "pat");
      expect(s.out).toEqual(["PR #1 merged. add-transfer-limit is now design."]);
    },
    T,
  );

  // ------------------------------------------------------------------ design
  it(
    "Design round 1: the critic catches every seeded design problem: architecture b01-b03, runtime b04-b05, data design b06-b08, knowledge gaps g01-g11 and g14, and the risks r01 and r06-r08",
    async () => {
      await writeArtifacts(e.root, FC, DESIGN_FILES);
      const r = await run("critic", CHANGE, "--gate", "design");
      expect(r.code).toBe(1);
      // Re-baselined for the four questions (ADR 0124 addendum, Part 4, and the product owner's
      // decisions of 2026-10-24): g14 (constitution.public-entry-auth), r06
      // (review.call-timeout-stated), r07 and r08 (review.store-write-rollback).
      expect(r.out[0]).toBe(
        "Critic round 1 of 2 at the design gate for add-transfer-limit: 8 blocking, 12 gaps, 4 risks, 0 ideas.",
      );
      const ex = await readYaml<{ seeded: Seeded[]; alsoExpected: Seeded[] }>(
        join(FORGE_CHANGE, "expected/findings.yaml"),
      );
      const atDesign = ex.seeded.filter(
        (s) =>
          s.layer === "deterministic" &&
          (!s.artifact || ["interfaces.md", "data.md"].includes(s.artifact)),
      );
      expect(atDesign.map((s) => s.id)).toEqual([
        "b01-pattern-typo",
        "b02-hop-without-pattern",
        "b03-unknown-system",
        "b04-vendor-call-no-timeout",
        "b05-risk-call-no-timeout",
        "b06-table-without-migration",
        "b07-personal-column-unclassified",
        "b08-table-without-retention",
        "g01-audit-owner-unknown",
        "g02-ledger-vendor-timeouts-unknown",
        "g03-portal-bff-alerts-unknown",
        "g04-audit-alerts-unknown",
        "g05-vendor-rate-limit-unknown",
        "g06-vendor-contact-unknown",
        "g07-vendor-operation-unpublished",
        "g08-account-retention-unknown",
        "g09-ledger-slo-unknown",
        "g10-portal-slo-unknown",
        "g11-ledger-volume-unknown",
        "g14-audit-entry-auth-unknown",
      ]);
      const found = await findingFiles(e.root, "design", 1);
      expect(atDesign.filter((s) => !found.some((f) => matches(s, f))).map((s) => s.id)).toEqual(
        [],
      );
      // The four risks are the expected ones the design artifacts carry, each caught by code.
      const risksAtDesign = ex.alsoExpected.filter(
        (s) =>
          s.layer === "deterministic" &&
          ["interfaces.md", "data.md", "mappings.md"].includes(s.artifact ?? ""),
      );
      expect(risksAtDesign.map((s) => s.id)).toEqual([
        "r01-mapping-missing",
        "r06-audit-call-no-timeout",
        "r07-account-write-no-rollback",
        "r08-limit-change-write-no-rollback",
      ]);
      const risks = found.filter((f) => f.severity === "risk");
      expect(risks).toHaveLength(4);
      expect(
        risksAtDesign.filter((s) => !risks.some((f) => matches(s, f))).map((s) => s.id),
      ).toEqual([]);
      // A blocking finding stops the hand-off.
      const h = await run("change", "handoff", CHANGE, "--approve", "--by", "ari");
      expect(h.code).toBe(1);
      expect(h.err[0]).toBe('add-transfer-limit isn\'t ready for "Approve design".');
      expect(h.text).toMatch(/Blocking finding data-retention-stated-data-l8 on the design gate/);
    },
    T,
  );

  it(
    "Design fix: the architect asks each gap's owner and fixes the artifacts; round 2 has nothing blocking, the gaps stay asked and the two rollback risks stay open",
    async () => {
      const gaps = (await findingFiles(e.root, "design", 1)).filter((f) => f.severity === "gap");
      expect(gaps).toHaveLength(12);
      for (const g of gaps) {
        const a = await run("finding", CHANGE, g.id, "ask", "--by", "ari");
        expect(a.code, a.text).toBe(0);
        expect(a.out[0]).toMatch(
          /^Asked team-[a-z]+\. The gap stops blocking while the question is open\.$/,
        );
      }
      await writeArtifacts(e.root, FIX, ["interfaces.md", "data.md", "design.md", "ux.md"]);
      const r = await run("critic", CHANGE, "--gate", "design");
      expect(r.out[0]).toBe(
        "Critic round 2 of 2 at the design gate for add-transfer-limit: 0 blocking, 12 gaps, 2 risks, 0 ideas.",
      );
      expect(r.out.filter((l) => l.endsWith("(asked in the last round)"))).toHaveLength(12);
      // The fix states the audit call's timeout (r06 goes), but its rollback line ("the new column
      // and table stay") names neither table nor migration, so r07 and r08 stay: risks, which
      // don't stop the gate (review.store-write-rollback).
      const risks = (await findingFiles(e.root, "design", 2)).filter((f) => f.severity === "risk");
      expect(risks.map((f) => [f.rule, f.artifact, f.locator.line])).toEqual([
        ["review.store-write-rollback", "data.md", 7],
        ["review.store-write-rollback", "data.md", 8],
      ]);
      expect(r.out.at(-1)).toBe("The design gate may proceed: nothing blocking is open.");
      expect(r.code).toBe(0);
    },
    T,
  );

  it(
    "Approve design: the approval of the person who raised the PR doesn't count; the other architect's does",
    async () => {
      const h = await run("change", "handoff", CHANGE, "--approve", "--by", "ari");
      expect(h.code).toBe(0);
      expect(h.out[1]).toBe("Reviewers: @forge/platform");
      gh.review(METAREPO, 2, "ari", "approved");
      const own = await run("change", "sync", CHANGE, "--approve", "--by", "ari");
      expect(own.code).toBe(1);
      expect(own.err).toEqual([
        "PR #2 can't merge yet:",
        "  - PR #2 is approved only by ari, who raised it; it needs someone else's approval.",
      ]);
      gh.review(METAREPO, 2, "avery", "approved");
      expect((await run("change", "sync", CHANGE, "--approve", "--by", "avery")).out).toEqual([
        "PR #2 merged. add-transfer-limit is now plan.",
      ]);
    },
    T,
  );

  // ------------------------------------------------------------------ plan
  it(
    "Plan: stories and tasks from the approved design with the replayed story writer, service-desk drafts, and the story bar is met",
    async () => {
      const p = await run("plan", "stories", CHANGE, "--mode", "replay");
      expect(p.code).toBe(0);
      expect(p.out[0]).toBe("Planned 5 stories and 9 tasks for add-transfer-limit in 3 repos.");
      expect(p.text).not.toMatch(/Discarded AI output|No AI prose/);
      const snow = await run("plan", "snow", CHANGE);
      expect(snow.out[0]).toBe(
        "Wrote 2 service-desk drafts to openspec/changes/add-transfer-limit/snow.md.",
      );
      // The delivery lead fills the two values Atticus couldn't know.
      const f = join(changeDir(e.root), "snow.md");
      await writeFile(
        f,
        (await readFile(f, "utf8"))
          .replace("| Target |  |", "| Target | https://api.northwind.example |")
          .replace("| Destination host |  |", "| Destination host | api.northwind.example |"),
      );
      const bar = await run("plan", "bar", CHANGE);
      expect(bar.out[0]).toMatch(/^5 of 5 stories are ready \(100%, the bar is 90%\); /);
      expect(bar.out.at(-1)).toBe("The story bar is met.");
      expect(bar.code).toBe(0);
    },
    T,
  );

  it(
    "Plan critic round: nothing blocking (no story without criteria, no instruction in a story, both service-desk drafts complete); the twelve gaps come back at the plan gate, already asked at the design gate, and the two rollback risks stay open",
    async () => {
      const r = json<{
        open: { blocking: number; gaps: number };
        findings: { rule: string; severity: string; state: string }[];
      }>(await run("critic", CHANGE, "--gate", "plan", "--json"));
      expect(r.open).toEqual({ blocking: 0, gaps: 0, risks: 2, ideas: 0 });
      expect(
        r.findings.filter((f) => f.severity === "risk" && f.state === "open").map((f) => f.rule),
      ).toEqual(["review.store-write-rollback", "review.store-write-rollback"]);
      const gaps = r.findings.filter((f) => f.severity === "gap");
      expect(gaps).toHaveLength(12);
      expect(gaps.every((f) => f.state === "asked")).toBe(true);
      for (const rule of [
        "constitution.story-acceptance-criteria",
        "constitution.no-embedded-instructions",
        "constitution.snow-drafts-present",
        "tasks-cover-stories",
      ])
        expect(r.findings.map((f) => f.rule)).not.toContain(rule);
    },
    T,
  );

  it(
    "finding-gate: the questions asked at the design gate come back at the plan gate already asked, linked to the first; atticus finding acts on the plan gate's copy, and --gate picks one",
    async () => {
      const gaps = (await findingFiles(e.root, "plan", 1)).filter((f) => f.severity === "gap");
      expect(gaps).toHaveLength(12);
      expect(gaps.map((f) => f.state)).toEqual(Array(12).fill("asked"));
      expect(
        parse(
          await readFile(
            join(changeDir(e.root), "review/plan/1/gap-slo-known-ledger.yaml"),
            "utf8",
          ),
        ).resolution,
      ).toMatchObject({
        action: "ask",
        by: "ari",
        reason: "Already asked at the design gate: see review/design/2/gap-slo-known-ledger.yaml.",
      });
      // No gate named: the latest round across gates, the plan gate's copy, with its link.
      const r = await run("finding", CHANGE, "gap-slo-known-ledger", "ask", "--by", "tia");
      expect(r.code).toBe(1);
      expect(r.err[0]).toBe(
        "Finding gap-slo-known-ledger is already asked (by ari). Already asked at the design gate: see review/design/2/gap-slo-known-ledger.yaml.",
      );
      // --gate design reaches the design gate's own copy.
      const d = await run(
        "finding",
        CHANGE,
        "gap-slo-known-ledger",
        "ask",
        "--by",
        "tia",
        "--gate",
        "design",
      );
      expect(d.err[0]).toBe("Finding gap-slo-known-ledger is already asked (by ari).");
      // Nothing is left for the team lead to ask: only the hand-off itself is missing.
      const s = json<{ reasons: { code: string }[] }>(
        await run("change", "status", CHANGE, "--json"),
      );
      expect(s.reasons.map((x) => x.code)).toEqual(["no-handoff"]);
    },
    T,
  );

  it(
    "ado sync: a dry run sends nothing; the approved sync creates the feature, 5 stories and 9 tasks, each write carrying the BA's approval",
    async () => {
      const dry = await run("ado", "sync", CHANGE, "--dry-run");
      expect(dry.out[0]).toBe(
        "Dry run: 15 work-item writes for add-transfer-limit. Nothing was sent.",
      );
      expect(tracker.journal.filter((j) => j.approval)).toEqual([]);
      const live = await run("ado", "sync", CHANGE, "--approve", "--by", "bao");
      expect(live.out[0]).toBe("Sent 15 work-item writes for add-transfer-limit.");
      const writes = tracker.journal.filter((j) => j.approval);
      expect(writes).toHaveLength(15);
      expect(new Set(writes.map((j) => j.approval!.by))).toEqual(new Set(["bao"]));
    },
    T,
  );

  it(
    "plan submit: the two service-desk requests go out on the delivery lead's approval",
    async () => {
      const dry = await run("plan", "submit", CHANGE, "--dry-run");
      expect(dry.out[0]).toBe(
        "Dry run: 2 service-desk writes for add-transfer-limit. Nothing was sent.",
      );
      const live = await run("plan", "submit", CHANGE, "--approve", "--by", "dana");
      expect(live.out[0]).toBe("Sent 2 service-desk writes for add-transfer-limit.");
      const writes = desk.journal.filter((j) => j.approval);
      expect(writes).toHaveLength(2);
      expect(new Set(writes.map((j) => j.approval!.by))).toEqual(new Set(["dana"]));
    },
    T,
  );

  it(
    "Plan ready: the BA raises it and the team lead approves",
    async () => {
      expect((await run("change", "handoff", CHANGE, "--approve", "--by", "bao")).code).toBe(0);
      gh.review(METAREPO, 3, "tia", "approved");
      expect((await run("change", "sync", CHANGE, "--approve", "--by", "tia")).out).toEqual([
        "PR #3 merged. add-transfer-limit is now build.",
      ]);
    },
    T,
  );

  // ------------------------------------------------------------------ build
  it(
    "Build: the change's worktrees open, and task 1.2 is handed down to forge-ledger as a Spec Kit feature",
    async () => {
      const w = await run(
        "workspace",
        "open",
        CHANGE,
        "--repos",
        "forge-ledger,forge-portal-bff,forge-portal-ui",
      );
      expect(w.code).toBe(0);
      const d = await run("spec", "hand-down", CHANGE, "1.2");
      expect(d.code).toBe(0);
      expect(d.out[0]).toBe(
        "Handed task 1.2 down to forge-ledger as the Spec Kit feature specs/1.2, in workspace/.worktrees/add-transfer-limit/forge-ledger.",
      );
      expect(d.out).toContain("  wrote specs/1.2/plan.md");
      expect(d.out.at(-1)).toMatch(
        /^Committed [0-9a-f]{12} on change\/add-transfer-limit; nothing was pushed\.$/,
      );
    },
    T,
  );

  it(
    "task-run-replay: atticus task run --mode replay reads the recordings named by ATTICUS_REPLAY_DIR, applies the recorded answer on the task branch and the fake build runner passes",
    async () => {
      const r = await run(
        "task",
        "run",
        CHANGE,
        "1.2",
        "--by",
        "dev",
        "--level",
        "draft",
        "--mode",
        "replay",
      );
      expect(r.text).not.toMatch(/needs a folder of recordings/);
      expect(r.out[0]).toMatch(
        /^Task 1\.2 is drafted on task\/add-transfer-limit\/1\.2 and the build passes \(1 attempt\); committed [0-9a-f]{12}\.$/,
      );
      expect(r.code).toBe(0);
      const state = join(changeDir(e.root), "tasks/1.2/task-run.yaml");
      expect((await readYaml<{ state: string }>(state)).state).toBe("built");
      const log = await readFile(e.buildLog, "utf8");
      expect(log).toMatch(/\.tasks[\\/]1\.2[\\/]forge-ledger/);
      const tw = join(e.root, "workspace/.worktrees", CHANGE, ".tasks/1.2/forge-ledger");
      expect(sh(tw, "show", "--stat", "--format=%s", "HEAD")).toMatch(/TransferLimits\.java/);
    },
    T,
  );

  it(
    "a developer merges the task branch; spec hand-up reads the feature back at the PR, the complete lens runs on replay, and nothing drifted",
    async () => {
      const wt = join(e.root, "workspace/.worktrees", CHANGE, "forge-ledger");
      sh(wt, "merge", "--no-ff", "-q", "-m", "Merge task 1.2", "task/add-transfer-limit/1.2");
      const u = await run(
        "spec",
        "hand-up",
        CHANGE,
        "1.2",
        "--by",
        "dev",
        "--pr",
        "7",
        "--pr-url",
        "https://git.example.com/forge/forge-ledger/pull/7",
      );
      expect(u.out[0]).toBe(
        "Task 1.2 is handed up from PR https://git.example.com/forge/forge-ledger/pull/7 and marked done in tasks.md.",
      );
      expect(u.out).toContain("  The complete lens raised 0 findings.");
      expect(u.out.at(-1)).toBe("  Drift: none.");
      expect(u.code).toBe(0);
      const d = await run("drift", CHANGE);
      expect(d.out).toEqual([
        "Compared the design of add-transfer-limit with 1 repo plan and the code.",
        "No drift.",
      ]);
    },
    T,
  );

  it(
    "tests generate for story s2, then trace: stories without tests are blocking trace findings",
    async () => {
      const g = await run("tests", "generate", CHANGE, "s2-remaining-limit");
      expect(g.code).toBe(0);
      expect(g.out[0]).toMatch(/^Generated \d+ test cases for s2-remaining-limit in \d+ files: /);
      const t = await run("trace", CHANGE);
      expect(t.code).toBe(1);
      expect(t.out[0]).toBe("# Traceability: add-transfer-limit");
      expect(t.text).toMatch(/story-without-test: Story s1-daily-transfer-limit has no test/);
    },
    T,
  );

  it(
    "trace-gate-lifecycle: open blocking findings on the built-in trace gate stop the Build hand-off (ADR 0039: read by the lifecycle like any gate)",
    async () => {
      const s = json<{ reasons: { code: string; message: string }[] }>(
        await run("change", "status", CHANGE, "--json"),
      );
      expect(
        s.reasons.some((x) => x.code === "blocking-finding" && /trace gate/.test(x.message)),
      ).toBe(true);
    },
    T,
  );

  it(
    "tests for every story close the trace gaps: trace is clean apart from one risk",
    async () => {
      for (const st of [
        "s1-daily-transfer-limit",
        "s3-northwind-pay-velocity-checks",
        "s4-audit-events",
        "s5-limit-change",
      ]) {
        const g = await run("tests", "generate", CHANGE, st);
        expect(g.code, g.text).toBe(0);
      }
      const t = await run("trace", CHANGE);
      expect(t.code).toBe(0);
      expect(t.out, t.text).toContain("Wrote 1 finding to review/trace/2/.");
      expect(t.text).toMatch(/test-without-requirement: /);
    },
    T,
  );

  it(
    "trace-noise: trace says one quiet line about tasks that were never run, not Git's error for each",
    async () => {
      const t = await run("trace", CHANGE, "--no-write");
      expect(t.err.filter((l) => /git diff failed|no diff for task/.test(l))).toEqual([]);
      expect(t.err.length).toBeLessThanOrEqual(1);
    },
    T,
  );

  it(
    "Raise PR: the developer raises it and the other developer approves",
    async () => {
      expect((await run("change", "handoff", CHANGE, "--approve", "--by", "dev")).code).toBe(0);
      gh.review(METAREPO, 4, "dee", "approved");
      expect((await run("change", "sync", CHANGE, "--approve", "--by", "dee")).out).toEqual([
        "PR #4 merged. add-transfer-limit is now qa.",
      ]);
    },
    T,
  );

  // ------------------------------------------------------------------ qa and release
  it(
    "QA sign-off: QA approves",
    async () => {
      expect((await run("change", "handoff", CHANGE, "--approve", "--by", "tia")).code).toBe(0);
      gh.review(METAREPO, 5, "quinn", "approved");
      expect((await run("change", "sync", CHANGE, "--approve", "--by", "quinn")).out).toEqual([
        "PR #5 merged. add-transfer-limit is now release-ready.",
      ]);
    },
    T,
  );

  it(
    "Go/no-go: the release hand-off PR is go / no-go; it merges once someone other than its raiser approves, then it is released",
    async () => {
      const st = await run("change", "status", CHANGE);
      expect(st.out).toContain(
        "Hand-off: no PR yet; atticus change handoff add-transfer-limit --approve opens it, and merging it approves the release gate.",
      );
      expect(st.text).not.toMatch(/Approvals needed/);
      // The release gate is mandatory on the Forge platform: the critic reviews it first.
      const c = await run("critic", CHANGE, "--gate", "release");
      expect(c.text).toMatch(/Critic round 1 of 2 at the release gate/);
      expect(c.code, c.text).toBe(0);
      expect((await run("change", "handoff", CHANGE, "--approve", "--by", "tia")).code).toBe(0);
      gh.review(METAREPO, 6, "tia", "approved");
      const early = await run("change", "sync", CHANGE, "--approve", "--by", "tia");
      expect(early.code).toBe(1);
      expect(early.err).toEqual([
        "PR #6 can't merge yet:",
        "  - PR #6 is approved only by tia, who raised it; it needs someone else's approval.",
      ]);
      gh.review(METAREPO, 6, "dana", "approved");
      // Approved, but merging writes to the Git host: without --approve it is only reported.
      const ready = await run("change", "sync", CHANGE, "--by", "dana");
      expect(ready.code).toBe(1);
      expect(ready.out[0]).toMatch(/^PR #6 is approved and the Git host's rules are met\./);
      expect((await run("change", "sync", CHANGE, "--approve", "--by", "dana")).out).toEqual([
        "PR #6 merged. add-transfer-limit is now released.",
      ]);
    },
    T,
  );

  it(
    "Release: the archive gate passes (no open blocking finding or gap, no drift) and the change is archived",
    async () => {
      const g = await run("ci", "archive-gate", CHANGE);
      expect(g.out).toEqual([
        "add-transfer-limit may be archived: no blockers, builds passed and the catalog matches its repos.",
      ]);
      expect(g.code).toBe(0);
      const a = await run("change", "archive", CHANGE, "--by", "dana");
      expect(a.out).toContain("Archived add-transfer-limit.");
      expect(a.code).toBe(0);
      const l = json<{ id: string; state: string }[]>(await run("change", "list", "--json"));
      expect(l).toEqual([
        { id: CHANGE, title: "Add a daily transfer limit", type: "feature", state: "archived" },
      ]);
      const c = await readYaml<{ history: { to: string }[] }>(
        join(changeDir(e.root), "change.yaml"),
      );
      expect(c.history.map((h) => h.to)).toEqual([
        "define",
        "design",
        "plan",
        "build",
        "qa",
        "release-ready",
        "released",
        "archived",
      ]);
    },
    T,
  );

  it(
    "safety: every write to a shared system carried a person's approval, and nothing was pushed to any repo",
    async () => {
      const writes = (j: readonly JournalEntry[], methods: string[]) =>
        j.filter((x) => methods.includes(x.method));
      const prWrites = writes(gh.journal, ["createPullRequest", "merge", "comment"]);
      expect(prWrites.length).toBeGreaterThanOrEqual(12);
      for (const w of prWrites) expect(w.approval?.by, w.method).toMatch(/^[a-z]+$/);
      // Each hand-off merged on the approval of someone holding the phase's role.
      const merges = writes(gh.journal, ["merge"]).map((m) => m.approval!.by);
      expect(merges).toEqual(["pat", "avery", "tia", "dee", "quinn", "dana"]);
      // AI never pushes: every remote still has only its initial commit on main.
      for (const repo of ["forge-ledger", "forge-portal-bff", "forge-portal-ui"]) {
        const refs = sh(
          join(e.top, "remotes", `${repo}.git`),
          "for-each-ref",
          "--format=%(refname)",
        );
        expect(refs.split("\n")).toEqual(["refs/heads/main"]);
      }
    },
    T,
  );
});
