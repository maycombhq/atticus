import type { Api } from "@maycombhq/core";
import { hitsAt, splitAt, type FactCite, type FactsView } from "../../app/evidence-model.js";
import type { Views } from "./model.js";

/**
 * Why is this linked, and this link is wrong (ADR 0135, C1 and C2), apart from React: the call a
 * link's join rests on, the correction a person makes of it, what `atticus verify --write` will
 * change, and, once it has run, what moved. Pure functions of the graph views and a repo's facts.
 */

export type Join = Api.HierJoinT;

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
      for (const j of e.joins ?? []) {
        const line = callerLine(j);
        if (!line) continue;
        out.set(`${line.repo}:${line.at}`, {
          link: `${j.from} → ${j.to}`,
          what: [j.method, j.path].filter(Boolean).join(" "),
        });
      }
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
