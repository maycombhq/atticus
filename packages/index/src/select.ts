import { createHash } from "node:crypto";
import { identifierWords } from "@maycombhq/core";
import type { CatalogIndex } from "./catalog-index.js";
import { ASKED_ONLY_KINDS, endpointName, foldName } from "./sources.js";
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
  /** Look for an identifier's words too (ADR 0116). Default true; false is the eval's "words" mode. */
  split?: boolean;
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

/**
 * The words a search looks for: lower case, three letters or more, common words left out. An
 * identifier gives its words too (ADR 0116): `renamedAt` is looked for as renamedat and renamed.
 */
export function queryWords(text: string, max = 200, o: { split?: boolean } = {}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (w: string) => {
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w) || seen.has(w)) return;
    seen.add(w);
    out.push(w);
  };
  for (const m of text.matchAll(/[A-Za-z0-9]+/g)) {
    push(m[0].toLowerCase());
    if (o.split !== false) for (const w of identifierWords(m[0])) push(w);
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}

export function searchIndex(ix: CatalogIndex, text: string, o: SearchOptions = {}): SearchHit[] {
  const words = queryWords(text, 200, { split: o.split !== false });
  if (!words.length) return [];
  const match = words.map((w) => `"${w}"`).join(" OR ");
  const kinds = o.kinds?.length ? o.kinds : undefined;
  // WP7.6: archived changes only when asked for by kind.
  const askedOnly = kinds ? [] : [...ASKED_ONLY_KINDS];
  // ADR 0116: the words of a node's identifiers weigh 6, below its names (10) and ids (8).
  const wordsWeight = o.split === false ? 0 : 6;
  const rows = prep(
    ix,
    `SELECT f.key AS key, n.kind AS kind, n.id AS id, n.name AS name, n.file AS file,
              bm25(fts, 0.0, 10.0, 8.0, 1.0, ${wordsWeight.toFixed(1)}) AS rank
       FROM fts f JOIN nodes n ON n.key = f.key
       WHERE fts MATCH ?${kinds ? ` AND n.kind IN (${kinds.map(() => "?").join(", ")})` : ""}${
         askedOnly.length ? ` AND n.kind NOT IN (${askedOnly.map(() => "?").join(", ")})` : ""
       }
       ORDER BY rank, f.key LIMIT ?`,
  ).all(match, ...(kinds ?? []), ...askedOnly, o.limit ?? 20) as (Omit<SearchHit, "score"> & {
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
  /**
   * More rankings to fuse with the searches (ADR 0116): a search phrase (a model's expansion of
   * the input) or an ordered list of node keys (nodes similar in meaning). Each only ranks what
   * goes in the pack; none makes a link, a name or a fact.
   */
  rankings?: { name: string; text?: string; keys?: string[] }[];
  /**
   * What a model read the input as (ADR 0116, the planner's expansion), already checked: search
   * phrases (each one more ranking), the ids of names it mapped (each an id the index has; seeds),
   * and the names it found that the index may not know (each quoted from the input). With it,
   * the gaps are its names the index doesn't know; without it, only names the input marks.
   */
  expansion?: { terms: string[]; ids: string[]; unknown: string[] };
}

/** One ordered list of node keys, best first, with what it is (for a seed's `via`). */
export interface Ranking {
  name: string;
  keys: string[];
  /** Said beside a key's rank in its way in (a similarity's cosine). */
  detail?: Map<string, string>;
}

/**
 * The default k of reciprocal rank fusion, chosen on the retrieval cases (ADR 0116): k 0 to 60
 * were tried; 1 gave the best recall at the normal budget and kept every exact name first.
 */
export const RRF_K = 1;

/** A search hit enters a ranking only with at least this share of the best hit's BM25. */
export const RANK_FLOOR = 0.3;

/** The cosine below which a node is not similar in meaning, unless the model says otherwise. */
export const MEANING_FLOOR = 0.3;

/**
 * Reciprocal rank fusion (ADR 0116): each ranking gives a key 1 / (k + its rank); the sums are
 * scaled so the best is 0.95. Each key's way in names the rankings that found it, best first.
 * The same rankings give the same scores, ties broken by key where they are used.
 */
export function fuse(rankings: Ranking[], k = RRF_K): Map<string, { score: number; via: string }> {
  const sum = new Map<
    string,
    { score: number; parts: { name: string; rank: number; v: number }[] }
  >();
  for (const r of rankings)
    r.keys.forEach((key, i) => {
      const v = 1 / (k + i + 1);
      const s = sum.get(key) ?? { score: 0, parts: [] };
      s.score += v;
      const d = r.detail?.get(key);
      s.parts.push({ name: `${r.name} #${i + 1}${d ? ` (${d})` : ""}`, rank: i + 1, v });
      sum.set(key, s);
    });
  const best = Math.max(0, ...[...sum.values()].map((s) => s.score));
  const out = new Map<string, { score: number; via: string }>();
  for (const [key, s] of [...sum].sort((a, b) => cmp(a[0], b[0]))) {
    const parts = [...s.parts].sort((a, b) => b.v - a.v || cmp(a.name, b.name)).slice(0, 3);
    out.set(key, {
      score: round((0.95 * s.score) / best),
      via: `search (${parts.map((p) => p.name).join(", ")})`,
    });
  }
  return out;
}

/**
 * The other names of what the input names (ADR 0116): for each glossary term the input uses by
 * its term or an alias, its other names and the words of the columns and fields it defines; for
 * each alias it uses (curated, the org pack's, an item's), the other names of what it names.
 * They are searched as one more ranking; they never resolve a name or make a link.
 */
function synonymsOf(
  ix: CatalogIndex,
  names: Map<string, string[]>,
  text: string,
  maxWords: number,
): { name: string; words: string[] }[] {
  const out: { name: string; words: string[] }[] = [];
  const seen = new Set<string>();
  const namesOfId = prep(ix, "SELECT DISTINCT name, how FROM names WHERE id = ? ORDER BY name");
  for (const m of namesIn(text, names, maxWords)) {
    if (seen.has(m.name)) continue;
    seen.add(m.name);
    const words = new Set<string>();
    for (const id of names.get(m.name) ?? []) {
      const all = namesOfId.all(id) as { name: string; how: string }[];
      const nodes = nodesById(ix, id);
      const term = nodes.find((n) => n.kind === "GlossaryTerm");
      const alias = all.some((r) => r.name === m.name && r.how.startsWith("alias:"));
      if (!term && !alias) continue;
      for (const r of all) if (r.name !== m.name) words.add(r.name);
      if (term) {
        const x = (term.json ?? {}) as { term?: string; fields?: unknown[] };
        if (x.term) words.add(x.term.toLowerCase());
        for (const f of x.fields ?? [])
          if (typeof f === "string")
            for (const n of nodesById(ix, f)) words.add(identifierWords(n.name).join(" "));
      }
    }
    if (words.size) out.push({ name: m.name, words: [...words].sort() });
  }
  return out;
}

/**
 * How far a group's text is trusted: an ingested document ranks below a record (ADR 0116; a
 * document never overrides a fact verified from code).
 */
const trust = (key: string) => (key.startsWith("document:") ? 0.8 : 1);

export interface SelectOptions {
  /** Tokens for the selected context (characters ÷ 4, as buildContextPack counts). */
  budget: number;
  /** The kinds to return. Default: every kind. */
  kinds?: string[];
  /** Only nodes of these groups: catalog, knowledge, flow, change, question, wiki, org-pack. Default: every group. */
  groups?: string[];
  /** The kinds the walk goes through. Default: every kind. */
  through?: string[];
  /**
   * The lexical layers (ADR 0116), for the eval: an identifier's words (split) and the other
   * names of what the input names (synonyms). Both on by default.
   */
  lexical?: { split?: boolean; synonyms?: boolean };
  /** The k of reciprocal rank fusion: a hit at rank r adds 1 / (k + r). Default RRF_K. */
  rrfK?: number;
  /** A search hit enters a ranking only with this share of the best hit's BM25. Default RANK_FLOOR. */
  rankFloor?: number;
  /**
   * Rank by similarity in meaning too, when the index has a model and every node a vector
   * (ADR 0116). Default true; it is off, and the selection says so, until then.
   */
  meaning?: boolean;
  /** The cosine below which a node isn't similar. Default: the model's, else MEANING_FLOOR. */
  meaningFloor?: number;
  /**
   * A model's order of the candidates it was shown (ADR 0116, the planner's rerank): `shown`, the
   * candidates it saw ("Kind id"), and `refs`, the ones it wants, most needed first. The fit runs
   * in that order; one it saw and dropped is left out with why. Ignored unless `refs` is a subset
   * of `shown`, each once. It never changes the scores, the links or the gaps.
   */
  order?: { shown: string[]; refs: string[] };
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
  leftOut: { id: string; kind: string; score: number; why?: string }[];
  /** Names in the input the index has nothing for. */
  unknown: string[];
  tokens: number;
  /** The index version the selection was made on. */
  version: string;
  /** Whether similarity in meaning ranked too, or why not (ADR 0116). */
  meaning: string;
  cached: boolean;
}

interface Candidate {
  key: string;
  kind: string;
  id: string;
  score: number;
  via: string;
}

const GROUP_ORDER = [
  "catalog",
  "flow",
  "knowledge",
  "change",
  "question",
  "wiki",
  "document",
  "org-pack",
];

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

/** Words a name may end with that don't change what it names: Northwind Pay API is Northwind Pay. */
const GENERIC = new Set(
  "api apis service services system systems team app apps application platform portal ui ux gateway database db store queue topic site module library sdk client server backend frontend web mobile integration endpoint endpoints".split(
    " ",
  ),
);

/** A file name in backticks (notes.md, OrderController.java), not a name. */
const FILE =
  /\.(md|markdown|ya?ml|json|java|kt|ts|tsx|js|mjs|py|go|cs|rb|sql|xml|txt|csv|html?|properties|sh|toml|ini|cfg)$/i;

/**
 * Names the input marks as names by its form, without judging its prose (ADR 0116): names in
 * backticks (an id like forge-hold-store, or a capitalised name; not a field, a file or a
 * command) and endpoints. Which words of a sentence are a name is the model's to say (the
 * expansion's names, `ContextInput.expansion`); with no model, only these are asked about.
 */
function nameCandidates(text: string): string[] {
  const out = new Set<string>();
  const body = text
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l) && !/^\s*<!--/.test(l))
    .join("\n");
  for (const m of body.matchAll(/`([^`\n]{2,60})`/g)) {
    const t = m[1]!.trim();
    if (/^(GET|POST|PUT|PATCH|DELETE)\s+\//.test(t)) continue; // taken as an endpoint below
    const id = /^[a-z0-9]+(?:[-.][a-z0-9]+)+$/.test(t) && !FILE.test(t);
    const name = /^[A-Z][A-Za-z0-9]*(?: [A-Z][A-Za-z0-9]*){0,3}$/.test(t);
    if (id || name) out.add(t);
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
  const words = queryWords(candidate, 200, { split: false });
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
  // ADR 0116: the ids a model mapped the input's names to (each one the index has).
  for (const id of [...new Set(input.expansion?.ids ?? [])].sort())
    if (!exactIds.has(id))
      for (const n of nodesById(ix, id)) {
        if (rejected.has(n.id)) continue;
        seed(n.key, 0.9, "named in the input (the model's reading, an id the index has)");
        expansion.push(...describe(n));
      }
  const limit = o.searchLimit ?? 30;
  const split = o.lexical?.split !== false;
  const hitScore = new Map<string, number>();
  const hitVia = new Map<string, string>();
  // Hits among every kind (for the walk to start from), and among the kinds asked for, so the
  // kinds asked for compete among themselves. What the exactly named records are (a vendor, a
  // gateway) is a search of its own: the words say what kind of thing the input is about, which
  // its prose may not. ADR 0116: the other names of what the input names (a glossary term's
  // aliases and the columns it defines, an alias's system) are a search of their own too, and
  // the searches are fused by their ranks, not their scores (reciprocal rank fusion).
  const query = `${text}\n${expansion.join(" ")}`;
  const about = [...new Set(expansion)].join(" ");
  const synonyms =
    o.lexical?.synonyms === false ? [] : synonymsOf(ix, names, `${title}\n${text}`, maxWords);
  const extra: { name: string; text?: string; keys?: string[] }[] = [
    ...(input.rankings ?? []),
    ...(input.expansion?.terms ?? [])
      .slice(0, 8)
      .map((t) => ({ name: `the model's "${t}"`, text: t })),
  ];
  // A ranking keeps the hits whose BM25 is at least a share of its best: a weak match (one
  // common word) doesn't enter it, so rank alone doesn't lift it.
  const floor = o.rankFloor ?? RANK_FLOOR;
  const ranked = (q: string, k: SearchOptions) => {
    const hs = searchIndex(ix, q, k);
    const best = hs[0]?.score ?? 0;
    return hs.filter((h) => h.score >= best * floor).map((h) => h.key);
  };
  for (const kinds of o.kinds?.length ? [undefined, o.kinds] : [undefined]) {
    const k = { limit, split, ...(kinds ? { kinds } : {}) };
    const rankings: Ranking[] = [{ name: "words", keys: ranked(query, k) }];
    if (title) rankings.push({ name: "title", keys: ranked(title, k) });
    if (about) rankings.push({ name: "what is named", keys: ranked(about, k) });
    for (const syn of synonyms)
      rankings.push({
        name: `synonyms of "${syn.name}"`,
        keys: ranked(syn.words.join(" "), k),
      });
    // ADR 0116: the nodes nearest the input in meaning, a ranking like the others (never a link).
    if (o.meaning !== false) {
      const sim = ix.similar(input, {
        limit,
        ...(kinds ? { kinds } : {}),
        ...(o.meaningFloor !== undefined ? { floor: o.meaningFloor } : {}),
      });
      if ("hits" in sim)
        rankings.push({
          name: "similar in meaning",
          keys: sim.hits.map((h) => h.key),
          detail: new Map(sim.hits.map((h) => [h.key, `cos ${h.cos.toFixed(2)}`])),
        });
    }
    for (const r of extra)
      rankings.push({
        name: r.name,
        keys: (r.keys ?? ranked(r.text ?? "", k))
          .filter((key) => !kinds || kinds.includes(key.split(":")[1]!))
          .slice(0, limit),
      });
    for (const [key, v] of fuse(rankings, o.rrfK ?? RRF_K)) {
      if (v.score > (hitScore.get(key) ?? 0)) {
        hitScore.set(key, v.score);
        hitVia.set(key, v.via);
      }
    }
  }
  for (const [key, s] of [...hitScore].sort((a, b) => cmp(a[0], b[0])))
    if (!rejected.has(key.split(":").slice(2).join(":")))
      seed(key, Math.min(0.95, s), hitVia.get(key) ?? "search");

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
          (a, b) => (hitScore.get(b.key) ?? 0) - (hitScore.get(a.key) ?? 0) || cmp(a.key, b.key),
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
    const score = round(text * trust(key) * (verified.get(key) ? 1.2 : 1));
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
  // ADR 0116: the model's names when it read the input, else the names the input marks; either
  // way only those the index has nothing for (knownName is the fact check, never a judgment).
  const asked = input.expansion
    ? [...new Set([...input.expansion.unknown, ...nameCandidates(`${title}\n${text}`)])]
    : nameCandidates(`${title}\n${text}`);
  const unknown = asked.filter((c) => !knownName(ix, names, maxWords, c)).sort();
  return { candidates, unknown };
}

/** A candidate as a rerank names it: its kind and id. */
export const candidateRef = (c: { kind: string; id: string }) => `${c.kind} ${c.id}`;

/**
 * The candidates in a model's order (ADR 0116, the planner's rerank). The order must name only
 * candidates it was shown, each once; else it is ignored and the score order stands. Shown and
 * not named: dropped. Not shown: after the named ones, in score order.
 */
export function orderCandidates<C extends { kind: string; id: string }>(
  candidates: C[],
  order: SelectOptions["order"],
): { candidates: C[]; dropped: C[]; used: boolean } {
  if (!order) return { candidates, dropped: [], used: false };
  const shown = new Set(order.shown);
  const named = order.refs;
  const byRef = new Map(candidates.map((c) => [candidateRef(c), c]));
  const valid =
    new Set(named).size === named.length && named.every((r) => shown.has(r) && byRef.has(r));
  if (!valid) return { candidates, dropped: [], used: false };
  const keep = new Set(named);
  return {
    candidates: [
      ...named.map((r) => byRef.get(r)!),
      ...candidates.filter((c) => !shown.has(candidateRef(c))),
    ],
    dropped: candidates.filter((c) => shown.has(candidateRef(c)) && !keep.has(candidateRef(c))),
    used: true,
  };
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
  // ADR 0116: whether similarity in meaning ranks too (a model, every node embedded, the input
  // embedded), said in the selection and part of its cache key and version.
  const m = ix.meaning();
  const probe = o.meaning === false || !m.on ? undefined : ix.similar(input, { limit: 1 });
  const meaning =
    o.meaning === false
      ? "similar in meaning is off for this step"
      : probe && "off" in probe
        ? `similar in meaning is off: ${probe.off}`
        : m.note;
  const meaningOn = !!probe && "hits" in probe;
  const version = meaningOn ? `${ix.version}+${m.model}` : ix.version;
  const keyed = {
    input,
    kinds: o.kinds ?? null,
    groups: o.groups ?? null,
    through: o.through ?? null,
    lexical: o.lexical ?? null,
    rrfK: o.rrfK ?? RRF_K,
    rankFloor: o.rankFloor ?? RANK_FLOOR,
    hops: o.hops ?? 2,
    fanout: o.fanout ?? 24,
    searchLimit: o.searchLimit ?? 30,
    minScore: o.minScore ?? 0.1,
    exclude: o.exclude ?? null,
    includeRejected: o.includeRejected ?? false,
    meaning: meaningOn ? (o.meaningFloor ?? "default") : false,
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
  // ADR 0116: a model's order of the candidates it was shown (a rerank): the fit runs in that
  // order; what it was shown and left off its list is left out, said why; the rest follow.
  const ordered = orderCandidates(found.candidates, o.order);
  for (const c of ordered.candidates) {
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
  for (const d of ordered.dropped)
    leftOut.push({ id: d.id, kind: d.kind, score: d.score, why: "the model judged it not needed" });
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
  return { sources, picked, leftOut, unknown: found.unknown, tokens, version, cached, meaning };
}
