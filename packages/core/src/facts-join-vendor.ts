import { factIdPart } from "./facts.js";
import { APIGEE_BUNDLE, routeScore, type FactEnd, type JoinRepo } from "./facts-join.js";
import type { Fact, FactOf } from "./schema/facts.js";
import { hostMatches, urlHostPort } from "./schema/workspace.js";

/**
 * A gateway's forwarding calls matched to the vendor operations they reach (ADR 0130). The facts
 * join (ADR 0124, A-gateway) follows a call through a gateway to whatever in the estate answers;
 * a forwarding call to a vendor's host has nothing in the estate behind it, so the join stops
 * there. This reads the other side: the vendor's published operations (intake reads them from
 * its spec in inputs/), and for each forwarding call of a gateway route, the one operation it
 * reaches by method and path, path parameters normalised.
 *
 * Which vendor a call goes to is read, in order, from: a person's answer naming the vendor; the
 * call's `to`; its host, or the hosts the config facts its base names give (an Apigee
 * TargetServer per environment), matched to a host the vendor's spec lists, else to the vendor's
 * name written in a host label (api.northwindpay.example → Northwind Pay), as the merge does.
 * A call whose host no vendor claims is left alone: it is the join's, never guessed.
 *
 * Then the operation: the vendor's operations of the same method whose path, with the spec's
 * server path in front or without it, has the call's shape. One is a match; none is a gap (the
 * vendor's spec doesn't publish what the gateway forwards); two or more equally good is a
 * question. Pure and deterministic: the same facts, answers and operations give the same result,
 * whatever order they come in.
 */

/** One operation a vendor publishes, as intake reads it from the vendor's spec. */
export interface JoinVendorOperation {
  /** The catalog Endpoint id of the operation. */
  id: string;
  method: string;
  /** The path as the spec writes it (Swagger 2's basePath in front). */
  path: string;
  /** The path with the spec's server path in front (OpenAPI 3 `servers`), when it has one. */
  fullPath?: string;
  /** spec path:line of the operation. */
  cite?: string;
}

/** A vendor and what the join needs to find its calls: its names, its hosts and its operations. */
export interface JoinVendor {
  /** The org pack's system id (boundary vendor). */
  system: string;
  /** Its name and aliases, as the org pack writes them. */
  names: readonly string[];
  /** The hosts its spec's servers name, and any host the org pack gives it (patterns allowed). */
  hosts: readonly string[];
  operations: readonly JoinVendorOperation[];
}

/** How the vendor was found: a person's `answer`, the call's `to` (`named`), or its `host`. */
export type VendorJoinHow = "answer" | "named" | "host";

export interface VendorCallMatch {
  /** The gateway's forwarding call. */
  call: FactEnd;
  /** The route (entry) the forwarding call is under. */
  route?: FactEnd;
  /** The config fact (a TargetServer) that ties the call to the vendor's host. */
  tie?: FactEnd;
  vendor: string;
  how: VendorJoinHow;
  /** The vendor operation's Endpoint id. */
  operation: string;
  method?: string;
  /** The path the gateway forwards to. */
  path: string;
}

/** A forwarding call to an operation the vendor's spec doesn't publish. */
export interface VendorCallGap {
  call: FactEnd;
  route?: FactEnd;
  tie?: FactEnd;
  vendor: string;
  method?: string;
  path: string;
  message: string;
}

/** A forwarding call two or more of the vendor's operations answer equally well. */
export interface VendorCallAsk {
  call: FactEnd;
  route?: FactEnd;
  vendor: string;
  question: string;
  /** The operations' Endpoint ids, sorted. */
  candidates: string[];
}

export interface VendorJoinResult {
  matches: VendorCallMatch[];
  gaps: VendorCallGap[];
  asks: VendorCallAsk[];
}

export interface JoinVendorOperationsInput {
  repos: readonly JoinRepo[];
  vendors: readonly JoinVendor[];
  /** A person's answer naming the repo or system a call goes to: repo → call fact id → name. */
  targets?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

type Call = FactOf<"call">;
type Entry = FactOf<"entry">;
type Config = FactOf<"config">;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const compact = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
const SECRETISH = /^(env:|vault:|secret:|ref:|\$\{|\{\{)/i;

/** A host written as a URL or as `name[:port]`. */
function hostOf(s: string | undefined): { host: string; port?: number } | undefined {
  const t = s?.trim();
  if (!t || SECRETISH.test(t)) return undefined;
  const u = urlHostPort(t);
  if (u) return u.host ? u : undefined;
  const m = /^([a-z0-9][a-z0-9.-]*)(?::(\d+))?$/i.exec(t);
  return m ? { host: m[1]!.toLowerCase(), ...(m[2] ? { port: Number(m[2]) } : {}) } : undefined;
}

const sameMethod = (a: string | undefined, b: string | undefined) => {
  const x = a?.toUpperCase();
  const y = b?.toUpperCase();
  return !x || !y || x === "ANY" || y === "ANY" || x === y;
};

/** Match every gateway forwarding call that goes to a vendor to the vendor operation it reaches. */
export function joinVendorOperations(input: JoinVendorOperationsInput): VendorJoinResult {
  const vendors = [...input.vendors].sort((a, b) => cmp(a.system, b.system));
  const byName = new Map<string, JoinVendor>();
  for (const v of vendors)
    for (const n of [v.system, ...v.names]) if (n) byName.set(factIdPart(n), v);
  const byLabel = new Map<string, Set<JoinVendor>>();
  for (const v of vendors)
    for (const n of [v.system, ...v.names]) {
      const k = compact(n);
      if (k.length >= 3) byLabel.set(k, (byLabel.get(k) ?? new Set()).add(v));
    }
  /** The vendor a host belongs to: a host its spec lists, else its name as a host label. */
  const vendorOfHost = (h: { host: string; port?: number }): JoinVendor | undefined => {
    const listed = vendors.filter((v) => v.hosts.some((p) => hostMatches(p, h.host, h.port)));
    if (listed.length === 1) return listed[0];
    if (listed.length > 1) return undefined;
    const hits = new Set<JoinVendor>();
    for (const label of h.host.split(".").slice(0, -1))
      for (const v of byLabel.get(compact(label)) ?? []) hits.add(v);
    return hits.size === 1 ? [...hits][0] : undefined;
  };

  const matches: VendorCallMatch[] = [];
  const gaps: VendorCallGap[] = [];
  const asks: VendorCallAsk[] = [];
  for (const r of [...input.repos].sort((a, b) => cmp(a.repo, b.repo))) {
    const component = (f: Fact) => factIdPart(f.component ?? r.component ?? r.repo);
    const end = (f: Fact): FactEnd => ({
      repo: r.repo,
      fact: f.id,
      component: component(f),
      at: `${f.cite.file}:${f.cite.line}`,
    });
    const facts = [...r.facts].sort((a, b) => cmp(a.id, b.id));
    const entries = new Map(
      facts.filter((f): f is Entry => f.kind === "entry").map((f) => [f.id, f] as const),
    );
    const isRoute = (e: Entry) => !!r.gateway || APIGEE_BUNDLE.test(e.cite.file);
    for (const f of facts) {
      if (f.kind !== "call" || f.callType !== "rest" || !f.from) continue;
      const routeFact = entries.get(f.from);
      if (!routeFact || !isRoute(routeFact)) continue;
      const call = f as Call;
      const route = end(routeFact);

      // ---- which vendor
      let vendor: JoinVendor | undefined;
      let how: VendorJoinHow | undefined;
      let tie: FactEnd | undefined;
      const answer = input.targets?.[r.repo]?.[call.id];
      if (answer) {
        vendor = byName.get(factIdPart(answer));
        how = "answer";
      } else if (call.to && byName.has(factIdPart(call.to))) {
        vendor = byName.get(factIdPart(call.to));
        how = "named";
      } else {
        const direct = hostOf(call.host);
        const configs = call.base
          ? facts.filter(
              (c): c is Config => c.kind === "config" && c.key === call.base && !!hostOf(c.value),
            )
          : [];
        const seen = new Map<string, { v: JoinVendor; tie?: Config }>();
        if (direct) {
          const v = vendorOfHost(direct);
          if (v) seen.set(v.system, { v });
        } else if (configs.length) {
          for (const c of configs) {
            const v = vendorOfHost(hostOf(c.value)!);
            if (v && !seen.has(v.system)) seen.set(v.system, { v, tie: c });
          }
        } else {
          const b = hostOf(call.base);
          const v = b ? vendorOfHost(b) : undefined;
          if (v) seen.set(v.system, { v });
        }
        // Hosts that name two vendors (one per environment) are the join's to ask, not this.
        if (seen.size === 1) {
          const only = [...seen.values()][0]!;
          vendor = only.v;
          how = "host";
          if (only.tie) tie = end(only.tie);
        }
      }
      if (!vendor || !how) continue;

      // ---- which operation
      const name = vendor.names[0] ?? vendor.system;
      const method = call.method?.toUpperCase();
      const what = [method, call.path].filter(Boolean).join(" ");
      const shape = (op: JoinVendorOperation) =>
        Math.max(
          routeScore(call.path, op.fullPath ?? op.path),
          op.fullPath ? routeScore(call.path, op.path) : 0,
        );
      const scored = vendor.operations
        .map((op) => ({ op, score: shape(op) }))
        .filter((s) => s.score >= 400);
      const fitting = scored.filter((s) => sameMethod(method, s.op.method));
      const best = Math.max(0, ...fitting.map((s) => s.score));
      const hits = fitting
        .filter((s) => s.score === best)
        .map((s) => s.op)
        .sort((a, b) => cmp(a.id, b.id));
      const base = {
        call: end(call),
        route,
        ...(tie ? { tie } : {}),
        vendor: vendor.system,
      };
      if (hits.length === 1) {
        const op = hits[0]!;
        matches.push({
          ...base,
          how,
          operation: op.id,
          ...(method || op.method ? { method: (method ?? op.method).toUpperCase() } : {}),
          path: call.path,
        });
      } else if (hits.length > 1) {
        const opName = (op: JoinVendorOperation) => `${op.method.toUpperCase()} ${op.path}`;
        const names = hits.map(opName).sort();
        asks.push({
          call: end(call),
          route,
          vendor: vendor.system,
          question: `Which of ${name}'s operations does ${what}, which ${component(call)} forwards, reach: ${names.slice(0, -1).join(", ")} or ${names.at(-1)}?`,
          candidates: hits.map((o) => o.id),
        });
      } else {
        const others = [...new Set(scored.map((s) => s.op.method.toUpperCase()))].sort();
        gaps.push({
          ...base,
          ...(method ? { method } : {}),
          path: call.path,
          message: `${component(call)} forwards ${what} to ${name}, whose spec publishes no such operation${others.length ? ` (it publishes ${others.join(", ")} on that path)` : ""}`,
        });
      }
    }
  }
  const byCall = (x: { call: FactEnd }, y: { call: FactEnd }) =>
    cmp(x.call.repo, y.call.repo) || cmp(x.call.fact, y.call.fact);
  return { matches: matches.sort(byCall), gaps: gaps.sort(byCall), asks: asks.sort(byCall) };
}
