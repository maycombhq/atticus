import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import {
  factsDirOf,
  factsFileOf,
  helperOn,
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
    /** Calls left to a system outside the estate. */
    outside: number;
    /** Calls nothing answers: no join, no question, no outside system. */
    unresolved: number;
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
  const qs = await listQuestions(root, { state: "open" }).catch(() => ({
    questions: [],
    problems: [],
  }));
  problems += qs.problems.length;
  const byKind: Record<string, number> = {};
  for (const q of qs.questions) bump(byKind, q.askedBy.step);

  // Repos: each one's freshness, as `atticus estate fresh` reads it.
  const fresh = await estateFreshness(root, o.git ? { git: o.git } : {});
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
    if (text === undefined) continue;
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
    const plan = await loadReadPlan(root, r.repo);
    const cost = plan ? readCostOf(plan).reported : undefined;
    if (!cost) continue;
    tokens.repos++;
    tokens.reports += cost.reports;
    tokens.reported += cost.tokens ?? 0;
  }

  // Links: the estate join over the verified facts on file, as `atticus verify --write` makes it.
  const links = { verified: 0, inferred: 0, inferredBy: {}, asked: 0, outside: 0, unresolved: 0 };
  let op: OrgPack | undefined;
  try {
    op = await loadOrgPack(orgPackDirOf(root));
  } catch {
    if (total) problems++;
  }
  if (op) Object.assign(links, await linkCounts(root, op));

  return {
    questions: { open: qs.questions.length, byKind: sorted(byKind) },
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
    outside: 0,
    unresolved: 0,
  };
  const answered = new Set<string>();
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
  }
  for (const x of join.outside ?? []) {
    if (answered.has(key(x.call))) continue;
    answered.add(key(x.call));
    out.outside++;
  }
  for (const r of repos)
    for (const f of r.facts) {
      if (f.kind !== "call" || LISTENS.test(f.method ?? "")) continue;
      if (!answered.has(`${r.repo}\u0000${f.id}`)) out.unresolved++;
    }
  out.inferredBy = sorted(out.inferredBy);
  return out;
}

const kv = (m: Record<string, number>) =>
  Object.entries(m)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");

/** The counts as lines: numbers and Atticus's own words only. */
export function countsLines(c: DoctorCounts): string[] {
  const by = kv(c.questions.byKind);
  const inferred = kv(c.links.inferredBy);
  const states = kv(c.repos.byState);
  return [
    `Questions: ${c.questions.open} open${by ? ` (${by})` : ""}`,
    `Links: ${c.links.verified} verified, ${c.links.inferred} inferred${inferred ? ` (${inferred})` : ""}, ${c.links.asked} asked, ${c.links.outside} to outside systems, ${c.links.unresolved} unresolved calls`,
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
