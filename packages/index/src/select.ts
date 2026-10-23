import { createHash } from "node:crypto";
import type { CatalogIndex } from "./catalog-index.js";
import { endpointName, foldName } from "./sources.js";
import { namesIn } from "./store.js";

/**
 * Search and context selection over the index (ADR 0107 points 2 and 3), without a model:
 *
 * - **search**: FTS5 with BM25, names weighted 10, ids 8, prose 1.
 * - **selectContext**: seeds (ids and names the input uses, exactly; the top search hits, the
 *   title's words weighted up), a bounded walk of the links (2 hops by default, a fan-out cap,
 *   the kinds the step asks for), a score (text × 0.5 a hop × the kind's weight × 1.2 for a
 *   verified record), then the fit: full detail for the top, one line for the next, within the
 *   budget; what was left out is listed by id and score.
 *
 * The same index and input select the same context: every order is broken by key, and the
 * candidates are cached under the input's hash and the index's version. What the input names
 * that the index has nothing for is returned as `unknown` (for questions to a person, later).
 */

export interface SearchOptions {
  /** Only nodes of these kinds (System, Flow, ProcessDefinition, WikiSection...). */
  kinds?: string[];
  limit?: number;
}

export interface SearchHit {
  key: string;
  kind: string;
  id: string;
  name: string;
  file: string;
  /** BM25, higher is better. */
  score: number;
}

const STOP = new Set(
  (
    "the and for with from that this into onto over under than then them they their there these those " +
    "what when where which while who whom whose why how are was were been being has have had having " +
    "not but can could should would will shall may might must its it's our ours your yours his her " +
    "out off per via all any each every some such only own same other more most less least very just " +
    "also too both either neither nor yet one two old use used uses using make makes made does done " +
    "get gets got let lets about after before again against because below between during above upon " +
    "here once until within without through scope out-of-scope problem outcome open questions"
  ).split(/\s+/),
);

/** The words a search looks for: lower case, three letters or more, common words left out. */
export function queryWords(text: string, max = 200): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/[a-z0-9]+/g)) {
    const w = m[0];
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

export function searchIndex(ix: CatalogIndex, text: string, o: SearchOptions = {}): SearchHit[] {
  const words = queryWords(text);
  if (!words.length) return [];
  const match = words.map((w) => `"${w}"`).join(" OR ");
  const kinds = o.kinds?.length ? o.kinds : undefined;
  const rows = prep(
    ix,
    `SELECT f.key AS key, n.kind AS kind, n.id AS id, n.name AS name, n.file AS file,
              bm25(fts, 0.0, 10.0, 8.0, 1.0) AS rank
       FROM fts f JOIN nodes n ON n.key = f.key
       WHERE fts MATCH ?${kinds ? ` AND n.kind IN (${kinds.map(() => "?").join(", ")})` : ""}
       ORDER BY rank, f.key LIMIT ?`,
  ).all(match, ...(kinds ?? []), o.limit ?? 20) as (Omit<SearchHit, "score"> & {
    rank: number;
  })[];
  return rows.map(({ rank, ...r }) => ({ ...r, score: round(-rank) }));
}

/** Statements, prepared once per open index. */
const statements = new WeakMap<object, Map<string, ReturnType<CatalogIndex["db"]["prepare"]>>>();
function prep(ix: CatalogIndex, sql: string): ReturnType<CatalogIndex["db"]["prepare"]> {
  let m = statements.get(ix.db);
  if (!m) statements.set(ix.db, (m = new Map()));
  let st = m.get(sql);
  if (!st) m.set(sql, (st = ix.db.prepare(sql)));
  return st;
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

export interface GraphNodeRow {
  key: string;
  kind: string;
  id: string;
  grp: string;
  name: string;
  file: string;
  verified: boolean;
  line: string;
  detail: string;
  /** The record or flow as parsed, when the node is one. */
  json?: unknown;
  /** A person's verdict on a knowledge item: verified, corrected or rejected. */
  review?: string;
}

interface RawNode {
  key: string;
  kind: string;
  id: string;
  grp: string;
  name: string;
  file: string;
  verified: number;
  line: string;
  detail: string;
  json: string | null;
  review: string | null;
}

const NODE_SQL = `SELECT n.key, n.kind, n.id, n.grp, n.name, n.file, n.verified, n.line, n.detail, n.json,
  (SELECT r.verdict FROM reviews r WHERE r.item = n.id ORDER BY r.at DESC, r.file LIMIT 1) AS review
  FROM nodes n`;

function toNode(r: RawNode): GraphNodeRow {
  return {
    key: r.key,
    kind: r.kind,
    id: r.id,
    grp: r.grp,
    name: r.name,
    file: r.file,
    verified: r.verified === 1 || r.review === "verified" || r.review === "corrected",
    line: r.line,
    detail: r.detail,
    ...(r.json ? { json: JSON.parse(r.json) as unknown } : {}),
    ...(r.review ? { review: r.review } : {}),
  };
}

export function nodesById(ix: CatalogIndex, id: string): GraphNodeRow[] {
  return (
    prep(ix, `${NODE_SQL} WHERE n.id = ? ORDER BY n.grp, n.kind`).all(id) as unknown as RawNode[]
  ).map(toNode);
}

function nodeByKey(ix: CatalogIndex, key: string): GraphNodeRow | undefined {
  const r = prep(ix, `${NODE_SQL} WHERE n.key = ?`).get(key) as unknown as RawNode | undefined;
  return r ? toNode(r) : undefined;
}

export interface NodeLink {
  /** out: this node links to the other; in: the other links to this node. */
  dir: "out" | "in";
  key: string;
  kind: string;
  id: string;
  type: string;
  /** How the link was made: a field, the placement, a need, a mention by name or alias. */
  how: string;
}

/** A node's links, both ways, resolved to nodes; sorted. */
export function linksOf(ix: CatalogIndex, key: string): NodeLink[] {
  const self = prep(ix, "SELECT id FROM nodes WHERE key = ?").get(key) as
    { id: string } | undefined;
  if (!self) return [];
  const out = prep(
    ix,
    `SELECT DISTINCT d.key AS key, d.kind AS kind, d.id AS id, l.type AS type, l.how AS how
       FROM links l JOIN nodes d ON d.id = l.to_ref
       WHERE l.from_key = ? AND l.by = 'id' AND d.key != l.from_key
       UNION
       SELECT DISTINCT d.key, d.kind, d.id, l.type, l.how
       FROM links l JOIN names m ON m.name = l.to_ref JOIN nodes d ON d.id = m.id
       WHERE l.from_key = ? AND l.by = 'name' AND d.key != l.from_key`,
  ).all(key, key) as unknown as Omit<NodeLink, "dir">[];
  const inn = prep(
    ix,
    `SELECT DISTINCT d.key AS key, d.kind AS kind, d.id AS id, l.type AS type, l.how AS how
       FROM links l JOIN nodes d ON d.key = l.from_key
       WHERE l.by = 'id' AND l.to_ref = ? AND l.from_key != ?
       UNION
       SELECT DISTINCT d.key, d.kind, d.id, l.type, l.how
       FROM names m JOIN links l ON l.by = 'name' AND l.to_ref = m.name JOIN nodes d ON d.key = l.from_key
       WHERE m.id = ? AND l.from_key != ?`,
  ).all(self.id, key, self.id, key) as unknown as Omit<NodeLink, "dir">[];
  const all: NodeLink[] = [
    ...out.map((l) => ({ dir: "out" as const, ...l })),
    ...inn.map((l) => ({ dir: "in" as const, ...l })),
  ];
  return all.sort(
    (a, b) => cmp(a.key, b.key) || cmp(a.dir, b.dir) || cmp(a.type, b.type) || cmp(a.how, b.how),
  );
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- selection

export interface ContextInput {
  /** What the step reads: its brief, its placement, its target flows. */
  text: string;
  /** The title, whose words weigh more. */
  title?: string;
  /** Ids the step already knows it needs (seeds, exact). */
  ids?: string[];
}

export interface SelectOptions {
  /** Tokens for the selected context (characters ÷ 4, as buildContextPack counts). */
  budget: number;
  /** The kinds to return. Default: every kind. */
  kinds?: string[];
  /** Only nodes of these groups: catalog, knowledge, flow, change, question, wiki, org-pack. Default: every group. */
  groups?: string[];
  /** The kinds the walk goes through. Default: every kind. */
  through?: string[];
  /** A weight per kind (default 1). */
  kindWeights?: Record<string, number>;
  /** How far the walk goes from a seed. Default 2. */
  hops?: number;
  /** At most this many links followed from one node. Default 24. */
  fanout?: number;
  /** Search hits taken as seeds. Default 30. */
  searchLimit?: number;
  /** The share of the budget for full detail; the rest goes to one line each. Default 0.6. */
  fullShare?: number;
  /** At most this many in full. */
  maxFull?: number;
  /** Candidates below this score are not kept. Default 0.1. */
  minScore?: number;
  /** Ids never returned (the walk still goes through them): the step's own change, say. */
  exclude?: string[];
  /** Keep knowledge items a person rejected. Default false: plans and answers leave them out. */
  includeRejected?: boolean;
  /** How a node is written: full or in one line. Undefined: the index's own text. */
  render?: (n: GraphNodeRow, level: "full" | "line") => string | undefined;
  /** The sources' classification. Default internal. */
  classification?: string;
  /** The highest source's priority; the rest count down from it. Default 50. */
  priority?: number;
  /** Prefix of the sources' ids. Default ctx-. */
  idPrefix?: string;
  /** The heading of the one-line source. */
  linesHeading?: string;
}

/** A source ready for buildContextPack (packages/ai), with its priority. */
export interface ContextSource {
  id: string;
  kind: "catalog" | "document";
  origin: string;
  text: string;
  classification: string;
  priority: number;
}

export interface Picked {
  key: string;
  kind: string;
  id: string;
  score: number;
  level: "full" | "line";
  file: string;
  /** Why it was picked: named in the input, a search hit, or the link it was reached by. */
  via: string;
}

export interface ContextSelection {
  sources: ContextSource[];
  picked: Picked[];
  /** Candidates that didn't fit, by score: a person can see them, the model can ask for them. */
  leftOut: { id: string; kind: string; score: number }[];
  /** Names in the input the index has nothing for. */
  unknown: string[];
  tokens: number;
  /** The index version the selection was made on. */
  version: string;
  cached: boolean;
}

interface Candidate {
  key: string;
  kind: string;
  id: string;
  score: number;
  via: string;
}

const GROUP_ORDER = ["catalog", "flow", "knowledge", "change", "question", "wiki", "org-pack"];

/** Words that say what an exactly named node is, added to the search: a vendor, a product. */
function describe(n: GraphNodeRow): string[] {
  const x = (n.json ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  for (const f of ["boundary", "partyKind", "productKind"])
    if (typeof x[f] === "string") out.push(String(x[f]).replace(/-/g, " "));
  if (n.grp === "org-pack") {
    const m = /\(([a-z-]+)\)/.exec(n.line);
    if (m) out.push(m[1]!);
  }
  return out;
}

function namesMap(ix: CatalogIndex): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of prep(ix, "SELECT DISTINCT name, id FROM names ORDER BY name, id").all() as {
    name: string;
    id: string;
  }[]) {
    const l = out.get(r.name) ?? [];
    l.push(r.id);
    out.set(r.name, l);
  }
  return out;
}

/** "POST /a/{id}" in a text → "post /a/{}", the way endpoints are named. */
function endpointsIn(text: string): string[] {
  return [...text.matchAll(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[^\s`"'),;]*)/g)].map(
    (m) => endpointName(m[1]!, m[2]!.replace(/[.:]+$/, "")),
  );
}

/**
 * Words that are not part of a name when capitalised: small words, days and months, the words
 * of a Given/When/Then or a user story, and the headings a brief has.
 */
const NOT_NAME = new Set([
  ...STOP,
  ..."a an and as at be but by do if in is it me my no of on or so to up us we i".split(" "),
  ..."monday tuesday wednesday thursday friday saturday sunday".split(" "),
  ..."january february march april june july august september october november december".split(" "),
  ..."given when then customer user story stories acceptance criteria scenario feature background".split(
    " ",
  ),
  ..."summary notes note risks assumptions dependencies definition ready release review rollout".split(
    " ",
  ),
]);

/** A phrase that starts with one of these is a Given/When/Then or a user story, not a name. */
const STEP_WORDS = new Set(["given", "when", "then", "and", "but", "as", "if"]);

/** A first word of a sentence that tells someone to do something: not part of the name after it. */
const VERBS = new Set(
  "ask send call use read run see check add make keep let show put move hold score place write open close update remove raise talk tell email notify contact route post fetch store reserve refuse".split(
    " ",
  ),
);

/** Words a name may end with that don't change what it names: Northwind Pay API is Northwind Pay. */
const GENERIC = new Set(
  "api apis service services system systems team app apps application platform portal ui ux gateway database db store queue topic site module library sdk client server backend frontend web mobile integration endpoint endpoints".split(
    " ",
  ),
);

/** A file name in backticks (notes.md, OrderController.java), not a name. */
const FILE =
  /\.(md|markdown|ya?ml|json|java|kt|ts|tsx|js|mjs|py|go|cs|rb|sql|xml|txt|csv|html?|properties|sh|toml|ini|cfg)$/i;

/** Title Case: most words of the line capitalised, as in a heading; its capitals say nothing. */
function titleCase(line: string): boolean {
  const words = line.match(/[A-Za-z][A-Za-z0-9'-]*/g) ?? [];
  if (words.length < 3) return false;
  return words.filter((w) => /^[A-Z]/.test(w)).length / words.length > 0.6;
}

/**
 * Names the input uses that might be systems, vendors, components or endpoints: names in
 * backticks (an id like forge-hold-store, or a capitalised name; not a field, a file or a
 * command), runs of capitalised words in a sentence (not in a heading or a Title Case line, cut
 * at the small words, without a sentence's first verb, and not a Given/When/Then), and endpoints.
 */
function nameCandidates(text: string): string[] {
  const out = new Set<string>();
  const lines = text.split(/\r?\n/).filter((l) => !/^\s*#/.test(l) && !/^\s*<!--/.test(l));
  const body = lines.join("\n");
  for (const m of body.matchAll(/`([^`\n]{2,60})`/g)) {
    const t = m[1]!.trim();
    if (/^(GET|POST|PUT|PATCH|DELETE)\s+\//.test(t)) continue; // taken as an endpoint below
    const id = /^[a-z0-9]+(?:[-.][a-z0-9]+)+$/.test(t) && !FILE.test(t);
    const name = /^[A-Z][A-Za-z0-9]*(?: [A-Z][A-Za-z0-9]*){0,3}$/.test(t);
    if (id || name) out.add(t);
  }
  // A paragraph's lines read as one, so a name can run over a line break; a Title Case line is out.
  const paragraphs: string[] = [];
  let para: string[] = [];
  for (const l of [...lines, ""]) {
    if (!l.trim() || titleCase(l)) {
      if (para.length) paragraphs.push(para.join(" "));
      para = [];
    } else para.push(l.trim());
  }
  for (const line of paragraphs) {
    for (const m of line.matchAll(/\b([A-Z][A-Za-z0-9]+(?:[ -][A-Z][A-Za-z0-9]+)+)\b/g)) {
      const words = m[1]!.split(/[ -]/);
      if (STEP_WORDS.has(words[0]!.toLowerCase())) continue;
      // At a sentence's start, a verb is the sentence's, not the name's: "Ask Quillfeather Risk".
      const before = line.slice(0, m.index).trimEnd();
      const starts = before === "" || /[.!?:;]$/.test(before);
      if (starts && VERBS.has(words[0]!.toLowerCase())) words.shift();
      // Cut at the small words: "On Monday In October" is no name.
      let run: string[] = [];
      const flush = () => {
        if (run.length >= 2) out.add(run.join(" "));
        run = [];
      };
      for (const w of words) {
        if (NOT_NAME.has(w.toLowerCase())) flush();
        else run.push(w);
      }
      flush();
    }
  }
  for (const m of body.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s`"'),;]*)/g))
    out.add(`${m[1]} ${m[2]!.replace(/[.:]+$/, "")}`);
  return [...out];
}

/**
 * Whether the index knows a name: by its name or alias exactly; as known names with only
 * generic words beside them (Northwind Pay API, Forge Shop UI); or because a record, an item,
 * a flow, an answered question or a wiki section already uses the phrase (a change's own files
 * don't count: they are the input).
 */
function knownName(
  ix: CatalogIndex,
  names: Map<string, string[]>,
  maxWords: number,
  candidate: string,
): boolean {
  const m = /^(GET|POST|PUT|PATCH|DELETE)\s+(\/\S*)$/.exec(candidate);
  if (m) return names.has(endpointName(m[1]!, m[2]!));
  const f = foldName(candidate);
  if (names.has(f) || names.has(f.replace(/ /g, "-"))) return true;
  const toks = f.split(/[\s-]+/).filter(Boolean);
  const covered = new Array<boolean>(toks.length).fill(false);
  for (const hit of namesIn(toks.join(" "), names, maxWords)) {
    const n = hit.name.split(" ").length;
    for (let i = hit.at; i < hit.at + n && i < toks.length; i++) covered[i] = true;
  }
  if (covered.some(Boolean) && toks.every((t, i) => covered[i] || GENERIC.has(t))) return true;
  const words = queryWords(candidate);
  if (words.length < 2 || words.length !== toks.length) return false;
  const phrase = `"${words.join(" ")}"`;
  return !!prep(
    ix,
    `SELECT 1 FROM fts f JOIN nodes n ON n.key = f.key WHERE fts MATCH ? AND n.grp != 'change' LIMIT 1`,
  ).get(phrase);
}

function candidatesOf(
  ix: CatalogIndex,
  input: ContextInput,
  o: SelectOptions,
): { candidates: Candidate[]; unknown: string[] } {
  const names = namesMap(ix);
  const maxWords = Math.min(8, Math.max(1, ...[...names.keys()].map((k) => k.split(" ").length)));
  const text = input.text;
  const title = input.title ?? "";
  const rejected = new Set(
    o.includeRejected
      ? []
      : (
          prep(
            ix,
            `SELECT item FROM reviews r WHERE verdict = 'rejected' AND at = (SELECT max(at) FROM reviews x WHERE x.item = r.item)`,
          ).all() as { item: string }[]
        ).map((r) => r.item),
  );
  const weight = (kind: string) => o.kindWeights?.[kind] ?? 1;
  const through = o.through?.length ? new Set(o.through) : undefined;

  // ---- seeds: exact names and ids, then search hits
  const seeds = new Map<string, { score: number; via: string }>();
  const seed = (key: string, score: number, via: string) => {
    const was = seeds.get(key);
    if (!was) seeds.set(key, { score, via });
    else seeds.set(key, { score: 1 - (1 - was.score) * (1 - score), via: was.via });
  };
  const exactIds = new Set<string>(input.ids ?? []);
  for (const m of namesIn(`${title}\n${text}`, names, maxWords))
    for (const id of names.get(m.name) ?? []) exactIds.add(id);
  for (const e of endpointsIn(`${title}\n${text}`))
    for (const id of names.get(e) ?? []) exactIds.add(id);
  const expansion: string[] = [];
  for (const id of [...exactIds].sort())
    for (const n of nodesById(ix, id)) {
      if (rejected.has(n.id)) continue;
      seed(n.key, 1, "named in the input");
      expansion.push(...describe(n));
    }
  const limit = o.searchLimit ?? 30;
  const hitScore = new Map<string, number>();
  const top = (hs: SearchHit[]) => hs[0]?.score ?? 1;
  // Hits among every kind (for the walk to start from), and among the kinds asked for, each
  // scored against the best of its own search, so the kinds asked for compete among themselves.
  // What the exactly named records are (a vendor, a gateway) is a search of its own: the words
  // say what kind of thing the input is about, which its prose may not.
  const query = `${text}\n${expansion.join(" ")}`;
  const about = [...new Set(expansion)].join(" ");
  for (const kinds of o.kinds?.length ? [undefined, o.kinds] : [undefined]) {
    const k = { limit, ...(kinds ? { kinds } : {}) };
    const s = new Map<string, number>();
    const add = (hs: SearchHit[], w: number) => {
      for (const h of hs) s.set(h.key, (s.get(h.key) ?? 0) + w * (h.score / top(hs)));
    };
    add(searchIndex(ix, query, k), 0.7);
    if (title) add(searchIndex(ix, title, k), 0.3);
    if (about) add(searchIndex(ix, about, k), 0.3);
    for (const [key, v] of s) hitScore.set(key, Math.max(hitScore.get(key) ?? 0, v));
  }
  for (const [key, s] of [...hitScore].sort((a, b) => cmp(a[0], b[0])))
    if (!rejected.has(key.split(":").slice(2).join(":"))) seed(key, Math.min(0.95, s), "search");

  // ---- the walk
  const kindOf = new Map<string, { kind: string; id: string }>();
  const meta = prep(ix, "SELECT kind, id FROM nodes WHERE key = ?");
  const info = (key: string) => {
    let v = kindOf.get(key);
    if (!v) {
      v = meta.get(key) as { kind: string; id: string } | undefined;
      if (v) kindOf.set(key, v);
    }
    return v;
  };
  const hops = o.hops ?? 2;
  const fanout = o.fanout ?? 24;
  const near = new Map<string, NodeLink[]>();
  const neighbours = (key: string): NodeLink[] => {
    let l = near.get(key);
    if (!l) {
      const seen = new Set<string>();
      l = linksOf(ix, key)
        .filter((x) => !rejected.has(x.id))
        .filter((x) => (seen.has(x.key) ? false : (seen.add(x.key), true)))
        .sort(
          (a, b) =>
            (hitScore.get(b.key) ?? 0) - (hitScore.get(a.key) ?? 0) ||
            weight(b.kind) - weight(a.kind) ||
            cmp(a.key, b.key),
        )
        .slice(0, fanout);
      near.set(key, l);
    }
    return l;
  };
  const contributions = new Map<string, { score: number; via: string }[]>();
  for (const [key, s] of [...seeds].sort((a, b) => cmp(a[0], b[0]))) {
    const best = new Map<string, { score: number; via: string }>([[key, s]]);
    let frontier = [key];
    for (let h = 1; h <= hops && frontier.length; h++) {
      const next: string[] = [];
      for (const k of frontier) {
        const at = info(k);
        if (h > 1 && through && at && !through.has(at.kind)) continue;
        const from = best.get(k)!;
        for (const n of neighbours(k)) {
          const score = from.score * 0.5;
          const was = best.get(n.key);
          if (was && was.score >= score) continue;
          if (!was) next.push(n.key);
          best.set(n.key, {
            score,
            via: `${n.dir === "out" ? `${at?.id ?? k} ${n.type} ${n.id}` : `${n.id} ${n.type} ${at?.id ?? k}`} (${n.how})`,
          });
        }
      }
      frontier = next.sort();
    }
    for (const [k, v] of best) {
      const l = contributions.get(k) ?? [];
      l.push(v);
      contributions.set(k, l);
    }
  }

  // ---- score and keep the kinds asked for
  const kinds = o.kinds?.length ? new Set(o.kinds) : undefined;
  const exclude = new Set(o.exclude ?? []);
  const groups = o.groups?.length ? new Set(o.groups) : undefined;
  const verified = new Map(
    (
      prep(
        ix,
        `SELECT n.key AS key, n.verified AS v,
             (SELECT r.verdict FROM reviews r WHERE r.item = n.id ORDER BY r.at DESC LIMIT 1) AS review
           FROM nodes n`,
      ).all() as { key: string; v: number; review: string | null }[]
    ).map((r) => [r.key, r.v === 1 || r.review === "verified" || r.review === "corrected"]),
  );
  const byKindId = new Map<string, Candidate & { grp: string }>();
  for (const [key, cs] of contributions) {
    const i = info(key);
    if (!i || rejected.has(i.id) || exclude.has(i.id)) continue;
    if (kinds && !kinds.has(i.kind)) continue;
    if (groups && !groups.has(key.split(":")[0]!)) continue;
    const sorted = [...cs].sort((a, b) => b.score - a.score || cmp(a.via, b.via));
    const text = 1 - sorted.reduce((p, c) => p * (1 - Math.min(1, c.score)), 1);
    const score = round(text * weight(i.kind) * (verified.get(key) ? 1.2 : 1));
    if (score < (o.minScore ?? 0.1)) continue;
    const grp = key.split(":")[0]!;
    const k = `${i.kind}|${i.id}`;
    const was = byKindId.get(k);
    const c = { key, kind: i.kind, id: i.id, score, via: sorted[0]!.via, grp };
    if (
      !was ||
      GROUP_ORDER.indexOf(grp) < GROUP_ORDER.indexOf(was.grp) ||
      (grp === was.grp && key < was.key)
    )
      byKindId.set(k, was ? { ...c, score: Math.max(score, was.score) } : c);
    else byKindId.set(k, { ...was, score: Math.max(score, was.score) });
  }
  const candidates = [...byKindId.values()]
    .map(({ grp: _g, ...c }) => c)
    .sort((a, b) => b.score - a.score || cmp(a.key, b.key));

  // ---- what the input names that the index doesn't have
  const unknown = nameCandidates(`${title}\n${text}`)
    .filter((c) => !knownName(ix, names, maxWords, c))
    .sort();
  return { candidates, unknown };
}

/** The size of a source once buildContextPack wraps it as data. */
const wrapped = (id: string, kind: string, origin: string, textLength: number) =>
  `<atticus-data id="${id}" kind="${kind}" origin="${origin}">\n\n</atticus-data>`.length +
  textLength;
const tokensOf = (chars: number) => Math.ceil(chars / 4);

export function selectContext(
  ix: CatalogIndex,
  raw: ContextInput | string,
  o: SelectOptions,
): ContextSelection {
  const input: ContextInput = typeof raw === "string" ? { text: raw } : raw;
  const version = ix.version;
  const keyed = {
    input,
    kinds: o.kinds ?? null,
    groups: o.groups ?? null,
    through: o.through ?? null,
    kindWeights: o.kindWeights ?? null,
    hops: o.hops ?? 2,
    fanout: o.fanout ?? 24,
    searchLimit: o.searchLimit ?? 30,
    minScore: o.minScore ?? 0.1,
    exclude: o.exclude ?? null,
    includeRejected: o.includeRejected ?? false,
  };
  const cacheKey = createHash("sha256")
    .update(`${version}\n${JSON.stringify(keyed)}`)
    .digest("hex");
  let cached = false;
  let found: { candidates: Candidate[]; unknown: string[] } | undefined;
  const hit = prep(ix, "SELECT json FROM selections WHERE key = ?").get(cacheKey) as
    { json: string } | undefined;
  if (hit) {
    found = JSON.parse(hit.json) as { candidates: Candidate[]; unknown: string[] };
    cached = true;
  } else {
    found = candidatesOf(ix, input, o);
    try {
      prep(ix, "INSERT OR REPLACE INTO selections VALUES (?, ?)").run(
        cacheKey,
        JSON.stringify(found),
      );
    } catch {
      // A read-only index still selects; it only doesn't keep the selection.
    }
  }

  // ---- the fit
  const prefix = o.idPrefix ?? "ctx-";
  const base = o.priority ?? 50;
  const classification = o.classification ?? "internal";
  const budget = Math.max(0, Math.floor(o.budget * 0.98));
  const fullBudget = budget * (o.fullShare ?? 0.6);
  const sources: ContextSource[] = [];
  const picked: Picked[] = [];
  const leftOut: ContextSelection["leftOut"] = [];
  const linesId = `${prefix}lines`;
  const linesOrigin = "the index, one line each (ask for one in full by its id)";
  const heading =
    o.linesHeading ??
    "More that may matter, one line each; each names its id and where it is read from:";
  const lines: string[] = [];
  let linesChars = 0;
  let used = 0;
  let phase: "full" | "line" = "full";
  let full = 0;
  // In score order: once one doesn't fit, the rest are left out, so nothing lower jumps it.
  let over = false;
  for (const c of found.candidates) {
    if (over) {
      leftOut.push({ id: c.id, kind: c.kind, score: c.score });
      continue;
    }
    const n = nodeByKey(ix, c.key);
    if (!n) continue;
    const kind =
      n.grp === "catalog" || n.grp === "flow" || n.grp === "org-pack" ? "catalog" : "document";
    if (phase === "full") {
      const text = o.render?.(n, "full") ?? n.detail;
      const id = `${prefix}${n.kind}-${n.id}`.replace(/[^\w.#:/-]+/g, "-");
      const t = tokensOf(wrapped(id, kind, n.file, text.length));
      if (used + t <= fullBudget && (o.maxFull === undefined || full < o.maxFull)) {
        used += t;
        full++;
        sources.push({
          id,
          kind,
          origin: n.file,
          text,
          classification,
          priority: round(base - sources.length * 0.001),
        });
        picked.push({
          key: n.key,
          kind: n.kind,
          id: n.id,
          score: c.score,
          level: "full",
          file: n.file,
          via: c.via,
        });
        continue;
      }
      phase = "line";
    }
    const line = o.render?.(n, "line") ?? n.line;
    const nextChars = (linesChars || heading.length) + line.length + 1;
    const t = tokensOf(wrapped(linesId, "catalog", linesOrigin, nextChars));
    if (used + t <= budget) {
      lines.push(line);
      linesChars = nextChars;
      picked.push({
        key: n.key,
        kind: n.kind,
        id: n.id,
        score: c.score,
        level: "line",
        file: n.file,
        via: c.via,
      });
    } else {
      over = true;
      leftOut.push({ id: n.id, kind: n.kind, score: c.score });
    }
  }
  if (lines.length)
    sources.push({
      id: linesId,
      kind: "catalog",
      origin: linesOrigin,
      text: [heading, ...lines].join("\n"),
      classification,
      priority: round(base - (sources.length + 1) * 0.001),
    });
  const tokens =
    used + (lines.length ? tokensOf(wrapped(linesId, "catalog", linesOrigin, linesChars)) : 0);
  return { sources, picked, leftOut, unknown: found.unknown, tokens, version, cached };
}
