import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { QuestionDraft, questionFromDraft, writeQuestion } from "@maycombhq/core";
import type { GitRunner } from "@maycombhq/workspace";
import {
  doctorCounts,
  doctorCountsCommand,
  countsLines,
  QUESTION_STEPS,
} from "../src/doctor-counts.js";

/** Review 18: a read that throws, its message naming the file it read. */
const fail = vi.hoisted(() => ({ plan: false, facts: false }));
vi.mock("../src/map-parts.js", async (orig) => {
  const m = await orig<typeof import("../src/map-parts.js")>();
  return {
    ...m,
    loadReadPlan: (root: string, repo: string) => {
      if (fail.plan)
        throw new Error(`EACCES: permission denied, open '${root}/facts/${repo}.read-plan.yaml'`);
      return m.loadReadPlan(root, repo);
    },
  };
});
vi.mock("@maycombhq/scanner", async (orig) => {
  const m = await orig<typeof import("@maycombhq/scanner")>();
  return {
    ...m,
    estateFacts: (
      root: string,
      ...rest: Parameters<typeof m.estateFacts> extends [unknown, ...infer R] ? R : never
    ) => {
      if (fail.facts)
        throw new Error(`EACCES: permission denied, open '${root}/facts/forge-payments.jsonl'`);
      return m.estateFacts(root, ...rest);
    },
  };
});
afterEach(() => {
  fail.plan = false;
  fail.facts = false;
});

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const ESTATE = join(FIXTURES, "link-estate");
let root: string;

/** No clone answers: every repo reads as having no checkout to compare with (no network, no git). */
const noGit: GitRunner = async () => {
  throw new Error("not a git repository");
};

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err };
};

/** Every name in the estate: the repo ids, components, systems, owners and hosts. */
function namesIn(): string[] {
  const m = parse(
    readFileSync(join(ESTATE, "org-pack/profiles/forge/repos.manifest.yaml"), "utf8"),
  ) as { repos: Record<string, unknown>[] };
  const names = new Set<string>(["api.forge.example", "apps.forge.internal", "git.forge.example"]);
  for (const r of m.repos)
    for (const k of ["id", "component", "system", "owner"])
      if (typeof r[k] === "string") names.add(r[k]);
  for (const f of readFileSync(join(ESTATE, "facts/forge-payments.jsonl"), "utf8").split("\n"))
    for (const h of f.match(/[a-z0-9-]+\.forge\.(example|internal)/g) ?? []) names.add(h);
  return [...names];
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-doctor-counts-"));
  await cp(ESTATE, root, { recursive: true });
  // One open question, and a read's cost as the reader reported it, so every count has a value.
  await writeQuestion(
    root,
    questionFromDraft(
      QuestionDraft.parse({
        question: "Which store keeps the payment holds?",
        evidence: ["src/main/java/forge/payments/PaymentsService.java:24"],
      }),
      {
        step: "scan-survey",
        repo: "forge-payments",
        command: "atticus map forge-payments",
        rerun: "atticus map forge-payments",
        at: "2026-10-30T10:00:00Z",
      },
    ),
  );
  await writeFile(
    join(root, "facts/forge-payments.read-plan.yaml"),
    [
      "schemaVersion: 2",
      "repo: forge-payments",
      "commit: 0123456789abcdef0123456789abcdef01234567",
      "session: 120000",
      "plannedAt: 2026-10-30T10:00:00Z",
      "parts: []",
      "reported:",
      "  - at: 2026-10-30T11:00:00Z",
      "    commit: 0123456789abcdef0123456789abcdef01234567",
      "    tokens: 41000",
      "  - at: 2026-10-30T12:00:00Z",
      "    commit: 0123456789abcdef0123456789abcdef01234567",
      "    tokens: 9000",
      "",
    ].join("\n"),
  );
});

describe("atticus doctor --counts (F10)", () => {
  it("counts links, repos, facts, questions and tokens on the link estate", async () => {
    const c = await doctorCounts(root, { git: noGit });
    expect(c.repos).toMatchObject({ total: 10, read: 10, unread: 0 });
    expect(c.repos.read + c.repos.unread).toBe(c.repos.total);
    // The join on the fixture, as its README says: joined through the gateways and the ingress
    // host, two guesses (by path, by a host's first label) and the audit event's wrong path guess.
    // Asked: payments' /limits/{id} (two services serve it); unresolved: cards' GET /ping, which
    // joins nobody; outside: the calls left to the outside systems (Northwind Pay, Forge SSO).
    expect(c.links).toEqual({
      verified: 8,
      inferred: 3,
      inferredBy: { "joined-by-label": 1, "joined-by-path": 2 },
      asked: 1,
      // Why, in the join's own words: two services serve /limits/{id}.
      askedBy: { ambiguous: 1 },
      outside: 3,
      unresolved: 1,
      // GET /ping: a health path with no target, which every service serves.
      unresolvedBy: { "generic-path": 1 },
    });
    expect(c.questions.targets).toEqual({
      open: 0,
      calls: 0,
      alone: 0,
      groups: 0,
      inGroups: 0,
      bySize: {},
    });
    expect(c.repos.byState["no-checkout"]).toBe(10);
    expect(c.facts).toEqual({ accepted: 52, rejected: 0, notVerified: 0, filesNotRead: 0 });
    expect(c.tokens).toEqual({ reported: 50000, reports: 2, repos: 1 });
    expect(c.questions).toMatchObject({ open: 1, byKind: { "scan-survey": 1 } });
  });

  it("prints only counts and flags: no repo id, component, system, owner or host", async () => {
    const t = capture();
    expect(await doctorCountsCommand(root, {}, t.io, { git: noGit })).toBe(0);
    const j = capture();
    expect(await doctorCountsCommand(root, { json: true }, j.io, { git: noGit })).toBe(0);
    const text = t.out.join("\n");
    const json = j.out.join("\n");
    expect(text).toMatch(/Links: \d+ verified, \d+ inferred/);
    expect(text).toContain("joined-by-path");
    expect(JSON.parse(json)).toMatchObject({ repos: { total: 10 } });
    for (const out of [text, json, ...t.err, ...j.err])
      for (const name of namesIn()) expect(out, name).not.toContain(name);
    // Nor a path: nothing of the machine it ran on.
    expect(text + json).not.toContain(root);
  });

  it("says the same in its lines as in its JSON", async () => {
    const c = await doctorCounts(root, { git: noGit });
    const lines = countsLines(c).join("\n");
    expect(lines).toContain(`${c.links.verified} verified`);
    expect(lines).toContain(`${c.repos.read} read`);
    expect(lines).toContain(`${c.tokens.reported} tokens`);
  });

  it("counts a question asked by a step that isn't Atticus's own as other (review 18)", async () => {
    const r = await mkdtemp(join(tmpdir(), "atticus-doctor-counts-steps-"));
    await cp(ESTATE, r, { recursive: true });
    const ask = (step: string, question: string) =>
      writeQuestion(
        r,
        questionFromDraft(
          QuestionDraft.parse({
            question,
            evidence: ["src/main/java/forge/payments/PaymentsService.java:24"],
          }),
          {
            step,
            repo: "forge-payments",
            command: "atticus map forge-payments",
            rerun: "atticus map forge-payments",
            at: "2026-10-30T10:00:00Z",
          },
        ),
      );
    // A plugin's step can carry an organisation's name: it is never printed.
    await ask("northwind-pay-ledger-check", "Is the ledger posted nightly?");
    await ask("facts-targets", "Which repo answers this call?");
    const c = await doctorCounts(r, { git: noGit });
    expect(c.questions.byKind).toEqual({ "facts-targets": 1, other: 1 });
    const t = capture();
    await doctorCountsCommand(r, {}, t.io, { git: noGit });
    expect(t.out.join("\n")).not.toContain("northwind");
    for (const s of ["map", "scan-survey", "facts-targets", "facts-topics", "scan-hosts"])
      expect(QUESTION_STEPS.has(s), s).toBe(true);
  });

  it("counts a part it can't read as a problem, printing no message or path (review 18)", async () => {
    const r = await mkdtemp(join(tmpdir(), "atticus-doctor-counts-broken-"));
    await cp(ESTATE, r, { recursive: true });
    fail.plan = true;
    fail.facts = true;
    const c = await doctorCounts(r, { git: noGit });
    expect(c.problems).toBeGreaterThan(0);
    const t = capture();
    expect(await doctorCountsCommand(r, {}, t.io, { git: noGit })).toBe(0);
    const j = capture();
    expect(await doctorCountsCommand(r, { json: true }, j.io, { git: noGit })).toBe(0);
    const all = [...t.out, ...t.err, ...j.out, ...j.err].join("\n");
    expect(all).not.toContain(r);
    expect(all).not.toMatch(/EACCES|forge-payments/);
  });

  it("counts the target questions by how many calls each covers: alone or in a group", async () => {
    const r = await mkdtemp(join(tmpdir(), "atticus-doctor-counts-targets-"));
    await cp(ESTATE, r, { recursive: true });
    const ask = (question: string, lines: number[]) =>
      writeQuestion(
        r,
        questionFromDraft(
          QuestionDraft.parse({
            question,
            // A group's question cites every call's line; a call's own, its one line.
            evidence: lines.map((l) => `src/main/java/forge/payments/PaymentsService.java:${l}`),
          }),
          {
            step: "facts-targets",
            repo: "forge-payments",
            command: "atticus verify forge-payments --write",
            rerun: "atticus verify forge-payments --write",
            at: "2026-10-30T10:00:00Z",
          },
        ),
      );
    await ask("Which repo or system answers GET /a?", [10]);
    await ask("Which repo or system answers GET /b?", [11]);
    await ask("Which repo or system answers the calls under /c?", [12, 13, 14]);
    await ask("Which repo or system answers the calls under /d?", [20, 21, 22, 23, 24, 25]);
    const c = await doctorCounts(r, { git: noGit });
    expect(c.questions.targets).toEqual({
      open: 4,
      calls: 11,
      alone: 2,
      groups: 2,
      inGroups: 9,
      bySize: { "1": 2, "2-4": 1, "5-9": 1 },
    });
    const lines = countsLines(c).join("\n");
    expect(lines).toContain(
      "Target questions: 4 open, covering 11 calls: 2 asked alone, 2 groups holding 9 (by calls each: 1 2, 2-4 1, 5-9 1)",
    );
    expect(lines).toContain("asked by why: ambiguous 1");
    expect(lines).toContain("unresolved by why: generic-path 1");
    expect(lines).not.toContain("forge-payments");
  });

  it("counts an empty metarepo as zeros, never an error", async () => {
    const empty = await mkdtemp(join(tmpdir(), "atticus-doctor-counts-empty-"));
    const c = await doctorCounts(empty, { git: noGit });
    expect(c.repos.total).toBe(0);
    expect(c.links.verified + c.links.inferred + c.links.unresolved).toBe(0);
    expect(c.tokens.reported).toBe(0);
  });
});
