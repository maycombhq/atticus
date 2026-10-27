import {
  knowledgeRelOf,
  listQuestions,
  recordPath,
  type Question,
  type QuestionDraft,
} from "@maycombhq/core";
import { codeSettles, type CodeFactRecord } from "./conflict-code.js";
import { pageFacts, type ConflictOwner } from "./conflict-owner.js";
import type { KnowledgeConflict, KnowledgeRecord, PageRef } from "./knowledge-scan.js";
import { readKnowledge, itemTitle } from "./knowledge-store.js";
import { checkQuote } from "./quotes.js";
import { readSnapshot, type Snapshot } from "./snapshot.js";

/**
 * Pages that disagree, as a person decides them (ADR 0124 addendum B-task-knowledge). The scan
 * records a conflict quoting both pages, and the page that likely owns the topic when a signal
 * says so (conflict-owner.ts). When a change or one of its tasks relies on the item, the change
 * asks a person which page applies: a question (ADR 0078) quoting both pages, with their owners
 * and last edits when the snapshot has them and the signal's page named as suggested, offering
 * each page and "both, in different cases". Nothing is picked silently. The one exception is the
 * code: a document never overrides a fact verified from code, so when a catalog record verified
 * from code holds one page's value (conflict-code.ts), the conflict is settled by the code, says
 * so and cites the record, and no one is asked. The question's evidence is the item's file and
 * each page's line in its snapshot, so the conflict it is about is read back from it: the same
 * topic and pages are never asked again, whatever the snapshot's date. The answer is recorded on
 * the question and read here.
 */

/** The step a conflict question is asked by. */
export const CONFLICT_STEP = "knowledge-conflict";

const pageFile = (page: string) => (/\.(md|markdown)$/i.test(page) ? page : `${page}.md`);
const ref = (p: PageRef) => `${p.source}/${p.page}`;
const refKey = (p: PageRef) => `${p.source}/${pageFile(p.page)}`;

/** A conflict's key: the items it is about and its pages, each sorted. */
export function conflictKey(c: { about: string[]; pages: PageRef[] }): string {
  return `${[...new Set(c.about)].sort().join(" + ")} @ ${[...new Set(c.pages.map(refKey))].sort().join(" | ")}`;
}

/** Evidence is path:line with no spaces or colons in the path: those are written %-escaped. */
const enc = (p: string) => p.replace(/%/g, "%25").replace(/\s/g, "%20").replace(/:/g, "%3A");
const dec = (p: string) => {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
};
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What a conflict question's evidence says: the items, then the pages in the options' order. */
function evidenceOf(
  root: string,
  q: Pick<Question, "evidence">,
): { items: string[]; pages: string[] } {
  const rel = knowledgeRelOf(root);
  const item = new RegExp(`^${esc(rel)}/items/[a-z]+/(.+)\\.yaml$`);
  const snap = new RegExp(`^${esc(rel)}/snapshots/([^/]+)/\\d{4}-\\d{2}-\\d{2}/(.+)$`);
  const items: string[] = [];
  const pages: string[] = [];
  for (const e of q.evidence) {
    const path = dec(e.slice(0, e.lastIndexOf(":")));
    const i = item.exec(path);
    if (i) items.push(i[1]!);
    const s = snap.exec(path);
    if (s) pages.push(`${s[1]}/${s[2]}`);
  }
  return { items, pages };
}

/** The key of the conflict a question asks about; undefined for a question of another step. */
export function conflictKeyOfQuestion(
  root: string,
  q: Pick<Question, "evidence" | "askedBy">,
): string | undefined {
  if (q.askedBy.step !== CONFLICT_STEP) return undefined;
  const { items, pages } = evidenceOf(root, q);
  if (!items.length || pages.length < 2) return undefined;
  return `${[...new Set(items)].sort().join(" + ")} @ ${[...new Set(pages)].sort().join(" | ")}`;
}

/** A page of a conflict as the newest snapshot of its source has it. */
async function pageIn(
  root: string,
  p: PageRef,
  cache: Map<string, Snapshot | undefined>,
): Promise<{ snapshot: Snapshot; page: Snapshot["pages"][number] } | undefined> {
  if (!cache.has(p.source)) cache.set(p.source, await readSnapshot(root, p.source));
  const s = cache.get(p.source);
  const page = s?.pages.find((x) => x.pagePath === p.page);
  return s && page ? { snapshot: s, page } : undefined;
}

const and = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;

/**
 * The question a conflict becomes: both pages quoted, with their owners and last edits when the
 * snapshot has them; the page a signal suggests, and why; an option per page and "both, in
 * different cases"; what each choice changes.
 */
export async function conflictDraft(
  root: string,
  c: KnowledgeConflict,
  o: { items?: KnowledgeRecord[] } = {},
): Promise<QuestionDraft> {
  const items = o.items ?? (await readKnowledge(root, { cacheRoot: root })).items;
  const about = c.about.map((id) => items.find((i) => i.id === id));
  const topic = c.about
    .map((id, k) => (about[k] ? `"${itemTitle(about[k])}" (${id})` : id))
    .join(" and ");
  const cache = new Map<string, Snapshot | undefined>();
  const evidence: string[] = about.flatMap((i) =>
    i ? [`${knowledgeRelOf(root)}/items/${enc(recordPath(i))}:1`] : [],
  );
  const said: string[] = [];
  for (const [k, p] of c.pages.entries()) {
    const at = await pageIn(root, p, cache);
    const says = c.says[k] ?? "";
    const q = at ? checkQuote(at.page.text ?? "", says) : undefined;
    if (at) evidence.push(`${enc(at.page.path)}:${q?.ok ? q.line : 1}`);
    const f = at ? pageFacts(at.page, at.snapshot.manifest) : undefined;
    const owner = f?.pageOwner ?? f?.sourceOwner;
    const meta = [
      ...(owner ? [`owner ${owner}`] : []),
      ...(f?.date ? [`last edited ${f.date}`] : []),
    ];
    said.push(`${ref(p)}${meta.length ? ` (${meta.join(", ")})` : ""} says "${says}"`);
  }
  const ids = and(c.about);
  const suggested = (p: PageRef) =>
    !!c.owner && c.owner.source === p.source && c.owner.page === p.page;
  const options = c.pages.map((p, k) => {
    const others = c.pages.filter((_, j) => j !== k).map(ref);
    return {
      label: `${ref(p)} applies`,
      means: `Follow ${ref(p)}: "${c.says[k] ?? ""}"${suggested(p) ? ` Suggested, by ${c.owner!.signal}: ${c.owner!.detail}.` : ""}`,
      changes: `Tasks that use ${ids} show ${ref(p)}'s words; ${and(others)} ${others.length === 1 ? "is" : "are"} listed as disagreeing and not used.`,
    };
  });
  options.push({
    label: "Both, in different cases",
    means:
      "Each page applies in its own case: answer in your own words to say which case takes which page.",
    changes: `Tasks that use ${ids} show every page's words, with when each applies as you say it.`,
  });
  return {
    question: `The wiki pages disagree on ${topic}${c.summary ? `, ${c.summary}` : ""}: ${said.join("; ")}.${c.owner ? ` Suggested: ${ref(c.owner)}, by ${c.owner.signal} (${c.owner.detail}); a suggestion only.` : ""} No fact verified from code settles it. Which page applies?`,
    options,
    evidence,
    scope: "repo",
  };
}

/** A conflict with who decided which page applies, if anyone has. */
export interface ConflictView {
  key: string;
  conflict: KnowledgeConflict;
  /** The pages that apply: the one chosen, every page for "both", none while undecided. */
  applies: PageRef[];
  /**
   * Who decided: a person's answer, or the code (a record verified from code holds one page's
   * value: a document never overrides it).
   */
  decided?:
    | { by: "person"; who: string; at: string; question: string; words?: string }
    | { by: "code"; record: string; kind: string; value: string; at: string };
  /** The page an ownership signal the scan recorded suggests: never a decision. */
  suggested?: ConflictOwner;
  /** The question to a person about it, when one is on file. */
  question?: { id: string; state: Question["state"]; repo: string };
}

/** The pages a person's answer applies, in the conflict's own pages. */
function answered(
  root: string,
  q: Question,
  c: KnowledgeConflict,
): { applies: PageRef[]; words?: string } | undefined {
  const a = q.answer;
  if (q.state !== "answered" || !a) return undefined;
  if (a.text !== undefined) return { applies: [...c.pages], words: a.text };
  const { pages } = evidenceOf(root, q);
  const n = a.option ?? 0;
  if (n === pages.length + 1) return { applies: [...c.pages] };
  const chosen = pages[n - 1];
  const p = chosen ? c.pages.find((x) => refKey(x) === chosen) : undefined;
  return p ? { applies: [p] } : undefined;
}

/**
 * Every conflict the last scan recorded, with the question about it and who decided it. With
 * `records` (the catalog), a conflict the code settles is decided by the code, before any answer.
 */
export async function readConflicts(
  root: string,
  o: {
    conflicts?: KnowledgeConflict[];
    questions?: Question[];
    records?: readonly CodeFactRecord[];
  } = {},
): Promise<ConflictView[]> {
  const conflicts =
    o.conflicts ?? (await readKnowledge(root, { cacheRoot: root })).report?.conflicts ?? [];
  if (!conflicts.length) return [];
  const qs = (
    o.questions ??
    (await listQuestions(root, { step: CONFLICT_STEP }).catch(() => undefined))?.questions ??
    []
  ).filter((q) => q.state !== "retired");
  const byKey = new Map<string, Question>();
  // An answered question wins over an open one; then the newest.
  for (const q of [...qs].sort(
    (a, b) =>
      Number(a.state === "answered") - Number(b.state === "answered") ||
      a.askedBy.at.localeCompare(b.askedBy.at),
  )) {
    const k = conflictKeyOfQuestion(root, q);
    if (k) byKey.set(k, q);
  }
  return conflicts.map((c) => {
    const key = conflictKey(c);
    const q = byKey.get(key);
    const code = o.records ? codeSettles(c, o.records) : undefined;
    const a = q && !code ? answered(root, q, c) : undefined;
    const view: ConflictView = {
      key,
      conflict: c,
      applies: code ? [code.page] : (a?.applies ?? []),
      ...(q ? { question: { id: q.id, state: q.state, repo: q.repo } } : {}),
      ...(c.owner ? { suggested: c.owner } : {}),
    };
    if (code)
      view.decided = {
        by: "code",
        record: code.record,
        kind: code.kind,
        value: code.value,
        at: code.at,
      };
    else if (a && q?.answer)
      view.decided = {
        by: "person",
        who: q.answer.by,
        at: q.answer.at,
        question: q.id,
        ...(a.words !== undefined ? { words: a.words } : {}),
      };
    return view;
  });
}

/** One line for a conflict: the pages, what each says, and who decided, for a person. */
export function conflictLine(v: ConflictView): string {
  const c = v.conflict;
  const pages = c.pages.map((p, k) => `${ref(p)} says "${c.says[k] ?? ""}"`).join("; ");
  const d = v.decided;
  const s = v.suggested;
  const suggestion = s ? `; ${ref(s)} suggested by ${s.signal} (${s.detail})` : "";
  const how = !d
    ? v.question
      ? `open: a person answers question ${v.question.id} (atticus questions answer ${v.question.id})${suggestion}`
      : `undecided: a change that relies on it asks a person${suggestion}`
    : d.by === "person"
      ? `${v.applies.length > 1 ? `both apply${d.words ? `: "${d.words}"` : ", in different cases"}` : `${v.applies.map(ref).join(", ")} applies`} (answered by ${d.who}, question ${d.question})`
      : `the code settles it: ${v.applies.map(ref).join(", ")} applies (${codeText(d)})`;
  return `${c.about.join(", ")}${c.summary ? ` (${c.summary})` : ""}: ${pages}. ${how[0]!.toUpperCase()}${how.slice(1)}.`;
}

/** A code decision in words: "Endpoint forge-orders.x has /a/b, verified from code at ...". */
export const codeText = (d: { record: string; kind: string; value: string; at: string }) =>
  `${d.kind} ${d.record} has ${d.value}, verified from code at ${d.at}`;
