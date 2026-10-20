import { createHash } from "node:crypto";
import { parseRecord, type CatalogRecord, type RecordIssue } from "./catalog.js";
import { interfaceId, normalizePath } from "./identity.js";
import { COMPONENT_TYPES } from "./schema/kinds.js";

/**
 * Merge and identity: turns the records every repo's scan produced into one catalog.
 *
 * - Records with the same identity merge (evidence is unioned, the best value wins).
 * - REST endpoints are keyed by component, method and normalised path and get a canonical id.
 * - Loose ends (Unresolved records, ADR 0016) are resolved: HTTP calls into Interfaces
 *   (through the gateway when a route's base path matches), publishes and subscribes into
 *   event Interfaces, database access into Tables' readers and writers; GraphQL, gRPC and
 *   webhook loose ends (ADR 0040) into Interfaces to the matching typed endpoints.
 * - A direct synchronous call between two components with a `mesh` Setting goes via mesh.
 * - Interfaces are verified only when both ends are seen; otherwise inferred.
 * - Whatever can't be resolved stays as an Unresolved record with its owner.
 *
 * Deterministic: the same input gives the same catalog, sorted by kind and id. See ADR 0017.
 */

export interface MergeRepo {
  id: string;
  component?: string;
  system?: string;
  type: string;
  /** Hosts the repo's component (or, for a gateway repo, the gateway) answers on (ADR 0053). */
  hosts?: string[];
}

export interface MergeSystem {
  id: string;
  name: string;
  boundary: "product" | "internal" | "vendor";
  owner?: string;
  aliases: string[];
}

/** What merge needs from an integration pattern (C6) to infer it on a hop. */
export interface MergePattern {
  code: string;
  status: string;
  detection: { via: string[]; sync?: string; targetBoundary?: string; sameSystem?: boolean };
}

export interface MergeInput {
  records: CatalogRecord[];
  repos: MergeRepo[];
  systems: MergeSystem[];
  patterns?: MergePattern[];
  /** Where the systems came from, for their evidence (e.g. "org-pack/profiles/forge/profile.yaml"). */
  profilePath?: string;
  /**
   * Route a call to an undeclared host through the gateway route its path starts with, as before
   * ADR 0053. Only for callers without the repos manifest (drift on a fetched copy of the
   * catalog), where no host is declared; a full scan never sets it.
   */
  gatewayByBasepath?: boolean;
}

export interface MergeResult {
  records: CatalogRecord[];
  /** Records merge produced that failed C1 (a bug if ever non-empty). */
  invalid: { record: unknown; issues: RecordIssue[] }[];
  stats: { interfaces: number; verified: number; unresolved: number };
  /** Things worth knowing that aren't wrong, e.g. hosts that look like a gateway nobody declared. */
  notes: string[];
}

type Rec = Record<string, unknown> & {
  kind: string;
  id: string;
  evidence: Evidence[];
  confidence: string;
};
type Evidence = Record<string, unknown> & {
  source: string;
  path?: string;
  line?: number;
  side?: string;
  repo?: string;
};

const short = (s: string, n = 6) => createHash("sha256").update(s).digest("hex").slice(0, n);
const evKey = (e: Evidence) =>
  `${e.repo ?? ""}|${e.path ?? ""}|${e.line ?? ""}|${e.side ?? ""}|${e.source}`;

function unionEvidence(...lists: Evidence[][]): Evidence[] {
  const seen = new Map<string, Evidence>();
  for (const l of lists) for (const e of l) if (!seen.has(evKey(e))) seen.set(evKey(e), e);
  return [...seen.values()];
}

const RANK: Record<string, number> = { verified: 3, asserted: 2, inferred: 1 };
const DOCUMENTED_TYPES = new Set<string>(COMPONENT_TYPES);

/**
 * Endpoint types keyed by their id rather than by path or topic (ADR 0040): two services can
 * both serve `Query.product` or a `/ws` path, so these never merge across components.
 */
const BY_ID_ENDPOINTS = new Set([
  "graphql",
  "grpc",
  "websocket",
  "sse",
  "webhook",
  "function",
  "transaction",
]);

/** Merge two records of the same identity: union evidence, keep the stronger confidence, fill gaps. */
function combine(a: Rec, b: Rec): Rec {
  const out: Rec = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (k === "evidence" || k === "confidence") continue;
    const cur = out[k];
    if (cur === undefined || cur === "unknown" || (Array.isArray(cur) && cur.length === 0))
      out[k] = v;
    else if (Array.isArray(cur) && Array.isArray(v) && v.every((x) => typeof x === "string"))
      out[k] = [...new Set([...(cur as string[]), ...(v as string[])])].sort();
    // A documented component type (ADR 0040) says more than a repo type from the manifest.
    else if (
      a.kind === "Component" &&
      k === "type" &&
      !DOCUMENTED_TYPES.has(String(cur)) &&
      DOCUMENTED_TYPES.has(String(v))
    )
      out[k] = v;
  }
  // Code is the source of truth: a record seen as current wins over a planned one of the same identity.
  if (a.status !== b.status && (a.status === "current" || b.status === "current"))
    out.status = "current";
  out.evidence = unionEvidence(a.evidence, b.evidence);
  out.confidence =
    (RANK[b.confidence] ?? 0) > (RANK[a.confidence] ?? 0) ? b.confidence : a.confidence;
  return out;
}

/** "transfers" → "transfer", "policies" → "policy"; good enough for endpoint names. */
function singular(word: string): string {
  if (/ies$/.test(word) && word.length > 4) return word.slice(0, -3) + "y";
  if (/(ses|xes|zes|ches|shes)$/.test(word)) return word.slice(0, -2);
  if (/s$/.test(word) && !/ss$/.test(word) && word.length > 3) return word.slice(0, -1);
  return word;
}

/** Canonical REST endpoint id: <component>.<method>-<last fixed path segment, singular>. */
export function endpointId(
  component: string,
  method: string | undefined,
  normalizedPath: string,
): string {
  const segs = normalizedPath.split("/").filter((s) => s && s !== "{}" && !/^v\d+$/i.test(s));
  const last = segs.at(-1) ?? "root";
  const name =
    singular(
      last
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, ""),
    ) || "root";
  return `${component}.${(method ?? "any").toLowerCase()}-${name}`;
}

function splitUrl(url: string): { host?: string; path: string } {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)([^?#]*)/i.exec(url);
  if (m) return { host: m[1]!.toLowerCase().split(":")[0]!, path: m[2] || "/" };
  return { path: url.split(/[?#]/)[0] ?? "" };
}

export function mergeCatalog(input: MergeInput): MergeResult {
  const byKey = new Map<string, Rec>();
  const put = (key: string, r: Rec) =>
    byKey.set(key, byKey.has(key) ? combine(byKey.get(key)!, r) : r);
  const loose: Rec[] = [];
  const dialectInterfaces: Rec[] = [];

  // ---- 0. a store name claimed by two owning components (e.g. the <system>-db fallback for two
  //         services of one system) is two stores: each becomes <owner>-db, with its tables,
  //         columns, keys and migrations renamed to match.
  const owners = new Map<string, Set<string>>();
  for (const r of input.records as unknown as Rec[])
    if (r.kind === "DataStore" && typeof r.ownerComponent === "string")
      owners.set(r.id, (owners.get(r.id) ?? new Set()).add(r.ownerComponent));
  const renames = new Map<string, Map<string, string>>(); // repo → old store → new store
  for (const r of input.records as unknown as Rec[]) {
    if (r.kind !== "DataStore" || (owners.get(r.id)?.size ?? 0) < 2) continue;
    const repo = String(r.evidence[0]?.repo ?? "");
    renames.set(
      repo,
      (renames.get(repo) ?? new Map<string, string>()).set(r.id, `${String(r.ownerComponent)}-db`),
    );
  }
  const renameStore = (r: Rec): Rec => {
    const m = renames.get(String(r.evidence[0]?.repo ?? ""));
    if (!m) return r;
    const fix = (v: unknown) => {
      if (typeof v !== "string") return v;
      for (const [from, to] of m)
        if (v === from || v.startsWith(`${from}.`)) return to + v.slice(from.length);
      return v;
    };
    const out: Rec = { ...r };
    if (["DataStore", "Table", "Column", "IndexConstraint", "Migration"].includes(r.kind))
      out.id = fix(r.id) as string;
    for (const f of ["dataStore", "table"]) if (f in out) out[f] = fix(out[f]);
    if (out.references && typeof out.references === "object")
      out.references = { ...(out.references as Rec), table: fix((out.references as Rec).table) };
    return out;
  };

  // ---- 1. collect: endpoints keyed by identity, loose ends aside, everything else by kind/id
  for (const raw0 of input.records as unknown as Rec[]) {
    const raw = renameStore(raw0);
    const r = { ...raw, evidence: raw.evidence.map((e) => ({ ...e })) } as Rec;
    if (r.kind === "Unresolved") loose.push(r);
    else if (r.kind === "Interface") dialectInterfaces.push(r);
    else if (r.kind === "Endpoint" && r.endpointType === "rest") {
      const norm = normalizePath(String(r.normalizedPath ?? r.pathOrTopic));
      put(`Endpoint|${r.component}|${String(r.method ?? "").toUpperCase()}|${norm}`, {
        ...r,
        normalizedPath: norm,
      });
    } else if (r.kind === "Endpoint" && BY_ID_ENDPOINTS.has(String(r.endpointType)))
      put(`Typed|${r.id}`, r);
    else if (r.kind === "Endpoint") put(`Topic|${r.pathOrTopic}`, r);
    else put(`${r.kind}|${r.id}`, r);
  }

  // ---- 2. canonical endpoint ids (collisions get a short path hash)
  const endpoints = [...byKey.entries()].filter(([k]) => k.startsWith("Endpoint|"));
  const proposed = new Map<string, string[]>();
  for (const [k, e] of endpoints) {
    const id = endpointId(
      String(e.component),
      e.method as string | undefined,
      String(e.normalizedPath),
    );
    proposed.set(id, [...(proposed.get(id) ?? []), k]);
  }
  for (const [id, keys] of proposed) {
    for (const k of keys) {
      const e = byKey.get(k)!;
      e.id = keys.length === 1 ? id : `${id}-${short(String(e.normalizedPath))}`;
    }
  }
  const restEndpoints = endpoints.map(([, e]) => e);
  // Indexes, so each loose end is matched in constant time (a scan per loose end made merge
  // quadratic: 800 components took about a minute). Same order as the list, so same results.
  const endpointsAt = new Map<string, Rec[]>(); // component + path
  const endpointsOnPath = new Map<string, Rec[]>(); // path
  for (const e of restEndpoints) {
    const at = `${String(e.component)}\u0000${String(e.normalizedPath)}`;
    endpointsAt.set(at, [...(endpointsAt.get(at) ?? []), e]);
    const on = String(e.normalizedPath);
    endpointsOnPath.set(on, [...(endpointsOnPath.get(on) ?? []), e]);
  }

  // ---- 3. components, systems and lookups
  const components = new Map<string, Rec>();
  for (const [k, r] of byKey) if (k.startsWith("Component|")) components.set(r.id, r);
  const systemsById = new Map(input.systems.map((s) => [s.id, s]));
  const systemsLongestFirst = [...systemsById.keys()].sort((a, b) => b.length - a.length);
  const systemByPrefix = new Map<string, string | undefined>();
  const systemOf = (componentId: string): string | undefined => {
    const c = components.get(componentId);
    if (c?.system) return String(c.system);
    if (!systemByPrefix.has(componentId))
      systemByPrefix.set(
        componentId,
        systemsLongestFirst.find((s) => componentId === s || componentId.startsWith(`${s}-`)),
      );
    return systemByPrefix.get(componentId);
  };
  const componentsOfSystem = (sys: string) =>
    [...components.values()].filter((c) => c.system === sys).map((c) => c.id);

  /** Find the component a host name or name refers to; create an inferred one when a system claims it. */
  const resolveComponent = (name: string, ev: Evidence): string | undefined => {
    if (components.has(name)) return name;
    if (systemsById.has(name)) {
      const inSys = componentsOfSystem(name);
      if (inSys.length === 1) return inSys[0];
      if (inSys.length === 0) return name; // a system without code, e.g. a vendor: the system is the endpoint
    }
    for (const s of input.systems) {
      if (s.aliases.some((a) => a.toLowerCase() === name)) {
        const inSys = componentsOfSystem(s.id);
        if (inSys.length === 1) return inSys[0];
      }
    }
    const sys = systemOf(name);
    if (sys) {
      const c: Rec = {
        schemaVersion: 1,
        kind: "Component",
        id: name,
        status: "current",
        confidence: "inferred",
        system: sys,
        type: "service",
        evidence: [ev],
      };
      components.set(name, c);
      put(`Component|${name}`, c);
      return name;
    }
    return undefined;
  };

  const routes = [...byKey.values()].filter((r) => r.kind === "GatewayRoute");
  // An endpoint of another method is a different endpoint: never matched (it once made a GET
  // call "verified" against a POST endpoint).
  const findEndpoint = (component: string, method: string | undefined, norm: string) =>
    (endpointsAt.get(`${component}\u0000${norm}`) ?? []).find(
      (e) => !method || method === "ANY" || e.method === method,
    );

  // Hosts the manifest declares (ADR 0053). A repo with gateway routes is a gateway: its hosts
  // are the gateway's, and only calls to them go through it.
  const routeRepos = new Set(
    routes.flatMap((r) => r.evidence.map((e) => String(e.repo ?? ""))).filter(Boolean),
  );
  const declaredHosts = input.repos.flatMap((r) =>
    (r.hosts ?? []).map((h) => ({
      re: hostPattern(h),
      repo: r,
      gateway: routeRepos.has(r.id) || r.type === "gateway",
    })),
  );
  const declaredFor = (host: string) => declaredHosts.find((d) => d.re.test(host));
  /** Components that list their hosts are reached through them only, not by a host's first label. */
  const hostedComponents = new Set(
    input.repos.filter((r) => (r.hosts ?? []).length > 0).map((r) => r.component ?? r.id),
  );
  const undeclaredGatewayHosts = new Set<string>();

  /** Callee-side evidence of an endpoint: code on the serving side, else its definition re-labelled. */
  const calleeEvidence = (e: Rec | undefined): Evidence[] => {
    if (!e) return [];
    const code = e.evidence.filter((x) => x.side === "callee");
    return code.length > 0
      ? code
      : e.evidence.filter((x) => x.side === "definition").map((x) => ({ ...x, side: "callee" }));
  };

  // Vendor systems by name: a host label that is a vendor's id, name or alias written without
  // spaces or dashes (api.tidewater.example → Tidewater; api.lanternmail.example → Lantern
  // Mail). Only vendor systems, and only when one matches.
  const compact = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
  const vendorNames = new Map<string, Set<string>>();
  for (const sys of input.systems.filter((x) => x.boundary === "vendor"))
    for (const n of [sys.id, sys.name, ...sys.aliases]) {
      const k = compact(n);
      if (k.length >= 3) vendorNames.set(k, (vendorNames.get(k) ?? new Set()).add(sys.id));
    }
  const vendorFor = (host: string): string | undefined => {
    const hits = new Set<string>();
    for (const label of host.split(".").slice(0, -1))
      for (const id of vendorNames.get(compact(label)) ?? []) hits.add(id);
    return hits.size === 1 ? [...hits][0] : undefined;
  };

  const interfaces = new Map<string, Rec>();
  const addInterface = (r: Rec) =>
    interfaces.set(r.id, interfaces.has(r.id) ? combine(interfaces.get(r.id)!, r) : r);
  const unresolved: Rec[] = [];

  // ---- 4. HTTP calls
  for (const l of loose.filter((x) => x.unresolvedKind === "http-call")) {
    const raw = String(l.raw);
    const sp = raw.indexOf(" ");
    const method = raw.slice(0, sp).toUpperCase();
    const url = raw.slice(sp + 1);
    const owner = String(l.owner ?? "");
    const caller = l.evidence;
    const { host, path } = splitUrl(url);
    if (url.includes("${")) {
      unresolved.push(l);
      continue;
    }
    let to: string | undefined;
    let via = "direct";
    let route: Rec | undefined;
    let calleePath = path;

    const declared = host ? declaredFor(host) : undefined;
    const hostComponent = host ? host.split(".")[0]! : undefined;
    const hostKnown = hostComponent
      ? components.has(hostComponent) || systemsById.has(hostComponent)
      : false;
    const onBasepath = (r: Rec) =>
      path === r.basepath || path.startsWith(`${String(r.basepath).replace(/\/$/, "")}/`);
    const longest = (rs: Rec[]) =>
      rs.sort((a, b) => String(b.basepath).length - String(a.basepath).length)[0];
    // Only a declared gateway host routes through a gateway, and only to its own routes.
    const gw = declared?.gateway
      ? longest(
          routes.filter(
            (r) => onBasepath(r) && r.evidence.some((e) => e.repo === declared.repo.id),
          ),
        )
      : input.gatewayByBasepath && host && !declared && !hostKnown
        ? longest(routes.filter(onBasepath))
        : undefined;
    const byFirstLabel = hostKnown && !hostedComponents.has(hostComponent!);
    if (
      !input.gatewayByBasepath &&
      host &&
      !declared &&
      !byFirstLabel &&
      longest(routes.filter(onBasepath))
    )
      undeclaredGatewayHosts.add(host);
    if (host && gw) {
      route = gw;
      via = "gateway";
      calleePath = path.slice(String(gw.basepath).replace(/\/$/, "").length) || "/";
      const targetHost = gw.target ? splitUrl(String(gw.target)) : undefined;
      if (targetHost?.path && targetHost.path !== "/")
        calleePath = `${targetHost.path.replace(/\/$/, "")}${calleePath}`;
      to = targetHost?.host
        ? resolveComponent(targetHost.host.split(".")[0]!, caller[0]!)
        : undefined;
    } else if (declared && !declared.gateway) {
      to = declared.repo.component ?? declared.repo.id;
    } else if (host && !declared && vendorFor(host)) {
      // A vendor's name in the host says more than a first label such as api.
      to = vendorFor(host);
    } else if (host && !declared && !hostedComponents.has(hostComponent!)) {
      to = resolveComponent(hostComponent!, caller[0]!);
    } else if (!host && !GENERIC_PATH.test(path)) {
      // Relative URL: served by a component of the caller's own system with a matching endpoint.
      const sys = systemOf(owner);
      const norm = normalizePath(path);
      const hits = (endpointsOnPath.get(norm) ?? []).filter(
        (e) =>
          e.component !== owner &&
          systemOf(String(e.component)) === sys &&
          (method === "ANY" || e.method === method),
      );
      if (hits.length === 1) to = String(hits[0]!.component);
    }
    if (!to || to === owner) {
      unresolved.push(l);
      continue;
    }
    const norm = normalizePath(calleePath);
    const ep = findEndpoint(to, method, norm);
    const callee = calleeEvidence(ep);
    const gwEv = route ? route.evidence.slice(0, 1) : [];
    const m = method === "ANY" ? (ep?.method as string | undefined) : method;
    addInterface({
      schemaVersion: 1,
      kind: "Interface",
      id: interfaceId(owner, to, m, norm),
      status: "current",
      confidence: callee.length > 0 ? "verified" : "inferred",
      from: owner,
      to,
      ...(ep ? { endpoint: ep.id } : {}),
      via,
      ...(route ? { route: route.id } : {}),
      ...(m ? { method: m } : {}),
      normalizedPath: norm,
      sync: "sync",
      direction: "outbound",
      conflicts: [],
      evidence: unionEvidence(caller, gwEv, callee),
    });
  }

  // Interfaces a dialect emitted directly: attach the callee end if the target is known.
  for (const d of dialectInterfaces) {
    const ep = findEndpoint(String(d.to), d.method as string | undefined, String(d.normalizedPath));
    const callee = calleeEvidence(ep);
    resolveComponent(String(d.to), d.evidence[0]!);
    addInterface({
      ...d,
      ...(ep ? { endpoint: ep.id } : {}),
      evidence: unionEvidence(d.evidence, callee),
      confidence: callee.length > 0 ? "verified" : d.confidence,
    });
  }

  // ---- 4b. GraphQL, gRPC and webhook loose ends (ADR 0040)
  resolveTypedCalls({
    loose,
    endpoints: [...byKey.values()].filter((r) => r.kind === "Endpoint"),
    systemOf,
    resolveComponent,
    calleeEvidence,
    addInterface,
    unresolved,
  });

  // ---- 5. events
  const topics = new Map<string, { pub: Map<string, Evidence[]>; sub: Map<string, Evidence[]> }>();
  for (const l of loose.filter(
    (x) => x.unresolvedKind === "event-publish" || x.unresolvedKind === "event-subscribe",
  )) {
    const t = String(l.raw);
    const entry = topics.get(t) ?? { pub: new Map(), sub: new Map() };
    const side = l.unresolvedKind === "event-publish" ? entry.pub : entry.sub;
    const owner = String(l.owner);
    side.set(owner, unionEvidence(side.get(owner) ?? [], l.evidence));
    topics.set(t, entry);
  }
  for (const [topic, { pub, sub }] of [...topics.entries()].sort()) {
    // A topic the code names but doesn't spell out (${Topics.PAYMENTS}, a constant) isn't known:
    // its publishers and subscribers stay loose ends, never an interface.
    if (topic.includes("${")) {
      for (const l of loose.filter(
        (x) =>
          (x.unresolvedKind === "event-publish" || x.unresolvedKind === "event-subscribe") &&
          x.raw === topic,
      ))
        unresolved.push(l);
      continue;
    }
    const ep = byKey.get(`Topic|${topic}`);
    const def = ep ? ep.evidence.filter((e) => e.side === "definition") : [];
    const firstCodePub = [...pub.entries()].find(([, ev]) =>
      ev.some((e) => e.source === "code"),
    )?.[0];
    if (ep && (ep.component === "unknown" || !ep.component) && firstCodePub)
      ep.component = firstCodePub;
    for (const [p, pev] of [...pub.entries()].sort()) {
      for (const [s, sev] of [...sub.entries()].sort()) {
        if (p === s) continue;
        const pc = pev.filter((e) => e.source === "code");
        const sc = sev.filter((e) => e.source === "code");
        addInterface({
          schemaVersion: 1,
          kind: "Interface",
          id: interfaceId(p, s, undefined, topic),
          status: "current",
          confidence: pc.length > 0 && sc.length > 0 ? "verified" : "inferred",
          from: p,
          to: s,
          ...(ep ? { endpoint: ep.id } : {}),
          via: "event-bus",
          normalizedPath: topic,
          sync: "async",
          direction: "outbound",
          conflicts: [],
          evidence: unionEvidence(pc.length > 0 ? pc : pev, def, sc.length > 0 ? sc : sev),
        });
      }
    }
    // A publisher or subscriber with no counterpart stays a loose end.
    if (sub.size === 0)
      for (const l of loose.filter(
        (x) =>
          x.unresolvedKind === "event-publish" &&
          x.raw === topic &&
          x.evidence.some((e) => e.source === "code"),
      ))
        unresolved.push(l);
    if (pub.size === 0)
      for (const l of loose.filter(
        (x) =>
          x.unresolvedKind === "event-subscribe" &&
          x.raw === topic &&
          x.evidence.some((e) => e.source === "code"),
      ))
        unresolved.push(l);
  }

  // ---- 6. database access
  const tables = [...byKey.values()].filter((r) => r.kind === "Table");
  const stores = [...byKey.values()].filter((r) => r.kind === "DataStore");
  const storeIds = new Set(stores.map((s) => s.id));
  // The first store each component owns, and tables by name and by store: lookups, not scans.
  const storeOf = new Map<string, string>();
  for (const s of stores)
    if (typeof s.ownerComponent === "string" && !storeOf.has(s.ownerComponent))
      storeOf.set(s.ownerComponent, s.id);
  const tablesNamed = new Map<string, Rec[]>();
  const tablesIn = new Map<string, Rec[]>();
  for (const t of tables) {
    tablesNamed.set(String(t.name), [...(tablesNamed.get(String(t.name)) ?? []), t]);
    tablesIn.set(String(t.dataStore), [...(tablesIn.get(String(t.dataStore)) ?? []), t]);
  }
  const connections = new Map<string, string>(); // owner → store id
  for (const l of loose.filter((x) => x.unresolvedKind === "db-connection")) {
    const host = splitUrl(String(l.raw).replace(/^jdbc:/, "")).host?.split(".")[0];
    if (host && storeIds.has(host)) connections.set(String(l.owner), host);
    else unresolved.push(l);
  }
  for (const l of loose.filter((x) => x.unresolvedKind === "db-access")) {
    const [access, name] = String(l.raw).split(" ");
    const owner = String(l.owner);
    const store = connections.get(owner) ?? storeOf.get(owner);
    const candidates = (tablesNamed.get(String(name)) ?? []).filter(
      (t) => !store || t.dataStore === store,
    );
    if (candidates.length !== 1) {
      unresolved.push(l);
      continue;
    }
    const t = candidates[0]!;
    const list = access === "write" ? "writers" : "readers";
    t[list] = [...new Set([...((t[list] as string[]) ?? []), owner])].sort();
    if (t.ownerComponent !== owner) t.evidence = unionEvidence(t.evidence, l.evidence);
  }
  for (const s of stores) {
    const held = (tablesIn.get(s.id) ?? []).map((t) => String(t.name));
    s.entitiesHeld = [...new Set([...((s.entitiesHeld as string[]) ?? []), ...held])].sort();
  }

  // ---- 7. finishing touches: setting targets, access-grant subjects, component runtime
  for (const st of [...byKey.values()].filter((r) => r.kind === "Setting" && !r.target)) {
    const first = String(st.key).split(".")[0]!.toLowerCase();
    const sys = systemsById.has(first)
      ? first
      : input.systems.find((s) => s.aliases.some((a) => a.toLowerCase() === first))?.id;
    const target = components.has(first) ? first : sys ? componentsOfSystem(sys)[0] : undefined;
    if (target && target !== st.component) st.target = target;
  }
  for (const g of [...byKey.values()].filter(
    (r) => r.kind === "AccessGrant" && r.subject === "unknown",
  )) {
    const route = routes.find((r) => r.proxy === g.resource);
    const callers = [
      ...new Set(
        [...interfaces.values()]
          .filter((i) => route && i.route === route.id)
          .map((i) => String(i.from)),
      ),
    ].sort();
    if (callers.length > 0) g.subject = callers[0];
  }
  for (const d of [...byKey.values()].filter((r) => r.kind === "Deployment")) {
    const c = components.get(String(d.component));
    if (c && !c.runtime) c.runtime = d.platform;
  }

  // ---- 7a. a direct synchronous call between two services in a service mesh goes through
  //          their sidecars: via mesh (ADR 0040). Mesh membership is a `mesh` Setting.
  const meshed = new Set(
    [...byKey.values()]
      .filter((r) => r.kind === "Setting" && r.key === MESH_KEY)
      .map((r) => String(r.component)),
  );
  for (const i of interfaces.values())
    if (
      i.via === "direct" &&
      i.sync === "sync" &&
      meshed.has(String(i.from)) &&
      meshed.has(String(i.to))
    )
      i.via = "mesh";

  // ---- 7b. interface auth from the callee endpoint, and the integration pattern each hop fits
  const epById = new Map(restEndpoints.map((e) => [e.id, e]));
  const boundaryOf = (id: string) => {
    const sys = systemsById.get(id) ?? systemsById.get(systemOf(id) ?? "");
    return sys?.boundary;
  };
  const usable = (input.patterns ?? []).filter(
    (p) =>
      p.status !== "deprecated" &&
      (p.detection.via.length > 0 ||
        p.detection.sync ||
        p.detection.targetBoundary ||
        p.detection.sameSystem !== undefined),
  );
  const sameSystem = (a: string, b: string) => {
    const x = systemOf(a);
    return x !== undefined && x === systemOf(b);
  };
  for (const i of interfaces.values()) {
    const ep = i.endpoint ? epById.get(String(i.endpoint)) : undefined;
    if (!i.auth && ep?.auth) i.auth = ep.auth;
    if (!i.pattern) {
      const fits = usable.filter(
        (p) =>
          (p.detection.via.length === 0 || p.detection.via.includes(String(i.via))) &&
          (!p.detection.sync || p.detection.sync === i.sync) &&
          (!p.detection.targetBoundary ||
            p.detection.targetBoundary === boundaryOf(String(i.to))) &&
          (p.detection.sameSystem === undefined ||
            p.detection.sameSystem === sameSystem(String(i.from), String(i.to))),
      );
      if (fits.length === 1) i.pattern = { code: fits[0]!.code, source: "inferred" };
    }
  }

  // ---- 8. systems from the profile, with repos from the manifest
  const used = new Set<string>([...components.values()].map((c) => String(c.system)));
  for (const i of interfaces.values()) if (systemsById.has(String(i.to))) used.add(String(i.to));
  for (const s of input.systems) {
    const comps = componentsOfSystem(s.id).map((id) => components.get(id)!);
    const codeEvidence = comps
      .filter((c) => c.confidence === "verified")
      .flatMap((c) => c.evidence.slice(0, 1));
    const inferredEvidence = comps.flatMap((c) => c.evidence.slice(0, 1));
    const repos = [...new Set(input.repos.filter((r) => r.system === s.id).map((r) => r.id))];
    const evidence =
      codeEvidence.length > 0
        ? codeEvidence
        : inferredEvidence.length > 0
          ? inferredEvidence
          : [{ source: "config", path: input.profilePath ?? "org-pack/profiles" }];
    put(`System|${s.id}`, {
      schemaVersion: 1,
      kind: "System",
      id: s.id,
      status: "current",
      confidence: codeEvidence.length > 0 ? "verified" : "inferred",
      name: s.name,
      boundary: s.boundary,
      ...(s.owner ? { owner: s.owner } : {}),
      repos,
      tags: [],
      accessGroup: "everyone",
      evidence,
    });
  }

  // Loose ends of a kind merge doesn't join (http-endpoint, mq-publish, a dialect's own kinds)
  // stay as they are: nothing an extractor saw may disappear here.
  for (const l of loose) if (!JOINED_KINDS.has(String(l.unresolvedKind))) unresolved.push(l);

  // ---- 9. assemble and validate
  const out: Rec[] = [...byKey.values(), ...interfaces.values()];
  const inOut = new Set(out);
  for (const l of unresolved)
    if (!inOut.has(l)) {
      out.push(l);
      inOut.add(l);
    }
  const invalid: MergeResult["invalid"] = [];
  const records: CatalogRecord[] = [];
  const seen = new Set<string>();
  for (const r of out.sort((a, b) =>
    a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind.localeCompare(b.kind),
  )) {
    const key = `${r.kind}|${r.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const parsed = parseRecord(r);
    if (parsed.ok) records.push(parsed.record);
    else invalid.push({ record: r, issues: parsed.issues });
  }
  const ifs = records.filter((r) => r.kind === "Interface");
  return {
    records,
    invalid,
    stats: {
      interfaces: ifs.length,
      verified: ifs.filter((r) => r.confidence === "verified").length,
      unresolved: records.filter((r) => r.kind === "Unresolved").length,
    },
    notes: [...undeclaredGatewayHosts]
      .sort()
      .map(
        (h) =>
          `Calls to ${h} start with a gateway route's basepath, but no gateway repo lists that host; if it is a gateway, add it under hosts: for the gateway repo in repos.manifest.yaml (until then those calls stay loose ends).`,
      ),
  };
}

/** "pay-api-*.apps.bank.internal" → a RegExp matching whole host names; * is any part of a label. */
function hostPattern(p: string): RegExp {
  const body = p
    .toLowerCase()
    .split("*")
    .map((x) => x.replace(/[.\\^$+?()[\]{}|]/g, (c) => `\\${c}`))
    .join("[a-z0-9-]*");
  return new RegExp(`^${body}$`);
}

/** Loose-end kinds merge tries to join; it keeps the ones it can't. Every other kind passes through. */
const JOINED_KINDS = new Set([
  "http-call",
  "event-publish",
  "event-subscribe",
  "db-connection",
  "db-access",
  "graphql-call",
  "grpc-call",
  "webhook-callback",
]);

/** Paths every service serves (health, metrics): a relative call to one names no particular callee. */
const GENERIC_PATH =
  /^\/(health|healthz|ready|readiness|live|liveness|ping|status|info|metrics|prometheus|actuator)(\/|$)/;

/** The Setting key that says a component runs in a service mesh (ADR 0040); its value names the mesh. */
export const MESH_KEY = "mesh";

interface TypedCallContext {
  loose: Rec[];
  endpoints: Rec[];
  systemOf: (componentId: string) => string | undefined;
  resolveComponent: (name: string, ev: Evidence) => string | undefined;
  calleeEvidence: (e: Rec | undefined) => Evidence[];
  addInterface: (r: Rec) => void;
  unresolved: Rec[];
}

/**
 * Loose ends of the ADR 0040 vocabulary:
 * - `graphql-call "QUERY Query.field"`: the graphql Endpoint serving that operation and field
 *   (matched by field name, so a renamed root type still matches), in exactly one other
 *   component, preferring the caller's own system when several serve it. Subscriptions are async.
 * - `grpc-call "pkg.Service[/Method]"`: the grpc Endpoints of that service (by full name when
 *   the package is given, else by the service's short name), in exactly one other component.
 *   With a method, the interface points at that endpoint; without, at the service as a whole.
 * - `webhook-callback "METHOD /path REGISTRAR"` (a URL or a name): the system behind it calls
 *   the owner back: an Interface from it to the owner, via webhook, at the owner's webhook
 *   endpoint for that path when there is one.
 * Anything that doesn't resolve to exactly one component stays a loose end.
 */
function resolveTypedCalls(c: TypedCallContext): void {
  const typed = (t: string) => c.endpoints.filter((e) => e.endpointType === t);
  const pick = (owner: string, hits: Rec[]): Rec[] | undefined => {
    let h = hits.filter((e) => e.component !== owner);
    if (new Set(h.map((e) => e.component)).size > 1) {
      const sys = c.systemOf(owner);
      const same = h.filter((e) => sys !== undefined && c.systemOf(String(e.component)) === sys);
      if (new Set(same.map((e) => e.component)).size === 1) h = same;
    }
    return new Set(h.map((e) => e.component)).size === 1 ? h : undefined;
  };
  const link = (
    l: Rec,
    from: string,
    to: string,
    method: string | undefined,
    path: string,
    ep: Rec | undefined,
    callee: Evidence[],
    via: string,
    sync: string,
  ) =>
    c.addInterface({
      schemaVersion: 1,
      kind: "Interface",
      id: interfaceId(from, to, method, path),
      status: "current",
      confidence: callee.length > 0 ? "verified" : "inferred",
      from,
      to,
      ...(ep ? { endpoint: ep.id } : {}),
      via,
      ...(method ? { method } : {}),
      normalizedPath: path,
      sync,
      direction: "outbound",
      conflicts: [],
      evidence: unionEvidence(l.evidence, callee),
    });

  const graphql = typed("graphql");
  for (const l of c.loose.filter((x) => x.unresolvedKind === "graphql-call")) {
    const [op = "", field = ""] = String(l.raw).split(" ");
    const name = field.split(".").pop();
    const owner = String(l.owner ?? "");
    const hits = pick(
      owner,
      graphql.filter(
        (e) =>
          String(e.method ?? "").toUpperCase() === op.toUpperCase() &&
          String(e.pathOrTopic).split(".").pop() === name,
      ),
    );
    if (!hits) {
      c.unresolved.push(l);
      continue;
    }
    const ep = hits[0]!;
    link(
      l,
      owner,
      String(ep.component),
      op.toUpperCase(),
      String(ep.pathOrTopic),
      ep,
      c.calleeEvidence(ep),
      "direct",
      op.toUpperCase() === "SUBSCRIPTION" ? "async" : "sync",
    );
  }

  const grpc = typed("grpc");
  for (const l of c.loose.filter((x) => x.unresolvedKind === "grpc-call")) {
    const [svc = "", method] = String(l.raw).split("/");
    const owner = String(l.owner ?? "");
    const serviceOf = (e: Rec) => String(e.pathOrTopic).split("/")[0]!;
    const sameService = (e: Rec) =>
      svc.includes(".") ? serviceOf(e) === svc : serviceOf(e).split(".").pop() === svc;
    const hits = pick(
      owner,
      grpc.filter(
        (e) => sameService(e) && (!method || String(e.pathOrTopic).split("/")[1] === method),
      ),
    );
    if (!hits) {
      c.unresolved.push(l);
      continue;
    }
    const ep = method ? hits[0] : undefined;
    const callee = method
      ? c.calleeEvidence(ep)
      : unionEvidence(...hits.map((h) => c.calleeEvidence(h)));
    link(
      l,
      owner,
      String(hits[0]!.component),
      method,
      method ? String(ep!.pathOrTopic) : serviceOf(hits[0]!),
      ep,
      callee,
      "direct",
      "sync",
    );
  }

  const hooks = typed("webhook");
  for (const l of c.loose.filter((x) => x.unresolvedKind === "webhook-callback")) {
    const [method = "POST", path = "/", registrar = ""] = String(l.raw).split(" ");
    const owner = String(l.owner ?? "");
    // The registrar is a URL (its host's labels are tried in order) or a plain name.
    const host = splitUrl(registrar).host;
    const labels = host
      ? host.split(".").slice(0, -1)
      : /^[a-z0-9][a-z0-9-]*$/i.test(registrar)
        ? [registrar.toLowerCase()]
        : [];
    let from: string | undefined;
    for (const label of labels) {
      from = c.resolveComponent(label, l.evidence[0]!);
      if (from) break;
    }
    if (!from || from === owner) {
      c.unresolved.push(l);
      continue;
    }
    const norm = normalizePath(path);
    const ep = hooks.find(
      (e) =>
        e.component === owner && normalizePath(String(e.normalizedPath ?? e.pathOrTopic)) === norm,
    );
    link(l, from, owner, method.toUpperCase(), norm, ep, c.calleeEvidence(ep), "webhook", "async");
  }
}
