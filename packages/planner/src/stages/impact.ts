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
 * setting or a setting's folder name, J0; despite an open conflict or by a Service's short name, J1) gives a false break as often as a real one:
 * its caller may break, and is never counted as one that surely does. The critic's rule
 * `constitution.change-links-known` (ADR 0140) asks the caller's owner to confirm it; this view
 * links to that rule rather than asking again.
 *
 * Up the chain (ADR 0156): from each affected caller, who calls its entries (the entries of its
 * spec flows that make the call, when it has some; else every entry it has), through catalog
 * Interfaces (and the gateway routes they go through), the spec flows that call them and the
 * callers their triggers name, hop by hop until no new caller or `MAX_CHAIN_DEPTH`. A component
 * already on the chain (the entry's own, a direct caller, an earlier hop) is not walked again, so
 * a cycle stops. A hop whose own links are all guessed, or that calls only components that may
 * break, may break too and is never counted as a break.
 *
 * Pure and deterministic: the same deltas, catalog, specs and owners give the same impact.
 */

/** How far up the chain the impact walks: a direct caller is 1. */
export const MAX_CHAIN_DEPTH = 5;

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

/** A caller further up the chain (ADR 0156): it calls a direct caller, or another hop. */
export interface ImpactHop {
  component: string;
  repo?: string;
  /** 2 for a caller of a direct caller, and so on up to MAX_CHAIN_DEPTH. */
  depth: number;
  /** The callers (one depth down) whose entries it calls. */
  via: string[];
  /** Those entries: Endpoint ids, or "METHOD /path" where the link names no Endpoint. */
  entries: string[];
  /** breaks: a sure link to a caller that breaks; may-break: its links are guessed, or rest on one. */
  verdict: "breaks" | "may-break";
  /** The guess it rests on: its own link's, or the one under `restsOn`. */
  guessed?: GuessedBy;
  /** The component down the chain whose guessed link this hop rests on. */
  restsOn?: string;
  interfaces: string[];
  flows: string[];
  routes: string[];
  at: string[];
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
  /** Who calls the callers, up the chain (ADR 0156), by depth then component. */
  chain: ImpactHop[];
  /** The walk stopped at MAX_CHAIN_DEPTH with callers still above it. */
  capped?: true;
}

export interface ChangeImpact {
  change: string;
  /** Callers that surely break, counted once per item. */
  breaks: number;
  /** Callers whose only link is guessed: they may break. */
  mayBreak: number;
  /** Gateway routes to update. */
  routes: number;
  /** Up the chain (ADR 0156): hops that surely break and those that rest on a guess. */
  upstream: { breaks: number; mayBreak: number };
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

/** The guess flag of an Interface the join guessed, else undefined. */
const guessOf = (r: Rec): GuessedBy | undefined =>
  r.confidence === "inferred" ? GUESSES.find((g) => (r.flags ?? []).includes(g)) : undefined;

interface Links {
  ifaces: Rec[];
  flows: Set<string>;
  routes: Set<string>;
  at: Set<string>;
  entries: Set<string>;
  /** Spec flows' callers (trigger or step): a sure link. */
  named: boolean;
}
const links = (): Links => ({
  ifaces: [],
  flows: new Set(),
  routes: new Set(),
  at: new Set(),
  entries: new Set(),
  named: false,
});
/** A guess when every link is a guessed Interface and nothing else names the call. */
const guessedLinks = (l: Links): GuessedBy | undefined => {
  if (!l.ifaces.length || l.flows.size || l.named) return undefined;
  const g = l.ifaces.map(guessOf);
  return g.every((x) => x !== undefined) ? g[0] : undefined;
};

/**
 * Who calls a component's entries (ADR 0156): the Interfaces to them (to the component, or to one
 * of its Endpoints), the spec flows whose call-out or publish names one, and the callers its own
 * flows' triggers name. `entries` narrows them to those Endpoints; undefined takes every entry.
 */
function callersOfComponent(
  e: Estate,
  x: string,
  entries: ReadonlySet<string> | undefined,
): Map<string, Links> {
  const out = new Map<string, Links>();
  const got = (id: string) => {
    const l = out.get(id) ?? links();
    out.set(id, l);
    return l;
  };
  const repoOf = (c: string) => str(e.byId.get(c)?.repo);
  const componentOfEndpoint = (id: string) => str(e.byId.get(id)?.component);
  for (const r of e.records as Rec[]) {
    if (r.kind !== "Interface" || typeof r.from !== "string" || r.from === x) continue;
    const ep = str(r.endpoint);
    const hit = ep
      ? componentOfEndpoint(ep) === x && (!entries || entries.has(ep))
      : r.to === x && !entries;
    if (!hit) continue;
    const l = got(r.from);
    l.ifaces.push(r);
    l.entries.add(ep ?? `${str(r.method) ?? ""} ${str(r.normalizedPath) ?? ""}`.trim());
    if (typeof r.route === "string") l.routes.add(r.route);
    for (const ev of r.evidence)
      if (ev.side === "caller" || (!ev.side && ev.repo === repoOf(r.from))) {
        const w = at(ev);
        if (w) l.at.add(w);
      }
  }
  for (const f of e.flows) {
    const t = f.flow.trigger;
    if (f.flow.component === x && t.ref && (!entries || entries.has(t.ref))) {
      const caller = t.caller?.ref;
      if (caller && caller !== x) {
        const l = got(caller);
        l.named = true;
        l.entries.add(t.ref);
      }
    }
    if (f.flow.component === x) continue;
    for (const s of f.flow.steps) {
      if (s.kind !== "call-out" && s.kind !== "publish") continue;
      const named = [...s.refs, ...(s.to?.entry ? [s.to.entry] : [])].filter(
        (id) => componentOfEndpoint(id) === x && (!entries || entries.has(id)),
      );
      const hit = named.length > 0 || (!entries && s.to?.component === x);
      if (!hit) continue;
      const l = got(f.flow.component);
      l.flows.add(f.flow.id);
      for (const n of named) l.entries.add(n);
      if (!named.length && s.to?.entry) l.entries.add(s.to.entry);
    }
  }
  return out;
}

/**
 * The entries of a component that lead to a call: the triggers of the spec flows that make it,
 * when it has some; else undefined (every entry it has: the map doesn't say which leads there).
 */
function entriesLeadingTo(e: Estate, flows: Iterable<string>): Set<string> | undefined {
  const refs = [...flows].flatMap((id) => {
    const t = e.flowById.get(id)?.flow.trigger;
    return t?.ref && e.byId.get(t.ref)?.kind === "Endpoint" ? [t.ref] : [];
  });
  return refs.length ? new Set(refs) : undefined;
}

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

    // ---- up the chain (ADR 0156)
    const seen = new Set<string>([...list.map((x) => x.component)]);
    if (own) seen.add(own);
    const entryComponent = c.id ? str(e.byId.get(c.id)?.component) : undefined;
    if (entryComponent) seen.add(entryComponent);
    interface Down {
      component: string;
      verdict: "breaks" | "may-break";
      guessed?: GuessedBy;
      restsOn?: string;
      entries: Set<string> | undefined;
    }
    let frontier: Down[] = list.map((x) => ({
      component: x.component,
      verdict: x.verdict,
      ...(x.guessed ? { guessed: x.guessed } : {}),
      ...(x.verdict === "may-break" ? { restsOn: x.component } : {}),
      entries: entriesLeadingTo(e, x.flows),
    }));
    const chain: ImpactHop[] = [];
    let capped = false;
    for (let depth = 2; frontier.length; depth++) {
      // Each new caller of this depth, with its links to each component one depth down.
      const found = new Map<string, { down: Down; l: Links }[]>();
      for (const d of frontier)
        for (const [id, l] of callersOfComponent(e, d.component, d.entries)) {
          if (seen.has(id)) continue;
          const xs = found.get(id) ?? [];
          xs.push({ down: d, l });
          found.set(id, xs);
        }
      if (!found.size) break;
      if (depth > MAX_CHAIN_DEPTH) {
        capped = true;
        break;
      }
      const next: Down[] = [];
      for (const id of [...found.keys()].sort()) {
        seen.add(id);
        const xs = found.get(id)!;
        // Sure when one link of its own is sure and the caller it reaches surely breaks.
        const sure = xs.find((x) => x.down.verdict === "breaks" && !guessedLinks(x.l));
        const first = xs[0]!;
        const ownGuess = guessedLinks(first.l);
        const guessed = sure ? undefined : (ownGuess ?? first.down.guessed);
        const restsOn = sure || ownGuess ? undefined : first.down.restsOn;
        const repo = repoOf(id);
        const flows = sorted(xs.flatMap((x) => [...x.l.flows]));
        const hop: ImpactHop = {
          component: id,
          ...(repo ? { repo } : {}),
          depth,
          via: sorted(xs.map((x) => x.down.component)),
          entries: sorted(xs.flatMap((x) => [...x.l.entries])),
          verdict: sure ? "breaks" : "may-break",
          ...(guessed ? { guessed } : {}),
          ...(restsOn ? { restsOn } : {}),
          interfaces: sorted(xs.flatMap((x) => x.l.ifaces.map((r) => r.id))),
          flows,
          routes: sorted(xs.flatMap((x) => [...x.l.routes])),
          at: sorted(xs.flatMap((x) => [...x.l.at])),
          owner: ownerOf(repo, id),
        };
        chain.push(hop);
        next.push({
          component: id,
          verdict: hop.verdict,
          ...(guessed ? { guessed } : {}),
          ...(hop.verdict === "may-break" ? { restsOn: restsOn ?? id } : {}),
          entries: entriesLeadingTo(e, flows),
        });
      }
      frontier = next;
    }

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
      chain,
      ...(capped ? { capped: true as const } : {}),
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
    for (const h of i.chain) add(h.owner, h.repo);
  }
  const owners = [...byOwner.entries()]
    .sort(([a], [b]) => {
      const [ka, ia] = a.split("\u0000") as [string, string];
      const [kb, ib] = b.split("\u0000") as [string, string];
      return ka !== kb ? (ka === "team" ? -1 : 1) : ia < ib ? -1 : ia > ib ? 1 : 0;
    })
    .map(([, v]) => ({ owner: v.owner, repos: sorted(v.repos) }));

  const callers = items.flatMap((i) => i.callers);
  const hops = items.flatMap((i) => i.chain);
  return {
    change,
    breaks: callers.filter((c) => c.verdict === "breaks").length,
    mayBreak: callers.filter((c) => c.verdict === "may-break").length,
    routes: new Set(items.flatMap((i) => i.routes.map((r) => r.id))).size,
    upstream: {
      breaks: hops.filter((h) => h.verdict === "breaks").length,
      mayBreak: hops.filter((h) => h.verdict === "may-break").length,
    },
    rule: GUESSED_LINK_RULE,
    items,
    owners,
  };
}
