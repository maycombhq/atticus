import { entryEndpointId, factIdPart } from "./facts.js";
import {
  fieldNameKey,
  joinFacts,
  routeScore,
  type FactEnd,
  type JoinHow,
  type JoinRepo,
} from "./facts-join.js";
import {
  joinVendorOperations,
  type JoinVendor,
  type JoinVendorOperation,
} from "./facts-join-vendor.js";
import type { Fact, FactOf } from "./schema/facts.js";

/**
 * A prototype compared with the estate (ADR 0133). A team's working prototype (a UI, its BFF
 * behind SSO, and the backend mocked) states exactly what a change must deliver: its screens'
 * calls to its BFF, and its BFF's calls to the mocks. This places each of those calls in one of
 * four groups, citing the prototype's line and, where there is one, the estate's or the vendor's:
 *
 * - **exists**: the estate serves it as the prototype needs (through the gateway chain, where the
 *   estate join follows one);
 * - **changes**: the estate serves the operation, but a field the prototype sends or reads is
 *   missing or differs (type, required-ness), or the prototype's sign-on asks for a scope the
 *   estate doesn't demand, or a different auth;
 * - **new**: nothing in the estate serves it and no vendor publishes it;
 * - **vendor**: only a vendor's published operation provides it, so it needs a route through the
 *   external gateway (the repos that forward to that vendor already are named).
 *
 * Nothing new matches a call: the estate side is the estate join (`joinFacts`, ADR 0124 C-join,
 * with its fallback by method and path and its walk through gateways), and the vendor side is
 * ADR 0130's `joinVendorOperations`. Inside the prototype, a call is paired with the entry it
 * lands on by `routeScore`, the join's own path rule. A prototype's facts are never projected
 * into the catalog; they are read here, and only here.
 *
 * Pure and deterministic: the same facts and vendors give the same comparison, in any order.
 */

/** A repo type that marks a prototype (`prototype`, `prototype-<anything>`), from the manifest. */
export const PROTOTYPE_TYPE = /^prototype(-|$)/;

/** Whether a manifest repo type is a prototype's. */
export const isPrototypeType = (type: string | undefined): boolean =>
  !!type && PROTOTYPE_TYPE.test(type);

/**
 * The mock tools whose declarations mark a module as the mocked backend (a framework fact naming
 * one, with the module as its component): MSW, WireMock, json-server, MockServer, Prism, Mirage.
 */
export const MOCK_FRAMEWORKS =
  /^(@mswjs\/.*|msw|wiremock.*|json-server|mockserver.*|@stoplight\/prism.*|prism.*|miragejs|mirage)$/i;

/**
 * A mock's file, by its path: a mocks or stubs folder, a WireMock mapping, a json-server
 * `db.json` or `routes.json`, a Postman collection.
 */
export const MOCK_FILE =
  /(^|\/)(mocks?|__mocks__|stubs?|mock-server|mockserver|wiremock|msw)\/|(^|\/)mappings\/[^/]+\.json$|(^|\/)(db|routes)\.json$|\.postman_collection\.json$/i;

/** A part of an entry's citation that says the entry runs only as a mock: `@Profile("mock")`. */
const MOCK_PART = /^(mock|mocks|stub|stubs)$/i;

type Entry = FactOf<"entry">;
type Call = FactOf<"call">;
type Field = FactOf<"field">;

/**
 * Whether an entry is one of the prototype's mocks: its file is a mock's, its module declares a
 * mock tool (a framework fact with that component), or its citation's other lines hold a mock
 * profile (`@Profile("mock")`).
 */
export function isMockEntry(e: Entry, facts: readonly Fact[]): boolean {
  if (MOCK_FILE.test(e.cite.file)) return true;
  if ((e.cite.with ?? []).some((w) => MOCK_PART.test(w.value))) return true;
  if (!e.component) return false;
  return facts.some(
    (f) => f.kind === "framework" && f.component === e.component && MOCK_FRAMEWORKS.test(f.name),
  );
}

export const PROTOTYPE_GROUPS = ["exists", "changes", "new", "vendor"] as const;
export type PrototypeGroup = (typeof PROTOTYPE_GROUPS)[number];

/** `ui-bff`: a screen's call to the prototype's BFF; `bff-mock`: the BFF's call to a mock. */
export type PrototypeLeg = "ui-bff" | "bff-mock";

/** A field of a vendor operation, as intake reads it from the spec. */
export interface PrototypeVendorField {
  side: "request" | "response";
  name: string;
  type?: string;
  required?: boolean;
  /** spec path:line of the property. */
  at?: string;
}

export interface PrototypeVendorOperation extends JoinVendorOperation {
  auth?: string;
  scopes?: readonly string[];
  fields?: readonly PrototypeVendorField[];
}

/** A vendor with its published operations and their fields (ADR 0130's reading of its spec). */
export interface PrototypeVendor extends JoinVendor {
  operations: readonly PrototypeVendorOperation[];
}

export type PrototypeDifferenceKind =
  "field-missing" | "field-type" | "field-required" | "scope-missing" | "auth";

/** One way the estate (or the vendor) serves an operation other than as the prototype needs. */
export interface PrototypeDifference {
  kind: PrototypeDifferenceKind;
  side?: "request" | "response";
  field?: string;
  scope?: string;
  /** What the prototype says, and the line it says it on. */
  prototype: { value: string; at: string };
  /** What the estate says, when it says something. */
  estate?: { value: string; at: string };
  message: string;
}

/** One call of the prototype, placed. */
export interface PrototypeCall {
  /** `<leg>.<method>-<path>`, stable. */
  id: string;
  leg: PrototypeLeg;
  group: PrototypeGroup;
  method?: string;
  path: string;
  /** The prototype's call. */
  call: FactEnd;
  /** The prototype's entry it lands on: the BFF's route, or the mock. */
  lands: FactEnd;
  /** The auth and scopes the prototype's sign-on gives the route (a BFF route only). */
  auth?: string;
  scopes?: string[];
  /** What in the estate serves it (exists, changes). */
  estate?: {
    entry: FactEnd;
    /** The Endpoint the estate's entry projects to. */
    endpoint: string;
    how: JoinHow;
    /** The gateway routes the estate join went through to reach the entry, in order. */
    gateway?: string[];
    auth?: string;
    scopes?: string[];
  };
  /** The vendor operation that alone provides it (vendor). */
  vendor?: {
    system: string;
    name: string;
    operation: string;
    method: string;
    path: string;
    at?: string;
    /** The estate's repos that forward to this vendor already: where the new route goes. */
    through: string[];
  };
  /** Two or more estate entries serve it equally well: a person says which. */
  candidates?: FactEnd[];
  differences: PrototypeDifference[];
  sentence: string;
}

export interface PrototypeComparison {
  prototype: string;
  counts: Record<PrototypeGroup, number>;
  calls: PrototypeCall[];
  /** The estate repos the change modifies: those serving a call that changes, and the proxies a vendor call needs. */
  repos: string[];
  /** The estate repos that serve calls as they are. */
  uses: string[];
  /** The estate Endpoints that change. */
  endpoints: string[];
  /** The vendor operations the prototype needs routed. */
  vendorOperations: string[];
  vendors: string[];
  /** Calls that land on nothing in the prototype (a sign-on server's keys, say): not compared. */
  left: { call: FactEnd; why: string }[];
}

export interface ComparePrototypeInput {
  /** The prototype's verified facts. */
  prototype: JoinRepo;
  /** The estate's repos as the join reads them; no prototype among them. */
  estate: readonly JoinRepo[];
  /** The vendors whose specs are in inputs/. */
  vendors?: readonly PrototypeVendor[];
  /** The org pack's outside systems (vendors' ids and names), as the estate join takes them. */
  outside?: readonly string[];
}

/** The words of the comparison, in one place: the CLI, the attached document and the app say these. */
export const PROTOTYPE_WORDS = {
  leg: { "ui-bff": "on its BFF", "bff-mock": "on its mock" } as Record<PrototypeLeg, string>,
  exists: (what: string, who: string, repo: string, served: string, at: string) =>
    `${what}, which ${who}: ${repo} serves it as the prototype needs (${served}, ${at}).`,
  changes: (what: string, who: string, repo: string, served: string, at: string, n: number) =>
    `${what}, which ${who}: ${repo} serves it (${served}, ${at}), but not as the prototype needs: ${n} difference${n === 1 ? "" : "s"}.`,
  ambiguous: (what: string, who: string, n: number) =>
    `${what}, which ${who}: ${n} entries of the estate serve it equally well; say which, and compare again.`,
  new: (what: string, who: string) =>
    `${what}, which ${who}: nothing in the estate serves it, and no vendor publishes it.`,
  vendor: (what: string, who: string, name: string, op: string, at: string, through: string[]) =>
    `${what}, which ${who}: only ${name} provides it (${op}${at ? `, ${at}` : ""}); ${
      through.length
        ? `it needs a route through ${through.join(" or ")}, which forward${through.length === 1 ? "s" : ""} to ${name} already.`
        : `nothing in the estate forwards to ${name} yet, so it needs an external gateway route.`
    }`,
  fieldMissing: (side: string, name: string, at: string, repo: string) =>
    `the ${side} field ${name} (${at}) isn't in ${repo}'s ${side}`,
  fieldType: (
    side: string,
    name: string,
    mine: string,
    at: string,
    repo: string,
    theirs: string,
    raw: string,
    theirAt: string,
  ) =>
    `the ${side} field ${name} is ${article(mine)} in the prototype (${at}) and ${article(theirs)} in ${repo} (${raw === theirs ? "" : `${raw}, `}${theirAt})`,
  fieldRequired: (
    side: string,
    name: string,
    mine: boolean,
    at: string,
    repo: string,
    theirAt: string,
  ) =>
    `the ${side} field ${name} is ${mine ? "required" : "optional"} in the prototype (${at}) and ${mine ? "optional" : "required"} in ${repo} (${theirAt})`,
  scopeMissing: (scope: string, at: string, repo: string, theirs: string[]) =>
    `the prototype's sign-on asks for the scope ${scope} (${at}), which ${repo} doesn't demand${theirs.length ? ` (it demands ${theirs.join(", ")})` : ""}`,
  auth: (mine: string, at: string, repo: string, theirs: string, theirAt: string) =>
    `the prototype's sign-on gives the route ${mine} auth (${at}); ${repo} uses ${theirs} (${theirAt})`,
  left: (what: string, who: string) =>
    `${what}, which ${who} calls, reaches nothing in the prototype: it is neither the prototype's BFF nor one of its mocks, so it isn't compared.`,
};

const article = (w: string) => `${/^[aeiou]/i.test(w) ? "an" : "a"} ${w}`;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();
const at = (f: Fact) => `${f.cite.file}:${f.cite.line}`;
const sameMethod = (a: string | undefined, b: string | undefined) => {
  const x = a?.toUpperCase();
  const y = b?.toUpperCase();
  return !x || !y || x === "ANY" || y === "ANY" || x === y;
};

/** The family a declared type belongs to, compared across languages; undefined when unsure. */
function typeFamily(t: string | undefined): string | undefined {
  const x = (t ?? "").trim().toLowerCase();
  if (!x) return undefined;
  if (/\[\]$|^(array|list|set|collection|seq|vec)\b|^(list|set|array)</.test(x)) return "array";
  if (/^(string|str|text|char|character|uuid|guid|date|datetime|instant|localdate)$/.test(x))
    return "string";
  if (
    /^(number|int|integer|long|short|byte|float|double|decimal|bigdecimal|biginteger|numeric|int32|int64|u?int\d*)$/.test(
      x,
    )
  )
    return "number";
  if (/^(bool|boolean)$/.test(x)) return "boolean";
  return undefined;
}

interface SideField {
  side: "request" | "response";
  name: string;
  type?: string;
  required?: boolean;
  at: string;
}

const fieldsOf = (facts: readonly Fact[], owner: string): SideField[] =>
  facts
    .filter(
      (f): f is Field =>
        f.kind === "field" && f.owner === owner && (f.side === "request" || f.side === "response"),
    )
    .map((f) => ({
      side: f.side as "request" | "response",
      name: f.name,
      ...(f.type ? { type: f.type } : {}),
      ...(f.required !== undefined ? { required: f.required } : {}),
      at: at(f),
    }))
    .sort((a, b) => cmp(a.side, b.side) || cmp(a.name, b.name) || cmp(a.at, b.at));

/** The fields the prototype needs and those the estate (or vendor) has: what differs. */
function fieldDifferences(
  mine: readonly SideField[],
  theirs: readonly SideField[],
  repo: string,
): PrototypeDifference[] {
  const out: PrototypeDifference[] = [];
  for (const side of ["request", "response"] as const) {
    const have = theirs.filter((f) => f.side === side);
    // A side the estate's facts say nothing about is unknown, not missing (ADR 0125's rule).
    if (!have.length) continue;
    const byKey = new Map(have.map((f) => [fieldNameKey(f.name), f] as const));
    const seen = new Set<string>();
    for (const f of mine.filter((x) => x.side === side)) {
      const k = fieldNameKey(f.name);
      if (seen.has(k)) continue;
      seen.add(k);
      const t = byKey.get(k);
      if (!t) {
        out.push({
          kind: "field-missing",
          side,
          field: f.name,
          prototype: { value: f.name, at: f.at },
          message: PROTOTYPE_WORDS.fieldMissing(side, f.name, f.at, repo),
        });
        continue;
      }
      const a = typeFamily(f.type);
      const b = typeFamily(t.type);
      if (a && b && a !== b)
        out.push({
          kind: "field-type",
          side,
          field: f.name,
          prototype: { value: f.type!, at: f.at },
          estate: { value: t.type!, at: t.at },
          message: PROTOTYPE_WORDS.fieldType(side, f.name, a, f.at, repo, b, t.type!, t.at),
        });
      if (f.required !== undefined && t.required !== undefined && f.required !== t.required)
        out.push({
          kind: "field-required",
          side,
          field: f.name,
          prototype: { value: String(f.required), at: f.at },
          estate: { value: String(t.required), at: t.at },
          message: PROTOTYPE_WORDS.fieldRequired(side, f.name, f.required, f.at, repo, t.at),
        });
    }
  }
  return out;
}

/** Compare a prototype's calls with what the estate and the vendors serve. */
export function comparePrototype(input: ComparePrototypeInput): PrototypeComparison {
  const proto = input.prototype;
  const pfacts = [...proto.facts].sort((a, b) => cmp(a.id, b.id));
  const componentOf = (f: Fact) => factIdPart(f.component ?? proto.component ?? proto.repo);
  const end = (f: Fact): FactEnd => ({
    repo: proto.repo,
    fact: f.id,
    component: componentOf(f),
    at: at(f),
  });
  const entries = pfacts.filter((f): f is Entry => f.kind === "entry" && f.entryType === "rest");
  const mock = new Set(entries.filter((e) => isMockEntry(e, pfacts)).map((e) => e.id));

  // ---- inside the prototype: which entry each call lands on (the join's path rule)
  interface Subject {
    call: Call;
    lands: Entry;
    leg: PrototypeLeg;
  }
  const subjects: Subject[] = [];
  const left: PrototypeComparison["left"] = [];
  for (const f of pfacts) {
    if (f.kind !== "call" || f.callType !== "rest") continue;
    const scored = entries
      .filter((e) => e.id !== f.from && sameMethod(f.method, e.method))
      .map((e) => ({ e, score: routeScore(f.path, e.path) }))
      .filter((s) => s.score >= 400);
    const best = Math.max(0, ...scored.map((s) => s.score));
    const hits = scored.filter((s) => s.score === best).map((s) => s.e);
    const what = [f.method?.toUpperCase(), f.path].filter(Boolean).join(" ");
    if (hits.length !== 1) {
      left.push({ call: end(f), why: PROTOTYPE_WORDS.left(what, componentOf(f)) });
      continue;
    }
    const e = hits[0]!;
    subjects.push({ call: f, lands: e, leg: mock.has(e.id) ? "bff-mock" : "ui-bff" });
  }

  // ---- the estate join: each call as a relative call with no target, from a repo of its own
  const probeRepo = `prototype.${proto.repo}`;
  const probeComponent = factIdPart(probeRepo);
  const probeId = (i: number) => `probe.${i}`;
  const probe: JoinRepo = {
    repo: probeRepo,
    component: probeComponent,
    facts: subjects.map((s, i): Fact => {
      const { host: _h, base: _b, to: _t, from: _f, ...rest } = s.call;
      return { ...rest, id: probeId(i), repo: probeRepo, component: probeComponent };
    }),
  };
  const estate = [...input.estate].sort((a, b) => cmp(a.repo, b.repo));
  const join = joinFacts({
    repos: [...estate, probe],
    ...(input.outside ? { outside: input.outside } : {}),
  });
  const joinOf = new Map(
    join.joins.filter((j) => j.call.repo === probeRepo).map((j) => [j.call.fact, j] as const),
  );
  const askOf = new Map(
    join.asks.filter((a) => a.call.repo === probeRepo).map((a) => [a.call.fact, a] as const),
  );
  const factOf = new Map<string, Fact>();
  for (const r of estate) for (const f of r.facts) factOf.set(`${r.repo}\u0000${f.id}`, f);

  // ---- the vendors: each call as a forwarding call of a route, named to each vendor in turn
  const vendors = [...(input.vendors ?? [])].sort((a, b) => cmp(a.system, b.system));
  const vprobe: Fact[] = [];
  subjects.forEach((s, i) => {
    vprobe.push({
      kind: "entry",
      id: `route.${i}`,
      repo: probeRepo,
      commit: s.call.commit,
      entryType: "rest",
      ...(s.call.method ? { method: s.call.method } : {}),
      path: s.call.path,
      cite: s.call.cite,
      verified: s.call.verified,
      by: s.call.by,
      conf: s.call.conf,
    });
    for (const v of vendors)
      vprobe.push({
        kind: "call",
        id: `forward.${i}.${factIdPart(v.system)}`,
        repo: probeRepo,
        commit: s.call.commit,
        callType: "rest",
        ...(s.call.method ? { method: s.call.method } : {}),
        path: s.call.path,
        to: v.system,
        from: `route.${i}`,
        cite: s.call.cite,
        verified: s.call.verified,
        by: s.call.by,
        conf: s.call.conf,
      });
  });
  const vjoin = joinVendorOperations({
    repos: [{ repo: probeRepo, component: probeComponent, facts: vprobe, gateway: true }],
    vendors,
  });
  const vendorHits = new Map<string, typeof vjoin.matches>();
  for (const m of vjoin.matches) {
    const i = m.route?.fact.replace(/^route\./, "") ?? "";
    vendorHits.set(i, [...(vendorHits.get(i) ?? []), m]);
  }
  // The estate's own forwarding calls to each vendor: where a new route for it goes.
  const forwards = joinVendorOperations({ repos: estate, vendors });
  const throughOf = (system: string) =>
    sorted(forwards.matches.filter((m) => m.vendor === system).map((m) => m.call.repo));

  // ---- each call, placed
  const calls: PrototypeCall[] = subjects.map((s, i): PrototypeCall => {
    const c = s.call;
    const method = c.method?.toUpperCase();
    const what = [method, c.path].filter(Boolean).join(" ");
    const who = `${componentOf(c)} calls ${PROTOTYPE_WORDS.leg[s.leg]}`;
    const scopes = (s.lands.scopes ?? []).map((x) => x.value);
    const base = {
      id: `${s.leg}.${factIdPart(what)}`,
      leg: s.leg,
      ...(method ? { method } : {}),
      path: c.path,
      call: end(c),
      lands: end(s.lands),
      ...(s.lands.auth && s.lands.authCite ? { auth: s.lands.auth } : {}),
      ...(scopes.length ? { scopes } : {}),
    };
    const mine = [
      ...fieldsOf(pfacts, s.lands.id),
      // A call's own fields stand in for a side the entry it lands on doesn't state.
      ...fieldsOf(pfacts, c.id).filter(
        (f) => !fieldsOf(pfacts, s.lands.id).some((g) => g.side === f.side),
      ),
    ];
    const j = joinOf.get(probeId(i));
    if (j) {
      const e = factOf.get(`${j.entry.repo}\u0000${j.entry.fact}`) as Entry;
      const repo = j.entry.repo;
      const theirScopes = sorted([...(j.scopes ?? []), ...(e.scopes ?? []).map((x) => x.value)]);
      const repoFacts = estate.find((r) => r.repo === repo)?.facts ?? [];
      const differences = fieldDifferences(mine, fieldsOf(repoFacts, e.id), repo);
      // Scopes and auth are compared only where the estate states them: an unknown isn't a miss.
      if (theirScopes.length)
        for (const sc of s.lands.scopes ?? []) {
          if (theirScopes.includes(sc.value)) continue;
          const first = (e.scopes ?? [])[0];
          differences.push({
            kind: "scope-missing",
            scope: sc.value,
            prototype: { value: sc.value, at: `${sc.file}:${sc.line}` },
            ...(first ? { estate: { value: first.value, at: `${first.file}:${first.line}` } } : {}),
            message: PROTOTYPE_WORDS.scopeMissing(
              sc.value,
              `${sc.file}:${sc.line}`,
              repo,
              theirScopes,
            ),
          });
        }
      if (s.lands.auth && s.lands.authCite && e.auth && e.authCite && s.lands.auth !== e.auth)
        differences.push({
          kind: "auth",
          prototype: {
            value: s.lands.auth,
            at: `${s.lands.authCite.file}:${s.lands.authCite.line}`,
          },
          estate: { value: e.auth, at: `${e.authCite.file}:${e.authCite.line}` },
          message: PROTOTYPE_WORDS.auth(
            s.lands.auth,
            `${s.lands.authCite.file}:${s.lands.authCite.line}`,
            repo,
            e.auth,
            `${e.authCite.file}:${e.authCite.line}`,
          ),
        });
      const served = [e.method?.toUpperCase(), e.path].filter(Boolean).join(" ");
      const group: PrototypeGroup = differences.length ? "changes" : "exists";
      return {
        ...base,
        group,
        estate: {
          entry: j.entry,
          endpoint: entryEndpointId(e, j.entry.component),
          how: j.how,
          ...(j.gateway?.length ? { gateway: j.gateway.map((h) => h.route) } : {}),
          ...(e.auth && e.authCite ? { auth: e.auth } : {}),
          ...(theirScopes.length ? { scopes: theirScopes } : {}),
        },
        differences,
        sentence:
          group === "exists"
            ? PROTOTYPE_WORDS.exists(what, who, repo, served, j.entry.at)
            : PROTOTYPE_WORDS.changes(what, who, repo, served, j.entry.at, differences.length),
      };
    }
    const ask = askOf.get(probeId(i));
    if (ask && ask.candidates.length) {
      return {
        ...base,
        group: "exists",
        candidates: ask.candidates,
        differences: [],
        sentence: PROTOTYPE_WORDS.ambiguous(what, who, ask.candidates.length),
      };
    }
    const hits = vendorHits.get(String(i)) ?? [];
    if (hits.length === 1) {
      const m = hits[0]!;
      const v = vendors.find((x) => x.system === m.vendor)!;
      const op = v.operations.find((o) => o.id === m.operation)!;
      const name = v.names[0] ?? v.system;
      const through = throughOf(v.system);
      const opWhat = `${op.method.toUpperCase()} ${op.path}`;
      const differences = fieldDifferences(
        mine,
        (op.fields ?? []).map((f) => ({ ...f, at: f.at ?? op.cite ?? "" })),
        name,
      );
      return {
        ...base,
        group: "vendor",
        vendor: {
          system: v.system,
          name,
          operation: op.id,
          method: op.method.toUpperCase(),
          path: op.path,
          ...(op.cite ? { at: op.cite } : {}),
          through,
        },
        differences,
        sentence: PROTOTYPE_WORDS.vendor(what, who, name, opWhat, op.cite ?? "", through),
      };
    }
    return { ...base, group: "new", differences: [], sentence: PROTOTYPE_WORDS.new(what, who) };
  });

  const legOrder = (l: PrototypeLeg) => (l === "ui-bff" ? 0 : 1);
  calls.sort(
    (a, b) =>
      legOrder(a.leg) - legOrder(b.leg) ||
      cmp(a.path, b.path) ||
      cmp(a.method ?? "", b.method ?? "") ||
      cmp(a.call.fact, b.call.fact),
  );
  const counts = Object.fromEntries(
    PROTOTYPE_GROUPS.map((g) => [g, calls.filter((c) => c.group === g).length]),
  ) as Record<PrototypeGroup, number>;
  const changing = calls.filter((c) => c.group === "changes");
  const vendorCalls = calls.filter((c) => c.group === "vendor");
  const repos = sorted([
    ...changing.map((c) => c.estate!.entry.repo),
    ...vendorCalls.flatMap((c) => c.vendor!.through),
  ]);
  return {
    prototype: proto.repo,
    counts,
    calls,
    repos,
    uses: sorted(
      calls
        .filter((c) => c.group === "exists" && c.estate)
        .map((c) => c.estate!.entry.repo)
        .filter((r) => !repos.includes(r)),
    ),
    endpoints: sorted(changing.map((c) => c.estate!.endpoint)),
    vendorOperations: sorted(vendorCalls.map((c) => c.vendor!.operation)),
    vendors: sorted(vendorCalls.map((c) => c.vendor!.system)),
    left: left.sort((a, b) => cmp(a.call.fact, b.call.fact)),
  };
}
