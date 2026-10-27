import {
  entryEndpointId,
  factIdPart,
  fieldNameKey,
  joinFacts,
  joinVendorOperations,
  type FactEnd,
  type FactJoin,
  type FactOf,
  type FacingWords,
  type JoinRepo,
  type JoinVendor,
  type VendorCallAsk,
  type VendorCallGap,
} from "@maycombhq/core";
import { diffVendorSpecs, type VendorChange } from "./vendor-diff.js";
import type { VendorSpec } from "./vendor-ops.js";

/**
 * What a newer version of a vendor's spec does to the estate (ADR 0130). For each change the
 * diff finds: the external gateway's forwarding calls that reach the operation (matched to the
 * older version's operations, which is what they call today; to the newer one's for an operation
 * it adds), the service calls that go through each forwarding route, and further back the entries
 * those calls are made under and whatever calls them, up the chain. Every step is a fact, cited.
 * From the footprint (repos, systems, flows, Interfaces, the vendor's Endpoints) a change starts.
 *
 * Pure and deterministic: the same specs, facts, answers and flows give the same impact. No model
 * call: the diff is fixed rules and the walk is the facts join's.
 */

/** A flow of today, with what starts it and the Endpoints its steps name (specs/<repo>/). */
export interface ImpactFlow {
  id: string;
  repo: string;
  /** The Endpoint id of its trigger. */
  trigger?: string;
  /** Endpoint ids its steps name. */
  refs?: string[];
}

export interface VendorImpactInput {
  /** The vendor: its org-pack system id, its name and aliases, and any host the org pack gives it. */
  vendor: { system: string; names: string[]; hosts?: string[] };
  older: { id: string; spec: VendorSpec };
  newer: { id: string; spec: VendorSpec };
  /** The estate's facts, as the join reads them (with the manifest's hosts and gateway types). */
  repos: readonly JoinRepo[];
  /** People's answers naming where a call goes: repo → call fact id → name. */
  targets?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  facing?: FacingWords;
  flows?: readonly ImpactFlow[];
  /** Each repo's system, from the manifest. */
  systemOfRepo?: Readonly<Record<string, string>>;
}

/** How a service call uses the changed field, when its facts list the fields it sends or reads. */
export interface FieldUse {
  uses: "sends" | "does-not-send" | "reads" | "does-not-read";
  /** path:line of the field fact, when it uses it. */
  at?: string;
}

/** A call further up the chain: it reaches `reaches`, and is made under `under`. */
export interface UpstreamCall {
  call: FactEnd;
  interface: string;
  /** The gateway routes it passes through, in order, when it goes through any. */
  via?: string[];
  reaches: FactEnd;
  under?: FactEnd;
}

/** A service call that goes through a forwarding route. */
export interface ServiceCaller {
  call: FactEnd;
  interface: string;
  via?: string[];
  field?: FieldUse;
  /** The entry the call is made under (its `from`). */
  under?: FactEnd;
  /** Who calls that entry, and on up, breadth first. */
  upstream: UpstreamCall[];
}

/** An external gateway's forwarding call that reaches the changed operation. */
export interface ForwardHit {
  call: FactEnd;
  route?: FactEnd;
  tie?: FactEnd;
  /** The vendor operation's Endpoint id. */
  operation: string;
  callers: ServiceCaller[];
}

export interface ImpactedChange {
  id: string;
  severity: VendorChange["severity"];
  says: string;
  forwards: ForwardHit[];
}

export interface SpecVersion {
  id: string;
  path: string;
  version?: string;
}

export interface VendorImpact {
  vendor: string;
  older: SpecVersion;
  newer: SpecVersion;
  changes: ImpactedChange[];
  /** The repos something affected lives in. */
  repos: string[];
  /** Their systems and the vendor's. */
  systems: string[];
  /** Today's flows that start at, or name, an affected entry. */
  flows: { id: string; repo: string }[];
  /** The Interfaces of the affected calls. */
  interfaces: string[];
  /** The vendor's Endpoints the estate reaches that change. */
  endpoints: string[];
  /** Forwarding calls to operations the older version doesn't publish. */
  gaps: VendorCallGap[];
  /** Forwarding calls two operations answer equally well. */
  asks: VendorCallAsk[];
}

/** The most entries walked up from a service call: past that, the chain is said as far as it got. */
export const MAX_UPSTREAM = 4;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();

const joinVendorOf = (input: VendorImpactInput, spec: VendorSpec): JoinVendor => ({
  system: input.vendor.system,
  names: input.vendor.names,
  hosts: [...new Set([...spec.hosts, ...(input.vendor.hosts ?? [])])],
  operations: spec.operations.map((o) => ({
    id: o.id,
    method: o.method,
    path: o.path,
    fullPath: o.fullPath,
    cite: o.cite,
  })),
});

const versionOf = (v: { id: string; spec: VendorSpec }): SpecVersion => ({
  id: v.id,
  path: v.spec.path,
  ...(v.spec.version ? { version: v.spec.version } : {}),
});

/** The diff of two versions, with what each change reaches in the estate. */
export function vendorImpact(input: VendorImpactInput): {
  diff: VendorChange[];
  impact: VendorImpact;
} {
  const diff = diffVendorSpecs(input.older.spec, input.newer.spec);
  const join = joinFacts({
    repos: input.repos,
    ...(input.targets ? { targets: input.targets } : {}),
    ...(input.facing ? { facing: input.facing } : {}),
  });
  const today = joinVendorOperations({
    repos: input.repos,
    vendors: [joinVendorOf(input, input.older.spec)],
    ...(input.targets ? { targets: input.targets } : {}),
  });
  const next = joinVendorOperations({
    repos: input.repos,
    vendors: [joinVendorOf(input, input.newer.spec)],
    ...(input.targets ? { targets: input.targets } : {}),
  });

  const k = (e: { repo: string; fact: string }) => `${e.repo}\u0000${e.fact}`;
  const facts = new Map<
    string,
    { repo: JoinRepo; fact: FactOf<"call"> | FactOf<"entry"> | FactOf<"field"> }
  >();
  for (const r of input.repos)
    for (const f of r.facts)
      if (f.kind === "call" || f.kind === "entry" || f.kind === "field")
        facts.set(k({ repo: r.repo, fact: f.id }), { repo: r, fact: f });
  const componentOf = (r: JoinRepo, f: { component?: string }) =>
    factIdPart(f.component ?? r.component ?? r.repo);
  const endOf = (repo: string, id: string): FactEnd | undefined => {
    const got = facts.get(k({ repo, fact: id }));
    if (!got) return undefined;
    return {
      repo,
      fact: id,
      component: componentOf(got.repo, got.fact),
      at: `${got.fact.cite.file}:${got.fact.cite.line}`,
    };
  };
  const under = (call: FactEnd): FactEnd | undefined => {
    const f = facts.get(k(call))?.fact;
    return f?.kind === "call" && f.from ? endOf(call.repo, f.from) : undefined;
  };
  // A gateway's own forwarding call is a hop of the joins through it, which name its route; it
  // isn't a caller of its own.
  const hops = new Set(join.joins.flatMap((j) => (j.gateway ?? []).map((h) => k(h.call))));
  const joins = join.joins.filter((j) => j.how !== "topic" && !hops.has(k(j.call)));
  const via = (j: FactJoin) => (j.gateway?.length ? { via: j.gateway.map((h) => h.route) } : {});

  /** Who calls an entry, and on up, breadth first, each entry once. */
  const upstreamOf = (start: FactEnd | undefined): UpstreamCall[] => {
    const out: UpstreamCall[] = [];
    if (!start) return out;
    const seen = new Set([k(start)]);
    let level = [start];
    for (let depth = 0; depth < MAX_UPSTREAM && level.length; depth++) {
      const nextLevel: FactEnd[] = [];
      for (const e of level)
        for (const j of joins.filter((x) => k(x.entry) === k(e))) {
          const u = under(j.call);
          out.push({
            call: j.call,
            interface: j.interface,
            ...via(j),
            reaches: j.entry,
            ...(u ? { under: u } : {}),
          });
          if (u && !seen.has(k(u))) {
            seen.add(k(u));
            nextLevel.push(u);
          }
        }
      level = nextLevel;
    }
    return out;
  };

  const fieldUse = (call: FactEnd, change: VendorChange): FieldUse | undefined => {
    if (!change.side || !change.field) return undefined;
    const side = change.side;
    const mine = (input.repos.find((r) => r.repo === call.repo)?.facts ?? [])
      .filter(
        (f): f is FactOf<"field"> =>
          f.kind === "field" && f.owner === call.fact && (f.side ?? "request") === side,
      )
      .sort((a, b) => cmp(a.id, b.id));
    if (!mine.length) return undefined;
    const want = fieldNameKey(change.field);
    const hit = mine.find((f) => fieldNameKey(f.name) === want);
    const req = side === "request";
    return hit
      ? { uses: req ? "sends" : "reads", at: `${hit.cite.file}:${hit.cite.line}` }
      : { uses: req ? "does-not-send" : "does-not-read" };
  };

  const changes: ImpactedChange[] = diff.map((c) => {
    const older = c.endpoints.older;
    const matches = older
      ? today.matches.filter((m) => m.operation === older)
      : next.matches.filter((m) => m.operation === c.endpoints.newer);
    const forwards: ForwardHit[] = matches.map((m) => {
      const callers = m.route
        ? joins
            .filter(
              (j) =>
                k(j.entry) === k(m.route!) ||
                (j.gateway ?? []).some((h) => k(h.entry) === k(m.route!)),
            )
            .map((j): ServiceCaller => {
              const u = under(j.call);
              const field = fieldUse(j.call, c);
              return {
                call: j.call,
                interface: j.interface,
                ...via(j),
                ...(field ? { field } : {}),
                ...(u ? { under: u } : {}),
                upstream: upstreamOf(u),
              };
            })
        : [];
      return {
        call: m.call,
        ...(m.route ? { route: m.route } : {}),
        ...(m.tie ? { tie: m.tie } : {}),
        operation: m.operation,
        callers,
      };
    });
    return { id: c.id, severity: c.severity, says: c.says, forwards };
  });

  // ---- the footprint
  const repos = new Set<string>();
  const interfaces = new Set<string>();
  const endpoints = new Set<string>();
  const entries = new Set<string>();
  for (const c of changes)
    for (const f of c.forwards) {
      repos.add(f.call.repo);
      endpoints.add(f.operation);
      for (const s of f.callers) {
        repos.add(s.call.repo);
        interfaces.add(s.interface);
        if (s.under) entries.add(k(s.under));
        for (const u of s.upstream) {
          repos.add(u.call.repo);
          interfaces.add(u.interface);
          entries.add(k(u.reaches));
          if (u.under) entries.add(k(u.under));
        }
      }
    }
  const endpointIds = new Set<string>();
  for (const e of entries) {
    const got = facts.get(e);
    if (got?.fact.kind === "entry")
      endpointIds.add(entryEndpointId(got.fact, componentOf(got.repo, got.fact)));
  }
  const flows = (input.flows ?? [])
    .filter(
      (f) =>
        (f.trigger && endpointIds.has(f.trigger)) || (f.refs ?? []).some((r) => endpointIds.has(r)),
    )
    .map((f) => ({ id: f.id, repo: f.repo }))
    .sort((a, b) => cmp(a.id, b.id));
  for (const f of flows) repos.add(f.repo);
  const systems = new Set([input.vendor.system]);
  for (const r of repos) {
    const s = input.systemOfRepo?.[r];
    if (s) systems.add(s);
  }

  return {
    diff,
    impact: {
      vendor: input.vendor.system,
      older: versionOf(input.older),
      newer: versionOf(input.newer),
      changes,
      repos: sorted(repos),
      systems: sorted(systems),
      flows,
      interfaces: sorted(interfaces),
      endpoints: sorted(endpoints),
      gaps: today.gaps,
      asks: today.asks,
    },
  };
}
