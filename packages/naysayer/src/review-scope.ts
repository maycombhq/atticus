import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { estimateTokens, type SourceInput } from "@maycombhq/ai";
import { Finding, runsDirOf, type CriticQuestion } from "@maycombhq/core";
import { writeFileAtomic } from "@maycombhq/changes";
import type { OpenFinding, ReviewSince } from "./ai.js";
import { fingerprint as fingerprintOf, readRound, readRoundMeta, wroteIn } from "./findings.js";
import { assistantClosed, readProposals, type Proposal } from "./proposals.js";

/**
 * What a critic round's lenses get, sized to need (ADR 0115 addendum, 2026-10-25, critic cost).
 * A live run spent 14 rounds of four lenses on one change, about 67.5k tokens a lens call, the
 * whole stage again each time. Now a redraft's lenses see the diff since the last reviewed draft
 * and the findings still open (findings about what didn't change are carried, not asked again),
 * and each lens gets only the estate that names what the draft names or what its question asks
 * about, capped at a share of its token budget. Facts and arithmetic only: no model decides.
 */

// ------------------------------------------------------------------ diff

export interface LineDiff {
  /** Whether the two texts differ at all. */
  changed: boolean;
  /** Each line of the old text that is still there, by its number then and now (1-based). */
  oldToNew: Map<number, number>;
  /** The lines of the new text that weren't in the old one. */
  addedNew: Set<number>;
  /** The edit script, in order: a kept, removed (old line) or added (new line) line. */
  ops: { op: "same" | "del" | "add"; text: string; old?: number; new?: number }[];
}

/** Lines as a Doc numbers them (doc.ts): the text split at each newline. */
const linesOf = (text: string) => text.replace(/\r\n/g, "\n").split("\n");

/** Past this many cells the diff isn't worked out: the file counts as changed throughout. */
const MAX_CELLS = 4_000_000;

/** A line diff (longest common subsequence) of two texts, with each kept line's numbers. */
export function diffLines(before: string, after: string): LineDiff {
  const a = linesOf(before);
  const b = linesOf(after);
  const ops: LineDiff["ops"] = [];
  if (before === after) {
    b.forEach((text, i) => ops.push({ op: "same", text, old: i + 1, new: i + 1 }));
  } else if (a.length * b.length > MAX_CELLS) {
    a.forEach((text, i) => ops.push({ op: "del", text, old: i + 1 }));
    b.forEach((text, i) => ops.push({ op: "add", text, new: i + 1 }));
  } else {
    // lcs[i][j]: the longest common subsequence of a[i..] and b[j..].
    const w = b.length + 1;
    const lcs = new Uint32Array((a.length + 1) * w);
    for (let i = a.length - 1; i >= 0; i--)
      for (let j = b.length - 1; j >= 0; j--)
        lcs[i * w + j] =
          a[i] === b[j]
            ? lcs[(i + 1) * w + j + 1]! + 1
            : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        ops.push({ op: "same", text: a[i]!, old: i + 1, new: j + 1 });
        i++;
        j++;
      } else if (j < b.length && (i === a.length || lcs[i * w + j + 1]! >= lcs[(i + 1) * w + j]!)) {
        ops.push({ op: "add", text: b[j]!, new: j + 1 });
        j++;
      } else {
        ops.push({ op: "del", text: a[i]!, old: i + 1 });
        i++;
      }
    }
    // Within a run of changes, removed lines first, then added: it reads as a replacement.
    for (let k = 0; k < ops.length;) {
      if (ops[k]!.op === "same") {
        k++;
        continue;
      }
      let e = k;
      while (e < ops.length && ops[e]!.op !== "same") e++;
      const run = ops.slice(k, e);
      ops.splice(
        k,
        run.length,
        ...run.filter((x) => x.op === "del"),
        ...run.filter((x) => x.op === "add"),
      );
      k = e;
    }
  }
  const oldToNew = new Map<number, number>();
  const addedNew = new Set<number>();
  for (const o of ops) {
    if (o.op === "same") oldToNew.set(o.old!, o.new!);
    if (o.op === "add") addedNew.add(o.new!);
  }
  return { changed: before !== after, oldToNew, addedNew, ops };
}

/**
 * The change as hunks a lens reads: each line kept or added with its number now (`7: text`), each
 * removed line as `-: text`, `context` kept lines around each change, and a header naming the
 * lines it covers now. The lens cites the numbers now, as it does a whole file's.
 */
export function diffText(d: LineDiff, o: { context?: number } = {}): string {
  const ctx = o.context ?? 3;
  const show = new Set<number>();
  d.ops.forEach((op, k) => {
    if (op.op === "same") return;
    for (let x = Math.max(0, k - ctx); x <= Math.min(d.ops.length - 1, k + ctx); x++) show.add(x);
  });
  const out: string[] = [];
  let hunk: string[] = [];
  let first: number | undefined;
  let last: number | undefined;
  const flush = () => {
    if (!hunk.length) return;
    out.push(
      `@@ ${first === undefined ? "removed lines" : `lines ${first}-${last ?? first} now`} @@`,
      ...hunk,
    );
    hunk = [];
    first = last = undefined;
  };
  d.ops.forEach((op, k) => {
    if (!show.has(k)) {
      flush();
      return;
    }
    if (op.op === "del") hunk.push(`-: ${op.text}`);
    else {
      hunk.push(`${op.new}: ${op.text}`);
      first ??= op.new;
      last = op.new;
    }
  });
  flush();
  return out.join("\n");
}

// ------------------------------------------------------------------ the last reviewed draft

/** The folder under .runs/ that keeps reviewed texts, apart from the changes' run folders. */
export const REVIEWED = ".reviewed";

/**
 * Where a round keeps the texts its lenses reviewed, by path:
 * `.runs/.reviewed/<change>/<gate>/<round>/` (gitignored, on this machine). A round on another
 * machine, or a cleaned .runs/, has none, and the next round reviews the whole draft again.
 */
export const reviewedDir = (root: string, change: string, gate: string, round: number) =>
  join(runsDirOf(root), REVIEWED, change, gate, String(round));

/** The key the people's answers the lenses were given are kept under: a new answer moves the brief. */
export const ANSWERS_TEXT = "source/answers-on-file";

/** A text kept for a data block the stage worked out (not a file): `source/<id>`. */
export const SOURCE_PREFIX = "source/";

/** Keep what a round's lenses were sent, and drop what older rounds at the gate kept. */
export async function keepReviewed(
  root: string,
  change: string,
  gate: string,
  round: number,
  texts: Map<string, string>,
): Promise<void> {
  const dir = reviewedDir(root, change, gate, round);
  for (const [path, text] of texts) {
    if (path.split("/").includes("..")) continue;
    const f = join(dir, ...path.split("/"));
    await mkdir(dirname(f), { recursive: true });
    await writeFileAtomic(f, text);
  }
}

/** Drop the texts kept for rounds at a gate older than `round`. */
export async function dropReviewedBefore(
  root: string,
  change: string,
  gate: string,
  round: number,
): Promise<void> {
  const base = join(runsDirOf(root), REVIEWED, change, gate);
  for (const n of await readdir(base).catch(() => [] as string[]))
    if (/^\d+$/.test(n) && Number(n) < round)
      await rm(join(base, n), { recursive: true, force: true });
}

async function readTree(dir: string, rel = ""): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const e of await readdir(join(dir, rel), { withFileTypes: true }).catch(() => [])) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) for (const [k, v] of await readTree(dir, p)) out.set(k, v);
    else out.set(p, await readFile(join(dir, ...p.split("/")), "utf8"));
  }
  return out;
}

/**
 * The last reviewed draft at a gate before `round`: the newest earlier round in which every lens
 * that was due reviewed (none failed or is still out, at least one ran), with the texts it kept.
 * Undefined when there is none: the round reviews the whole draft.
 */
export async function lastReviewed(
  root: string,
  change: string,
  gate: string,
  round: number,
): Promise<{ round: number; texts: Map<string, string> } | undefined> {
  const base = join(runsDirOf(root), REVIEWED, change, gate);
  const kept = (await readdir(base).catch(() => [] as string[]))
    .filter((n) => /^\d+$/.test(n) && Number(n) < round)
    .map(Number)
    .sort((a, b) => b - a);
  for (const n of kept) {
    const meta = await readRoundMeta(root, change, gate, n);
    const due = (meta?.lenses ?? []).filter((l) => l.state !== "skipped");
    if (!due.length || due.some((l) => l.state !== "ran")) continue;
    const texts = await readTree(join(base, String(n)));
    if (texts.size) return { round: n, texts };
  }
  return undefined;
}

// ------------------------------------------------------------------ context sized to need

/** The words each question asks about, kept whatever the draft names (lower case, matched as text). */
const QUESTION_WORDS: Record<CriticQuestion, string[]> = {
  true: [],
  complete: ["error", "timeout", "retry", "refus", "empty state", "accessib", "acceptance"],
  safe: [
    "auth",
    "token",
    "secret",
    "personal",
    "consent",
    "privacy",
    "encrypt",
    "permission",
    "role ",
    "password",
    "card",
    "classification",
  ],
  ship: [
    "deploy",
    "rollback",
    "roll back",
    "migration",
    "release",
    "alert",
    "monitor",
    "dashboard",
    "lead time",
    "request",
    "approval",
    "vendor",
    "firewall",
    "on-call",
    "runbook",
  ],
};

/** The shortest term worth matching; shorter ones match too much. */
const MIN_TERM = 4;

/**
 * The ids and names a text uses, lower case: dotted, hyphenated and path-like ids and each dotted
 * part of them (`forge-orders.place-order`, `forge-orders`), camelCase names, code in backticks,
 * and names of two or more capitalised words ("Northwind Pay").
 */
export function focusTerms(text: string): string[] {
  const out = new Set<string>();
  const add = (s: string) => {
    const t = s.trim().toLowerCase();
    if (t.length >= MIN_TERM) out.add(t);
  };
  for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9]*(?:[._/-][A-Za-z0-9{}]+)+/g)) {
    add(m[0]);
    for (const part of m[0].split(/[./]/)) if (/[-_]/.test(part)) add(part);
  }
  for (const m of text.matchAll(/\b[a-z]+[A-Z][A-Za-z0-9]*\b/g)) add(m[0]);
  for (const m of text.matchAll(/`([^`\n]{4,60})`/g)) add(m[1]!);
  for (const m of text.matchAll(/\b[A-Z][a-z0-9]+(?:[ ][A-Z][a-z0-9]+)+\b/g)) add(m[0]);
  return [...out].sort();
}

/** A source's text as a header (its first paragraph, when more follows) and entries. */
function entriesOf(text: string, code: boolean): { header: string[]; entries: string[] } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blank = lines.findIndex((l) => l.trim() === "");
  const hasMore = blank > 0 && lines.slice(blank).some((l) => l.trim() !== "");
  const header = hasMore ? lines.slice(0, blank) : [];
  const body = hasMore ? lines.slice(blank + 1) : lines;
  const entries: string[] = [];
  let cur: string[] = [];
  const end = () => {
    if (cur.some((l) => l.trim() !== "")) entries.push(cur.join("\n").replace(/\n+$/, ""));
    cur = [];
  };
  for (const l of body) {
    // Code goes by blank-line blocks; everything else by lines, with indented lines joined to
    // the entry above them (a YAML item, a wrapped line).
    const starts = code ? l.trim() === "" : l.trim() !== "" && !/^\s/.test(l);
    if (starts) end();
    if (l.trim() !== "" || code) cur.push(l);
  }
  end();
  return { header, entries };
}

export interface TrimmedSource {
  source: string;
  /** Tokens before and after; 0 after when the source was left out. */
  from: number;
  to: number;
}

/**
 * Each source cut to what bears on the draft and the lens's question: the header, and the entries
 * that name a focus term or one of the question's words, in their order, up to a cap of a
 * thirty-second of the lens's token budget for each source (the budget is the org pack's, runtime.yaml
 * `budgets`). A term that names more than three in five of a source's entries (the system every
 * line names) doesn't count there. A source with nothing left is left out; one with nothing cut
 * is sent as it was. What was cut is said in the text and returned.
 */
export function trimSources(
  sources: SourceInput[],
  o: { focus: readonly string[]; question: CriticQuestion; budget: number },
): { sources: SourceInput[]; trimmed: TrimmedSource[] } {
  const cap = Math.max(250, Math.floor(o.budget / 32));
  const words = QUESTION_WORDS[o.question];
  const out: SourceInput[] = [];
  const trimmed: TrimmedSource[] = [];
  for (const s of sources) {
    const from = estimateTokens(s.text);
    const { header, entries } = entriesOf(s.text, s.kind === "code");
    const low = entries.map((e) => e.toLowerCase());
    const terms = o.focus.filter((t) => {
      if (entries.length < 5) return true;
      return low.filter((e) => e.includes(t)).length <= (entries.length * 3) / 5;
    });
    const keep: string[] = [];
    let used = estimateTokens(header.join("\n"));
    let left = 0;
    for (let k = 0; k < entries.length; k++) {
      const e = low[k]!;
      const hit = terms.some((t) => e.includes(t)) || words.some((w) => e.includes(w));
      const cost = estimateTokens(entries[k]!) + 1;
      if (!hit || used + cost > cap) {
        left++;
        continue;
      }
      keep.push(entries[k]!);
      used += cost;
    }
    if (left === 0) {
      out.push(s);
      continue;
    }
    if (!keep.length) {
      trimmed.push({ source: s.id, from, to: 0 });
      continue;
    }
    const text = [
      ...(header.length ? [...header, ""] : []),
      ...keep,
      "",
      `(${left} of ${entries.length} entries left out: they name nothing the draft names or this lens asks about, or the source was over its share of the budget.)`,
    ].join("\n");
    out.push({ ...s, text });
    trimmed.push({ source: s.id, from, to: estimateTokens(text) });
  }
  return { sources: out, trimmed };
}

// ------------------------------------------------------------------ findings carried

/** What a redraft's round starts from: the last reviewed draft, what is open, what is carried. */
export interface SinceReview {
  since: ReviewSince;
  /** Findings of the last reviewed round about parts that didn't change, as this round's. */
  carry: Finding[];
  /** What assistants proposed about the carried findings that still waits on a person. */
  proposals: Proposal[];
}

/**
 * A redraft's review scope (ADR 0115 addendum, 2026-10-25): the last reviewed round at the gate,
 * and each AI finding of it, of a question this round asks. One whose file, line and evidence
 * lines didn't change is carried into this round as it was (still open, or as a person resolved
 * it), its lines moved to where they are now. One about a part that changed, still open, goes to
 * the lens with what an assistant said about it, for the lens to judge again: a claim that it is
 * fixed is checked, never trusted. An assistant's resolution of a blocking or risk finding closed
 * nothing, so it is carried open.
 */
export async function sinceReview(
  root: string,
  o: {
    change: string;
    gate: string;
    round: number;
    now: string;
    /** The texts the lenses review now, by path. */
    texts: ReadonlyMap<string, string>;
    questions: readonly string[];
    /** The round before this one, when it isn't the last reviewed: what a person decided there holds. */
    prior?: number | undefined;
  },
): Promise<SinceReview | undefined> {
  const last = await lastReviewed(root, o.change, o.gate, o.round);
  if (!last) return undefined;
  const meta = await readRoundMeta(root, o.change, o.gate, last.round);
  // A person answered a question since: the brief moved, so the lenses review the whole draft
  // against it again, and nothing is carried.
  if ((last.texts.get(ANSWERS_TEXT) ?? "") !== (o.texts.get(ANSWERS_TEXT) ?? "")) return undefined;
  const ai = new Set((meta?.findings ?? []).filter((f) => f.layer === "ai").map((f) => f.id));
  // A person's decision, or an assistant's proposal, made in a later round (one whose lenses
  // didn't review: nothing had changed, say) about the same finding holds over the older round's.
  const later = o.prior !== undefined && o.prior > last.round ? o.prior : undefined;
  const decided = new Map<string, Finding>();
  const laterProposals = new Map<string, Proposal>();
  const laterHas = new Set<string>();
  if (later !== undefined) {
    const read = await readRound(root, o.change, o.gate, later);
    const props = await readProposals(root, o.change, o.gate, later);
    for (const { finding: f } of read.findings) {
      laterHas.add(fingerprintOf(f));
      if (["dismissed", "waived", "asked"].includes(f.state) && !assistantClosed(f))
        decided.set(fingerprintOf(f), f);
      const p = props.find((x) => x.finding === f.id);
      if (p) laterProposals.set(fingerprintOf(f), p);
    }
  }
  const proposals = await readProposals(root, o.change, o.gate, last.round);
  const proposalOf = (f: Finding): Proposal | undefined => {
    const fp = fingerprintOf(f);
    if (laterHas.has(fp)) return decided.has(fp) ? undefined : laterProposals.get(fp);
    return proposals.find((p) => p.finding === f.id);
  };
  const diffs = new Map<string, LineDiff>();
  // A line's number now; null when it changed or its file is gone (undefined: no line, unchanged).
  const lineNow = (path: string, line: number | undefined): number | null | undefined => {
    const was = last.texts.get(path);
    const now = o.texts.get(path);
    if (was === undefined || now === undefined) return null;
    if (line === undefined) return was === now ? undefined : null;
    if (was === now) return line;
    let d = diffs.get(path);
    if (!d) diffs.set(path, (d = diffLines(was, now)));
    return d.oldToNew.get(line) ?? null;
  };
  const open: OpenFinding[] = [];
  const carry: Finding[] = [];
  const carried: Proposal[] = [];
  for (const { finding: f } of (await readRound(root, o.change, o.gate, last.round)).findings) {
    if (!ai.has(f.id) || !o.questions.includes(f.lens)) continue;
    const byPerson = decided.get(fingerprintOf(f));
    const reopened = !byPerson && assistantClosed(f);
    const proposal = proposalOf(f);
    // A fix marked applied is a claim the lens checks, as an assistant's is.
    const applied = f.state === "applied" && !wroteIn(f);
    const stillOpen = !byPerson && (f.state === "open" || reopened || applied);
    const line = lineNow(f.artifact, f.locator.line);
    const evidence = f.evidence.map((e) =>
      e.path && e.source === "artifact"
        ? { e, line: lineNow(e.path, e.line) }
        : { e, line: e.line },
    );
    // A part that didn't change is carried, whatever an assistant claimed: a claim that it was
    // fixed is plainly not borne out there, and drops.
    const same = line !== null && evidence.every((x) => x.line !== null);
    if (!same) {
      if (stillOpen)
        open.push({
          id: f.id,
          rule: f.rule,
          lens: f.lens,
          severity: f.severity,
          artifact: f.artifact,
          ...(f.locator.line ? { line: f.locator.line } : {}),
          summary: f.summary,
          ...(proposal
            ? {
                proposal: {
                  claim: proposal.claim,
                  by: proposal.by,
                  ...(proposal.reason ? { reason: proposal.reason } : {}),
                },
              }
            : {}),
        });
      continue;
    }
    // A decision carries as writeHits carries one: a dismissal, a waiver, a question asked, a fact
    // written in. A fix marked applied, on a part that didn't change, didn't take: it is open.
    const { resolution: was, state: wasState, ...rest } = f;
    const keeps = ["dismissed", "waived", "asked"].includes(wasState) || wroteIn(f);
    const resolution = byPerson?.resolution ?? (keeps ? was : undefined);
    const state = byPerson?.state ?? wasState;
    carry.push(
      Finding.parse({
        ...rest,
        round: o.round,
        locator: { ...f.locator, ...(line ? { line } : {}) },
        evidence: evidence.map((x) => ({ ...x.e, ...(x.line ? { line: x.line } : {}) })),
        createdAt: o.now,
        ...(reopened || !resolution ? { state: "open" } : { state, resolution }),
      }),
    );
    if (proposal?.claim === "not-relevant" && stillOpen) carried.push(proposal);
  }
  return { since: { round: last.round, texts: last.texts, open }, carry, proposals: carried };
}
