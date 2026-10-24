import { parse } from "yaml";
import { z } from "zod";
import { projectFacts, type CatalogRecord, type Fact } from "@maycombhq/core";

/**
 * The bench (revamp plan, Phase 1): public repos, each with a reference a person wrote by
 * reading the code, and a score of what a scan found, missed and got wrong. A reference is
 * written in plain facts, not Atticus's record ids, so it doesn't change when Atticus does:
 * what the repo serves, what it calls, which tables it stores and where it deploys, and (for
 * the references that cover them, ADR 0124 §6) the fields of its entries, calls and tables and
 * the config keys that name another system, a timeout or a flag.
 */

export const FACT_KINDS = ["serves", "calls", "stores", "deploys", "fields", "config"] as const;
export type FactKind = (typeof FACT_KINDS)[number];
/** The four kinds the readers' baseline was measured on (bench/README.md), kept apart to compare. */
export const BASE_KINDS = ["serves", "calls", "stores", "deploys"] as const;

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
    /**
     * A named value crossing a boundary: a top-level field of an entry's or a call's request or
     * response body (query parameters are request fields; path parameters are part of the path),
     * or a column of a table. The owner is written as in serves (`[type] [METHOD] path`), calls
     * or stores.
     */
    fields: z
      .array(
        z
          .strictObject({
            entry: z.string().min(1).optional(),
            call: z.string().min(1).optional(),
            table: z.string().min(1).optional(),
            side: z.enum(["request", "response", "message"]).optional(),
            name: z.string().min(1),
            type: z.string().optional(),
            required: z.boolean().optional(),
            at: At,
          })
          .superRefine((f, ctx) => {
            const owners = [f.entry, f.call, f.table].filter((x) => x !== undefined).length;
            if (owners !== 1)
              ctx.addIssue({
                code: "custom",
                message: "a field names exactly one of entry, call or table",
              });
            if (f.table === undefined && f.side === undefined)
              ctx.addIssue({
                code: "custom",
                path: ["side"],
                message: "a field of an entry or a call needs a side",
              });
          }),
      )
      .optional(),
    /** A config key naming another system (host, base URL, connection), a timeout or a flag. */
    config: z
      .array(
        z.strictObject({
          key: z.string().min(1),
          value: z.string().optional(),
          source: z.string().optional(),
          at: At,
        }),
      )
      .optional(),
    /**
     * Facts that are true but outside a kind's scope (a logging level is config, but not config
     * that names another system): patterns (`*` for any text) on the fact as the bench writes it.
     * A scanned or stated fact that matches one is neither found nor wrong.
     */
    ignore: z.partialRecord(z.enum(FACT_KINDS), z.array(z.string().min(1))).optional(),
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
/** A webhook receiver is an HTTP route: it compares as `rest` (the references have no webhook type). */
const serveFact = (type: string, m: string | undefined, path: string) => {
  const t = type === "webhook" ? "rest" : type;
  return HTTP.has(t) ? `${t} ${method(m)}${httpPath(path)}` : `${t} ${path.trim()}`;
};
const callFact = (type: string, m: string | undefined, path: string) =>
  type === "rest" ? `${method(m)}${httpPath(path)}` : `${type} ${path.trim()}`;

/**
 * Two facts match when they are equal, or when they differ only in the HTTP method and one
 * of them has none or ANY (a route that answers every method). Fields match when their owners
 * do and their sides and names are equal.
 */
const ANY_METHOD = /^((?:[a-z-]+ )?)(?:([A-Z]+) )?(\/.*)$/;
function sameFact(a: string, b: string): boolean {
  if (a === b) return true;
  const fa = a.indexOf(" | ");
  const fb = b.indexOf(" | ");
  if (fa >= 0 || fb >= 0) {
    if (fa < 0 || fb < 0 || a.slice(fa) !== b.slice(fb)) return false;
    const [ka, ...oa] = a.slice(0, fa).split(" ");
    const [kb, ...ob] = b.slice(0, fb).split(" ");
    return ka === kb && sameFact(oa.join(" "), ob.join(" "));
  }
  const x = ANY_METHOD.exec(a);
  const y = ANY_METHOD.exec(b);
  if (!x || !y || x[1] !== y[1] || x[3] !== y[3]) return false;
  const wild = (m: string | undefined) => m === undefined || m === "ANY";
  return wild(x[2]) || wild(y[2]);
}
/** A gRPC call as the scanner records it: package.Service/Method, no leading slash. */
const GRPC_PATH = /^[A-Za-z_][\w.]*\/[A-Za-z_]\w*$/;
const EVENT_VIA = new Set(["event-bus", "pubsub", "mq"]);

/**
 * A field's name as compared: lower case, underscores and hyphens left out (first_name is
 * firstName), the planner's way of folding names.
 */
const fieldName = (n: string) => n.toLowerCase().replace(/[_-]/g, "");
/** A config key as compared: lower case, `:` and `__` (.NET's section separators) as dots. */
const configKey = (k: string) => k.trim().toLowerCase().replace(/__|:/g, ".");

/** An owner as references write it: `[type] [METHOD] path`; type rest when left out. */
function ownerParts(text: string): { type?: string; method?: string; path: string } {
  const m = /^(?:([a-z][a-z-]*) )?(?:([A-Z]+) )?(.+)$/.exec(text.trim())!;
  return {
    ...(m[1] ? { type: m[1] } : {}),
    ...(m[2] ? { method: m[2] } : {}),
    path: m[3]!,
  };
}

/**
 * An entry as the bench compares it, from `[type] [METHOD] path` (type rest when left out):
 * `rest POST /owners/{}`, `grpc pkg.Service/Method`, `screen /owners/{id}/pets/add`.
 */
export function entryKey(text: string): string {
  const o = ownerParts(text);
  return serveFact(o.type ?? "rest", o.method, o.path);
}

/** A field fact: `<owner kind> <owner fact> | [side] <name>`; a column has no side. */
const fieldFact = (owner: string, side: string | undefined, name: string) =>
  `${owner} | ${side ? `${side} ` : ""}${fieldName(name)}`;

function referenceFacts(r: BenchReference): Record<FactKind, string[]> {
  return {
    serves: (r.serves ?? []).map((s) => serveFact(s.type, s.method, s.path)),
    calls: (r.calls ?? []).map((c) => callFact(c.type, c.method, c.path)),
    stores: (r.stores ?? []).map((s) => table(s.table)),
    deploys: (r.deploys ?? []).map((d) => d.platform.toLowerCase()),
    fields: (r.fields ?? []).map((f) => {
      if (f.table !== undefined) return fieldFact(`column ${table(f.table)}`, undefined, f.name);
      if (f.entry !== undefined) {
        const o = ownerParts(f.entry);
        return fieldFact(`entry ${serveFact(o.type ?? "rest", o.method, o.path)}`, f.side, f.name);
      }
      const o = ownerParts(f.call!);
      return fieldFact(`call ${callFact(o.type ?? "rest", o.method, o.path)}`, f.side, f.name);
    }),
    config: (r.config ?? []).map((c) => configKey(c.key)),
  };
}

/**
 * A call the facts projection left unresolved (no target named), from its raw text
 * (`[METHOD] [host or base] path`): gRPC as Service/Method, a name with no slash as an event,
 * the rest as REST.
 */
function unresolvedCall(raw: string, soap = false): string {
  const words = raw.trim().split(/\s+/);
  const m = /^[A-Z]+$/.test(words[0] ?? "") && words.length > 1 ? words.shift() : undefined;
  const path = words.at(-1) ?? "";
  if (soap) return callFact("soap", undefined, path.replace(/^\/+/, ""));
  if (GRPC_PATH.test(path)) return callFact("grpc", undefined, path);
  if (!path.includes("/")) return callFact("event", undefined, path);
  return callFact("rest", m, words.join(" "));
}

function interfaceCall(x: Record<string, string | undefined>, soap = false): string {
  const path = x.normalizedPath ?? "";
  if (soap) return callFact("soap", undefined, path.replace(/^\/+/, ""));
  const type = EVENT_VIA.has(x.via ?? "") ? "event" : GRPC_PATH.test(path) ? "grpc" : "rest";
  return callFact(type, x.method, path);
}

/** The side a Schema record is of, from its id (`<owner>.<side>`, as the facts projection names it). */
const SIDE_OF_SCHEMA = /\.(request|response|message)$/;

/** What a scan's records say, as the same kinds of fact (sorted, no repeats). */
export function benchFacts(
  records: CatalogRecord[],
  /** Ids of the call records that are SOAP calls (a facts file says so; C1 has no protocol). */
  soap: ReadonlySet<string> = new Set(),
): Record<FactKind, string[]> {
  const out = Object.fromEntries(FACT_KINDS.map((k) => [k, new Set<string>()])) as Record<
    FactKind,
    Set<string>
  >;
  const byId = new Map(records.map((r) => [r.id, r] as const));
  /** The owner a Schema's ref names, as the reference writes it. */
  const ownerOf = (id: string): string | undefined => {
    const o = byId.get(id) as unknown as Record<string, string | undefined> | undefined;
    if (!o) return undefined;
    if (o.kind === "Endpoint")
      return `entry ${serveFact(o.endpointType ?? "rest", o.method, o.pathOrTopic ?? "")}`;
    if (o.kind === "Interface") return `call ${interfaceCall(o, soap.has(id))}`;
    if (o.kind === "Unresolved" && o.raw) return `call ${unresolvedCall(o.raw, soap.has(id))}`;
    return undefined;
  };
  for (const r of records) {
    const x = r as unknown as Record<string, string | undefined>;
    if (r.kind === "Endpoint")
      out.serves.add(serveFact(x.endpointType ?? "rest", x.method, x.pathOrTopic ?? ""));
    else if (r.kind === "Interface" && (x.direction ?? "outbound") !== "inbound")
      out.calls.add(interfaceCall(x, soap.has(r.id)));
    else if (r.kind === "Unresolved" && x.unresolvedKind === "http-call" && x.raw) {
      const m = /^([A-Z]+)\s+(.*)$/.exec(x.raw.trim());
      out.calls.add(m ? `${m[1]} ${normalizePath(m[2]!)}` : normalizePath(x.raw));
    } else if (r.kind === "Unresolved" && x.unresolvedKind === "call" && x.raw)
      out.calls.add(unresolvedCall(x.raw, soap.has(r.id)));
    else if (r.kind === "Table" && x.name) out.stores.add(table(x.name));
    else if (r.kind === "Deployment" && x.platform) out.deploys.add(x.platform.toLowerCase());
    else if (r.kind === "Column" && x.name && x.table) {
      const t = byId.get(x.table) as unknown as { name?: string } | undefined;
      const tableName = t?.name ?? x.table.split(".").pop()!;
      out.fields.add(fieldFact(`column ${table(tableName)}`, undefined, x.name));
    } else if (r.kind === "Schema" && x.ref) {
      const owner = ownerOf(x.ref);
      if (!owner) continue;
      const side = SIDE_OF_SCHEMA.exec(r.id)?.[1] ?? "request";
      for (const f of (r as unknown as { fields: { name: string }[] }).fields)
        out.fields.add(fieldFact(owner, side, f.name));
    } else if (r.kind === "Setting" && x.key && x.settingKind !== "schedule")
      // A schedule is an entry the readers keep as a setting (ADR 0040), not a config key.
      out.config.add(configKey(x.key));
  }
  return Object.fromEntries(FACT_KINDS.map((k) => [k, [...out[k]].sort()])) as Record<
    FactKind,
    string[]
  >;
}

/** A fact the AI verify step (ADR 0082) flagged, in its own terms. */
export interface FlaggedFact {
  kind: "entry-point" | "call" | "table" | "deployment" | "other";
  method?: string;
  name: string;
}

export interface VerifierScore {
  /** Misses flagged; scored when the reference covers the kind; agreed when the reference has it. */
  missed: { flagged: number; scored: number; agreed: number };
  /** Wrong records flagged; agreed when the reference doesn't have the record's fact. */
  wrong: { flagged: number; scored: number; agreed: number };
  /** Agreed over scored, both together; 1 when nothing could be scored. */
  precision: number;
}

/** A flagged fact as the reference writes it, or undefined when the reference can't say. */
function flaggedFact(ref: BenchReference, f: FlaggedFact): [FactKind, string] | undefined {
  const k: FactKind | undefined =
    f.kind === "entry-point"
      ? "serves"
      : f.kind === "call"
        ? "calls"
        : f.kind === "table"
          ? "stores"
          : f.kind === "deployment"
            ? "deploys"
            : undefined;
  if (!k || !ref.covers.includes(k)) return undefined;
  if (k === "stores") return [k, table(f.name)];
  if (k === "deploys") return [k, f.name.toLowerCase()];
  if (!/\//.test(f.name)) return undefined;
  return [
    k,
    k === "serves" ? serveFact("rest", f.method, f.name) : callFact("rest", f.method, f.name),
  ];
}

/**
 * The verifier's precision on one repo (ADR 0082): of the misses and wrong records it flagged
 * that the reference can judge, how many the reference agrees with.
 */
export function scoreVerifier(
  ref: BenchReference,
  flagged: { missed: FlaggedFact[]; wrong: FlaggedFact[] },
): VerifierScore {
  const want = referenceFacts(ref);
  const has = (k: FactKind, x: string) => want[k].some((y) => sameFact(x, y));
  const count = (items: FlaggedFact[], agrees: (k: FactKind, x: string) => boolean) => {
    let scored = 0;
    let agreed = 0;
    for (const f of items) {
      const fact = flaggedFact(ref, f);
      if (!fact) continue;
      scored++;
      if (agrees(...fact)) agreed++;
    }
    return { flagged: items.length, scored, agreed };
  };
  const missed = count(flagged.missed, has);
  const wrong = count(flagged.wrong, (k, x) => !has(k, x));
  return {
    missed,
    wrong,
    precision: ratio(missed.agreed + wrong.agreed, missed.scored + wrong.scored),
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

export interface BenchTotal {
  found: number;
  missed: number;
  wrong: number;
  precision: number;
  recall: number;
}

export interface RepoScore {
  repo: string;
  commit: string;
  kinds: Partial<Record<FactKind, KindScore>>;
  /** Every kind the reference covers. */
  total: BenchTotal;
  /** Only serves, calls, stores and deploys: the kinds the readers' baseline is measured on. */
  base: BenchTotal;
}

const ratio = (a: number, b: number) => (b === 0 ? 1 : a / b);

/** A pattern of a reference's ignore list (`*` for any text) as a test on a fact. */
const ignored = (patterns: string[] | undefined) => {
  const res = (patterns ?? []).map(
    (p) =>
      new RegExp(
        `^${p
          .toLowerCase()
          .split("*")
          .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*")}$`,
      ),
  );
  return (fact: string) => res.some((re) => re.test(fact.toLowerCase()));
};

function totalOf(
  kinds: Partial<Record<FactKind, KindScore>>,
  which: readonly FactKind[],
): BenchTotal {
  let found = 0;
  let missed = 0;
  let wrong = 0;
  for (const k of which) {
    const s = kinds[k];
    if (!s) continue;
    found += s.found;
    missed += s.missed.length;
    wrong += s.wrong.length;
  }
  return {
    found,
    missed,
    wrong,
    precision: ratio(found, found + wrong),
    recall: ratio(found, found + missed),
  };
}

/** Score one repo's scan against its reference, for the kinds the reference covers. */
export function scoreRepo(
  ref: BenchReference,
  records: CatalogRecord[],
  soap: ReadonlySet<string> = new Set(),
): RepoScore {
  const want = referenceFacts(ref);
  const got = benchFacts(records, soap);
  const kinds: Partial<Record<FactKind, KindScore>> = {};
  for (const k of FACT_KINDS) {
    if (!ref.covers.includes(k)) continue;
    const out = ignored(ref.ignore?.[k]);
    const w = new Set(want[k]);
    const g = new Set(got[k]);
    const hit = (x: string, among: Set<string>) =>
      among.has(x) || [...among].some((y) => sameFact(x, y));
    const f = [...w].filter((x) => hit(x, g)).length;
    const m = [...w].filter((x) => !hit(x, g)).sort();
    const x = [...g].filter((y) => !hit(y, w) && !out(y)).sort();
    kinds[k] = {
      found: f,
      missed: m,
      wrong: x,
      precision: ratio(f, f + x.length),
      recall: ratio(f, w.size),
    };
  }
  return {
    repo: ref.repo,
    commit: ref.commit,
    kinds,
    total: totalOf(kinds, FACT_KINDS),
    base: totalOf(kinds, BASE_KINDS),
  };
}

// ---------------------------------------------------------------- an assistant's facts

export interface FactsScore extends RepoScore {
  facts: {
    total: number;
    /** Facts some check confirmed (the line check, a sample or a person). */
    verified: number;
    byKind: Record<Fact["kind"], number>;
    /**
     * What the score leaves out: screens (no reference lists a UI's routes as served), the
     * fields of screens, and flows (scored against bench/flows, not here).
     */
    left: { screens: number; screenFields: number; flows: number };
  };
  /** What the projection refused or couldn't join (a dangling reference), as it said it. */
  issues: { factId?: string; code: string; message: string }[];
}

/**
 * Score an assistant's facts file (ADR 0124) against a bench reference: the facts are projected
 * into C1 with `projectFacts` and scored with the same matcher and the same found, missed and
 * wrong as a reader's scan (`scoreRepo`), so the numbers compare with the readers' baseline.
 * Facts written for another commit than the reference's are refused.
 */
export function scoreFacts(ref: BenchReference, facts: readonly Fact[]): FactsScore {
  const other = facts.find((f) => !ref.commit.startsWith(f.commit));
  if (other)
    throw new Error(
      `The fact ${other.id} is of commit ${other.commit}; the reference is of ${ref.commit}.`,
    );
  const screens = new Set(
    facts.filter((f) => f.kind === "entry" && f.entryType === "screen").map((f) => f.id),
  );
  const screenFields = facts.filter(
    (f) => f.kind === "field" && (screens.has(f.owner) || f.side === "screen"),
  );
  const leftOut = new Set(screenFields.map((f) => f.id));
  const kept = facts.filter((f) => !screens.has(f.id) && !leftOut.has(f.id) && f.kind !== "flow");
  const { records, issues, ids } = projectFacts(kept);
  const soap = new Set(
    kept.flatMap((f) =>
      f.kind === "call" && f.callType === "soap" && ids[f.id] ? [ids[f.id]!] : [],
    ),
  );
  const byKind = { entry: 0, call: 0, store: 0, field: 0, deploy: 0, config: 0, flow: 0 };
  for (const f of facts) byKind[f.kind]++;
  return {
    ...scoreRepo(ref, records, soap),
    facts: {
      total: facts.length,
      verified: facts.filter((f) => f.verified !== "none").length,
      byKind,
      left: {
        screens: screens.size,
        screenFields: screenFields.length,
        flows: byKind.flow,
      },
    },
    // A call with no target is normal before the estate join; it is still scored.
    issues: issues
      .filter((i) => i.code !== "unresolved-target")
      .map((i) => ({
        ...(i.factId ? { factId: i.factId } : {}),
        code: i.code,
        message: i.message,
      })),
  };
}
