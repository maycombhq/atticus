import {
  JOIN_GUESS_FLAGS,
  ownerOfQuestion,
  type JoinGuessFlag,
  type QuestionOwner,
  type Team,
} from "@maycombhq/core";
import { breakingChanges, endpointName, tableConsumers, type BreakingChange } from "./contracts.js";
import { endpointKey, systemOf, type Estate } from "./estate.js";
import type { FlowDelta } from "./schema.js";

/**
 * A change's impact, as designed (V1): from its target flows, one view of what it breaks across
 * the estate. For each entry or table a target flow breaks (`breakingChanges`, ADR 0124 addendum
 * B-arch, ADR 0125): who calls or uses it today, the fields that stop crossing, the gateway routes
 * its callers go through (each one to update), and the team that owns each repo (the manifest's
 * `owner`, named by roles.yaml's `teams`, ADR 0140). It is `atticus intake impact` (ADR 0130) for
 * our own changes: there a vendor's newer spec is the change, here the target flows are.
 *
 * A link the join guessed (an Interface `inferred` and flagged with one of core's
 * `JOIN_GUESS_FLAGS`: by path or a host's label, ADR 0124 addendum F2, ADR 0135; by a platform
 * setting or a setting's folder name, J0; despite an open conflict, J1) gives a false break as often as a real one:
 * its caller may break, and is never counted as one that surely does. The critic's rule
 * `constitution.change-links-known` (ADR 0140) asks the caller's owner to confirm it; this view
 * links to that rule rather than asking again.
 *
 * Pure and deterministic: the same deltas, catalog, specs and owners give the same impact.
 */

/** The critic's rule that asks about a guessed link (ADR 0140, P4). */
export const GUESSED_LINK_RULE = "constitution.change-links-known";

/** The join's guesses (core's `JOIN_GUESS_FLAGS`). */
const GUESSES: readonly JoinGuessFlag[] = JOIN_GUESS_FLAGS;
export type GuessedBy = JoinGuessFlag;

type Rec = Estate["records"][number] & Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();

export interface ImpactCaller {
  component: string;
  /** The caller's repo, from its Component record. */
  repo?: string;
  /** breaks: a link read from code, a person's answer or a spec flow; may-break: only guessed. */
  verdict: "breaks" | "may-break";
  /** How the join guessed it, when every link of this caller is a guess. */
  guessed?: GuessedBy;
  /** The Interface records of its calls to the entry. */
  interfaces: string[];
  /** The spec flows of the caller whose call-out or publish names the entry. */
  flows: string[];
  /** The gateway routes its calls go through. */
  routes: string[];
  /** The caller's cited lines, "repo path:line". */
  at: string[];
  owner: QuestionOwner;
}

/** A gateway route the change's callers go through: its config forwards to an entry that changes. */
export interface ImpactRoute {
  id: string;
  proxy?: string;
  basepath?: string;
  /** The repo its config is in (its first cited line's). */
  repo?: string;
  at: string[];
  callers: string[];
  owner: QuestionOwner;
}

export interface ImpactItem {
  kind: BreakingChange["kind"];
  flow: string;
  repo: string;
  id?: string;
  name: string;
  why: string[];
  /** The fields that stop crossing the entry, and the ones its callers must now send. */
  fields: { gone: string[]; required: string[] };
  /** The team of the repo whose entry or table it is. */
  owner: QuestionOwner;
  callers: ImpactCaller[];
  routes: ImpactRoute[];
}

export interface ChangeImpact {
  change: string;
  /** Callers that surely break, counted once per item. */
  breaks: number;
  /** Callers whose only link is guessed: they may break. */
  mayBreak: number;
  /** Gateway routes to update. */
  routes: number;
  rule: typeof GUESSED_LINK_RULE;
  items: ImpactItem[];
  /** Each team to involve and its repos; teams by id, then the repos nobody owns. */
  owners: { owner: QuestionOwner; repos: string[] }[];
}

export interface ImpactOwners {
  /** Each listed repo's owner team, from the repo manifests. */
  owners: ReadonlyMap<string, string>;
  /** roles.yaml's teams (version 2). */
  teams: readonly Team[];
}

const at = (e: { repo?: string; path?: string; line?: number }) =>
  e.repo && e.path ? `${e.repo} ${e.path}${e.line ? `:${e.line}` : ""}` : undefined;

/** A call's entry as the catalog keys it: "METHOD /path" folded, or a topic as written. */
const entryKey = (entry: string) =>
  /^\s*[A-Za-z]+\s+\S/.test(entry) ? endpointKey(entry) : entry.trim();

/** The impact of a change's target flows on the estate as the map knows it. */
export function changeImpact(
  change: string,
  deltas: FlowDelta[],
  e: Estate,
  o: ImpactOwners,
): ChangeImpact {
  const ownerOf = (repo: string | undefined, who: string): QuestionOwner =>
    repo
      ? ownerOfQuestion({ repo }, { owners: o.owners, teams: o.teams })
      : { none: `the catalog names no repo for ${who}, so no team owns it` };
  const repoOf = (component: string) => str(e.byId.get(component)?.repo);

  const items: ImpactItem[] = breakingChanges(deltas, e).map((c) => {
    const own = e.flowById.get(c.flow)?.flow.component;
    const callers = new Map<
      string,
      { ifaces: Rec[]; flows: Set<string>; routes: Set<string>; at: Set<string> }
    >();
    const callerOf = (id: string) => {
      const got = callers.get(id) ?? {
        ifaces: [],
        flows: new Set<string>(),
        routes: new Set<string>(),
        at: new Set<string>(),
      };
      callers.set(id, got);
      return got;
    };
    if (c.kind === "endpoint" && c.id) {
      const ep = e.byId.get(c.id);
      const component = str(ep?.component);
      const system = component ? systemOf(e, component) : undefined;
      const key = entryKey(endpointName(e, c.id));
      // The Interfaces of today's calls to it, as endpointConsumers finds them.
      for (const r of e.records as Rec[]) {
        if (r.kind !== "Interface" || typeof r.from !== "string") continue;
        if (r.from === component || r.from === own) continue;
        const same =
          r.endpoint === c.id ||
          (!r.endpoint &&
            r.to === component &&
            entryKey(`${str(r.method) ?? ""} ${str(r.normalizedPath) ?? ""}`.trim()) === key);
        if (!same) continue;
        const got = callerOf(r.from);
        got.ifaces.push(r);
        if (typeof r.route === "string") got.routes.add(r.route);
        for (const ev of r.evidence)
          if (ev.side === "caller" || (!ev.side && ev.repo === repoOf(r.from))) {
            const w = at(ev);
            if (w) got.at.add(w);
          }
      }
      // The spec flows that call it, and the caller its own trigger names.
      for (const f of e.flows) {
        const caller = f.flow.trigger.ref === c.id ? f.flow.trigger.caller?.ref : undefined;
        if (caller && caller !== component && caller !== own) callerOf(caller);
        if (f.flow.component === component || f.flow.component === own) continue;
        for (const s of f.flow.steps) {
          if (s.kind !== "call-out" && s.kind !== "publish") continue;
          const to = s.to;
          const hit =
            s.refs.includes(c.id) ||
            (!!to &&
              (to.entry === c.id ||
                ((to.component === component || (!!system && to.component === system)) &&
                  entryKey(to.entry) === key)));
          if (hit) callerOf(f.flow.component).flows.add(f.flow.id);
        }
      }
    } else if (c.kind === "table" && c.id) {
      for (const u of tableConsumers(e, c.id, own)) callerOf(u);
    }

    const list: ImpactCaller[] = [...callers.keys()].sort().map((id) => {
      const got = callers.get(id)!;
      const guesses = got.ifaces.map((r) =>
        r.confidence === "inferred" ? GUESSES.find((g) => (r.flags ?? []).includes(g)) : undefined,
      );
      // Guessed only when every link is a guess and no spec flow says it calls it.
      const guessed =
        got.ifaces.length > 0 && got.flows.size === 0 && guesses.every((g) => g !== undefined)
          ? guesses[0]
          : undefined;
      const repo = repoOf(id);
      return {
        component: id,
        ...(repo ? { repo } : {}),
        verdict: guessed ? ("may-break" as const) : ("breaks" as const),
        ...(guessed ? { guessed } : {}),
        interfaces: sorted(got.ifaces.map((r) => r.id)),
        flows: sorted(got.flows),
        routes: sorted(got.routes),
        at: sorted(got.at),
        owner: ownerOf(repo, id),
      };
    });

    const routes: ImpactRoute[] = sorted(list.flatMap((x) => x.routes)).map((id) => {
      const r = e.byId.get(id);
      const repo = r?.evidence[0]?.repo;
      return {
        id,
        ...(str(r?.proxy) ? { proxy: str(r?.proxy)! } : {}),
        ...(str(r?.basepath) ? { basepath: str(r?.basepath)! } : {}),
        ...(repo ? { repo } : {}),
        at: sorted((r?.evidence ?? []).flatMap((ev) => at(ev) ?? [])),
        callers: list.filter((x) => x.routes.includes(id)).map((x) => x.component),
        owner: ownerOf(repo, id),
      };
    });

    return {
      kind: c.kind,
      flow: c.flow,
      repo: c.repo,
      ...(c.id ? { id: c.id } : {}),
      name: c.name,
      why: c.why,
      fields: c.fields ?? { gone: [], required: [] },
      owner: ownerOf(c.repo, c.repo),
      callers: list,
      routes,
    };
  });

  // ---- the teams to involve
  const byOwner = new Map<string, { owner: QuestionOwner; repos: Set<string> }>();
  const add = (owner: QuestionOwner, repo: string | undefined) => {
    if (!repo) return;
    const k = "team" in owner ? `team\u0000${owner.team}` : `none\u0000${repo}`;
    const got = byOwner.get(k) ?? { owner, repos: new Set<string>() };
    got.repos.add(repo);
    byOwner.set(k, got);
  };
  for (const i of items) {
    add(i.owner, i.repo);
    for (const c of i.callers) add(c.owner, c.repo);
    for (const r of i.routes) add(r.owner, r.repo);
  }
  const owners = [...byOwner.entries()]
    .sort(([a], [b]) => {
      const [ka, ia] = a.split("\u0000") as [string, string];
      const [kb, ib] = b.split("\u0000") as [string, string];
      return ka !== kb ? (ka === "team" ? -1 : 1) : ia < ib ? -1 : ia > ib ? 1 : 0;
    })
    .map(([, v]) => ({ owner: v.owner, repos: sorted(v.repos) }));

  const callers = items.flatMap((i) => i.callers);
  return {
    change,
    breaks: callers.filter((c) => c.verdict === "breaks").length,
    mayBreak: callers.filter((c) => c.verdict === "may-break").length,
    routes: new Set(items.flatMap((i) => i.routes.map((r) => r.id))).size,
    rule: GUESSED_LINK_RULE,
    items,
    owners,
  };
}
