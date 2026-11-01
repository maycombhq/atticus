import {
  helperOn,
  joinConventions,
  joinFacts,
  joinFlagsOf,
  type AuditItemT,
  type Fact,
  type FactEnd,
  type FactsJoinResult,
  type OrgPack,
} from "@maycombhq/core";
import { componentRenames, joinReposOf, outsideSystems } from "./facts-catalog.js";
import { isPrototypeRepo } from "./merge-input.js";

/**
 * The links a sample audit draws from (plan item P3, ADR 0148): the estate join of the repos'
 * verified facts, run as `verify --write` and `join measure` run it, and a repo's calls that it
 * tied to an entry, each with how it was joined (ADR 0135's flags) and every line it rests on.
 * Pure: it reads only what it is given.
 */

/** The estate join of these repos' facts, with the manifest's hosts and the targets people named. */
export function estateJoinOf(
  op: OrgPack,
  list: readonly { repo: string; facts: readonly Fact[] }[],
  targets?: Readonly<Record<string, Readonly<Record<string, string>>>>,
): FactsJoinResult {
  const repos = list.filter((x) => !isPrototypeRepo(op, x.repo));
  const renames = componentRenames(repos, op);
  return joinFacts({
    repos: joinReposOf(op, repos, renames),
    ...(targets ? { targets } : {}),
    outside: outsideSystems(op),
    // The org pack's facing words and gateway bundle folders (ADR 0147), as the catalog joins.
    ...joinConventions(op),
    walkGateways: helperOn("gateway-walk"),
  });
}

/** A repo's joined calls as audit items, in id order. */
export function auditLinkCandidates(
  join: FactsJoinResult,
  list: readonly { repo: string; facts: readonly Fact[] }[],
  repo: string,
): AuditItemT[] {
  const facts = new Map<string, Fact>();
  for (const r of list) for (const f of r.facts) facts.set(`${r.repo}\u0000${f.id}`, f);
  const mine = join.joins.filter((j) => j.call.repo === repo);
  const perCall = new Map<string, number>();
  for (const j of mine) perCall.set(j.call.fact, (perCall.get(j.call.fact) ?? 0) + 1);
  const at = (e: FactEnd) => `${e.repo} ${e.at}`;
  const out: AuditItemT[] = [];
  for (const j of mine) {
    const call = facts.get(`${j.call.repo}\u0000${j.call.fact}`) as
      (Fact & { method?: string; path?: string }) | undefined;
    const said = [call?.method?.toUpperCase(), call?.path].filter(Boolean).join(" ");
    const via = (j.gateway ?? []).map((h) => h.entry.repo);
    const flags = joinFlagsOf(j);
    const cites = [
      at(j.call),
      ...(j.tie ? [at(j.tie)] : []),
      ...(j.through ?? []).map(at),
      ...(j.exposedBy ?? []).map(at),
      ...(j.gateway ?? []).flatMap((h) => [
        at(h.entry),
        at(h.call),
        ...(h.tie ? [at(h.tie)] : []),
        ...(h.through ?? []).map(at),
        ...(h.exposedBy ?? []).map(at),
      ]),
      ...(j.entryThrough ?? []).map(at),
      at(j.entry),
    ];
    out.push({
      id: `link:${j.call.fact}${(perCall.get(j.call.fact) ?? 0) > 1 ? `~${j.entry.fact}` : ""}`,
      kind: "link",
      // A publish joined to its listener carries no flag: its topic says how (ADR 0135).
      of: flags[0] ?? (j.how === "topic" ? "topic" : `joined-by-${j.how}`),
      claim: `${repo} ${said || j.call.fact} -> ${j.entry.repo} ${[j.method, j.path].filter(Boolean).join(" ")}${via.length ? ` via ${via.join(", ")}` : ""}`,
      cites: [...new Set(cites)],
      fact: j.call.fact,
      to: j.entry.repo,
    });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
