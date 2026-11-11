import type { Api } from "@maycombhq/core";
import { normalizePath } from "@maycombhq/core/paths";
import { hitsAt, splitAt, type FactCite, type FactsView } from "../../app/evidence-model.js";
import type { Views } from "./model.js";

/**
 * Why is this linked, and this link is wrong (ADR 0135, C1 and C2), apart from React: the call a
 * link's join rests on, the correction a person makes of it, what `atticus verify --write` will
 * change, and, once it has run, what moved. Pure functions of the graph views and a repo's facts.
 */

export type Join = Api.HierJoinT;

/** The most calls one POST /api/links/corrections corrects: the API's LINK_CORRECTIONS_MAX. */
export const ARROW_CALLS_MAX = 5000;

/** The call's own line: the caller's first code citation (the config that ties it comes after). */
export function callerLine(j: Join): { repo: string; at: string } | undefined {
  const c = j.caller.find((e) => e.repo && e.source === "code") ?? j.caller.find((e) => e.repo);
  return c?.repo ? { repo: c.repo, at: c.at } : undefined;
}

/** The call facts on the caller's line, from the repo's facts: what a correction is about. */
export function callFactsOf(j: Join, v: FactsView | undefined): FactCite[] {
  const line = callerLine(j);
  const at = line ? splitAt(line.at) : undefined;
  if (!v || !at) return [];
  const seen = new Map<string, FactCite>();
  for (const h of hitsAt(v, at.file, at.line))
    if (h.fact.kind === "call" && !h.step) seen.set(h.fact.id, h.fact);
  return [...seen.values()];
}

/**
 * Every line of the caller's that names its repo (review of beta.24): an Interface merges every
 * call of its method and path (the join unions their evidence), so each call's line is here, the
 * code's first, then the config that ties them to the host.
 */
export function callerLines(j: Join): { repo: string; at: string }[] {
  const seen = new Set<string>();
  const out: { repo: string; at: string }[] = [];
  const sorted = [
    ...j.caller.filter((e) => e.source === "code"),
    ...j.caller.filter((e) => e.source !== "code"),
  ];
  for (const e of sorted) {
    if (!e.repo || !splitAt(e.at)) continue;
    const k = `${e.repo}\u0000${e.at}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ repo: e.repo, at: e.at });
  }
  return out;
}

/** The call facts cited on one line of a repo's facts. */
export function callFactsOn(line: { at: string }, v: FactsView | undefined): FactCite[] {
  const at = splitAt(line.at);
  if (!v || !at) return [];
  const seen = new Map<string, FactCite>();
  for (const h of hitsAt(v, at.file, at.line))
    if (h.fact.kind === "call" && !h.step) seen.set(h.fact.id, h.fact);
  return [...seen.values()];
}

/** One call a correction is written for: its repo, the line it is cited on, and its fact. */
export interface CallToCorrect {
  repo: string;
  at: string;
  fact: FactCite;
}

/**
 * A call on a line where the arrow's own call can't be told for sure (review of beta.24, round
 * 4): the person ticks the ones to correct. `ofPath`: its path is the link's (ticked at first).
 */
export interface CallToChoose extends CallToCorrect {
  ofPath: boolean;
}

/** A call's key in a pick: its repo and fact id. */
export const callKey = (c: { repo: string; fact: { id: string } }) => `${c.repo}\u0000${c.fact.id}`;

/**
 * What a correction of one link rests on (review of beta.24): on every line of the caller's, the
 * call facts of the link's method, and of those the ones of the link's path, normalised as the
 * join normalises it (or ending with it at a segment, a proxy's base path the join took off).
 * Round 4: a line with exactly one such call is clear, and that call is corrected (`calls`); a
 * line with none, or with several (two hosts, or another arrow's call of that path), is never
 * settled by a guess: its calls of the method are offered to the person to tick (`ask`), those of
 * the link's path ticked at first. A link a person declared (`declared`) has no call in code: the
 * declaration is withdrawn instead. A link with no line of a caller's (`routing`, a gateway
 * proxy's routing) has none of its own: its proxy's forwarding call is shared by every caller of
 * the route, so it is never corrected from here. `none`: the caller's lines hold no call fact
 * loaded.
 */
export type LinkBasis =
  | { kind: "calls"; calls: CallToCorrect[]; ask: CallToChoose[] }
  | { kind: "declared" }
  | { kind: "routing" }
  | { kind: "none" };

/** A call's path is the link's: the same, or one ending with it at a segment (a base path's). */
function ofLinkPath(c: FactCite, path: string): boolean {
  if (c.claim.path === undefined) return false;
  const q = normalizePath(c.claim.path);
  if (q === path) return true;
  if (path === "" || path === "/") return false;
  const tail = path.startsWith("/") ? path : `/${path}`;
  return q.length > tail.length && q.endsWith(tail);
}

export function linkBasis(j: Join, viewOf: (repo: string) => FactsView | undefined): LinkBasis {
  if (j.how === "declared") return { kind: "declared" };
  const lines = callerLines(j);
  if (!lines.length) return { kind: "routing" };
  const m = (x: string | undefined) => (x ?? "").toUpperCase();
  const path = j.path ? normalizePath(j.path) : undefined;
  const calls: CallToCorrect[] = [];
  const ask: CallToChoose[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const all = callFactsOn(line, viewOf(line.repo));
    const ofMethod = all.filter(
      (c) => !j.method || !c.claim.method || m(c.claim.method) === m(j.method),
    );
    const candidates = ofMethod.length ? ofMethod : all;
    const ofPath = path ? candidates.filter((c) => ofLinkPath(c, path)) : candidates;
    // Exactly one call of the link's path on the line: that one. Else the person says.
    const clear = ofPath.length === 1;
    for (const fact of clear ? ofPath : candidates) {
      const call = { repo: line.repo, at: line.at, fact };
      if (seen.has(callKey(call))) continue;
      seen.add(callKey(call));
      if (clear) calls.push(call);
      else ask.push({ ...call, ofPath: ofPath.includes(fact) });
    }
  }
  if (!calls.length && !ask.length) return { kind: "none" };
  return { kind: "calls", calls, ask };
}

/** The repos whose facts a link's correction reads: its caller's. */
export const callerRepos = (joins: readonly Join[]): string[] => [
  ...new Set(joins.flatMap((j) => (j.how === "declared" ? [] : callerLines(j).map((l) => l.repo)))),
];

/**
 * Every call on an arrow a correction is written for (`calls`), those the person is asked to
 * tick (`ask`, none of them in `calls`), and the links it leaves alone, by kind.
 */
export function arrowCalls(
  joins: readonly Join[],
  viewOf: (repo: string) => FactsView | undefined,
): {
  calls: CallToCorrect[];
  ask: CallToChoose[];
  missing: string[];
  declared: string[];
  routing: string[];
} {
  const calls = new Map<string, CallToCorrect>();
  const ask = new Map<string, CallToChoose>();
  const missing: string[] = [];
  const declared: string[] = [];
  const routing: string[] = [];
  for (const j of joins) {
    const b = linkBasis(j, viewOf);
    if (b.kind === "declared") declared.push(j.interface);
    else if (b.kind === "routing") routing.push(j.interface);
    else if (b.kind === "none") missing.push(j.interface);
    else {
      for (const c of b.calls) if (!calls.has(callKey(c))) calls.set(callKey(c), c);
      for (const c of b.ask) {
        const was = ask.get(callKey(c));
        ask.set(callKey(c), was ? { ...was, ofPath: was.ofPath || c.ofPath } : c);
      }
    }
  }
  for (const k of calls.keys()) ask.delete(k);
  return { calls: [...calls.values()], ask: [...ask.values()], missing, declared, routing };
}

/** The calls ticked of those asked about (by `callKey`); until the person ticks, those of the path. */
export const tickedOf = (ask: readonly CallToChoose[], ticked?: ReadonlySet<string>) =>
  ask.filter((c) => (ticked ? ticked.has(callKey(c)) : c.ofPath));

/**
 * This whole arrow is wrong (beta.24): the POST /api/links/corrections body that gives every call
 * on the arrow the same correction, each in its caller's repo, and the lines corrected (`lines`,
 * `repo:path:line`, to watch them move). Round 4: exactly the clear calls and those ticked of the
 * ones asked about (`ticked`; left out, those of the link's path). `missing`, `declared` and
 * `routing` name the links it leaves alone (see `linkBasis`); none to correct at all is an error
 * (`needPick` when calls are asked about and none is ticked), as is a fix missing its target or
 * why.
 */
export function arrowCorrections(
  joins: readonly Join[],
  viewOf: (repo: string) => FactsView | undefined,
  fix: LinkFix,
  ticked?: ReadonlySet<string>,
):
  | {
      body: Api.LinkCorrectionsRequestT;
      lines: string[];
      missing: string[];
      declared: string[];
      routing: string[];
    }
  | { error: "needTarget" | "sameTarget" | "needReason" | "noCalls" | "needPick" | "tooMany" } {
  const reason = fix.reason.trim();
  if (fix.kind === "not-a-call" && !reason) return { error: "needReason" };
  const target = fix.kind === "not-a-call" ? "" : fix.target.trim();
  if (fix.kind !== "not-a-call" && !target) return { error: "needTarget" };
  const { calls, ask, missing, declared, routing } = arrowCalls(joins, viewOf);
  const items: Api.LinkCorrectionsRequestT["items"] = [];
  const lines = new Set<string>();
  let already = 0;
  for (const c of [...calls, ...tickedOf(ask, ticked)]) {
    if (fix.kind !== "not-a-call" && (c.fact.claim.to ?? "").trim() === target) {
      already++;
      continue;
    }
    lines.add(`${c.repo}:${c.at}`);
    items.push(
      fix.kind === "not-a-call"
        ? { repo: c.repo, fact: c.fact.id, action: "wrong" }
        : { repo: c.repo, fact: c.fact.id, action: "edit", set: { to: target } },
    );
  }
  if (!items.length) return { error: already ? "sameTarget" : ask.length ? "needPick" : "noCalls" };
  // Review of beta.24, round 3: more than one request takes is said in words, never sent.
  if (items.length > ARROW_CALLS_MAX) return { error: "tooMany" };
  return {
    body: { items, ...(reason ? { reason } : {}) },
    lines: [...lines],
    missing,
    declared,
    routing,
  };
}

/** What a person says about a link: it goes elsewhere in the estate, outside it, or isn't a call. */
export type LinkFix =
  | { kind: "estate"; target: string; reason: string }
  | { kind: "outside"; target: string; reason: string }
  | { kind: "not-a-call"; reason: string };

/** The POST /api/facts/{repo}/corrections body for a fix, or what is missing (a key of the copy). */
export function linkCorrection(
  fact: FactCite,
  fix: LinkFix,
): { body: Record<string, unknown> } | { error: "needTarget" | "sameTarget" | "needReason" } {
  const reason = fix.reason.trim();
  if (fix.kind === "not-a-call") {
    if (!reason) return { error: "needReason" };
    return { body: { fact: fact.id, action: "wrong", reason } };
  }
  const target = fix.target.trim();
  if (!target) return { error: "needTarget" };
  if ((fact.claim.to ?? "").trim() === target) return { error: "sameTarget" };
  return {
    body: { fact: fact.id, action: "edit", set: { to: target }, ...(reason ? { reason } : {}) },
  };
}

/**
 * ADR 0192: the dependency facts on a `depends-on` join's first line (the depending build file's
 * dependency line): what "This link is wrong" corrects there.
 */
export function dependencyFactsOf(j: Join, v: FactsView | undefined): FactCite[] {
  const line = callerLine(j);
  const at = line ? splitAt(line.at) : undefined;
  if (!v || !at || !j.dependency) return [];
  const seen = new Map<string, FactCite>();
  for (const h of hitsAt(v, at.file, at.line))
    if (h.fact.kind === "dependency" && !h.step) seen.set(h.fact.id, h.fact);
  return [...seen.values()];
}

/**
 * ADR 0192: the POST /api/facts/{repo}/corrections body that says a dependency is wrong (with
 * why, which is required): verify then leaves the fact out, and its `depends-on` link goes.
 */
export function dependencyCorrection(
  fact: FactCite,
  reason: string,
): { body: Record<string, unknown> } | { error: "needReason" } {
  const why = reason.trim();
  if (!why) return { error: "needReason" };
  return { body: { fact: fact.id, action: "wrong", reason: why } };
}

/** One dependency fact a `depends-on` link rests on, as This link is wrong lists it. */
export interface LinkDependency {
  repo: string;
  id: string;
  /** Its cited line, `file:line`. */
  at: string;
  /** The fact as the repo's facts give it, when they are read and hold it. */
  fact?: FactCite;
  /**
   * Review of beta.25: the coordinates it names (`group:name`), from the join (C4 3.11.0): a link
   * holds every coordinate its component builds on of the library's.
   */
  coordinates?: string;
}

/**
 * Beta.25: every dependency fact a `depends-on` link rests on (its join's `dependency.facts`,
 * C4 3.11.0), each with its fact when the depending repo's facts are read; a join from before
 * lists the facts on its first line (`dependencyFactsOf`).
 */
export function linkDependenciesOf(j: Join, v: FactsView | undefined): LinkDependency[] {
  const listed = j.dependency?.facts;
  if (!listed?.length)
    return dependencyFactsOf(j, v).map((f) => ({
      repo: v!.repo,
      id: f.id,
      at: `${f.cite.file}:${f.cite.line}`,
      fact: f,
    }));
  return listed.map((d) => {
    const fact = v && v.repo === d.repo ? v.facts.find((f) => f.id === d.fact) : undefined;
    return {
      repo: d.repo,
      id: d.fact,
      at: d.at,
      ...(fact ? { fact } : {}),
      ...(d.group && d.name ? { coordinates: `${d.group}:${d.name}` } : {}),
    };
  });
}

/**
 * Beta.25: the POST /api/facts/{repo}/corrections bodies that say each chosen dependency is wrong
 * (with why, which is required), or what is missing (a key of the copy).
 */
export function dependencyCorrections(
  chosen: readonly { id: string }[],
  reason: string,
): { bodies: Record<string, unknown>[] } | { error: "needReason" | "needFact" } {
  if (!chosen.length) return { error: "needFact" };
  const why = reason.trim();
  if (!why) return { error: "needReason" };
  return { bodies: chosen.map((d) => ({ fact: d.id, action: "wrong", reason: why })) };
}

/**
 * Review of beta.25: the one POST /api/links/corrections that says every chosen dependency is
 * wrong (with why), all or none, or what is missing (a key of the copy).
 */
export function dependencyBatch(
  chosen: readonly { repo: string; id: string }[],
  reason: string,
): { body: Api.LinkCorrectionsRequestT } | { error: "needReason" | "needFact" } {
  const b = dependencyCorrections(chosen, reason);
  if ("error" in b) return b;
  return {
    body: {
      items: chosen.map((d) => ({ repo: d.repo, fact: d.id, action: "wrong" as const })),
      reason: reason.trim(),
    },
  };
}

/** A join's coordinates in words (`group:name`), or its method and path for a call. */
export const joinWhat = (j: Join): string =>
  j.dependency
    ? [
        ...new Set([
          `${j.dependency.group}:${j.dependency.name}`,
          // review of beta.25: every coordinate the link holds
          ...(j.dependency.facts ?? []).flatMap((f) =>
            f.group && f.name ? [`${f.group}:${f.name}`] : [],
          ),
        ]),
      ].join(", ")
    : [j.method, j.path].filter(Boolean).join(" ");

/** The ids a person can name as a call's target, from the views loaded: repos and components. */
export function knownTargets(views: Views, repos: readonly string[] = []): string[] {
  const out = new Set(repos);
  for (const v of views.values())
    for (const n of [v.node, ...v.children, ...v.outside])
      if (n.kind === "repo" || n.kind === "component") out.add(n.id.slice(n.id.indexOf(":") + 1));
  return [...out].sort();
}

/** What `atticus verify <repo> --write` will do with the fix, said by the copy (`will`). */
export type Prediction =
  | { kind: "moves"; from: string; was: string; to: string }
  | { kind: "outside"; from: string; was: string; to: string; unknown: boolean }
  | { kind: "dropped"; from: string; was: string };

export function predict(j: Join, fix: LinkFix, known: readonly string[]): Prediction {
  if (fix.kind === "not-a-call") return { kind: "dropped", from: j.from, was: j.to };
  const to = fix.target.trim();
  // A person's target that names nothing in the estate is outside it (ADR 0135, C2).
  if (fix.kind === "estate" && known.includes(to))
    return { kind: "moves", from: j.from, was: j.to, to };
  return { kind: "outside", from: j.from, was: j.to, to, unknown: fix.kind === "estate" };
}

/** The command that applies the correction and joins the estate again. */
export const reJoinCommand = (repo: string) => `atticus verify ${repo} --write`;

/** One call's place before and after the re-join: on a link (from → to), or on none. */
export interface Moved {
  /** The call's line: `repo:path:line`. */
  call: string;
  what: string;
  was: string;
  now?: string;
}

/** Each call of the loaded views by its line: the link it is on (`from → to`) and what it is. */
function callsIn(views: Views): Map<string, { link: string; what: string }> {
  const out = new Map<string, { link: string; what: string }>();
  for (const v of views.values())
    for (const e of v.edges)
      // Review of beta.24: by every line of the caller's, as a correction may rest on any.
      for (const j of e.joins ?? [])
        for (const line of callerLines(j))
          out.set(`${line.repo}:${line.at}`, {
            link: `${j.from} → ${j.to}`,
            what: joinWhat(j),
          });
  return out;
}

/**
 * What moved between two readings of the same views: each watched call (by its line) whose link
 * changed, or that is on none now. A call that didn't move is left out.
 */
export function whatMoved(before: Views, after: Views, watched: readonly string[]): Moved[] {
  const was = callsIn(before);
  const now = callsIn(after);
  const out: Moved[] = [];
  for (const call of watched) {
    const a = was.get(call);
    const b = now.get(call);
    if (!a || a.link === b?.link) continue;
    out.push({ call, what: a.what, was: a.link, ...(b ? { now: b.link } : {}) });
  }
  return out;
}
