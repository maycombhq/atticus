import { parse } from "yaml";
import { z } from "zod";
import type { CatalogRecord } from "@maycombhq/core";

/**
 * The bench (revamp plan, Phase 1): public repos, each with a reference a person wrote by
 * reading the code, and a score of what a scan found, missed and got wrong. A reference is
 * written in plain facts, not Atticus's record ids, so it doesn't change when Atticus does:
 * what the repo serves, what it calls, which tables it stores and where it deploys.
 */

export const FACT_KINDS = ["serves", "calls", "stores", "deploys"] as const;
export type FactKind = (typeof FACT_KINDS)[number];

/** Where a person saw the fact: path:line in the repo at the pinned commit. */
const At = z.string().regex(/^[^\s:]+:\d+$/, "at must be path:line");

const Reference = z
  .strictObject({
    repo: z.string().min(1),
    commit: z.string().regex(/^[0-9a-f]{40}$/, "commit must be a full SHA"),
    covers: z.array(z.enum(FACT_KINDS)).min(1),
    notes: z.string().optional(),
    serves: z
      .array(
        z.strictObject({
          type: z.string().default("rest"),
          method: z.string().optional(),
          path: z.string().min(1),
          at: At,
        }),
      )
      .optional(),
    calls: z
      .array(
        z.strictObject({
          /**
           * rest (the default), grpc (path Service/Method), soap (path Contract/Operation) or
           * event (path the topic or event).
           */
          type: z.enum(["rest", "grpc", "soap", "event"]).default("rest"),
          method: z.string().optional(),
          path: z.string().min(1),
          to: z.string().optional(),
          at: At,
        }),
      )
      .optional(),
    stores: z.array(z.strictObject({ table: z.string().min(1), at: At })).optional(),
    deploys: z.array(z.strictObject({ platform: z.string().min(1), at: At })).optional(),
  })
  .superRefine((r, ctx) => {
    for (const k of FACT_KINDS)
      if (r[k] && !r.covers.includes(k))
        ctx.addIssue({ code: "custom", path: [k], message: `${k} isn't in covers` });
  });
export type BenchReference = z.infer<typeof Reference>;

export function parseReference(text: string): BenchReference {
  const r = Reference.safeParse(parse(text));
  if (!r.success)
    throw new Error(
      r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
    );
  return r.data;
}

/**
 * A path as references are written: no host or `{API}`-style base before the first slash, no
 * query, every parameter (`{id}`, `:id`, `${id}`) as `{}`, no trailing slash. A topic or queue
 * name (no slash) is kept as it is.
 */
export function normalizePath(p: string): string {
  // A query starts at a `?` outside braces: `{id?}` is an optional parameter.
  let s = p.trim().replace(/[?#](?![^{]*\}).*$/, "");
  if (!s.includes("/")) return s;
  s = s.replace(/^[a-z]+:\/\/[^/]+/i, "");
  // A base before the path: {API}/x, ${BASE}/x, BASE_URL + "/x" already joined.
  const slash = s.search(/\/(?![^{]*\})/);
  if (slash > 0) s = s.slice(slash);
  s = s.replace(/\$?\{[^}]*\}/g, "{}").replace(/\/:[^/]+/g, "/{}");
  s = s.replace(/\/+/g, "/");
  if (s.length > 1) s = s.replace(/\/$/, "");
  return s;
}

const method = (m: string | undefined) => (m ? `${m.toUpperCase()} ` : "");
const table = (name: string) =>
  name
    .toLowerCase()
    .split(".")
    .pop()!
    .replace(/["`[\]]/g, "");

/** HTTP-style entry points have a method and a path; the rest are named, kept as written. */
const HTTP = new Set(["rest", "webhook", "websocket", "sse"]);
/** HTTP paths compare without letter case (ASP.NET routes ignore it; few apps rely on it). */
const httpPath = (path: string) => normalizePath(path).toLowerCase();
const serveFact = (type: string, m: string | undefined, path: string) =>
  HTTP.has(type) ? `${type} ${method(m)}${httpPath(path)}` : `${type} ${path.trim()}`;
const callFact = (type: string, m: string | undefined, path: string) =>
  type === "rest" ? `${method(m)}${httpPath(path)}` : `${type} ${path.trim()}`;

/**
 * Two facts match when they are equal, or when they differ only in the HTTP method and one
 * of them has none or ANY (a route that answers every method).
 */
const ANY_METHOD = /^((?:[a-z-]+ )?)(?:([A-Z]+) )?(\/.*)$/;
function sameFact(a: string, b: string): boolean {
  if (a === b) return true;
  const x = ANY_METHOD.exec(a);
  const y = ANY_METHOD.exec(b);
  if (!x || !y || x[1] !== y[1] || x[3] !== y[3]) return false;
  const wild = (m: string | undefined) => m === undefined || m === "ANY";
  return wild(x[2]) || wild(y[2]);
}
/** A gRPC call as the scanner records it: package.Service/Method, no leading slash. */
const GRPC_PATH = /^[A-Za-z_][\w.]*\/[A-Za-z_]\w*$/;
const EVENT_VIA = new Set(["event-bus", "pubsub", "mq"]);

function referenceFacts(r: BenchReference): Record<FactKind, string[]> {
  return {
    serves: (r.serves ?? []).map((s) => serveFact(s.type, s.method, s.path)),
    calls: (r.calls ?? []).map((c) => callFact(c.type, c.method, c.path)),
    stores: (r.stores ?? []).map((s) => table(s.table)),
    deploys: (r.deploys ?? []).map((d) => d.platform.toLowerCase()),
  };
}

/** What a scan's records say, as the same four kinds of fact (sorted, no repeats). */
export function benchFacts(records: CatalogRecord[]): Record<FactKind, string[]> {
  const out: Record<FactKind, Set<string>> = {
    serves: new Set(),
    calls: new Set(),
    stores: new Set(),
    deploys: new Set(),
  };
  for (const r of records) {
    const x = r as unknown as Record<string, string | undefined>;
    if (r.kind === "Endpoint")
      out.serves.add(serveFact(x.endpointType ?? "rest", x.method, x.pathOrTopic ?? ""));
    else if (r.kind === "Interface" && (x.direction ?? "outbound") !== "inbound") {
      const path = x.normalizedPath ?? "";
      const type = EVENT_VIA.has(x.via ?? "") ? "event" : GRPC_PATH.test(path) ? "grpc" : "rest";
      out.calls.add(callFact(type, x.method, path));
    } else if (r.kind === "Unresolved" && x.unresolvedKind === "http-call" && x.raw) {
      const m = /^([A-Z]+)\s+(.*)$/.exec(x.raw.trim());
      out.calls.add(m ? `${m[1]} ${normalizePath(m[2]!)}` : normalizePath(x.raw));
    } else if (r.kind === "Table" && x.name) out.stores.add(table(x.name));
    else if (r.kind === "Deployment" && x.platform) out.deploys.add(x.platform.toLowerCase());
  }
  const sorted = (s: Set<string>) => [...s].sort();
  return {
    serves: sorted(out.serves),
    calls: sorted(out.calls),
    stores: sorted(out.stores),
    deploys: sorted(out.deploys),
  };
}

export interface KindScore {
  found: number;
  /** In the reference, not in the scan. */
  missed: string[];
  /** In the scan, not in the reference. */
  wrong: string[];
  precision: number;
  recall: number;
}

export interface RepoScore {
  repo: string;
  commit: string;
  kinds: Partial<Record<FactKind, KindScore>>;
  total: { found: number; missed: number; wrong: number; precision: number; recall: number };
}

const ratio = (a: number, b: number) => (b === 0 ? 1 : a / b);

/** Score one repo's scan against its reference, for the kinds the reference covers. */
export function scoreRepo(ref: BenchReference, records: CatalogRecord[]): RepoScore {
  const want = referenceFacts(ref);
  const got = benchFacts(records);
  const kinds: Partial<Record<FactKind, KindScore>> = {};
  let found = 0;
  let missed = 0;
  let wrong = 0;
  for (const k of FACT_KINDS) {
    if (!ref.covers.includes(k)) continue;
    const w = new Set(want[k]);
    const g = new Set(got[k]);
    const hit = (x: string, among: Set<string>) =>
      among.has(x) || [...among].some((y) => sameFact(x, y));
    const f = [...w].filter((x) => hit(x, g)).length;
    const m = [...w].filter((x) => !hit(x, g)).sort();
    const x = [...g].filter((y) => !hit(y, w)).sort();
    kinds[k] = {
      found: f,
      missed: m,
      wrong: x,
      precision: ratio(f, f + x.length),
      recall: ratio(f, w.size),
    };
    found += f;
    missed += m.length;
    wrong += x.length;
  }
  return {
    repo: ref.repo,
    commit: ref.commit,
    kinds,
    total: {
      found,
      missed,
      wrong,
      precision: ratio(found, found + wrong),
      recall: ratio(found, found + missed),
    },
  };
}
