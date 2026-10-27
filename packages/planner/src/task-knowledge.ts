import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import {
  authorityRank,
  factsDirOf,
  identifierWords,
  knowledgeKindOf,
  orgPackDirOf,
  type PageStatus,
  type SourceAuthority,
} from "@maycombhq/core";
import { openIndex, type CatalogIndex, type ContextSelection } from "@maycombhq/index";
import {
  checkQuote,
  codeText,
  itemTitle,
  pageFacts,
  readConflicts,
  readKnowledge,
  emptyPlaces,
  pageStandingOf,
  readSourceSettings,
  scopeMatch,
  snapshotPages,
  type CodeFactRecord,
  type ConflictView,
  type KnowledgeRead,
  type KnowledgeRecord,
  type ScopePlaces,
  type SourceSettings,
} from "@maycombhq/knowledge";
import { codeFactRecords } from "./knowledge-conflicts.js";
import { readKnowledgeApplies } from "./stages/knowledge-applies.js";

/**
 * The knowledge that applies to one task (ADR 0124 addendum B-task-knowledge). The change's
 * stages select the knowledge for the change as a whole (knowledge.yaml); a task is narrower: the
 * how-tos and runbooks (wiki and document sections, processes with their steps), standards,
 * requests, patterns and decisions that bear on implementing its own step. The context engine
 * searches with the task's words and walks from its flow, components and table; then each
 * candidate is kept only when what it is about (its title, applies-when, rules, steps or section
 * text) shares a word with what the task changes (its step's new words, fields, target and
 * store, never the words of the flow it sits in): a pattern about orders reaches a task that
 * changes how orders are published, not every task of an order flow. An item a person confirmed
 * for the change is boosted and needs only a word in common with the task; one they excluded
 * never appears. A section an item was read from is shown through the item, with the other
 * pages that say the same (also on) and the pages that disagree, as a person or the code decided.
 *
 * Several pages on one topic: an item's pages (where it was read and where it is also described)
 * and items that are near-duplicates of each other (the same kind and nearly the same title or
 * rules) are one entry. The best page leads and the others are listed as "also", ranked: verified
 * by a person, then the newest, then a page someone owns (a page or source owner, or a space),
 * then the page that matches more of the task's words. No model: the same files give the same list.
 *
 * Many wikis (ADR 0130). Each source in sources.yaml has an authority (standard, platform,
 * framework, team, reference) and may have a scope (appliesTo). A scoped source's pages reach a
 * task only when the task's places fall in its scope: the components its code is in, their
 * systems, where they run, their repos' types and frameworks (from the catalog, the repos
 * manifests and the facts), what it calls, and what it creates, which only the target state has
 * (a target flow's runsOn). Each page says why it applied, with the scope it matched. Authority
 * is never a sort key of the list: the list is by relevance. It decides only between pages on
 * one topic (an entry's pages and near-duplicates): a page still current first (deprecated,
 * superseded and archived pages rank below every current one, and an entry they lead is halved),
 * then verified by a person, then the more authoritative, then the order above.
 */

/** The index kinds a task's knowledge is chosen from. */
export const TASK_KNOWLEDGE_KINDS = [
  "Pattern",
  "Decision",
  "ProcessDefinition",
  "WikiSection",
  "DocumentSection",
] as const;
const TASK_KINDS: readonly string[] = TASK_KNOWLEDGE_KINDS;

/** Tokens for the engine's fit of a task's candidates (it was 1,500, for patterns and decisions). */
export const TASK_KNOWLEDGE_TOKENS = 3000;

/** At most this many items reach one task. */
export const TASK_KNOWLEDGE_MAX = 8;

/** What a task is, for its selection. */
export interface TaskKnowledgeInput {
  task: string;
  title: string;
  /** What the task changes: its steps' words once the change is in, fields, targets, stores. */
  changes: string[];
  /** What is there already: today's steps it changes, the flow's name, its components, the repo. */
  context: string[];
  /** Ids the task names: its flow, components, the component it calls, the table it stores in. */
  ids: string[];
  /**
   * The places the task's change reaches: the component it calls, the table it stores in. An
   * item that names one is kept on that alone.
   */
  targets?: string[];
  /** The files likely to change, repo:path. */
  files: string[];
  /** The story's words: searched, never enough on their own. */
  story?: string;
  /** The repo the task's code is in: its story's (ADR 0130, for a source's scope). */
  repo?: string;
  /**
   * The component the task's code is in when the catalog doesn't have it yet, as the target state
   * places it (a target flow's runsOn, ADR 0130): what a scoped source is matched against for it.
   */
  placedIn?: NewComponent;
  /** Components the task creates: the first task of a new component's story (ADR 0130). */
  creates?: NewComponent[];
}

/** A component the target state has and the catalog doesn't yet, where it is placed. */
export interface NewComponent {
  component: string;
  system?: string;
  platform?: string;
  cloud?: string;
  framework?: string;
}

/** Where an item is read: a page's section, its line and the anchor a link goes to. */
export interface KnowledgePlace {
  source: string;
  page: string;
  section: string;
  line?: number;
  /** page#section-slug, the way a wiki links to a heading. */
  anchor: string;
  /** The page's copy in the snapshot, metarepo-relative. */
  file?: string;
  /** The page's own title, when the snapshot has it. */
  pageTitle?: string;
  /** When the page was last updated (YYYY-MM-DD), when the snapshot says. */
  updated?: string;
  /** Who wrote it last: front matter `author`, when the page says. */
  author?: string;
  /** Who owns it: the page's owner, else its source's. */
  owner?: string;
  /** The page's space: front matter `space`, else its folder. */
  space?: string;
  /** A person verified the item, read from this page. */
  verified?: boolean;
  /** How much its source's word counts, with its page overrides (ADR 0130). */
  authority?: SourceAuthority;
  /** Left out when current: deprecated, superseded or archived, and what said so. */
  status?: Exclude<PageStatus, "current">;
  statusBy?: string;
  /** A standard not updated within its source's review months. */
  outOfDate?: { since: string; months: number };
  /** Its source is scoped (appliesTo): the scope it matched for this task, in words. */
  scope?: string;
}

/** A page of a disagreement, what it says and whether it applies. */
export interface TaskConflictPage {
  source: string;
  page: string;
  section?: string;
  line?: number;
  anchor: string;
  says: string;
  /** The page applies: a person chose it (or both), or a signal decided it owns the topic. */
  applies: boolean;
  /** The page the item itself was read from. */
  own: boolean;
}

/** Pages that disagree about an item, as decided so far. */
export interface TaskConflict {
  key: string;
  /** What they disagree on: the scan's summary, else the item's title. */
  about: string;
  /**
   * open: a question waits for a person; not-asked: none yet; answered by a person; code: a
   * record verified from code settles it (a document never overrides it).
   */
  state: "open" | "not-asked" | "answered" | "code";
  question?: string;
  /** "answered by sam", "settled by the code: Endpoint x has /a, verified from code at ...". */
  by?: string;
  /** The page an ownership signal suggests, and why: never a decision. */
  suggested?: string;
  /** A person's own words, for "both, in different cases". */
  words?: string;
  pages: TaskConflictPage[];
}

export interface TaskKnowledge {
  id: string;
  /** The index kind: Pattern, Decision, ProcessDefinition, WikiSection or DocumentSection. */
  kind: string;
  /** In words: standard, pattern, process, request, decision, constraint, wiki or document section. */
  knowledgeKind: string;
  title: string;
  page?: KnowledgePlace;
  /** Why it applies to this task, in one line. */
  why: string;
  appliesWhen?: string;
  /** What it says: a standard's or pattern's rules, a decision, a section's text. */
  says: string[];
  /** A how-to's steps, in order: a process's, or the list a section gives. */
  steps?: string[];
  /** Other pages that say the same, best first. */
  alsoOn: KnowledgePlace[];
  /** Near-duplicate items grouped into this one: their pages are in alsoOn. */
  sameAs?: string[];
  /** What it matched: the task's terms it is about, and the task's places it names. */
  matched: { terms: string[]; places: string[] };
  /** Pages that disagree with it. */
  conflicts: TaskConflict[];
  /** A person confirmed it for the change. */
  confirmed?: boolean;
  /** A person verified the item. */
  verified: boolean;
  score: number;
  /** The item in one line, as the task context gave it before (ADR 0113). */
  line: string;
}

// ------------------------------------------------------------------ words

const STOP = new Set(
  (
    "the and for with from that this into onto over under than then them they their there these " +
    "those what when where which while who whom whose why how are was were been being has have " +
    "had having not but can could should would will shall may might must its our ours your his " +
    "her out off per via all any each every some such only own same other more most less least " +
    "very just also too both either neither nor yet one two use used uses using make makes made " +
    "does done get gets got let lets about after before again against because below between " +
    "during above upon here once until within without through new take takes taken read reads " +
    "step steps change changes changed add adds added remove removes removed today task tasks " +
    "code it's now still already whether instead"
  ).split(/\s+/),
);

/** A word folded for comparing: lower case, a plural or an ending off. */
const stem = (w: string) =>
  w
    .toLowerCase()
    .replace(/'s$/, "")
    .replace(/(?<=\w{2})ies$/, "y")
    .replace(/(?<=\w{3})(ing|ed|es|e|s)$/, "");

/** The words of substance in texts, folded, each with the first form it was written in. */
function wordsOf(texts: (string | undefined)[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of texts) {
    if (!t) continue;
    for (const m of t.matchAll(/[A-Za-z][A-Za-z0-9]*/g))
      for (const f of [m[0], ...identifierWords(m[0])]) {
        const w = f.toLowerCase();
        if (w.length < 3 || STOP.has(w)) continue;
        const s = stem(w);
        if (!out.has(s)) out.set(s, f);
      }
  }
  return out;
}

const and = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;

/** A heading as a wiki links to it: lower case, spaces to hyphens, punctuation out. */
export const headingSlug = (h: string) =>
  h
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");

const pageFile = (page: string) => (/\.(md|markdown)$/i.test(page) ? page : `${page}.md`);

/** A place in words: forge-wiki/sso-setup.md#steps, line 6. */
export const placeText = (p: { source: string; anchor: string; line?: number }) =>
  `${p.source}/${p.anchor}${p.line ? `, line ${p.line}` : ""}`;

// ------------------------------------------------------------------ the items

type Item = KnowledgeRecord;
const fields = (i: Item) => i as unknown as Record<string, unknown>;
const strings = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);

/** What an item is about, for the words check: never where it was read. */
function aboutText(i: Item): string[] {
  const x = fields(i);
  const str = (k: string) => (typeof x[k] === "string" ? (x[k] as string) : undefined);
  return [
    itemTitle(i),
    str("appliesWhen"),
    str("decision"),
    str("definition"),
    str("catalogueItem"),
    ...strings(x.rules),
    ...strings(x.steps),
  ].filter((s): s is string => !!s);
}

/** The item in one line, as the task context wrote it before (ADR 0113). */
function lineOf(i: Item): string {
  const x = fields(i);
  const rules = strings(x.rules);
  const q = i.quote;
  return `${i.kind} ${i.id}: ${itemTitle(i)}${x.appliesWhen ? `. Applies when: ${String(x.appliesWhen)}` : ""}${rules.length ? `. ${rules.join(" ")}` : ""}${q?.page ? ` (${q.source}/${q.page}${q.line ? `:${q.line}` : ""})` : ""}`;
}

/** The pages an item is read from: its quote and its also-on, as source/page.md. */
const itemPages = (i: Item): string[] =>
  [i.quote, ...(i.alsoOn ?? [])]
    .filter((q): q is NonNullable<typeof q> => !!q)
    .map((q) => `${q.source}/${pageFile(q.page)}`);

/** A section id's parts: forge-wiki/sso-setup.md#Steps#2 → source, page, heading. */
function sectionParts(id: string): { source: string; page: string; heading: string } {
  const hash = id.indexOf("#");
  const path = hash < 0 ? id : id.slice(0, hash);
  const heading = (hash < 0 ? "" : id.slice(hash + 1)).replace(/#\d+$/, "");
  const slash = path.indexOf("/");
  return slash < 0
    ? { source: "", page: path, heading }
    : { source: path.slice(0, slash), page: path.slice(slash + 1), heading };
}

/** The list lines of a section's text, as steps. */
function listSteps(text: string): string[] {
  const out: string[] = [];
  for (const l of text.split("\n")) {
    const m = /^\s*(?:\d+[.)]|[-*])\s+(.*)$/.exec(l);
    if (m && m[1]!.trim()) out.push(m[1]!.trim());
  }
  return out;
}

/** Where an item's quote is: its page, section, line, anchor and the snapshot copy it cites. */
function placeOf(i: Item, q: NonNullable<Item["quote"]>): KnowledgePlace {
  const file = (i.evidence as { path?: string }[]).find(
    (e) => typeof e.path === "string" && e.path.endsWith(`/${pageFile(q.page)}`),
  )?.path;
  return {
    source: q.source,
    page: q.page,
    section: q.section,
    ...(q.line ? { line: q.line } : {}),
    anchor: `${q.page}#${headingSlug(q.section)}`,
    ...(file ? { file } : {}),
  };
}

// ------------------------------------------------------------------ conflicts

/** Single pages of the newest snapshots (ADR 0130: never a whole snapshot for a few pages). */
type Snapshots = ReturnType<typeof snapshotPages>;
const snapshotsOf = (root: string): Snapshots => snapshotPages(root);

/** The disagreements about an item, with what each page says and whether it applies. */
async function conflictsOf(
  item: Item,
  views: ConflictView[],
  snapshot: Snapshots,
  places?: ScopePlaces,
): Promise<TaskConflict[]> {
  const out: TaskConflict[] = [];
  for (const v of views) {
    const c = v.conflict;
    if (!c.about.includes(item.id)) continue;
    const pages: TaskConflictPage[] = [];
    for (const [k, p] of c.pages.entries()) {
      const says = c.says[k] ?? "";
      const page = (await snapshot(p.source, p.page).catch(() => undefined))?.page;
      const q = page ? checkQuote(page.text ?? "", says) : undefined;
      const section = q?.ok ? q.section : undefined;
      pages.push({
        source: p.source,
        page: p.page,
        ...(section ? { section } : {}),
        ...(q?.ok ? { line: q.line } : {}),
        anchor: section ? `${p.page}#${headingSlug(section)}` : p.page,
        says,
        applies: v.applies.some((a) => a.source === p.source && a.page === p.page),
        own: !!item.quote && item.quote.source === p.source && item.quote.page === p.page,
      });
    }
    const d = v.decided;
    // ADR 0130: an approved exception is suggested within its scope; outside it, the page the
    // exception is to.
    const s =
      v.suggested?.signal === "exception" &&
      v.suggested.scope &&
      places &&
      !scopeMatch(v.suggested.scope, places)
        ? (v.suggested.otherwise ?? v.suggested)
        : v.suggested;
    out.push({
      key: v.key,
      about: c.summary ?? itemTitle(item),
      state: d
        ? d.by === "person"
          ? "answered"
          : "code"
        : v.question?.state === "open"
          ? "open"
          : "not-asked",
      ...(v.question ? { question: v.question.id } : {}),
      ...(d
        ? {
            by: d.by === "person" ? `answered by ${d.who}` : `settled by the code: ${codeText(d)}`,
          }
        : {}),
      ...(d?.by === "person" && d.words ? { words: d.words } : {}),
      ...(!d && s ? { suggested: `${s.source}/${s.page}, by ${s.signal}: ${s.detail}` } : {}),
      pages,
    });
  }
  return out;
}

/** A disagreement in lines, for the story file and the task's context. */
export function conflictLines(c: TaskConflict): string[] {
  const at = (p: TaskConflictPage) => `${placeText(p)}: "${p.says}"`;
  if (c.state === "open" || c.state === "not-asked")
    return [
      `Pages disagree on ${c.about}: ${c.pages.map((p) => `${p.source}/${p.page} says "${p.says}"`).join("; ")}. ${c.question ? `A person decides which applies (question ${c.question}).` : "No person has been asked which applies yet."}${c.suggested ? ` Suggested, not decided: ${c.suggested}.` : ""}`,
    ];
  const applies = c.pages.filter((p) => p.applies);
  if (applies.length > 1)
    return [
      `Both apply, in different cases (${c.by}${c.words ? `: "${c.words}"` : ""}): ${applies.map(at).join("; ")}`,
    ];
  return c.pages.flatMap((p) =>
    p.applies
      ? p.own
        ? []
        : [`Applies instead (${c.by}): ${at(p)}`]
      : [`Disagrees, not used (${c.by}): ${at(p)}`],
  );
}

// ------------------------------------------------------------------ the selection

interface Candidate {
  id: string;
  kind: string;
  score: number;
  named: boolean;
}

/** The candidates of a selection: what it picked and what it left out for room, each once. */
function candidatesOf(s: ContextSelection): Candidate[] {
  const out = new Map<string, Candidate>();
  for (const p of s.picked)
    out.set(p.id, {
      id: p.id,
      kind: p.kind,
      score: p.score,
      named: p.via.startsWith("named in the input"),
    });
  for (const l of s.leftOut)
    if (!out.has(l.id)) out.set(l.id, { id: l.id, kind: l.kind, score: l.score, named: false });
  return [...out.values()];
}

const groupOf = (kind: string) =>
  kind === "WikiSection" ? "wiki" : kind === "DocumentSection" ? "document" : "knowledge";

export interface TaskKnowledgeOptions {
  /** Tokens for the engine's fit. Default TASK_KNOWLEDGE_TOKENS. */
  budget?: number;
  /** The clock, for a standard's review age (ADR 0130). Default now. */
  now?: string;
  /** sources.yaml's settings. Default read from the org pack. */
  sources?: SourceSettings;
  knowledge?: KnowledgeRead;
  conflicts?: ConflictView[];
  /** The catalog's records, for a conflict the code settles. Default: read from the catalog. */
  records?: readonly CodeFactRecord[];
}

interface Kept {
  item?: Item;
  section?: string;
  sectionKind?: string;
  score: number;
  why: string;
  confirmed: boolean;
  /** The task's words it matched, folded, and their written forms. */
  words: string[];
  terms: string[];
  places: string[];
  /** ADR 0130: each source of its pages that is scoped, with the scope it matched. */
  scopes: Map<string, string>;
}

/** The task's places an item's text names, whole: its target component or table, its files. */
function placesNamed(text: string, input: TaskKnowledgeInput): string[] {
  const t = text.toLowerCase();
  const out: string[] = [];
  for (const id of [...(input.targets ?? []), ...input.ids])
    if (id.length > 3 && t.includes(id.toLowerCase()) && !out.includes(id)) out.push(id);
  for (const f of input.files) {
    const base = /([A-Za-z][\w-]*)(?:\.[A-Za-z]+)?$/.exec(f.split(/[:/]/).at(-1) ?? "")?.[1];
    if (base && base.length > 3 && t.includes(base.toLowerCase()) && !out.includes(base))
      out.push(base);
  }
  return out;
}

// ------------------------------------------------------------------ where a task works (ADR 0130)

type Rec = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** What the places of every task are read from: the catalog, the repos manifests, the facts. */
interface PlacesContext {
  byId: Map<string, Rec>;
  /** Components by their repo. */
  byRepo: Map<string, string[]>;
  /** Where each component runs: its runtime and its deployments' platforms. */
  runsOn: Map<string, string[]>;
  repos: Map<string, { type?: string; system?: string; component?: string }>;
  frameworks: (repo: string) => Promise<string[]>;
}

async function placesContext(root: string, records: readonly unknown[]): Promise<PlacesContext> {
  const byId = new Map<string, Rec>();
  const byRepo = new Map<string, string[]>();
  const runsOn = new Map<string, string[]>();
  const add = (m: Map<string, string[]>, k: string, v: string) => {
    const l = m.get(k) ?? [];
    if (!l.includes(v)) l.push(v);
    m.set(k, l);
  };
  for (const r of records as Rec[]) {
    const id = str(r.id);
    if (!id) continue;
    if (r.kind === "Component" || r.kind === "System") byId.set(id, r);
    if (r.kind === "Component") {
      const repo = str(r.repo);
      if (repo) add(byRepo, repo, id);
      const rt = str(r.runtime);
      if (rt) add(runsOn, id, rt.toLowerCase());
    }
    if (r.kind === "Deployment") {
      const c = str(r.component);
      const pl = str(r.platform);
      if (c && pl) add(runsOn, c, pl.toLowerCase());
    }
  }
  // The repos manifests: each repo's type and system (C6, read as they are).
  const repos = new Map<string, { type?: string; system?: string; component?: string }>();
  const profiles = join(orgPackDirOf(root), "profiles");
  for (const d of await readdir(profiles).catch(() => [] as string[])) {
    const text = await readFile(join(profiles, d, "repos.manifest.yaml"), "utf8").catch(
      () => undefined,
    );
    if (text === undefined) continue;
    try {
      for (const r of ((parse(text) as { repos?: Rec[] } | null)?.repos ?? []) as Rec[]) {
        const id = str(r.id);
        if (!id) continue;
        const type = str(r.type);
        const system = str(r.system);
        const component = str(r.component);
        repos.set(id, {
          ...(type ? { type } : {}),
          ...(system ? { system } : {}),
          ...(component ? { component } : {}),
        });
      }
    } catch {
      // a manifest that doesn't read gives nothing here; the org pack check names it
    }
  }
  // The frameworks a repo's facts declare (ADR 0124 addendum A-framework), read once a repo.
  const fw = new Map<string, Promise<string[]>>();
  const frameworks = (repo: string) => {
    if (!fw.has(repo))
      fw.set(
        repo,
        readFile(join(factsDirOf(root), `${repo}.jsonl`), "utf8").then(
          (t) => {
            const out = new Set<string>();
            for (const l of t.split("\n")) {
              if (!l.includes('"framework"')) continue;
              try {
                const f = JSON.parse(l) as Rec;
                const name = f.kind === "framework" ? str(f.name) : undefined;
                if (name) out.add(name.toLowerCase());
              } catch {
                // a line that isn't JSON is the verifier's to report
              }
            }
            return [...out];
          },
          () => [],
        ),
      );
    return fw.get(repo)!;
  };
  return { byId, byRepo, runsOn, repos, frameworks };
}

/** Where a task works: the places a source's scope is matched against (ADR 0130). */
async function taskPlaces(input: TaskKnowledgeInput, c: PlacesContext): Promise<ScopePlaces> {
  const p = emptyPlaces();
  const set = (m: Map<string, string>, k: string, why: string) => {
    const key = k.trim().toLowerCase();
    if (key && !m.has(key)) m.set(key, why);
  };
  const isComponent = (id: string) => c.byId.get(id)?.kind === "Component";
  const targets = new Set(input.targets ?? []);
  const repos = new Set<string>();
  if (input.repo) repos.add(input.repo);
  for (const f of input.files) {
    const r = f.split(":")[0];
    if (r && f.includes(":")) repos.add(r);
  }
  const own = new Set<string>();
  for (const r of repos) {
    for (const id of c.byRepo.get(r) ?? []) own.add(id);
    const m = c.repos.get(r)?.component;
    if (m && isComponent(m)) own.add(m);
    if (isComponent(r)) own.add(r);
  }
  for (const id of input.ids) if (isComponent(id) && !targets.has(id)) own.add(id);
  for (const id of own) {
    set(p.components, id, `this task works in ${id}`);
    const sys = str(c.byId.get(id)?.system);
    if (sys) set(p.systems, sys, `${id} is in ${sys}`);
    for (const pl of c.runsOn.get(id) ?? []) set(p.platforms, pl, `${id} runs on ${pl}`);
    const repo = str(c.byId.get(id)?.repo);
    if (repo) repos.add(repo);
  }
  for (const r of repos) {
    const m = c.repos.get(r);
    if (m?.type) set(p.repoTypes, m.type, `${r} is a ${m.type} repo`);
    if (m?.system) set(p.systems, m.system, `${r} is in ${m.system}`);
    for (const f of await c.frameworks(r)) set(p.frameworks, f, `${r} is built on ${f}`);
  }
  for (const id of targets) {
    if (!isComponent(id)) continue;
    set(p.calls.components, id, `this task calls ${id}`);
    const sys = str(c.byId.get(id)?.system);
    if (sys) set(p.calls.systems, sys, `this task calls ${id}, in ${sys}`);
  }
  // What only the target state has: the new component the task works in, where it is placed,
  // and the one it creates.
  for (const n of [...(input.placedIn ? [input.placedIn] : []), ...(input.creates ?? [])]) {
    if (c.byId.has(n.component)) continue;
    if (input.creates?.includes(n) && !p.creates.includes(n.component)) p.creates.push(n.component);
    set(
      p.components,
      n.component,
      input.creates?.includes(n)
        ? `this task creates ${n.component}`
        : `this task works in ${n.component}, new`,
    );
    if (n.system) set(p.systems, n.system, `${n.component} is in ${n.system}`);
    for (const pl of [n.platform, n.cloud])
      if (pl) set(p.platforms, pl, `${n.component} runs on ${pl}, as its target flow places it`);
    if (n.framework)
      set(
        p.frameworks,
        n.framework,
        `${n.component} is built on ${n.framework}, as its target flow says`,
      );
  }
  return p;
}

/**
 * Each task's knowledge, by task id: one index opened for every task. With no index (it can't be
 * read), nothing, and why.
 */
export async function selectTaskKnowledge(
  root: string,
  change: string,
  inputs: TaskKnowledgeInput[],
  o: TaskKnowledgeOptions = {},
): Promise<{ byTask: Map<string, TaskKnowledge[]>; note?: string }> {
  const byTask = new Map<string, TaskKnowledge[]>();
  if (!inputs.length) return { byTask };
  const knowledge = o.knowledge ?? (await readKnowledge(root, { cacheRoot: root }));
  const items = new Map(knowledge.items.map((i) => [i.id, i] as const));
  const verified = (id: string) => {
    const s = knowledge.reviews[id]?.state;
    return s === "verified" || s === "corrected";
  };
  const list = await readKnowledgeApplies(root, change);
  const excluded = new Set(
    (list?.items ?? []).filter((i) => i.status === "excluded").map((i) => i.id),
  );
  const confirmed = new Map(
    (list?.items ?? [])
      .filter((i) => i.status === "confirmed" && TASK_KINDS.includes(i.kind))
      .map((i) => [i.id, i.kind] as const),
  );
  const settings = o.sources ?? readSourceSettings(root);
  const now = o.now ?? new Date().toISOString();
  const records = o.records ?? (await codeFactRecords(root));
  const views =
    o.conflicts ??
    (await readConflicts(root, {
      conflicts: knowledge.report?.conflicts ?? [],
      records,
      sources: settings,
      now,
    }).catch(() => []));
  // ADR 0130: the places each task works in, read only when a source is scoped.
  const scoped = [...settings.values()].some((w) => w.appliesTo);
  const placesIn = scoped ? await placesContext(root, records) : undefined;
  // The pages an excluded item is read from: their sections stay out too.
  const excludedPages = new Set(
    [...excluded].flatMap((id) => (items.get(id) ? itemPages(items.get(id)!) : [])),
  );
  // The item each page is read from (its quote first), for a section that is one.
  const itemOfPage = new Map<string, Item>();
  for (const i of knowledge.items)
    if (!excluded.has(i.id) && TASK_KINDS.includes(i.kind))
      for (const p of itemPages(i)) if (!itemOfPage.has(p)) itemOfPage.set(p, i);

  let ix: CatalogIndex;
  try {
    ix = await openIndex(root);
  } catch (e) {
    return {
      byTask,
      note: `the index couldn't be read (${(e as Error).message.split("\n")[0]}), so no task has its knowledge`,
    };
  }
  const snapshot = snapshotsOf(root);
  try {
    for (const input of inputs) {
      const places = placesIn ? await taskPlaces(input, placesIn) : undefined;
      /** A source's scope for this task: "" unscoped, the match in words, undefined out of scope. */
      const scopeCache = new Map<string, string | undefined>();
      const scopeOf = (source: string): string | undefined => {
        if (!scopeCache.has(source)) {
          const sc = settings.get(source)?.appliesTo;
          scopeCache.set(source, !sc ? "" : places ? scopeMatch(sc, places) : undefined);
        }
        return scopeCache.get(source);
      };
      const sel = await ix.select(
        {
          text: [input.title, ...input.changes, ...input.files, input.story ?? ""]
            .filter((t) => t.trim())
            .join("\n"),
          title: input.title,
          ids: input.ids,
          ...(confirmed.size
            ? {
                rankings: [
                  {
                    name: "confirmed for the change",
                    keys: [...confirmed].map(([id, kind]) => `${groupOf(kind)}:${kind}:${id}`),
                  },
                ],
              }
            : {}),
        },
        {
          budget: o.budget ?? TASK_KNOWLEDGE_TOKENS,
          kinds: [...TASK_KNOWLEDGE_KINDS],
          groups: ["knowledge", "wiki", "document"],
          exclude: [change, ...excluded],
        },
      );
      const context = wordsOf([...input.context, ...input.files]);
      const said = wordsOf(input.changes);
      // What the task changes: its words that aren't the flow's, components' or today's step's.
      const changes = new Map([...said].filter(([s]) => !context.has(s)));
      const all = new Map([...context, ...wordsOf([input.title]), ...said]);
      const kept = new Map<string, Kept>();
      for (const c of candidatesOf(sel)) {
        let item = items.get(c.id);
        let section: string | undefined;
        if (!item && (c.kind === "WikiSection" || c.kind === "DocumentSection")) {
          const sp = sectionParts(c.id);
          const page = `${sp.source}/${pageFile(sp.page)}`;
          if (excludedPages.has(page)) continue;
          item = itemOfPage.get(page);
          if (!item) section = c.id;
        }
        if (item && (excluded.has(item.id) || !TASK_KINDS.includes(item.kind))) continue;
        if (!item && !section) continue;
        // ADR 0130: a scoped source's page reaches the task only when the task is in its scope;
        // an item read on several pages stays when one of its sources is.
        const sources = item
          ? [...new Set([item.quote, ...(item.alsoOn ?? [])].flatMap((q) => (q ? [q.source] : [])))]
          : [sectionParts(section!).source];
        const scopes = new Map<string, string>();
        let inScope = sources.length === 0;
        for (const src of sources) {
          const m = src === "document" ? "" : scopeOf(src);
          if (m === undefined) continue;
          inScope = true;
          if (m) scopes.set(src, m);
        }
        if (!inScope) continue;
        const id = item?.id ?? section!;
        const isConfirmed = confirmed.has(id);
        const aboutTexts = item
          ? aboutText(item)
          : [
              ix.nodes(section!).find((n) => n.kind === c.kind)?.detail ?? "",
              sectionParts(section!).heading,
            ];
        const about = wordsOf(aboutTexts);
        const matched = [...changes.keys()].filter((w) => about.has(w));
        const shared = [...all.keys()].filter((w) => about.has(w));
        // The task's places it names whole: the component it calls or its table keep it alone.
        const places = placesNamed(aboutTexts.join("\n"), input);
        const target = places.some((p) => (input.targets ?? []).includes(p));
        if (!(c.named || target || matched.length > 0 || (isConfirmed && shared.length > 0)))
          continue;
        const terms = (matched.length ? matched : shared).map((w) => all.get(w) ?? w);
        const words = terms.slice(0, 4).map((w) => `"${w}"`);
        const where = places.length ? ` It names ${and(places)}, where this task works.` : "";
        const why = c.named
          ? "The task's step names it."
          : matched.length
            ? `It is about ${and(words)}, which this task changes.${where}`
            : words.length
              ? `It is about ${and(words)}, as this task is.${where}`
              : where.trim();
        const score =
          c.score *
          (1 + 0.25 * Math.min(matched.length, 4)) *
          (places.length ? 1.25 : 1) *
          (isConfirmed ? 1.5 : 1);
        const was = kept.get(id);
        if (!was || was.score < score)
          kept.set(id, {
            ...(item ? { item } : {}),
            ...(section ? { section, sectionKind: c.kind } : {}),
            score,
            why: isConfirmed ? `${why} Confirmed for the change.` : why,
            confirmed: isConfirmed,
            words: matched.length ? matched : shared,
            terms: matched.length || !c.named ? terms : [],
            places,
            scopes,
          });
      }
      // A section of a page a kept item is read from, or of a page that disagrees with it, is
      // shown through that item.
      const shownPages = new Set<string>();
      for (const k of kept.values())
        if (k.item) {
          for (const p of itemPages(k.item)) shownPages.add(p);
          for (const v of views)
            if (v.conflict.about.includes(k.item.id))
              for (const p of v.conflict.pages) shownPages.add(`${p.source}/${pageFile(p.page)}`);
        }
      const ranked = [...kept.entries()]
        .filter(([, k]) => {
          if (!k.section) return true;
          const sp = sectionParts(k.section);
          return !shownPages.has(`${sp.source}/${pageFile(sp.page)}`);
        })
        .sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]))
        .slice(0, TASK_KNOWLEDGE_MAX * 2);
      const out: TaskKnowledge[] = [];
      const ctx: PageContext = { snapshot, settings, now, scopeOf, ...(places ? { places } : {}) };
      for (const [id, k] of ranked)
        out.push(
          k.item
            ? await itemEntry(k.item, k, views, ctx, verified(id))
            : await sectionEntry(ix, id, k, ctx),
        );
      // Relevance first: an entry led by a page no longer current is halved (ADR 0130).
      out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      byTask.set(input.task, groupNearDuplicates(out).slice(0, TASK_KNOWLEDGE_MAX));
    }
  } finally {
    ix.close();
  }
  return { byTask };
}

const round = (n: number) => Math.round(n * 1e4) / 1e4;

/** What a page is read with: its snapshot, the sources' settings, the clock and the task's scope. */
interface PageContext {
  snapshot: Snapshots;
  settings: SourceSettings;
  now: string;
  /** A source's scope for the task: "" unscoped, the match in words, undefined out of scope. */
  scopeOf: (source: string) => string | undefined;
  places?: ScopePlaces;
}

/** Why it applies, with the scope its leading page's source matched (ADR 0130). */
const scopedWhy = (why: string, page: KnowledgePlace | undefined) =>
  page?.scope ? `${why} Its source ${page.source} applies to ${page.scope}.` : why;

/** A page no longer current halves its entry's place in the list (ADR 0130). */
const retired = (page: KnowledgePlace | undefined) => (page?.status ? 0.5 : 1);

async function itemEntry(
  i: Item,
  k: Kept,
  views: ConflictView[],
  ctx: PageContext,
  verified: boolean,
): Promise<TaskKnowledge> {
  const x = fields(i);
  const q = i.quote;
  const steps = strings(x.steps);
  // The item's pages, each with what the snapshot says of it, best first; a page of a source
  // whose scope the task is outside isn't one of them (ADR 0130).
  const places: Ranked[] = [];
  for (const [n, a] of [q, ...(i.alsoOn ?? [])].entries()) {
    if (!a || (n > 0 && q && a.source === q.source && a.page === q.page)) continue;
    if (ctx.scopeOf(a.source) === undefined) continue;
    const place = await withFacts(placeOf(i, a), ctx);
    places.push({
      place: n === 0 && verified ? { ...place, verified: true } : place,
      text: `${a.section}\n${a.text}`,
    });
  }
  const [best, ...rest] = rankPages(places, k.words);
  return {
    id: i.id,
    kind: i.kind,
    knowledgeKind: knowledgeKindOf(i) ?? i.kind.toLowerCase(),
    title: itemTitle(i),
    ...(best ? { page: best } : {}),
    why: scopedWhy(k.why, best),
    ...(typeof x.appliesWhen === "string" && x.appliesWhen ? { appliesWhen: x.appliesWhen } : {}),
    says:
      i.kind === "Decision" ? [String(x.decision ?? "")].filter((s) => s.trim()) : strings(x.rules),
    ...(steps.length ? { steps } : {}),
    alsoOn: rest,
    matched: { terms: k.terms, places: k.places },
    conflicts: await conflictsOf(i, views, ctx.snapshot, ctx.places),
    ...(k.confirmed ? { confirmed: true } : {}),
    verified,
    score: round(k.score * retired(best)),
    line: lineOf(i),
  };
}

async function sectionEntry(
  ix: CatalogIndex,
  id: string,
  k: Kept,
  ctx: PageContext,
): Promise<TaskKnowledge> {
  const node = ix.nodes(id).find((n) => n.kind === (k.sectionKind ?? "WikiSection"));
  const sp = sectionParts(id);
  const body = (node?.detail ?? "").split("\n").slice(1).join("\n").trim();
  const at = /:(\d+)\]$/.exec(node?.line ?? "");
  const steps = listSteps(body);
  const doc = node?.kind === "DocumentSection";
  // A document section's id is its file under inputs/, then its heading.
  const page = doc ? `${sp.source}/${sp.page}` : sp.page;
  const place = await withFacts(
    {
      source: doc ? "document" : sp.source,
      page,
      section: sp.heading,
      ...(at ? { line: Number(at[1]) } : {}),
      anchor: `${page}#${headingSlug(sp.heading)}`,
      ...(node?.file ? { file: node.file } : {}),
    },
    ctx,
  );
  return {
    id,
    kind: node?.kind ?? "WikiSection",
    knowledgeKind: doc ? "document section" : "wiki section",
    title: node?.name ?? sp.heading,
    page: place,
    why: scopedWhy(k.why, place),
    says: steps.length || !body ? [] : [body],
    ...(steps.length ? { steps } : {}),
    alsoOn: [],
    matched: { terms: k.terms, places: k.places },
    conflicts: [],
    ...(k.confirmed ? { confirmed: true } : {}),
    verified: false,
    score: round(k.score * retired(place)),
    line: node?.line ?? `${node?.kind ?? "WikiSection"} ${id}`,
  };
}

/**
 * The disagreements of each item again, as they stand now: after a question was raised or
 * answered, the items stay as they were selected and only who decided what changes.
 */
export async function refreshTaskConflicts(
  root: string,
  lists: Iterable<TaskKnowledge[]>,
  places?: ScopePlaces,
): Promise<void> {
  const knowledge = await readKnowledge(root, { cacheRoot: root });
  const items = new Map(knowledge.items.map((i) => [i.id, i] as const));
  const views = await readConflicts(root, {
    conflicts: knowledge.report?.conflicts ?? [],
    records: await codeFactRecords(root),
  });
  const snapshot = snapshotsOf(root);
  for (const list of lists)
    for (const k of list) {
      const i = items.get(k.id);
      if (i) k.conflicts = await conflictsOf(i, views, snapshot, places);
    }
}

/** A task's knowledge in the story file: one bullet per item, its page, why, and the other pages. */
export function storyKnowledgeLines(ks: TaskKnowledge[]): string[] {
  if (!ks.length) return [];
  const out = ["- Knowledge that applies:"];
  for (const k of ks) {
    out.push(
      `  - ${k.title} (${k.knowledgeKind})${k.page ? `, ${placeText(k.page)}${pageMeta(k.page)}` : ""}: ${k.why}`,
    );
    if (k.alsoOn.length)
      out.push(
        `    - Also described on ${k.alsoOn.map((p) => `${placeText(p)}${pageMeta(p)}`).join("; ")}.`,
      );
    for (const c of k.conflicts) for (const l of conflictLines(c)) out.push(`    - ${l}`);
  }
  return out;
}

/** What is known of a page, in words: " (updated 2026-09-14 by kim, owner Identity team)". */
export function pageMeta(p: KnowledgePlace): string {
  const parts = [
    ...(p.updated ? [`updated ${p.updated}${p.author ? ` by ${p.author}` : ""}`] : []),
    ...(!p.updated && p.author ? [`by ${p.author}`] : []),
    ...(p.owner ? [`owner ${p.owner}`] : []),
    // ADR 0130: how much its source's word counts, and whether the page is still current.
    ...(p.authority ? [`${p.authority} source`] : []),
    ...(p.status ? [p.status] : []),
    ...(p.outOfDate ? [`may be out of date (not updated since ${p.outOfDate.since})`] : []),
    ...(p.verified ? ["verified by a person"] : []),
  ];
  return parts.length ? ` (${parts.join(", ")})` : "";
}

// ------------------------------------------------------------------ several pages on one topic

interface Ranked {
  place: KnowledgePlace;
  /** The page's words the item was read from: its section and quote. */
  text: string;
}

/** A page someone owns: a page or source owner, or a space. */
const owned = (p: KnowledgePlace) => !!(p.owner || p.space);

/**
 * Two pages of one topic, the better first (ADR 0130): a current page before one deprecated,
 * superseded or archived; then verified by a person; then the more authoritative source; then the
 * newest; then one someone owns. 0 when none of these tells them apart.
 */
export function comparePages(a: KnowledgePlace, b: KnowledgePlace): number {
  return (
    Number(!!a.status) - Number(!!b.status) ||
    Number(!!b.verified) - Number(!!a.verified) ||
    authorityRank(a.authority) - authorityRank(b.authority) ||
    (b.updated ?? "").localeCompare(a.updated ?? "") ||
    Number(owned(b)) - Number(owned(a))
  );
}

/**
 * The pages of one topic, best first: current, verified by a person, the more authoritative, the
 * newest, one someone owns (comparePages), then the one that matches more of the task's words
 * (folded); then as they came.
 */
export function rankPages(pages: Ranked[], words: readonly string[]): KnowledgePlace[] {
  const specific = (r: Ranked) => {
    const w = wordsOf([r.text]);
    return words.filter((x) => w.has(x)).length;
  };
  return pages
    .map((r, n) => ({ r, n, s: specific(r) }))
    .sort((a, b) => comparePages(a.r.place, b.r.place) || b.s - a.s || a.n - b.n)
    .map((x) => x.r.place);
}

/**
 * A page's facts from its snapshot: title, last update, author, owner and space; and (ADR 0130)
 * its source's authority, the page's status, a standard's review age, and the scope it matched.
 */
async function withFacts(p: KnowledgePlace, ctx: PageContext): Promise<KnowledgePlace> {
  if (p.source === "document") return p;
  const scope = ctx.scopeOf(p.source);
  const hit = await ctx.snapshot(p.source, p.page).catch(() => undefined);
  const authority = ctx.settings.get(p.source)?.authority;
  if (!hit) return { ...p, ...(authority ? { authority } : {}), ...(scope ? { scope } : {}) };
  const { page, manifest } = hit;
  const f = pageFacts(page, manifest);
  const author = page.frontMatter.author;
  const st = pageStandingOf(page, ctx.settings, ctx.now);
  // The authority is shown when sources.yaml gives one (the source's or a page override's).
  const said = !!authority || !!st.by?.startsWith("byPage");
  return {
    ...p,
    ...(said ? { authority: st.authority } : {}),
    ...(st.status !== "current"
      ? { status: st.status, ...(st.by ? { statusBy: st.by } : {}) }
      : {}),
    ...(st.outOfDate ? { outOfDate: st.outOfDate } : {}),
    ...(scope ? { scope } : {}),
    ...(page.title ? { pageTitle: page.title } : {}),
    ...(f.date ? { updated: f.date } : {}),
    ...(typeof author === "string" && author.trim() ? { author: author.trim() } : {}),
    ...((f.pageOwner ?? f.sourceOwner) ? { owner: f.pageOwner ?? f.sourceOwner } : {}),
    ...(f.space ? { space: f.space } : {}),
    ...(!p.file ? { file: page.path } : {}),
  };
}

/** The words two items are about, for near-duplicates: title, rules and steps. */
const topicWords = (k: TaskKnowledge) => new Set(wordsOf([k.title]).keys());
const bodyWords = (k: TaskKnowledge) => new Set(wordsOf([...k.says, ...(k.steps ?? [])]).keys());

const jaccard = (a: Set<string>, b: Set<string>) => {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n);
};

const isSection = (k: TaskKnowledge) => k.kind === "WikiSection" || k.kind === "DocumentSection";

/** How much of the smaller set is in the other; 0 under 8 words (too little to call a copy). */
const overlap = (a: Set<string>, b: Set<string>) => {
  const [x, y] = a.size <= b.size ? [a, b] : [b, a];
  if (x.size < 8) return 0;
  let n = 0;
  for (const w of x) if (y.has(w)) n++;
  return n / x.size;
};

/**
 * Two entries say nearly the same: the same kind, and nearly the same title or body. A section
 * no item is read from and an item say the same when most of the smaller one's words are in the
 * other (ADR 0130): a page copied from a standard into a team's wiki, perhaps drifted since, is
 * the standard's topic.
 */
export function nearDuplicates(a: TaskKnowledge, b: TaskKnowledge): boolean {
  if (a.knowledgeKind !== b.knowledgeKind) {
    if (isSection(a) === isSection(b)) return false;
    return overlap(bodyWords(a), bodyWords(b)) >= 0.75;
  }
  return jaccard(topicWords(a), topicWords(b)) >= 0.6 || jaccard(bodyWords(a), bodyWords(b)) >= 0.7;
}

/**
 * Which of two near-duplicates leads (ADR 0130): its page current, verified, the more
 * authoritative, the newest, owned (comparePages); then an item over a section; then the score.
 */
const leads = (a: TaskKnowledge, b: TaskKnowledge) =>
  Number(!!a.page?.status) - Number(!!b.page?.status) ||
  Number(b.verified) - Number(a.verified) ||
  (a.page && b.page ? comparePages(a.page, b.page) : Number(!b.page) - Number(!a.page)) ||
  Number(isSection(a)) - Number(isSection(b)) ||
  b.score - a.score ||
  a.id.localeCompare(b.id);

/**
 * Near-duplicate entries grouped into one: the one that leads keeps its place in the list and
 * lists the others' pages as "also" (best first) and their ids as sameAs; the disagreements of
 * every one of them stay.
 */
export function groupNearDuplicates(ks: TaskKnowledge[]): TaskKnowledge[] {
  const groups: TaskKnowledge[][] = [];
  for (const k of ks) {
    const g = groups.find((x) => x.some((y) => nearDuplicates(y, k)));
    if (g) g.push(k);
    else groups.push([k]);
  }
  return groups.map((g) => {
    if (g.length === 1) return g[0]!;
    const [lead, ...others] = [...g].sort(leads);
    const also = [
      ...lead!.alsoOn,
      ...others.flatMap((o) => [...(o.page ? [o.page] : []), ...o.alsoOn]),
    ];
    const seen = new Set<string>();
    const keys = new Set(lead!.conflicts.map((c) => c.key));
    return {
      ...lead!,
      // Its place in the list is the group's best.
      score: Math.max(...g.map((x) => x.score)),
      alsoOn: also
        .filter((p) => {
          const key = `${p.source}/${p.anchor}`;
          if (seen.has(key) || (lead!.page && key === `${lead!.page.source}/${lead!.page.anchor}`))
            return false;
          seen.add(key);
          return true;
        })
        .sort(comparePages),
      sameAs: [...(lead!.sameAs ?? []), ...others.flatMap((o) => [o.id, ...(o.sameAs ?? [])])],
      conflicts: [
        ...lead!.conflicts,
        ...others.flatMap((o) => o.conflicts).filter((c) => !keys.has(c.key) && keys.add(c.key)),
      ],
    };
  });
}
