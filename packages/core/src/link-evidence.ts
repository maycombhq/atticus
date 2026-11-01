import { isMap, isSeq, LineCounter, parseDocument, stringify } from "yaml";
import { z } from "zod";
import type { CatalogRecord } from "./catalog.js";
import {
  basePathOf,
  routeScore,
  type FactJoin,
  type FactsJoinResult,
  type JoinRepo,
} from "./facts-join.js";
import type { EvidenceT } from "./schema/common.js";
import type { Fact, FactOf } from "./schema/facts.js";
import { urlHostPort } from "./schema/workspace.js";

/**
 * Links confirmed from outside the code (ADR 0151): contract files a consumer keeps (J3) and
 * traffic exports a person imported as aggregate counts (J4). Neither makes a link: the join
 * makes links from cited code. They add evidence and a flag to an Interface the join already
 * made, and say where the two disagree: a contract or traffic the join has no link for, a
 * contract naming another provider, a link no traffic used over the range.
 *
 * A contract or traffic never raises a guess (`inferred`) to verified: a guess stays a guess
 * until the code names the callee (ADR 0151 §3). Pure: the same join and evidence files give
 * the same marks and findings, whatever order they come in.
 */

/** An Interface a consumer's contract file (a Pact interaction, a consumer-side OpenAPI operation) confirms. */
export const CONFIRMED_BY_CONTRACT = "confirmed-by-contract";
/** An Interface a contract file names another provider for: a gap a person settles. */
export const CONTRACT_DISAGREES = "contract-disagrees";
/** An Interface an imported traffic export shows used over its range. */
export const SEEN_IN_TRAFFIC = "seen-in-traffic";

/** The flags this module writes, and takes off again before every write. */
export const LINK_EVIDENCE_FLAGS: ReadonlySet<string> = new Set([
  CONFIRMED_BY_CONTRACT,
  CONTRACT_DISAGREES,
  SEEN_IN_TRAFFIC,
]);
/** The flags that are evidence a link holds, never a gap (as `JOIN_HOW_FLAGS`). */
export const LINK_EVIDENCE_NOT_GAPS: ReadonlySet<string> = new Set([
  CONFIRMED_BY_CONTRACT,
  SEEN_IN_TRAFFIC,
]);
/** The `extractor` of the evidence this module adds, so a write takes the last write's off. */
export const CONTRACT_EVIDENCE = "atticus-contract@1";
export const TRAFFIC_EVIDENCE = "atticus-traffic@1";

// ---------------------------------------------------------------- the files

/** One request a consumer's contract file says it makes. */
export const ContractEntry = z.strictObject({
  format: z.enum(["pact", "openapi"]),
  /** The file, relative to the repo, with forward slashes, and the line of the request. */
  file: z.string().min(1),
  line: z.number().int().positive(),
  /** Pact's consumer and provider names, as written; an OpenAPI document's `info.title` as provider. */
  consumer: z.string().optional(),
  provider: z.string().optional(),
  /** An OpenAPI document's server hosts, which name the provider when a repo lists them. */
  hosts: z.array(z.string()).optional(),
  method: z.string().optional(),
  path: z.string().min(1),
});
export type ContractEntryT = z.infer<typeof ContractEntry>;

/**
 * The facts companion `<repo>.contracts.yaml` (ADR 0151): the contract files read in a repo's
 * checkout at the facts' commit by `atticus verify <repo> --write`, so every later write of any
 * repo reads the same entries without the checkout.
 */
export const ContractsFile = z.strictObject({
  schemaVersion: z.literal(1),
  repo: z.string().min(1),
  commit: z.string().optional(),
  entries: z.array(ContractEntry),
});
export type ContractsFileT = z.infer<typeof ContractsFile>;

/** One aggregate of an imported traffic export: never a raw row. */
export const TrafficRow = z.strictObject({
  /** The calling application as the export names it (an app or developer app name). */
  app: z.string().min(1),
  /** The component a person says the app is, when its name isn't one (set in review). */
  component: z.string().optional(),
  method: z.string().min(1),
  /** The path, normalised to the estate's route templates (`{id}` where nothing matched). */
  path: z.string().min(1),
  proxy: z.string().optional(),
  basepath: z.string().optional(),
  count: z.number().int().positive(),
});
export type TrafficRowT = z.infer<typeof TrafficRow>;

const IsoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** `evidence/traffic/<source>-<from>-<to>.yaml`: what an import kept, reviewed in a pull request. */
export const TrafficFile = z.strictObject({
  schemaVersion: z.literal(1),
  source: z.string().min(1),
  from: IsoDay,
  to: IsoDay,
  /** The export's SHA-256, so a reviewer can tell which file it came from without its rows. */
  inputSha256: z.string().regex(/^[0-9a-f]{64}$/),
  rows: z.array(TrafficRow),
});
export type TrafficFileT = z.infer<typeof TrafficFile>;

/** The file name a traffic aggregate is written under. */
export const trafficFileName = (f: Pick<TrafficFileT, "source" | "from" | "to">) =>
  `${f.source.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}-${f.from}-${f.to}.yaml`;

/** The canonical text of a traffic aggregate: keys in schema order, one row a block. */
export function trafficFileText(f: TrafficFileT): string {
  const rows = [...f.rows].sort(rowOrder).map((r) => ({
    app: r.app,
    ...(r.component ? { component: r.component } : {}),
    method: r.method,
    path: r.path,
    ...(r.proxy ? { proxy: r.proxy } : {}),
    ...(r.basepath ? { basepath: r.basepath } : {}),
    count: r.count,
  }));
  return stringify(
    {
      schemaVersion: 1,
      source: f.source,
      from: f.from,
      to: f.to,
      inputSha256: f.inputSha256,
      rows,
    },
    { lineWidth: 0 },
  );
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const rowOrder = (a: TrafficRowT, b: TrafficRowT) =>
  cmp(a.app, b.app) ||
  cmp(a.proxy ?? "", b.proxy ?? "") ||
  cmp(a.path, b.path) ||
  cmp(a.method, b.method);

/** A traffic file read back, each row with the line it starts on (what its evidence cites). */
export interface TrafficOnFile {
  /** Its path in the metarepo, forward slashes (`evidence/traffic/...`). */
  rel: string;
  file: TrafficFileT;
  lines: number[];
}

/** Read a traffic aggregate with its rows' lines; a problem when it isn't one. */
export function readTrafficFile(
  rel: string,
  text: string,
): { ok: true; traffic: TrafficOnFile } | { ok: false; message: string } {
  const lc = new LineCounter();
  let doc;
  try {
    doc = parseDocument(text, { lineCounter: lc });
  } catch (e) {
    return { ok: false, message: `${rel} isn't YAML: ${(e as Error).message}` };
  }
  if (doc.errors.length)
    return { ok: false, message: `${rel} isn't YAML: ${doc.errors[0]!.message}` };
  const parsed = TrafficFile.safeParse(doc.toJS());
  if (!parsed.success)
    return {
      ok: false,
      message: `${rel} isn't a traffic aggregate: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    };
  const seq = doc.get("rows");
  const lines = isSeq(seq)
    ? seq.items.map((it) => (isMap(it) && it.range ? lc.linePos(it.range[0]).line : 1))
    : [];
  return { ok: true, traffic: { rel, file: parsed.data, lines } };
}

// ---------------------------------------------------------------- the findings

/** A link end as a finding names it. */
export interface LinkRef {
  interface: string;
  from: string;
  to: string;
  method?: string;
  path: string;
}

/**
 * What a contract file says that the join doesn't: `provider-differs` (the consumer's request is
 * a link the join made to another component), `no-link` (the join has no link for it),
 * `unknown-provider` (the provider it names is no component or repo of the estate).
 */
export interface ContractFinding {
  reason: "provider-differs" | "no-link" | "unknown-provider";
  repo: string;
  /** file:line in the consumer's repo. */
  at: string;
  format: "pact" | "openapi";
  consumer: string;
  provider?: string;
  method?: string;
  path: string;
  /** The links the request matched (for `provider-differs`, `unknown-provider`). */
  links: LinkRef[];
  message: string;
}

/**
 * What a traffic export says that the join doesn't: `missed-link` (traffic no link carries),
 * `unknown-app` (an app named like no component: a person names it in the row's `component`),
 * `unseen-link` (a link the export covers that no traffic used over the range).
 */
export interface TrafficFinding {
  reason: "missed-link" | "unknown-app" | "unseen-link";
  /** The traffic file, and the row's line (not for `unseen-link`). */
  file: string;
  at?: string;
  range: { from: string; to: string };
  app?: string;
  component?: string;
  method?: string;
  path?: string;
  count?: number;
  link?: LinkRef;
  message: string;
}

/** A link the traffic showed, with how much and over what range. */
export interface TrafficSeen extends LinkRef {
  count: number;
  file: string;
  range: { from: string; to: string };
}

export interface LinkEvidenceResult {
  /** By Interface id: the flags and evidence to add. */
  marks: Record<string, { flags: string[]; evidence: EvidenceT[] }>;
  contracts: { entries: number; confirmed: LinkRef[]; findings: ContractFinding[] };
  traffic: { rows: number; seen: TrafficSeen[]; findings: TrafficFinding[] };
}

export interface LinkEvidenceInput {
  /** The whole estate's join (every repo with verified facts). */
  join: FactsJoinResult;
  repos: readonly JoinRepo[];
  contracts?: readonly ContractsFileT[];
  traffic?: readonly TrafficOnFile[];
}

type Call = FactOf<"call">;
type Entry = FactOf<"entry">;

/** A name as compared: letters and digits, lower case. */
const nameKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The best path score of a request against a join, or 0 (`routeScore`'s scale). */
function pathScore(path: string, paths: readonly string[]): number {
  let best = 0;
  for (const p of paths) {
    const s = routeScore(path, p);
    if (s > best) best = s;
  }
  // A context path in front of a template (a tail match) counts from two plain segments up.
  return best >= 2 ? best : 0;
}

const sameMethod = (a: string | undefined, b: string | undefined) => {
  const x = a?.toUpperCase();
  const y = b?.toUpperCase();
  return !x || !y || x === "ANY" || y === "ANY" || x === y;
};

/**
 * Mark the joins the contract files and traffic aggregates bear out, and list where they and the
 * join disagree (ADR 0151).
 */
export function linkEvidenceOf(input: LinkEvidenceInput): LinkEvidenceResult {
  const facts = new Map<string, Fact>();
  for (const r of input.repos) for (const f of r.facts) facts.set(`${r.repo}\u0000${f.id}`, f);
  const fact = (e: { repo: string; fact: string }) => facts.get(`${e.repo}\u0000${e.fact}`);

  // Names and hosts → components.
  const byName = new Map<string, string>();
  const byHost: { host: string; component: string }[] = [];
  const repoComponents = new Map<string, Set<string>>();
  const addComp = (repo: string, c: string) => {
    if (!repoComponents.has(repo)) repoComponents.set(repo, new Set());
    repoComponents.get(repo)!.add(c);
    if (!byName.has(nameKey(c))) byName.set(nameKey(c), c);
  };
  for (const r of [...input.repos].sort((a, b) => cmp(a.repo, b.repo))) {
    const main = r.component ?? r.repo;
    addComp(r.repo, main);
    if (!byName.has(nameKey(r.repo))) byName.set(nameKey(r.repo), main);
    for (const h of r.hosts ?? []) byHost.push({ host: h.toLowerCase(), component: main });
    for (const m of r.modules ?? []) {
      addComp(r.repo, m.component);
      for (const h of m.hosts) byHost.push({ host: h.toLowerCase(), component: m.component });
    }
    for (const f of r.facts) if (f.component) addComp(r.repo, f.component);
  }
  const joins = input.join.joins.filter((j) => j.how !== "topic");
  for (const j of joins) {
    addComp(j.call.repo, j.call.component);
    addComp(j.entry.repo, j.entry.component);
  }
  const resolve = (name: string | undefined) => (name ? byName.get(nameKey(name)) : undefined);
  const hostComponent = (url: string) => {
    const h = urlHostPort(url)?.host;
    return h ? byHost.find((x) => x.host.split(":")[0] === h)?.component : undefined;
  };

  const ref = (j: FactJoin): LinkRef => ({
    interface: j.interface,
    from: j.call.component,
    to: j.entry.component,
    ...(j.method ? { method: j.method } : {}),
    path: j.path,
  });
  /** The paths a request to a join may be written as: the call's, the first route's, the entry's. */
  const pathsOf = (j: FactJoin): string[] => {
    const out: string[] = [];
    const call = fact(j.call) as Call | undefined;
    if (call?.path) out.push(call.path);
    for (const h of j.gateway ?? []) {
      const e = fact(h.entry) as Entry | undefined;
      if (e?.path) out.push(e.path);
    }
    out.push(j.path);
    return out;
  };
  const methodOf = (j: FactJoin) => j.method ?? (fact(j.call) as Call | undefined)?.method;
  /** The joins from `from` (any of) a request matches, the best-scoring only. */
  const matching = (from: ReadonlySet<string>, method: string | undefined, path: string) => {
    let best = 0;
    let hit: FactJoin[] = [];
    for (const j of joins) {
      if (!from.has(j.call.component) || !sameMethod(method, methodOf(j))) continue;
      const s = pathScore(path, pathsOf(j));
      if (s === 0 || s < best) continue;
      if (s > best) {
        best = s;
        hit = [];
      }
      hit.push(j);
    }
    // One link per Interface, in id order.
    const seen = new Set<string>();
    return hit
      .filter((j) => (seen.has(j.interface) ? false : (seen.add(j.interface), true)))
      .sort((a, b) => cmp(a.interface, b.interface));
  };
  const reaches = (j: FactJoin, c: string) =>
    j.entry.component === c || (j.gateway ?? []).some((h) => h.entry.component === c);

  const marks = new Map<string, { flags: Set<string>; evidence: EvidenceT[] }>();
  const mark = (id: string, flag: string, ev?: EvidenceT) => {
    if (!marks.has(id)) marks.set(id, { flags: new Set(), evidence: [] });
    const m = marks.get(id)!;
    m.flags.add(flag);
    if (ev) m.evidence.push(ev);
  };
  const what = (method: string | undefined, path: string) =>
    method ? `${method.toUpperCase()} ${path}` : path;

  // ---- J3: contract files
  const confirmed = new Map<string, LinkRef>();
  const cFindings: ContractFinding[] = [];
  let entries = 0;
  for (const cf of [...(input.contracts ?? [])].sort((a, b) => cmp(a.repo, b.repo))) {
    const own = repoComponents.get(cf.repo) ?? new Set<string>();
    const sorted = [...cf.entries].sort((a, b) => cmp(a.file, b.file) || a.line - b.line);
    for (const e of sorted) {
      entries++;
      const named = resolve(e.consumer);
      const from = named ? new Set([named]) : own;
      const consumer = named ?? e.consumer ?? [...own].sort()[0] ?? cf.repo;
      const provider =
        resolve(e.provider) ?? (e.hosts ?? []).map(hostComponent).find((x) => !!x) ?? undefined;
      const at = `${e.file}:${e.line}`;
      const hits = matching(from, e.method, e.path);
      const base = {
        repo: cf.repo,
        at,
        format: e.format,
        consumer,
        ...(e.provider ? { provider: e.provider } : provider ? { provider } : {}),
        ...(e.method ? { method: e.method.toUpperCase() } : {}),
        path: e.path,
      };
      const where = `${e.format === "pact" ? "the Pact interaction" : "the consumer's OpenAPI operation"} ${what(e.method, e.path)} at ${cf.repo}/${at}`;
      if (!provider) {
        // An OpenAPI document that names no provider the estate has confirms nothing and says
        // nothing: a client spec lists operations the consumer may never call.
        if (e.format === "openapi") continue;
        cFindings.push({
          ...base,
          reason: "unknown-provider",
          links: hits.map(ref),
          message: `${where} names the provider ${e.provider ?? "(none)"}, which is no component or repo of the estate${hits.length ? `; the join links it to ${[...new Set(hits.map((j) => j.entry.component))].join(", ")}` : ""}`,
        });
        continue;
      }
      const ok = hits.filter((j) => reaches(j, provider));
      if (ok.length) {
        for (const j of ok) {
          mark(j.interface, CONFIRMED_BY_CONTRACT, {
            source: "spec",
            repo: cf.repo,
            path: e.file,
            line: e.line,
            ...(cf.commit && /^[0-9a-f]{7,64}$/.test(cf.commit) ? { commit: cf.commit } : {}),
            side: "caller",
            extractor: CONTRACT_EVIDENCE,
          });
          confirmed.set(j.interface, ref(j));
        }
        continue;
      }
      if (hits.length) {
        for (const j of hits) mark(j.interface, CONTRACT_DISAGREES);
        cFindings.push({
          ...base,
          reason: "provider-differs",
          links: hits.map(ref),
          message: `${where} is with ${provider}, but the join links ${consumer}'s call to ${[...new Set(hits.map((j) => j.entry.component))].join(", ")}`,
        });
        continue;
      }
      // A consumer-side OpenAPI operation the consumer never calls is not a finding.
      if (e.format === "openapi") continue;
      cFindings.push({
        ...base,
        reason: "no-link",
        links: [],
        message: `${where} is with ${provider}, but the join has no link from ${consumer} for it`,
      });
    }
  }

  // ---- J4: traffic aggregates
  const seen: TrafficSeen[] = [];
  const tFindings: TrafficFinding[] = [];
  let rows = 0;
  for (const t of [...(input.traffic ?? [])].sort((a, b) => cmp(a.rel, b.rel))) {
    const range = { from: t.file.from, to: t.file.to };
    const counts = new Map<string, { ref: LinkRef; count: number }>();
    const reachedTo = new Set<string>();
    t.file.rows.forEach((r, i) => {
      rows++;
      const line = t.lines[i] ?? 1;
      const at = `${t.rel}:${line}`;
      const base = {
        file: t.rel,
        at,
        range,
        app: r.app,
        method: r.method.toUpperCase(),
        path: r.path,
        count: r.count,
      };
      const component = resolve(r.component) ?? (r.component ? undefined : resolve(r.app));
      if (!component) {
        tFindings.push({
          ...base,
          reason: "unknown-app",
          ...(r.component ? { component: r.component } : {}),
          message: `${r.app} called ${what(r.method, r.path)} ${r.count} times (${range.from} to ${range.to}), and ${r.component ? `${r.component}, the component named for it,` : "its name"} is no component or repo of the estate: name its component in the row (component: <id>) at ${at}`,
        });
        return;
      }
      const hits = matching(new Set([component]), r.method, r.path);
      if (!hits.length) {
        tFindings.push({
          ...base,
          component,
          reason: "missed-link",
          message: `${component} (${r.app}) called ${what(r.method, r.path)} ${r.count} times (${range.from} to ${range.to}), and the join has no link for it: a call the facts don't have (${at})`,
        });
        return;
      }
      for (const j of hits) {
        mark(j.interface, SEEN_IN_TRAFFIC, {
          source: "export",
          path: t.rel,
          line,
          extractor: TRAFFIC_EVIDENCE,
        });
        const c = counts.get(j.interface) ?? { ref: ref(j), count: 0 };
        c.count += r.count;
        counts.set(j.interface, c);
        reachedTo.add(j.entry.component);
      }
    });
    for (const [, c] of [...counts].sort(([a], [b]) => cmp(a, b)))
      seen.push({ ...c.ref, count: c.count, file: t.rel, range });
    // The links this export covers: through a proxy or base path it has rows for, or, when it
    // names neither, into a component some of its traffic reached.
    const proxies = new Set(t.file.rows.flatMap((r) => (r.proxy ? [r.proxy.toLowerCase()] : [])));
    const bases = new Set(t.file.rows.flatMap((r) => (r.basepath ? [r.basepath] : [])));
    const covers = (j: FactJoin) => {
      if (!methodOf(j)) return false;
      if (!proxies.size && !bases.size) return reachedTo.has(j.entry.component);
      return (j.gateway ?? []).some((h) => {
        const e = fact(h.entry) as Entry | undefined;
        if (!e) return false;
        const proxy = e.handler?.split("/")[0]?.toLowerCase();
        return (proxy && proxies.has(proxy)) || bases.has(basePathOf(e));
      });
    };
    const unseen = new Map<string, FactJoin>();
    for (const j of joins) if (!counts.has(j.interface) && covers(j)) unseen.set(j.interface, j);
    for (const [, j] of [...unseen].sort(([a], [b]) => cmp(a, b)))
      tFindings.push({
        reason: "unseen-link",
        file: t.rel,
        range,
        link: ref(j),
        message: `${j.call.component} → ${j.entry.component} ${what(j.method, j.path)}: a link ${t.rel} covers that no traffic used from ${range.from} to ${range.to} (dead, or wrongly joined?)`,
      });
  }

  const out: LinkEvidenceResult["marks"] = {};
  for (const [id, m] of [...marks].sort(([a], [b]) => cmp(a, b)))
    out[id] = { flags: [...m.flags].sort(), evidence: m.evidence };
  return {
    marks: out,
    contracts: {
      entries,
      confirmed: [...confirmed.values()].sort((a, b) => cmp(a.interface, b.interface)),
      findings: cFindings,
    },
    traffic: { rows, seen, findings: tFindings },
  };
}

const isLinkEvidence = (e: EvidenceT) =>
  e.extractor === CONTRACT_EVIDENCE || e.extractor === TRAFFIC_EVIDENCE;

/**
 * The records without what an earlier write's contract and traffic evidence added: its flags and
 * evidence entries. A record left with no evidence at all (none could be) is dropped.
 */
export function stripLinkEvidence(records: readonly CatalogRecord[]): CatalogRecord[] {
  const out: CatalogRecord[] = [];
  for (const r of records) {
    const ev = r.evidence as EvidenceT[];
    const flags = r.flags ?? [];
    if (!ev.some(isLinkEvidence) && !flags.some((f) => LINK_EVIDENCE_FLAGS.has(f))) {
      out.push(r);
      continue;
    }
    const evidence = ev.filter((e) => !isLinkEvidence(e));
    if (!evidence.length) continue;
    const left = flags.filter((f) => !LINK_EVIDENCE_FLAGS.has(f));
    const { flags: _f, ...rest } = r as CatalogRecord & { flags?: string[] };
    out.push({ ...rest, ...(left.length ? { flags: left } : {}), evidence } as CatalogRecord);
  }
  return out;
}

/**
 * The records with the marks added: each marked Interface gets its flags (after its own) and
 * evidence (after its own, each line once). Its confidence is never changed (ADR 0151 §3).
 */
export function applyLinkEvidence(
  records: readonly CatalogRecord[],
  marks: LinkEvidenceResult["marks"],
): CatalogRecord[] {
  return stripLinkEvidence(records).map((r) => {
    const m = r.kind === "Interface" ? marks[r.id] : undefined;
    if (!m) return r;
    const flags = [...(r.flags ?? []), ...m.flags.filter((f) => !(r.flags ?? []).includes(f))];
    const key = (e: EvidenceT) => `${e.source}|${e.repo ?? ""}|${e.path ?? ""}|${e.line ?? ""}`;
    const have = new Set((r.evidence as EvidenceT[]).map(key));
    const add = m.evidence.filter((e) => (have.has(key(e)) ? false : (have.add(key(e)), true)));
    return {
      ...r,
      flags,
      evidence: [...(r.evidence as EvidenceT[]), ...add],
    } as CatalogRecord;
  });
}
