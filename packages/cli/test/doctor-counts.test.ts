import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { QuestionDraft, questionFromDraft, writeQuestion } from "@maycombhq/core";
import type { GitRunner } from "@maycombhq/workspace";
import { doctorCounts, doctorCountsCommand, countsLines } from "../src/doctor-counts.js";

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
      outside: 3,
      unresolved: 1,
    });
    expect(c.repos.byState["no-checkout"]).toBe(10);
    expect(c.facts).toEqual({ accepted: 52, rejected: 0, notVerified: 0, filesNotRead: 0 });
    expect(c.tokens).toEqual({ reported: 50000, reports: 2, repos: 1 });
    expect(c.questions).toEqual({ open: 1, byKind: { "scan-survey": 1 } });
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

  it("counts an empty metarepo as zeros, never an error", async () => {
    const empty = await mkdtemp(join(tmpdir(), "atticus-doctor-counts-empty-"));
    const c = await doctorCounts(empty, { git: noGit });
    expect(c.repos.total).toBe(0);
    expect(c.links.verified + c.links.inferred + c.links.unresolved).toBe(0);
    expect(c.tokens.reported).toBe(0);
  });
});
