import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import {
  factsDirOf,
  factsFileOf,
  helperOn,
  HOSTS_STEP,
  LINK_QUESTION_STEPS,
  TARGETS_STEP_ID,
  TERM_STEP,
  TOPICS_STEP_ID,
  isGuessedJoin,
  joinConventions,
  joinFacts,
  joinGuessesOf,
  listQuestions,
  loadOrgPack,
  orgPackDirOf,
  parseFacts,
  type Fact,
  type OrgPack,
} from "@maycombhq/core";
import {
  componentRenames,
  estateFacts,
  isPrototypeRepo,
  joinReposOf,
  outsideSystems,
} from "@maycombhq/scanner";
import type { GitRunner } from "@maycombhq/workspace";
import type { Output } from "./commands.js";
import { estateFreshness, FRESH_STATES, type FreshState } from "./estate-fresh.js";
import { loadReadPlan, readCostOf } from "./map-parts.js";

/**
 * `atticus doctor --counts` (F10): how far the map has got, in counts and flags only, so it can be
 * pasted out of a client's estate into an issue or a chat. Nothing is named: no repo, component,
 * system, owner, host, path, topic or question text; the only words are Atticus's own (a join's
 * flag such as `joined-by-path`, the step that asked a question, a repo's freshness state).
 * It reads the metarepo and writes nothing.
 */
export interface DoctorCounts {
  questions: {
    open: number;
    /** By the Atticus step that asked (`map-targets`, `hosts`...). */
    byKind: Record<string, number>;
    /**
     * The open target questions (`facts-targets`) by how many calls each covers (one evidence
     * line per call): asked alone, or as a group (Q1), and how many by size.
     */
    targets: {
      open: number;
      calls: number;
      alone: number;
      groups: number;
      inGroups: number;
      /** `1`, `2-4`, `5-9`, `10+`: questions covering that many calls. */
      bySize: Record<string, number>;
    };
  };
  links: {
    /** Calls joined to their entry with both ends declared and nothing guessed. */
    verified: number;
    /** Calls joined by a guess, or with an end not declared. */
    inferred: number;
    /** The inferred ones by the flag that says how (`joined-by-path`, `joined-by-label`...). */
    inferredBy: Record<string, number>;
    /** Calls the join asked a person about (more than one callee, a host nobody lists). */
    asked: number;
    /** The asked ones by the join's reason (`ambiguous`, `unknown-host`, `cycle`). */
    askedBy: Record<string, number>;
    /** Calls left to a system outside the estate. */
    outside: number;
    /** Calls nothing answers: no join, no question, no outside system. */
    unresolved: number;
    /**
     * The unresolved ones by why the join left them (`JOIN_LEFT_REASONS`: `no-host`,
     * `unresolved-placeholder`, `host-no-route`...); `other` for one it gave no reason for.
     */
    unresolvedBy: Record<string, number>;
  };
  repos: {
    total: number;
    read: number;
    unread: number;
    stale: number;
    /** Every repo by its freshness state (`estate fresh`). */
    byState: Record<FreshState, number>;
  };
  facts: {
    /** Facts the verifier kept (marked verified in the facts files). */
    accepted: number;
    /** Lines in the rejected files, for the reader to fix. */
    rejected: number;
    /** Facts not verified yet. */
    notVerified: number;
    /** Source files no fact cites and nobody reviewed (the last verify's unknown files). */
    filesNotRead: number;
  };
  /** What readers reported their reads took, summed over every repo's read plan (ADR 0141). */
  tokens: { reported: number; reports: number; repos: number };
}

/**
 * The steps of Atticus's own that ask questions. A question asked by any other step (a plugin's,
 * whose id can carry an organisation's name) is counted as `other`, so nothing is named.
 */
export const QUESTION_STEPS: ReadonlySet<string> = new Set([
  "map",
  "scan-survey",
  "scan-verify",
  "spec-draft",
  "spec-check",
  HOSTS_STEP,
  TARGETS_STEP_ID,
  TOPICS_STEP_ID,
  TERM_STEP,
  ...LINK_QUESTION_STEPS,
  // The planner's, a change's stages (planner/src/stages) and its gaps; the knowledge conflicts.
  "change-feature",
  "change-architecture",
  "change-stories",
  "change-small",
  "context-gap",
  "knowledge-conflict",
]);
export const OTHER_STEP = "other";

const bump = (m: Record<string, number>, k: string, n = 1) => {
  m[k] = (m[k] ?? 0) + n;
};
const sorted = (m: Record<string, number>) =>
  Object.fromEntries(Object.entries(m).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** A listener's own call (subscribe, consume, listen) is no call to join. */
const LISTENS = /^(subscribe|consume|listen)$/i;

export async function doctorCounts(
  root: string,
  o: { git?: GitRunner } = {},
): Promise<DoctorCounts & { problems: number }> {
  let problems = 0;

  // Questions: the open ones, by the step that asked.
  // Every read is caught: an error's message names a file, so it is counted, never printed.
  const qs = await listQuestions(root, { state: "open" }).catch(() => {
    problems++;
    return { questions: [], problems: [] };
  });
  problems += qs.problems.length;
  const byKind: Record<string, number> = {};
  for (const q of qs.questions)
    bump(byKind, QUESTION_STEPS.has(q.askedBy.step) ? q.askedBy.step : OTHER_STEP);
  // The target questions by the calls each covers: a call's own cites its line, a group's
  // every member's (Q1), so its evidence lines are its calls.
  const targets = {
    open: 0,
    calls: 0,
    alone: 0,
    groups: 0,
    inGroups: 0,
    bySize: {} as Record<string, number>,
  };
  for (const q of qs.questions) {
    if (q.askedBy.step !== TARGETS_STEP_ID) continue;
    const n = Math.max(1, new Set(q.evidence).size);
    targets.open++;
    targets.calls += n;
    if (n === 1) targets.alone++;
    else {
      targets.groups++;
      targets.inGroups += n;
    }
    bump(targets.bySize, n === 1 ? "1" : n <= 4 ? "2-4" : n <= 9 ? "5-9" : "10+");
  }

  // Repos: each one's freshness, as `atticus estate fresh` reads it.
  const fresh = await estateFreshness(root, o.git ? { git: o.git } : {}).catch(() => {
    problems++;
    return { repos: [], problems: [] };
  });
  problems += fresh.problems.length;
  const byState = Object.fromEntries(FRESH_STATES.map((s) => [s, 0])) as Record<FreshState, number>;
  for (const r of fresh.repos) byState[r.state]++;
  const total = fresh.repos.length;

  // Facts: kept, rejected and not verified, from the facts folder; files not read from each
  // repo's last verify report.
  const facts = { accepted: 0, rejected: 0, notVerified: 0, filesNotRead: 0 };
  const dir = factsDirOf(root);
  const names = (await readdir(dir).catch(() => [] as string[])).sort();
  const read = async (n: string) => readFile(join(dir, n), "utf8").catch(() => undefined);
  for (const n of names) {
    const of = factsFileOf(n);
    if (!of) continue;
    const text = await read(n);
    if (text === undefined) {
      problems++;
      continue;
    }
    if (of.facts) {
      const p = parseFacts(text);
      if (!p.ok) {
        problems++;
        continue;
      }
      for (const f of p.facts)
        if (f.verified === "none") facts.notVerified++;
        else facts.accepted++;
    } else if (n.endsWith(".rejected.jsonl"))
      facts.rejected += text.split("\n").filter((l) => l.trim()).length;
    else if (n.endsWith(".verify.yaml"))
      try {
        const v = parse(text) as { coverage?: { unknown?: unknown } } | null;
        const u = v?.coverage?.unknown;
        facts.filesNotRead += Array.isArray(u) ? u.length : typeof u === "number" ? u : 0;
      } catch {
        problems++;
      }
  }

  // Tokens: what readers reported, per repo's read plan.
  const tokens = { reported: 0, reports: 0, repos: 0 };
  for (const r of fresh.repos) {
    const plan = await Promise.resolve()
      .then(() => loadReadPlan(root, r.repo))
      .catch(() => {
        problems++;
        return undefined;
      });
    const cost = plan ? readCostOf(plan).reported : undefined;
    if (!cost) continue;
    tokens.repos++;
    tokens.reports += cost.reports;
    tokens.reported += cost.tokens ?? 0;
  }

  // Links: the estate join over the verified facts on file, as `atticus verify --write` makes it.
  const links = {
    verified: 0,
    inferred: 0,
    inferredBy: {},
    asked: 0,
    askedBy: {},
    outside: 0,
    unresolved: 0,
    unresolvedBy: {},
  };
  let op: OrgPack | undefined;
  try {
    op = await loadOrgPack(orgPackDirOf(root));
  } catch {
    if (total) problems++;
  }
  if (op)
    try {
      Object.assign(links, await linkCounts(root, op));
    } catch {
      problems++;
    }

  return {
    questions: {
      open: qs.questions.length,
      byKind: sorted(byKind),
      targets: { ...targets, bySize: bySizeOrder(targets.bySize) },
    },
    links,
    repos: {
      total,
      read: total - byState["not-read"],
      unread: byState["not-read"],
      stale: byState.stale,
      byState,
    },
    facts,
    tokens,
    problems,
  };
}

async function linkCounts(root: string, op: OrgPack): Promise<DoctorCounts["links"]> {
  const estate = await estateFacts(root, op, "");
  const repos = estate.repos.filter((x) => !isPrototypeRepo(op, x.repo));
  const join = joinFacts({
    repos: joinReposOf(op, repos, componentRenames(repos, op)),
    ...(Object.keys(estate.targets).length ? { targets: estate.targets } : {}),
    outside: outsideSystems(op),
    ...joinConventions(op),
    walkGateways: helperOn("gateway-walk"),
    // Why each call was left, in the join's own words, for unresolvedBy.
    explain: true,
  });
  const factOf = new Map<string, Fact>();
  for (const r of repos) for (const f of r.facts) factOf.set(`${r.repo}\u0000${f.id}`, f);
  const key = (e: { repo: string; fact: string }) => `${e.repo}\u0000${e.fact}`;
  const declared = (e: { repo: string; fact: string }) => factOf.get(key(e))?.conf === "declared";

  const out: DoctorCounts["links"] = {
    verified: 0,
    inferred: 0,
    inferredBy: {},
    asked: 0,
    askedBy: {},
    outside: 0,
    unresolved: 0,
    unresolvedBy: {},
  };
  const answered = new Set<string>();
  const why = new Map((join.left ?? []).map((l) => [key(l.call), l.reason as string]));
  for (const j of join.joins) {
    answered.add(key(j.call));
    if (!isGuessedJoin(j) && declared(j.call) && declared(j.entry)) out.verified++;
    else {
      out.inferred++;
      const flags = joinGuessesOf(j);
      if (flags.length) for (const f of flags) bump(out.inferredBy, f);
      else bump(out.inferredBy, "one-end-inferred");
    }
  }
  for (const a of join.asks) {
    if (answered.has(key(a.call))) continue;
    answered.add(key(a.call));
    out.asked++;
    bump(out.askedBy, a.reason);
  }
  for (const x of join.outside ?? []) {
    if (answered.has(key(x.call))) continue;
    answered.add(key(x.call));
    out.outside++;
  }
  for (const r of repos)
    for (const f of r.facts) {
      if (f.kind !== "call" || LISTENS.test(f.method ?? "")) continue;
      const k = `${r.repo}\u0000${f.id}`;
      if (answered.has(k)) continue;
      out.unresolved++;
      bump(out.unresolvedBy, why.get(k) ?? "other");
    }
  out.inferredBy = sorted(out.inferredBy);
  out.askedBy = sorted(out.askedBy);
  out.unresolvedBy = sorted(out.unresolvedBy);
  return out;
}

const kv = (m: Record<string, number>) =>
  Object.entries(m)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");

/** The question sizes in order: 1, 2-4, 5-9, 10+. */
const SIZES = ["1", "2-4", "5-9", "10+"];
const bySizeOrder = (m: Record<string, number>) =>
  Object.fromEntries(SIZES.filter((k) => m[k]).map((k) => [k, m[k]!]));

/** The counts as lines: numbers and Atticus's own words only. */
export function countsLines(c: DoctorCounts): string[] {
  const by = kv(c.questions.byKind);
  const inferred = kv(c.links.inferredBy);
  const states = kv(c.repos.byState);
  const askedBy = kv(c.links.askedBy);
  const unresolvedBy = kv(c.links.unresolvedBy);
  const t = c.questions.targets;
  const sizes = kv(t.bySize);
  return [
    `Questions: ${c.questions.open} open${by ? ` (${by})` : ""}`,
    ...(t.open
      ? [
          `Target questions: ${t.open} open, covering ${t.calls} calls: ${t.alone} asked alone, ${t.groups} groups holding ${t.inGroups}${sizes ? ` (by calls each: ${sizes})` : ""}`,
        ]
      : []),
    `Links: ${c.links.verified} verified, ${c.links.inferred} inferred${inferred ? ` (${inferred})` : ""}, ${c.links.asked} asked, ${c.links.outside} to outside systems, ${c.links.unresolved} unresolved calls`,
    ...(askedBy || unresolvedBy
      ? [
          `Calls ${[askedBy ? `asked by why: ${askedBy}` : "", unresolvedBy ? `unresolved by why: ${unresolvedBy}` : ""].filter(Boolean).join("; ")}`,
        ]
      : []),
    `Repos: ${c.repos.total} in all, ${c.repos.read} read, ${c.repos.unread} unread, ${c.repos.stale} stale${states ? ` (${states})` : ""}`,
    `Facts: ${c.facts.accepted} accepted, ${c.facts.rejected} rejected, ${c.facts.notVerified} not verified; ${c.facts.filesNotRead} source files not read`,
    `Tokens reported: ${c.tokens.reported} tokens over ${c.tokens.reports} reports for ${c.tokens.repos} repos`,
    "Counts and flags only: nothing here names a repo, system, host or file, so it is safe to paste.",
  ];
}

export async function doctorCountsCommand(
  root: string,
  o: { json?: boolean },
  io: Output,
  deps: { git?: GitRunner } = {},
): Promise<number> {
  const { problems, ...c } = await doctorCounts(root, deps);
  if (o.json) io.out(JSON.stringify({ ...c, problems }, null, 2));
  else {
    for (const l of countsLines(c)) io.out(l);
    if (problems)
      io.out(
        `${problems} file${problems === 1 ? "" : "s"} didn't read; atticus doctor and atticus estate fresh say which.`,
      );
  }
  return 0;
}
