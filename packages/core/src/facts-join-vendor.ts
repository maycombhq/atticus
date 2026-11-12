import { factIdPart } from "./facts.js";
import { APIGEE_BUNDLE, placeholderIn, type FactEnd, type JoinRepo } from "./facts-join.js";
import type { Fact, FactOf } from "./schema/facts.js";
import { hostMatches, urlHostPort } from "./schema/workspace.js";
import { gatewayBundleTest } from "./schema/conventions.js";

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
 * Beta.27 (a user's estate): a target URL written as a deploy token (`@targetVendorUrl@`) is
 * each value the config facts setting that token give it, per environment, as the join reads it;
 * and the path the vendor receives is the target URL's own path (`/api/v1`) with the path the
 * route forwards after it. A host an estate repo's manifest lists is the estate's, never a
 * vendor's, whatever the profile's aliases say; a base that is a config key of the repo is never
 * read as a host itself; and a call the estate join joined to an entry (a service's call to the
 * gateway's own base path) reaches the vendor through that route, never directly.
 *
 * Then the operation: the vendor's operations of the same method whose path, with the spec's
 * server path in front or without it, has the call's shape: a path parameter (`{version}`,
 * `{account_guid}`) stands for any one segment, and a literal segment is preferred over a
 * parameter where both fit (`/accounts/balances` over `/accounts/{account_guid}`), as OpenAPI
 * routes. One is a match; none is a gap (the vendor's spec doesn't publish what the gateway
 * forwards); two or more equally good is a question. A route that forwards a wildcard (a `*`
 * segment, or `**` at the end) reaches every operation under it by design: each is a match
 * (`wildcard`), never a question. Pure and deterministic: the same facts, answers and operations
 * give the same result, whatever order they come in.
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

/**
 * A vendor, or any other system outside the estate that publishes a spec (O2: another team's,
 * boundary `internal`), and what the join needs to find its calls: its names, its hosts and its
 * operations.
 */
export interface JoinVendor {
  /** The org pack's system id: a vendor's, or another outside system's. */
  system: string;
  /**
   * The system's boundary in the profile. `internal` (another team's system, ADR 0142): the
   * estate's services call it themselves, not through the external gateway, so a service's own
   * call to it is matched too (`direct` on the match). Left out, or `vendor`: only a gateway's
   * forwarding calls are matched, as ADR 0130 says.
   */
  boundary?: "vendor" | "internal";
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
  /** The path the gateway forwards to: the target URL's own path in front, when it has one. */
  path: string;
  /**
   * Beta.27: the route forwards a wildcard (`/accounts/*`), so it reaches every operation under
   * it; this is one of them (the call has a match for each).
   */
  wildcard?: true;
  /**
   * ADR 0142: a service's own call to another team's system, not a gateway's forwarding call;
   * `route` is then the entry the call is made under, when it names one.
   */
  direct?: true;
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
  /** The gateway bundle folders, as given to `joinFacts` (ADR 0147). */
  bundleFolders?: readonly string[];
  /**
   * Beta.27: the estate join's joins. A call joined to an entry of the estate (a service's call
   * to the gateway's own host and base path, joined to the proxy's route) goes there: the route
   * forwards it on, so it is never a direct call to the vendor.
   */
  joined?: readonly { call: FactEnd }[];
}

type Call = FactOf<"call">;
type Entry = FactOf<"entry">;
type Config = FactOf<"config">;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const compact = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
const SECRETISH = /^(env:|vault:|secret:|ref:|\$\{|\{\{)/i;

/** The path part of a URL (`https://host/api/v1` gives `/api/v1`), when it has one. */
function urlPathOf(s: string | undefined): string | undefined {
  const m = s ? /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+(\/[^?#]*)/i.exec(s.trim()) : null;
  const p = m?.[1]?.replace(/\/+$/, "");
  return p ? p : undefined;
}

/** A path with another in front, unless it already starts with it. */
function under(prefix: string | undefined, path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  if (!prefix) return p;
  const lower = p.toLowerCase();
  const pre = prefix.toLowerCase();
  return lower === pre || lower.startsWith(`${pre}/`) ? p : `${prefix}${p === "/" ? "" : p}`;
}

/**
 * A path's segments as the vendor match reads them: literals lower-cased, a path parameter in any
 * of its forms (`{id}`, `:id`, `<id>`, `${id}`) `{}`, a one-segment wildcard `*`, and a wildcard
 * for the rest (`**`, `{*rest}`) `**`.
 */
function segs(path: string): string[] | undefined {
  const p = (path.trim().split(/[?#]/, 1)[0] ?? "").replace(/\{([^}:?]*)[^}]*\}/g, "{$1}");
  if (!p.startsWith("/")) return undefined;
  return p
    .split("/")
    .filter(Boolean)
    .map((s) =>
      /^(\{\*[^}]*\}|\*\*|\{\*\*\})$/.test(s)
        ? "**"
        : s === "*"
          ? "*"
          : /^(\{[^}]*\}|:[^/]+|<[^>]+>|\$\{[^}]*\})$/.test(s)
            ? "{}"
            : s.toLowerCase(),
    );
}

/**
 * How a forwarded path fits an operation's: the count of literal segments both write (more is
 * the better fit: a literal over a parameter), and whether the forwarded path is a wildcard that
 * takes the operation among others; undefined when it doesn't fit. A parameter of the operation
 * takes any one segment; a parameter of the call (a value it sends) only a parameter; a `*` of
 * the call any one segment, a `**` the rest. At least one literal is shared.
 */
function fit(call: string[], op: string[]): { literals: number; wildcard: boolean } | undefined {
  const rest = call.indexOf("**");
  const head = rest >= 0 ? call.slice(0, rest) : call;
  if (rest >= 0 ? op.length < head.length : op.length !== call.length) return undefined;
  let literals = 0;
  let wildcard = rest >= 0;
  for (let i = 0; i < head.length; i++) {
    const a = head[i]!;
    const b = op[i]!;
    if (a === "*") wildcard = true;
    else if (b === "{}") continue;
    else if (a === b) literals++;
    else return undefined;
  }
  return literals > 0 ? { literals, wildcard } : undefined;
}

/** A host written as a URL or as `name[:port]`. */
function hostOf(s: string | undefined): { host: string; port?: number } | undefined {
  const t = s?.trim();
  if (!t || SECRETISH.test(t)) return undefined;
  const u = urlHostPort(t);
  if (u) return u.host ? u : undefined;
  const m = /^([a-z0-9][a-z0-9.-]*)(?::(\d+))?$/i.exec(t);
  return m ? { host: m[1]!.toLowerCase(), ...(m[2] ? { port: Number(m[2]) } : {}) } : undefined;
}

/**
 * Beta.27: the deploy token a call's target URL is written as (`@targetVendorUrl@`,
 * `{{vendor_url}}`, `${VENDOR_URL}`): its `host` when that is the token whole, else, for a
 * gateway's forwarding call with no host or base (a read before beta.27), the one token the lines
 * it cites write as the URL (the TargetEndpoint's `<URL>` line in `cite.with`).
 */
function tokenOf(call: Call, forwarding: boolean): string | undefined {
  const whole = (v: string | undefined) => {
    const t = v?.trim();
    const p = t ? placeholderIn(t) : undefined;
    return p && !p.before.trim() && (p.after === "" || /^[/:?]/.test(p.after)) ? t : undefined;
  };
  if (call.host) return whole(call.host);
  if (call.base || !forwarding) return undefined;
  const said = new Set(
    [call.cite.value, ...(call.cite.with ?? []).map((w) => w.value)].flatMap((v) => {
      const t = whole(v);
      return t ? [t] : [];
    }),
  );
  return said.size === 1 ? [...said][0] : undefined;
}

/** Whether a system's own published operations take a service's direct calls (ADR 0142). */
const takesDirect = (v: JoinVendor) => v.boundary === "internal";

const sameMethod = (a: string | undefined, b: string | undefined) => {
  const x = a?.toUpperCase();
  const y = b?.toUpperCase();
  return !x || !y || x === "ANY" || y === "ANY" || x === y;
};

/** Match every gateway forwarding call that goes to a vendor to the vendor operation it reaches. */
export function joinVendorOperations(input: JoinVendorOperationsInput): VendorJoinResult {
  const vendors = [...input.vendors].sort((a, b) => cmp(a.system, b.system));
  const bundle = input.bundleFolders ? gatewayBundleTest(input.bundleFolders) : APIGEE_BUNDLE;
  const byName = new Map<string, JoinVendor>();
  for (const v of vendors)
    for (const n of [v.system, ...v.names]) if (n) byName.set(factIdPart(n), v);
  const byLabel = new Map<string, Set<JoinVendor>>();
  for (const v of vendors)
    for (const n of [v.system, ...v.names]) {
      const k = compact(n);
      if (k.length >= 3) byLabel.set(k, (byLabel.get(k) ?? new Set()).add(v));
    }
  // A host an estate repo (or a module of one) answers on is the estate's: a call to it is the
  // join's (the gateway's own host, say), whatever a vendor's aliases list.
  const estateHosts = input.repos.flatMap((r) => [
    ...(r.hosts ?? []),
    ...(r.modules ?? []).flatMap((m) => m.hosts),
  ]);
  const joinedCalls = new Set(
    (input.joined ?? []).map((j) => `${j.call.repo}\u0000${j.call.fact}`),
  );
  /** The vendor a host belongs to: a host its spec lists, else its name as a host label. */
  const vendorOfHost = (h: { host: string; port?: number }): JoinVendor | undefined => {
    if (estateHosts.some((p) => hostMatches(p, h.host, h.port))) return undefined;
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
    const isRoute = (e: Entry) => !!r.gateway || bundle.test(e.cite.file);
    for (const f of facts) {
      if (f.kind !== "call" || f.callType !== "rest") continue;
      const routeFact = f.from ? entries.get(f.from) : undefined;
      const forwarding = !!routeFact && isRoute(routeFact);
      // ADR 0142: a call no gateway route makes is matched only to a system that takes direct
      // calls (another team's), so a vendor's matches stay a gateway's, as ADR 0130 has them.
      if (!forwarding && !vendors.some(takesDirect)) continue;
      const call = f as Call;
      const route = routeFact ? end(routeFact) : undefined;
      // Beta.27: a call the estate join joined to an entry goes there (a service's call to the
      // gateway's own base path lands on the proxy's route, which forwards it on).
      if (joinedCalls.has(`${r.repo}\u0000${call.id}`)) continue;

      // ---- which vendor
      let vendor: JoinVendor | undefined;
      let how: VendorJoinHow | undefined;
      let tie: FactEnd | undefined;
      const direct = hostOf(call.host);
      // Beta.27: a target URL written as a token (`@targetVendorUrl@`), in `host` or, for a read
      // before beta.27, only on the lines the call cites: the config facts of that key set it.
      const token = direct ? undefined : tokenOf(call, forwarding);
      const keyed = (k: string) =>
        facts.filter((c): c is Config => c.kind === "config" && c.key === k && !!hostOf(c.value));
      // A token is set by its name as written (`@targetVendorUrl@`) or by the name inside it.
      const tokenName = token ? placeholderIn(token)?.name : undefined;
      const configs = token
        ? [
            ...new Set([
              ...keyed(token),
              ...(tokenName && tokenName !== token ? keyed(tokenName) : []),
            ]),
          ]
        : call.base
          ? keyed(call.base)
          : [];
      // A base that is a config key of the repo (resolved or not) is never read as a host itself.
      const baseIsKey =
        !!call.base && facts.some((c) => c.kind === "config" && c.key === call.base);
      const answer = input.targets?.[r.repo]?.[call.id];
      if (answer) {
        vendor = byName.get(factIdPart(answer));
        how = "answer";
      } else if (call.to && byName.has(factIdPart(call.to))) {
        vendor = byName.get(factIdPart(call.to));
        how = "named";
      } else {
        const seen = new Map<string, { v: JoinVendor; tie?: Config }>();
        if (direct) {
          const v = vendorOfHost(direct);
          if (v) seen.set(v.system, { v });
        } else if (configs.length) {
          for (const c of configs) {
            const v = vendorOfHost(hostOf(c.value)!);
            if (v && !seen.has(v.system)) seen.set(v.system, { v, tie: c });
          }
        } else if (!token && !baseIsKey) {
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
      if (!forwarding && !takesDirect(vendor)) continue;
      const own = vendor;
      /** The target URL's own paths (`/api/v1`), one per environment's setting, when it has any. */
      const prefixes = [
        ...new Set(
          [
            urlPathOf(call.host),
            ...configs
              .filter((c) => {
                const h = hostOf(c.value)!;
                return how !== "host" || vendorOfHost(h) === own;
              })
              .map((c) => urlPathOf(c.value)),
          ].filter((p): p is string => !!p),
        ),
      ].sort();

      // ---- which operation
      const name = vendor.names[0] ?? vendor.system;
      const method = call.method?.toUpperCase();
      // The path the vendor receives: each environment's target path in front of the route's.
      const sent = prefixes.length ? prefixes.map((p) => under(p, call.path)) : [call.path];
      const what = [method, sent[0]].filter(Boolean).join(" ");
      const shape = (op: JoinVendorOperation) => {
        let bestFit: { literals: number; wildcard: boolean; path: string } | undefined;
        for (const path of [...sent, ...(prefixes.length ? [call.path] : [])]) {
          const a = segs(path);
          if (!a) continue;
          for (const served of op.fullPath ? [op.fullPath, op.path] : [op.path]) {
            const b = segs(served);
            const x = b ? fit(a, b) : undefined;
            if (x && (!bestFit || x.literals > bestFit.literals)) bestFit = { ...x, path };
          }
        }
        return bestFit;
      };
      const scored = vendor.operations.flatMap((op) => {
        const s = shape(op);
        return s ? [{ op, ...s }] : [];
      });
      const fitting = scored.filter((s) => sameMethod(method, s.op.method));
      // A wildcard route reaches every operation it fits; any other call the best fit only.
      const wild = fitting.some((s) => s.wildcard);
      const best = Math.max(0, ...fitting.map((s) => s.literals));
      const hits = fitting
        .filter((s) => wild || s.literals === best)
        .sort((a, b) => cmp(a.op.id, b.op.id));
      const base = {
        call: end(call),
        ...(route ? { route } : {}),
        ...(tie ? { tie } : {}),
        vendor: vendor.system,
      };
      if (hits.length === 1 || (wild && hits.length > 1)) {
        for (const h of hits)
          matches.push({
            ...base,
            how,
            operation: h.op.id,
            ...(method || h.op.method ? { method: (method ?? h.op.method).toUpperCase() } : {}),
            path: sent.includes(h.path) ? h.path : sent[0]!,
            ...(wild ? { wildcard: true as const } : {}),
            ...(forwarding ? {} : { direct: true as const }),
          });
      } else if (hits.length > 1) {
        const opName = (op: JoinVendorOperation) => `${op.method.toUpperCase()} ${op.path}`;
        const names = hits.map((h) => opName(h.op)).sort();
        asks.push({
          call: end(call),
          ...(route ? { route } : {}),
          vendor: vendor.system,
          question: `Which of ${name}'s operations does ${what}, which ${component(call)} forwards, reach: ${names.slice(0, -1).join(", ")} or ${names.at(-1)}?`,
          candidates: hits.map((h) => h.op.id),
        });
      } else {
        const others = [...new Set(scored.map((s) => s.op.method.toUpperCase()))].sort();
        gaps.push({
          ...base,
          ...(method ? { method } : {}),
          path: sent[0]!,
          message: `${component(call)} ${forwarding ? "forwards" : "calls"} ${what} ${forwarding ? "to" : "on"} ${name}, whose spec publishes no such operation${others.length ? ` (it publishes ${others.join(", ")} on that path)` : ""}`,
        });
      }
    }
  }
  const byCall = (x: { call: FactEnd }, y: { call: FactEnd }) =>
    cmp(x.call.repo, y.call.repo) || cmp(x.call.fact, y.call.fact);
  return { matches: matches.sort(byCall), gaps: gaps.sort(byCall), asks: asks.sort(byCall) };
}
