import { createHash } from "node:crypto";
import { parseRecord, type CatalogRecord, type RecordIssue } from "./catalog.js";
import { interfaceId, normalizePath } from "./identity.js";

/**
 * Merge and identity: turns the records every repo's scan produced into one catalog.
 *
 * - Records with the same identity merge (evidence is unioned, the best value wins).
 * - REST endpoints are keyed by component, method and normalised path and get a canonical id.
 * - Loose ends (Unresolved records, ADR 0016) are resolved: HTTP calls into Interfaces
 *   (through the gateway when a route's base path matches), publishes and subscribes into
 *   event Interfaces, database access into Tables' readers and writers.
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
}

export interface MergeResult {
  records: CatalogRecord[];
  /** Records merge produced that failed C1 (a bug if ever non-empty). */
  invalid: { record: unknown; issues: RecordIssue[] }[];
  stats: { interfaces: number; verified: number; unresolved: number };
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
  }
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

  // ---- 1. collect: endpoints keyed by identity, loose ends aside, everything else by kind/id
  for (const raw of input.records as unknown as Rec[]) {
    const r = { ...raw, evidence: raw.evidence.map((e) => ({ ...e })) } as Rec;
    if (r.kind === "Unresolved") loose.push(r);
    else if (r.kind === "Interface") dialectInterfaces.push(r);
    else if (r.kind === "Endpoint" && r.endpointType === "rest") {
      const norm = normalizePath(String(r.normalizedPath ?? r.pathOrTopic));
      put(`Endpoint|${r.component}|${String(r.method ?? "").toUpperCase()}|${norm}`, {
        ...r,
        normalizedPath: norm,
      });
    } else if (r.kind === "Endpoint") put(`Topic|${r.pathOrTopic}`, r);
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

  // ---- 3. components, systems and lookups
  const components = new Map<string, Rec>();
  for (const [k, r] of byKey) if (k.startsWith("Component|")) components.set(r.id, r);
  const systemsById = new Map(input.systems.map((s) => [s.id, s]));
  const systemOf = (componentId: string): string | undefined => {
    const c = components.get(componentId);
    if (c?.system) return String(c.system);
    return [...systemsById.keys()]
      .sort((a, b) => b.length - a.length)
      .find((s) => componentId === s || componentId.startsWith(`${s}-`));
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
  const findEndpoint = (component: string, method: string | undefined, norm: string) =>
    restEndpoints.find(
      (e) =>
        e.component === component &&
        e.normalizedPath === norm &&
        (!method || method === "ANY" || e.method === method),
    ) ?? restEndpoints.find((e) => e.component === component && e.normalizedPath === norm);

  /** Callee-side evidence of an endpoint: code on the serving side, else its definition re-labelled. */
  const calleeEvidence = (e: Rec | undefined): Evidence[] => {
    if (!e) return [];
    const code = e.evidence.filter((x) => x.side === "callee");
    return code.length > 0
      ? code
      : e.evidence.filter((x) => x.side === "definition").map((x) => ({ ...x, side: "callee" }));
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

    const hostComponent = host ? host.split(".")[0]! : undefined;
    const hostKnown = hostComponent
      ? components.has(hostComponent) || systemsById.has(hostComponent)
      : false;
    const gw = routes
      .filter(
        (r) => path === r.basepath || path.startsWith(`${String(r.basepath).replace(/\/$/, "")}/`),
      )
      .sort((a, b) => String(b.basepath).length - String(a.basepath).length)[0];
    if (host && gw && !hostKnown) {
      route = gw;
      via = "gateway";
      calleePath = path.slice(String(gw.basepath).replace(/\/$/, "").length) || "/";
      const targetHost = gw.target ? splitUrl(String(gw.target)) : undefined;
      if (targetHost?.path && targetHost.path !== "/")
        calleePath = `${targetHost.path.replace(/\/$/, "")}${calleePath}`;
      to = targetHost?.host
        ? resolveComponent(targetHost.host.split(".")[0]!, caller[0]!)
        : undefined;
    } else if (host) {
      to = resolveComponent(hostComponent!, caller[0]!);
    } else {
      // Relative URL: served by a component of the caller's own system with a matching endpoint.
      const sys = systemOf(owner);
      const norm = normalizePath(path);
      const hits = restEndpoints.filter(
        (e) =>
          e.component !== owner &&
          systemOf(String(e.component)) === sys &&
          e.normalizedPath === norm &&
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
  const connections = new Map<string, string>(); // owner → store id
  for (const l of loose.filter((x) => x.unresolvedKind === "db-connection")) {
    const host = splitUrl(String(l.raw).replace(/^jdbc:/, "")).host?.split(".")[0];
    if (host && stores.some((s) => s.id === host)) connections.set(String(l.owner), host);
    else unresolved.push(l);
  }
  for (const l of loose.filter((x) => x.unresolvedKind === "db-access")) {
    const [access, name] = String(l.raw).split(" ");
    const owner = String(l.owner);
    const store =
      connections.get(owner) ??
      [...byKey.values()].find((r) => r.kind === "DataStore" && r.ownerComponent === owner)?.id;
    const candidates = tables.filter((t) => t.name === name && (!store || t.dataStore === store));
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
    const held = tables.filter((t) => t.dataStore === s.id).map((t) => String(t.name));
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
    const repos = input.repos.filter((r) => r.system === s.id).map((r) => r.id);
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

  // ---- 9. assemble and validate
  const out: Rec[] = [...byKey.values(), ...interfaces.values()];
  for (const l of unresolved) if (!out.includes(l)) out.push(l);
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
  };
}
