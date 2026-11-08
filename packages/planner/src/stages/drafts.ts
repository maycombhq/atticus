import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { toCanonicalYaml } from "@maycombhq/core";
import { writeFileAtomic } from "@maycombhq/changes";
import { PlannerError } from "../errors.js";
import { Stage } from "./schema.js";

/**
 * ADR 0181 (stage drafts): AI decides first, a person corrects, and the AI corrects the rest like
 * it. Two small per-change files beside the stages' loop files, both written by Atticus:
 *
 * - `stage/drafted.yaml`: who wrote each stage draft last. The stage loop records every file a
 *   draft wrote, with the stage, its run and the file's sha-256; a person's save in the app
 *   (the artifact and placement PUT routes) records who and when. A file whose text no longer
 *   has the recorded hash was edited outside the app: a person's, with no name.
 * - `stage/corrections.yaml`: a person's corrections of AI-drafted items (a target-flow step, a
 *   story, a section of the proposal or design, a task), each with what the person says, who,
 *   when, and whether to apply it to every similar item. The stage's next run reads them as the
 *   person's word in its brief, beside the answered questions; after the draft, a correction
 *   whose item the draft changed is marked applied (and kept), and for "Apply to similar" the
 *   other items the draft changed that name the same thing are listed.
 *
 * Both are additive: no contract file changes, and a change without them reads as before. A stage
 * with no corrections gets exactly the prompt it got before (the replays match).
 */

export const DRAFTS_SCHEMA_VERSION = 1 as const;
export const DRAFTED_FILE = "stage/drafted.yaml";
export const CORRECTIONS_FILE = "stage/corrections.yaml";

const V = z.literal(DRAFTS_SCHEMA_VERSION);
const text = () => z.string().trim().min(1);
const Id = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/);

export const DraftedRecord = z.discriminatedUnion("by", [
  z.strictObject({
    by: z.literal("ai"),
    stage: Stage,
    /** The run that drafted it (a hand-off, a model run or a replay). */
    run: z.string().optional(),
    /** The stage's draft number. */
    iteration: z.number().int().min(0),
    at: z.string(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  z.strictObject({
    by: z.literal("person"),
    who: text(),
    at: z.string(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
]);
export type DraftedRecord = z.infer<typeof DraftedRecord>;

export const DraftedFile = z.strictObject({
  schemaVersion: V,
  change: Id,
  /** By change-folder path: who wrote the file last. */
  files: z.record(z.string(), DraftedRecord).default({}),
});
export type DraftedFile = z.infer<typeof DraftedFile>;

export const CorrectionScope = z.enum(["one", "similar"]);
export const CorrectionState = z.enum(["waiting", "read", "applied"]);

export const Correction = z.strictObject({
  id: z.string().regex(/^c-[0-9a-f]{10}$/),
  /** The stage whose next run reads it: the one that drafted the file. */
  stage: Stage,
  /** The file, change-folder relative. */
  file: text(),
  /** The item in it (draftItems' id); left out, the whole file. */
  item: z.string().optional(),
  /** What the person saw: the item's label. */
  label: text(),
  /** What the person says, in their words. */
  text: text().max(4000),
  /** one: this item; similar: this item and every item like it. */
  scope: CorrectionScope,
  /** similar: the name the similar items share (a component, an entry, a table, a term). */
  like: z.string().trim().min(1).optional(),
  by: text(),
  at: z.string(),
  /**
   * waiting: no draft has read it yet; read: a draft had it and didn't change the item;
   * applied: a draft had it and changed the item. Kept on file either way.
   */
  state: CorrectionState,
  /** The run of the draft that first read it, and that draft's number. */
  run: z.string().optional(),
  iteration: z.number().int().min(0).optional(),
  /** When the draft changed the item. */
  appliedAt: z.string().optional(),
  /** similar: the other items a draft with it changed, as `<file>#<item>`. */
  touched: z.array(z.string()).optional(),
});
export type Correction = z.infer<typeof Correction>;

export const CorrectionsFile = z.strictObject({
  schemaVersion: V,
  change: Id,
  corrections: z.array(Correction).default([]),
});
export type CorrectionsFile = z.infer<typeof CorrectionsFile>;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
/** A file's hash as the loop keeps it: line endings aside (a Windows checkout isn't an edit). */
export const draftSha = (s: string) => sha(s.replace(/\r\n?/g, "\n"));

async function readYaml<T>(
  file: string,
  schema: z.ZodType<T>,
  empty: T,
): Promise<{ data: T; present: boolean }> {
  const t = await readFile(file, "utf8").catch(() => undefined);
  if (t === undefined) return { data: empty, present: false };
  let raw: unknown;
  try {
    raw = parse(t);
  } catch (e) {
    throw new PlannerError("invalid", `${file} doesn't read as YAML: ${(e as Error).message}`);
  }
  const r = schema.safeParse(raw);
  if (!r.success)
    throw new PlannerError(
      "invalid",
      `${file} doesn't read: ${r.error.issues.map((i) => `${i.path.join(".") || "(top)"}: ${i.message}`).join("; ")}`,
    );
  return { data: r.data, present: true };
}

// ------------------------------------------------------------------ stage/drafted.yaml

export async function readDrafted(dir: string, change: string): Promise<DraftedFile> {
  return (
    await readYaml(join(dir, DRAFTED_FILE), DraftedFile, {
      schemaVersion: DRAFTS_SCHEMA_VERSION,
      change,
      files: {},
    })
  ).data;
}

async function writeDrafted(dir: string, d: DraftedFile): Promise<void> {
  const files = Object.fromEntries(Object.entries(d.files).sort(([a], [b]) => a.localeCompare(b)));
  await writeFileAtomic(
    join(dir, DRAFTED_FILE),
    `# Who wrote each stage draft last (ADR 0181): the AI, with its stage and run, or a person who saved it in the app. Atticus writes this file.\n${toCanonicalYaml(DraftedFile.parse({ ...d, files }), ["schemaVersion", "change", "files"])}`,
  );
}

/**
 * Record the files a stage's draft wrote as drafted by AI (the loop calls it after each draft's
 * write). A file whose text is what a person saved last stays theirs.
 */
export async function recordAiDraft(
  dir: string,
  change: string,
  o: { stage: Stage; run?: string; iteration: number; at: string; files: string[] },
): Promise<void> {
  const d = await readDrafted(dir, change).catch(() => undefined);
  // A drafted.yaml a person broke is written again from what is known now.
  const out: DraftedFile = d ?? { schemaVersion: DRAFTS_SCHEMA_VERSION, change, files: {} };
  let any = false;
  for (const f of o.files) {
    const t = await readFile(join(dir, ...f.split("/")), "utf8").catch(() => undefined);
    if (t === undefined) continue;
    const h = draftSha(t);
    const was = out.files[f];
    if (was?.by === "person" && was.sha256 === h) continue;
    if (was?.by === "ai" && was.sha256 === h && was.stage === o.stage) continue;
    out.files[f] = {
      by: "ai",
      stage: o.stage,
      ...(o.run ? { run: o.run } : {}),
      iteration: o.iteration,
      at: o.at,
      sha256: h,
    };
    any = true;
  }
  if (any) await writeDrafted(dir, out);
}

/** Record a person's save of a stage file in the app: who, when, and the text's hash. */
export async function recordPersonSave(
  dir: string,
  change: string,
  o: { file: string; who: string; at: string; content: string },
): Promise<void> {
  const d = (await readDrafted(dir, change).catch(() => undefined)) ?? {
    schemaVersion: DRAFTS_SCHEMA_VERSION,
    change,
    files: {},
  };
  d.files[o.file] = { by: "person", who: o.who, at: o.at, sha256: draftSha(o.content) };
  await writeDrafted(dir, d);
}

/** Who wrote a stage file last, as a page shows it. */
export type Provenance =
  | { by: "ai"; stage: Stage; run?: string; at?: string }
  | { by: "person"; who?: string; at?: string };

/**
 * Who wrote each of `files` last: the record in drafted.yaml while the file still has its hash;
 * a file changed since then (or one a stage wrote, by its loop file's hashes, that differs) is a
 * person's edit outside the app. `written`: the stages' loop files' hashes, for a change drafted
 * before drafted.yaml was kept. A file nothing says anything about is left out.
 */
export async function draftProvenance(
  dir: string,
  change: string,
  files: string[],
  written: { stage: Stage; hashes: Record<string, string> }[] = [],
): Promise<Record<string, Provenance>> {
  const d = await readDrafted(dir, change).catch(() => undefined);
  const out: Record<string, Provenance> = {};
  for (const f of files) {
    const t = await readFile(join(dir, ...f.split("/")), "utf8").catch(() => undefined);
    if (t === undefined) continue;
    const h = draftSha(t);
    const r = d?.files[f];
    if (r) {
      if (r.sha256 !== h) out[f] = { by: "person" };
      else if (r.by === "ai")
        out[f] = { by: "ai", stage: r.stage, ...(r.run ? { run: r.run } : {}), at: r.at };
      else out[f] = { by: "person", who: r.who, at: r.at };
      continue;
    }
    const w = written.find((x) => x.hashes[f] !== undefined);
    if (w) out[f] = w.hashes[f] === h ? { by: "ai", stage: w.stage } : { by: "person" };
  }
  return out;
}

// ------------------------------------------------------------------ items in a draft

/** An item of a stage draft a person can correct. */
export interface DraftItem {
  id: string;
  label: string;
  /** Names it shares with items like it (a step's component, entry or table). */
  like?: string[];
}

/** At most this many items of one file are offered. */
export const DRAFT_ITEMS_MAX = 80;

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "section";

interface Span {
  item: DraftItem;
  text: string;
}

function markdownSpans(t: string): Span[] {
  const lines = t.replace(/\r\n?/g, "\n").split("\n");
  const heads: { at: number; level: number; title: string }[] = [];
  let fence = false;
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    const m = !fence && /^(#{2,4})\s+(.+?)\s*#*\s*$/.exec(l);
    if (m) heads.push({ at: i, level: m[1]!.length, title: m[2]! });
  });
  const seen = new Map<string, number>();
  return heads.map((h, k) => {
    const end = heads.slice(k + 1).find((x) => x.level <= h.level)?.at ?? lines.length;
    const base = slug(h.title);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return {
      item: { id: n === 1 ? base : `${base}-${n}`, label: h.title.replace(/`/g, "") },
      text: lines.slice(h.at, end).join("\n").trim(),
    };
  });
}

function taskSpans(t: string): Span[] {
  const out: Span[] = [];
  for (const l of t.replace(/\r\n?/g, "\n").split("\n")) {
    const m = /^\s*- \[[ xX]\]\s+(\d+(?:\.\d+)*)\s+(.*)$/.exec(l);
    if (m) out.push({ item: { id: `task-${m[1]}`, label: `${m[1]} ${m[2]}` }, text: l.trim() });
  }
  return out;
}

function flowSpans(t: string): Span[] {
  let raw: unknown;
  try {
    raw = parse(t);
  } catch {
    return [];
  }
  const steps = (raw as { steps?: unknown })?.steps;
  if (!Array.isArray(steps)) return [];
  return steps.map((s, i) => {
    const st = (s ?? {}) as {
      op?: string;
      kind?: string;
      what?: string;
      to?: { component?: string; entry?: string };
      store?: { table?: string };
    };
    const like = [st.to?.component, st.to?.entry, st.store?.table].filter(
      (x): x is string => typeof x === "string" && x.trim() !== "",
    );
    const head = [st.op, st.kind].filter(Boolean).join(" ");
    return {
      item: {
        id: `step-${i + 1}`,
        label: `Step ${i + 1}${head ? ` (${head})` : ""}${st.what ? `: ${st.what}` : ""}`,
        ...(like.length ? { like } : {}),
      },
      text: JSON.stringify(s),
    };
  });
}

function spansOf(file: string, t: string): Span[] {
  if (/^target-flows\/[^/]+\.ya?ml$/.test(file)) return flowSpans(t);
  if (file === "tasks.md") return taskSpans(t);
  if (file.endsWith(".md")) return markdownSpans(t);
  return [];
}

/**
 * The items of a stage draft a person can correct, by file: a target flow's steps, tasks.md's
 * tasks, and a Markdown file's sections (a proposal's, a design's, a story's, a spec's).
 */
export function draftItems(file: string, t: string): DraftItem[] {
  return spansOf(file, t)
    .slice(0, DRAFT_ITEMS_MAX)
    .map((s) => s.item);
}

/** An item's text, to tell whether a draft changed it; the whole file without an item. */
export function draftItemText(file: string, t: string, item?: string): string | undefined {
  if (!item) return t;
  return spansOf(file, t).find((s) => s.item.id === item)?.text;
}

// ------------------------------------------------------------------ stage/corrections.yaml

export async function readCorrections(dir: string, change: string): Promise<Correction[]> {
  return (
    await readYaml(join(dir, CORRECTIONS_FILE), CorrectionsFile, {
      schemaVersion: DRAFTS_SCHEMA_VERSION,
      change,
      corrections: [],
    })
  ).data.corrections;
}

async function writeCorrections(dir: string, change: string, cs: Correction[]): Promise<void> {
  await writeFileAtomic(
    join(dir, CORRECTIONS_FILE),
    `# A person's corrections of AI-drafted items (ADR 0181): each stage's next run reads them as the person's word; Atticus marks what a draft applied. Atticus writes this file.\n${toCanonicalYaml(
      CorrectionsFile.parse({ schemaVersion: DRAFTS_SCHEMA_VERSION, change, corrections: cs }),
      ["schemaVersion", "change", "corrections"],
    )}`,
  );
}

/** Write a person's correction, waiting for the stage's next run. */
export async function addCorrection(
  dir: string,
  change: string,
  o: {
    stage: Stage;
    file: string;
    item?: string;
    label: string;
    text: string;
    similar: boolean;
    like?: string;
    by: string;
    at: string;
  },
): Promise<Correction> {
  const words = o.text.trim();
  if (!words) throw new PlannerError("invalid", "Write the correction first.");
  if (words.length > 4000)
    throw new PlannerError("invalid", "A correction is at most 4000 characters.");
  const cs = await readCorrections(dir, change);
  const id = `c-${sha([o.stage, o.file, o.item ?? "", words, o.by, o.at].join("\n")).slice(0, 10)}`;
  if (cs.some((c) => c.id === id)) return cs.find((c) => c.id === id)!;
  const like = o.like?.trim();
  const c = Correction.parse({
    id,
    stage: o.stage,
    file: o.file,
    ...(o.item ? { item: o.item } : {}),
    label: o.label.trim() || o.file,
    text: words,
    scope: o.similar ? "similar" : "one",
    ...(o.similar && like ? { like } : {}),
    by: o.by,
    at: o.at,
    state: "waiting",
  });
  await writeCorrections(dir, change, [...cs, c]);
  return c;
}

/**
 * Take back a correction no draft has read yet. One a draft read is part of the stage's record:
 * a person corrects it again instead (a later correction wins).
 */
export async function removeCorrection(dir: string, change: string, id: string): Promise<boolean> {
  const cs = await readCorrections(dir, change);
  const c = cs.find((x) => x.id === id);
  if (!c) return false;
  if (c.state !== "waiting")
    throw new PlannerError(
      "refused",
      `Correction ${id} was read by run ${c.run ?? "of the stage"}; it stays on file. Write a new correction to change it: a later correction wins.`,
    );
  await writeCorrections(
    dir,
    change,
    cs.filter((x) => x.id !== id),
  );
  return true;
}

/** The trusted line the stage's instructions gain when a person's corrections are in the brief. */
export const CORRECTIONS_RULE = `A person corrected items of the stage's drafts; the "hand-backs" data block lists each correction under "Corrections a person made", with the item and the person's words. Each one is the person's instruction, like an answer: follow it in this draft, and where it says to apply it to similar items, make the same correction to every other item that names the same thing. A later correction of an item wins over an earlier one. A correction never overrides a fact verified from code: where one contradicts a cited line, keep what the code says and ask a question naming the correction.`;

/** The corrections as the hand-backs block lists them. */
export function correctionsText(cs: Correction[]): string | undefined {
  if (!cs.length) return undefined;
  return [
    "Corrections a person made (the person's instruction; follow each one):",
    ...cs.map((c) => {
      const where = `${c.file}${c.item ? `, ${c.label}` : ""}`;
      const similar =
        c.scope === "similar"
          ? ` Apply the same correction to every similar item${c.like ? ` (every other step, story, section or task naming ${c.like})` : " (every other item like it)"}.`
          : "";
      return `- ${where}: "${c.text}" (${c.by}, ${c.at.slice(0, 10)}).${similar}`;
    }),
  ].join("\n");
}

/** A stage's corrections, oldest first: those for its brief, and those no draft has read yet. */
export async function stageCorrections(
  dir: string,
  change: string,
  stage: Stage,
): Promise<{ all: Correction[]; waiting: Correction[] }> {
  const all = (await readCorrections(dir, change).catch(() => [] as Correction[]))
    .filter((c) => c.stage === stage)
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return { all, waiting: all.filter((c) => c.state === "waiting") };
}

/** The texts of a stage's files before a draft's write, to see after it what the draft changed. */
export async function snapshotFiles(dir: string, files: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const f of [...new Set(files)]) {
    const t = await readFile(join(dir, ...f.split("/")), "utf8").catch(() => undefined);
    if (t !== undefined) out.set(f, t);
  }
  return out;
}

/**
 * After a draft that had the stage's corrections in its brief: each correction not yet applied
 * is marked applied when the draft changed its item (or read when it didn't), and a correction
 * for similar items lists the other items the draft changed that name what it is like.
 */
export async function settleCorrections(
  dir: string,
  change: string,
  o: {
    stage: Stage;
    run?: string;
    iteration: number;
    at: string;
    before: Map<string, string>;
    files: string[];
  },
): Promise<Correction[]> {
  const cs = await readCorrections(dir, change).catch(() => undefined);
  if (!cs?.length) return [];
  const after = await snapshotFiles(dir, [...o.files, ...o.before.keys()]);
  const settled: Correction[] = [];
  const changedItems = (likeOf: (s: Span) => boolean) => {
    const out: string[] = [];
    for (const f of [...new Set([...o.before.keys(), ...after.keys()])].sort()) {
      const was = new Map(spansOf(f, o.before.get(f) ?? "").map((s) => [s.item.id, s.text]));
      for (const s of spansOf(f, after.get(f) ?? ""))
        if (was.get(s.item.id) !== s.text && likeOf(s)) out.push(`${f}#${s.item.id}`);
    }
    return out;
  };
  for (const c of cs) {
    if (c.stage !== o.stage || c.state === "applied") continue;
    const before = o.before.has(c.file)
      ? draftItemText(c.file, o.before.get(c.file)!, c.item)
      : undefined;
    const now = after.has(c.file) ? draftItemText(c.file, after.get(c.file)!, c.item) : undefined;
    if (c.state === "waiting") {
      if (o.run) c.run = o.run;
      c.iteration = o.iteration;
    }
    if (before !== now) {
      c.state = "applied";
      c.appliedAt = o.at;
    } else c.state = "read";
    if (c.scope === "similar") {
      const like = c.like?.toLowerCase();
      const mine = `${c.file}#${c.item ?? ""}`;
      const touched = changedItems(
        (s) =>
          !like ||
          s.text.toLowerCase().includes(like) ||
          s.item.label.toLowerCase().includes(like) ||
          (s.item.like ?? []).some((x) => x.toLowerCase() === like),
      ).filter((x) => x !== mine);
      if (touched.length) c.touched = [...new Set([...(c.touched ?? []), ...touched])].sort();
    }
    settled.push(c);
  }
  if (settled.length) await writeCorrections(dir, change, cs);
  return settled;
}
