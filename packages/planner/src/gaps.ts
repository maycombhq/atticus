import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SourceInput } from "@maycombhq/ai";
import { loadChangeContext } from "@maycombhq/changes";
import {
  answerText,
  changesDirOf,
  changesRelOf,
  listQuestions,
  raiseQuestions,
  type CatalogRecord,
  type Question,
  type QuestionDraft,
} from "@maycombhq/core";
import { parse } from "yaml";
import {
  GAP_STEP,
  gapNameOf,
  gapQuestion,
  namesInCode,
  type ContextToolOptions,
} from "@maycombhq/index";
import { sourceTokens } from "./engine.js";
import { unfence } from "./stages/answer.js";
import { FlowDelta } from "./stages/schema.js";

/** The change's target flows folder (stages/architecture.ts's TARGET_DIR). */
const TARGET_DIR = "target-flows";

/**
 * What neither the wikis nor the repos say (ADR 0107 point 5), in the steps that use the
 * context engine (needs, feature, architecture, stories): the names the change uses that the
 * index has nothing for are listed as gaps in the step's result, sent to the model with the
 * rule not to guess, and each gap the model's answer says it relies on (under relies_on_gaps,
 * ADR 0117; a name it merely mentions isn't one) becomes a question
 * to a person (questions/, ADR 0078), never a guess. Asked under one step id with the change as
 * its repo and the line the change names it on as evidence, so every step of the change that
 * meets the same gap waits on the same question. A person's answer is indexed as asserted
 * knowledge (who and when), the name is known from then on, and the answer goes in the packs
 * of the change's later steps.
 */

export interface ContextGap {
  name: string;
  /** Where the change names it: path:line, relative to the metarepo. */
  evidence?: string;
  /** listed: in the result only; asked: the answer relied on it, a question waits; answered. */
  state: "listed" | "asked" | "answered";
  /** The question it became. */
  question?: string;
}

/** The change's files a gap's line is looked for in. */
async function changeTexts(root: string, change: string): Promise<[string, string][]> {
  const dir = join(changesDirOf(root), change);
  const out: [string, string][] = [];
  const top = (await readdir(dir).catch(() => [] as string[]))
    .filter((f) => /\.md$/.test(f))
    .sort();
  for (const f of ["brief.md", ...top.filter((x) => x !== "brief.md")]) {
    const t = await readFile(join(dir, f), "utf8").catch(() => undefined);
    if (t !== undefined) out.push([f, t]);
  }
  for (const sub of ["stories", "target-flows"])
    for (const f of (await readdir(join(dir, sub)).catch(() => [] as string[])).sort())
      if (/\.(md|ya?ml)$/.test(f)) {
        const t = await readFile(join(dir, sub, f), "utf8").catch(() => undefined);
        if (t !== undefined) out.push([`${sub}/${f}`, t]);
      }
  return out;
}

const fold = (s: string) => s.toLowerCase().replace(/\s+/g, " ");

/** The gaps of a step's selection, each with the first line of the change that names it. */
export async function gapsOf(
  root: string,
  change: string,
  unknown: string[],
): Promise<ContextGap[]> {
  if (!unknown.length) return [];
  const texts = await changeTexts(root, change);
  const rel = `${changesRelOf(root)}/${change}`;
  const out: ContextGap[] = [];
  for (const name of unknown) {
    let gap: ContextGap = { name, state: "listed" };
    let own = false;
    for (const [f, t] of texts) {
      const lines = t.split(/\r?\n/);
      const i = lines.findIndex((l) => fold(l).includes(fold(name)));
      if (i < 0) continue;
      // What the change's own target flows add (new: true) is the change's, not a gap.
      own = f.startsWith("target-flows/") && /\bnew:\s*true\b/.test(lines[i]!);
      gap = { name, evidence: `${rel}/${f}:${i + 1}`, state: "listed" };
      break;
    }
    if (!own) out.push(gap);
  }
  return out;
}

/** A name the change uses that a repo's code has: not a gap, and where the code has it. */
export interface NameInCode {
  name: string;
  /** repo:path:line of its declaration, or repo:path of the file it names. */
  at: string;
}

/** A name the change uses that is known without the index: not a gap, and why (T2, U2). */
export interface KnownName {
  name: string;
  /** Where it is known from: the target flow's file and line, a migration's file, a question. */
  at: string;
  /** target-flow: the change's own target flows add it; migration: the catalog records the file; answer: a person answered about it for this change. */
  how: "target-flow" | "migration" | "answer";
}

/**
 * The code readers namesInCode uses (ADR 0118, S1): the outline from the syntax trees the
 * extractors parse, and their own test of which files have a grammar. Loaded on first use.
 */
export async function codeReaders(): Promise<Pick<ContextToolOptions, "outline" | "outlines">> {
  const x = await import("@maycombhq/extractors");
  return {
    outline: (path, text) => x.declarationOutline(path, text),
    outlines: (path) => x.syntaxLanguageOf(path) !== undefined,
  };
}

/** "PUT /a/{id}/" → "PUT /a/{}"; undefined when it isn't METHOD /path. */
function endpointOf(s: string): string | undefined {
  const m = /^\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S*)\s*$/i.exec(s);
  if (!m) return undefined;
  const path = m[2]!
    .replace(/\?.*$/, "")
    .replace(/\{[^}]*\}/g, "{}")
    .replace(/(.)\/$/, "$1");
  return `${m[1]!.toUpperCase()} ${path.toLowerCase()}`;
}

const sameName = (a: string, b: string) => {
  if (fold(a).trim() === fold(b).trim()) return true;
  const x = endpointOf(a);
  return !!x && x === endpointOf(b);
};

/**
 * What the change's own target flows add (T2): a new flow's id, name and trigger entry; a step's
 * new target component and entry; a new table (its id and its name) and the columns a step adds
 * (those it gives types for, or every column of a new table). Each with the file and line that
 * says it. These are facts of the change itself: never gaps.
 */
export async function ownNames(
  root: string,
  change: string,
): Promise<{ name: string; at: string }[]> {
  const rel = `${changesRelOf(root)}/${change}/${TARGET_DIR}`;
  const dir = join(changesDirOf(root), change, TARGET_DIR);
  const out: { name: string; at: string }[] = [];
  for (const f of (await readdir(dir).catch(() => [] as string[])).sort()) {
    if (!/\.ya?ml$/.test(f)) continue;
    const text = await readFile(join(dir, f), "utf8").catch(() => undefined);
    if (text === undefined) continue;
    let d: FlowDelta;
    try {
      const r = FlowDelta.safeParse(parse(text));
      if (!r.success) continue;
      d = r.data;
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    const add = (name: string | undefined, key?: string) => {
      if (!name?.trim()) return;
      let i = lines.findIndex((l) => l.includes(name) && (!key || l.includes(key)));
      if (i < 0) i = lines.findIndex((l) => l.includes(name));
      out.push({ name, at: `${rel}/${f}:${i + 1}` });
    };
    if (d.change === "new") {
      add(d.flow, "flow:");
      add(d.name, "name:");
      add(d.trigger?.entry, "entry:");
    }
    for (const s of d.steps) {
      if (s.to?.new) {
        add(s.to.entry);
        add(s.to.component);
      }
      if (s.store?.new) {
        add(s.store.table);
        const short = s.store.table.split(".").pop();
        if (short && short !== s.store.table) out.push({ name: short, at: out.at(-1)!.at });
      }
      const added = s.store?.new ? s.store.columns : Object.keys(s.store?.types ?? {});
      for (const c of added) add(c);
    }
  }
  return out;
}

/**
 * The gap sources and the answered gaps for a change's selection, with the tokens they take,
 * so the step can give the selection that much less room. A name the index doesn't know is no
 * gap when (each a fact Atticus checks, never a judgment):
 *
 * - the change's own target flows add it (T2), cited to their line;
 * - a person answered about it for this change (U2), cited to the question;
 * - a repo in the workspace declares it in a source file, or has a file of that name (ADR 0116
 *   addendum, ADR 0118, S1, T2), cited to the line or the file;
 * - the catalog records a migration of that file name (T2).
 *
 * Only a name found in none of them is a gap.
 */
export async function gapContext(
  root: string,
  change: string,
  unknown: string[],
  o: {
    /** The catalog's records, when the step has them; else read when a file name needs them. */
    records?: CatalogRecord[];
    /** The code readers (the default loads the extractors'). */
    readers?: Pick<ContextToolOptions, "outline" | "outlines">;
  } = {},
): Promise<{
  gaps: ContextGap[];
  inCode: NameInCode[];
  known: KnownName[];
  searched: string[];
  sources: SourceInput[];
}> {
  const known: KnownName[] = [];
  let open = [...new Set(unknown)];
  const own = open.length ? await ownNames(root, change) : [];
  const answers = await gapAnswers(root, change);
  open = open.filter((n) => {
    const t = own.find((x) => sameName(x.name, n));
    if (t) {
      known.push({ name: n, at: t.at, how: "target-flow" });
      return false;
    }
    const q = answers.answered.find((x) => sameName(gapNameOf(x) ?? "", n));
    if (q) {
      known.push({ name: n, at: `question ${q.id}`, how: "answer" });
      return false;
    }
    return true;
  });
  const none = {
    found: new Map<string, string>(),
    how: new Map<string, "declaration" | "file">(),
    repos: [] as string[],
  };
  const readers = open.length ? (o.readers ?? (await codeReaders().catch(() => ({})))) : {};
  const code = open.length ? await namesInCode(root, open, readers).catch(() => none) : none;
  const inCode = [...code.found]
    .map(([name, at]) => ({ name, at }))
    .sort((a, b) => a.name.localeCompare(b.name));
  open = open.filter((n) => !code.found.has(n));
  // A migration file the catalog records, by its name or the end of its path.
  const files = open.filter((n) => /\.[A-Za-z0-9]+$/.test(n) && !/\s/.test(n));
  if (files.length) {
    const records =
      o.records ??
      (await loadChangeContext(root)
        .then((c) => c.records)
        .catch(() => []));
    for (const r of records) {
      if (r.kind !== "Migration") continue;
      const file = (r as { file?: string }).file ?? "";
      const n = files.find((x) => file === x || file.endsWith(`/${x}`));
      if (!n || known.some((k) => k.name === n)) continue;
      const repo = r.evidence.find((e) => e.repo)?.repo;
      known.push({ name: n, at: repo ? `${repo}:${file}` : file, how: "migration" });
    }
    open = open.filter((n) => !known.some((k) => k.name === n));
  }
  known.sort((a, b) => a.name.localeCompare(b.name));
  const gaps = await gapsOf(root, change, open);
  return {
    gaps,
    inCode,
    known,
    searched: code.repos,
    sources: [
      ...gapSources(gaps, code.repos),
      ...inCodeSources(inCode),
      ...knownSources(known),
      ...(answers.source ? [answers.source] : []),
    ],
  };
}

/**
 * The gap context's share of the room it takes from the catalog selection: at most half, so a
 * tight budget still leaves records. The gaps stay whatever they cost (they are what the model
 * asks about); the lists of names already known or found in the code are data for the model only,
 * no longer gaps, so they give way first: the known names, then the names in code.
 */
export function fitGapSources(sources: SourceInput[], room: number): SourceInput[] {
  const share = room / 2;
  const out = [...sources];
  for (const id of ["known-names", "names-in-code"]) {
    if (sourceTokens(out) <= share) break;
    const i = out.findIndex((s) => s.id === id);
    if (i >= 0) out.splice(i, 1);
  }
  return out;
}

/** The names known without the index, as data for the model: why each is known, and where. */
export function knownSources(known: KnownName[]): SourceInput[] {
  if (!known.length) return [];
  const why = (k: KnownName) =>
    k.how === "target-flow"
      ? `the change's own target flow (${k.at})`
      : k.how === "answer"
        ? `answered (${k.at})`
        : `a migration the catalog records (${k.at})`;
  return [
    {
      id: "known-names",
      kind: "document",
      origin: "atticus (the change's target flows, the catalog's migrations, answered questions)",
      text: [
        "Names the change uses that are known, though the index has no record of them; they are not gaps:",
        ...known.slice(0, 30).map((k) => `- ${k.name}: ${why(k)}`),
        ...(known.length > 30 ? [`- and ${known.length - 30} more`] : []),
      ].join("\n"),
      classification: "internal",
      priority: 60,
    },
  ];
}

/** The names the code has, as data for the model: where to read each (show_code, grep). */
export function inCodeSources(inCode: NameInCode[]): SourceInput[] {
  if (!inCode.length) return [];
  return [
    {
      id: "names-in-code",
      kind: "document",
      origin: "atticus (a search of the workspace's code, ADR 0118)",
      text: [
        "Names the change uses that the repos' code names, though the catalog has no record of them (classes, fields and the like); read them there:",
        ...inCode.slice(0, 20).map((n) => `- ${n.name}: ${n.at}`),
        ...(inCode.length > 20 ? [`- and ${inCode.length - 20} more`] : []),
      ].join("\n"),
      classification: "internal",
      priority: 60,
    },
  ];
}

/** Said to the model when the step has gaps: list them, never guess. Atticus's own words. */
export const GAP_RULE =
  'The names in context-gaps are gaps: nothing Atticus has read says what they are. Never guess a fact about one. When your answer needs a fact about one, list it at the top level of your answer, one name a line, each in double quotes (a name may hold { } [ ] : or #):\nrelies_on_gaps:\n  - "<name, as it is listed>"\nand Atticus asks a person. Leave relies_on_gaps out when your answer needs no fact about a gap. A gap you leave out or only mention is not asked.';

/** The gaps as the model reads them (data: the names come from the change) and the rule. */
export function gapSources(gaps: ContextGap[], searched?: string[]): SourceInput[] {
  if (!gaps.length) return [];
  return [
    {
      id: "gap-rule",
      kind: "instruction",
      origin: "atticus (ADR 0107 point 5)",
      text: GAP_RULE,
      classification: "public",
      trusted: true,
    },
    {
      id: "context-gaps",
      kind: "document",
      origin: "context-gaps",
      text: [
        searched === undefined
          ? "Names the change uses that nothing Atticus has read says anything about:"
          : searched.length
            ? `Names the change uses that neither the catalog, the knowledge, the specs nor the code of the workspace's repos (${searched.join(", ")}) has:`
            : "Names the change uses that neither the catalog, the knowledge nor the specs has (no repo is cloned in the workspace, so no code was searched):",
        ...gaps.map((g) => `- ${g.name}${g.evidence ? ` (${g.evidence})` : ""}`),
      ].join("\n"),
      classification: "internal",
      priority: 95,
    },
  ];
}

/** The change's gap questions people answered, as a source of the step's pack (asserted knowledge). */
export async function gapAnswers(
  root: string,
  change: string,
): Promise<{ answered: Question[]; source?: SourceInput }> {
  const answered = (
    await listQuestions(root, { repo: change, step: GAP_STEP, state: "answered" }).catch(() => ({
      questions: [] as Question[],
    }))
  ).questions.filter((q) => gapNameOf(q));
  if (!answered.length) return { answered };
  return {
    answered,
    source: {
      id: "gap-answers",
      kind: "document",
      origin: "questions/ (answered gaps)",
      text: [
        "People said what these names are; their answers are asserted knowledge (who and when), not read from code:",
        ...answered.map(
          (q) =>
            `- ${gapNameOf(q)}: ${answerText(q) ?? ""} (${q.answer!.by}, ${q.answer!.at}, question ${q.id})`,
        ),
      ].join("\n"),
      classification: "internal",
      priority: 96,
    },
  };
}

/**
 * The gaps an answer relies on (ADR 0117): the names it lists under relies_on_gaps, each one a
 * gap the step listed (set membership, spacing and case aside). A name that isn't a listed gap
 * comes back in `unknown`; an answer that doesn't parse relies on none.
 */
export function reliedOn(
  gaps: ContextGap[],
  answer: string,
): { relied: ContextGap[]; unknown: string[] } {
  let data: unknown;
  try {
    data = parse(unfence(answer));
  } catch {
    return { relied: [], unknown: [] };
  }
  const listed = (data as { relies_on_gaps?: unknown } | null)?.relies_on_gaps;
  const names = Array.isArray(listed)
    ? listed.filter((x): x is string => typeof x === "string" && x.trim() !== "")
    : [];
  const relied: ContextGap[] = [];
  const unknown: string[] = [];
  for (const n of names) {
    const g = gaps.find((x) => fold(x.name).trim() === fold(n).trim());
    if (!g) unknown.push(n);
    else if (!relied.includes(g)) relied.push(g);
  }
  return { relied, unknown };
}

/** The question a gap becomes, or undefined when the change doesn't say where it names it. */
export function gapDraft(g: ContextGap): QuestionDraft | undefined {
  if (!g.evidence) return undefined;
  return { question: gapQuestion(g.name), options: [], evidence: [g.evidence], scope: "repo" };
}

/**
 * Ask a person about each gap the answer relies on. The gaps are updated in place (asked or
 * answered, with the question); the questions raised or already on file come back.
 */
export async function askGaps(
  root: string,
  change: string,
  gaps: ContextGap[],
  answer: string,
  by: { command: string; rerun: string; run?: string; at: string },
): Promise<Question[]> {
  const { relied } = reliedOn(gaps, answer);
  const drafts = relied.map((g) => [g, gapDraft(g)] as const).filter((x) => x[1]);
  if (!drafts.length) return [];
  const r = await raiseQuestions(
    root,
    drafts.map((x) => x[1]!),
    { step: GAP_STEP, repo: change, ...by },
  );
  const qs = [...r.raised, ...r.known];
  for (const [g] of drafts) {
    const q = qs.find((x) => gapNameOf(x) === g.name);
    if (!q) continue;
    g.question = q.id;
    g.state = q.state === "answered" ? "answered" : "asked";
  }
  return qs;
}
