import { z } from "zod";
import { normalizeFactPaths } from "../fact-paths.js";
import { FactId, FACT_KINDS } from "./facts.js";
import { AI_RUNTIMES, AppliedRule, BatchId, DecideBar } from "./question.js";

/**
 * A person's correction of a fact (ADR 0124 addendum D-app, F3): `facts/<repo>.corrections.jsonl`
 * (`.atticus/facts/` when adopted), one JSON object per line, written from the Map in the app.
 * The verifier applies every correction to the facts it is given, each time it runs, so a
 * correction outlives the next read: a fact marked wrong is left out of what the verifier keeps,
 * and an edited fact becomes a person's fact (`by: person`, `verified: person`) whose claim is
 * still checked on its line, because every fact cites its code (CLAUDE.md rule 4).
 *
 * A correction names the fact it is about twice: by id, and by what the assistant cited (kind,
 * file, line and value), so a read that gives the same fact another id still meets it. One that
 * meets no fact is stale: the verifier says so and applies nothing.
 */

/**
 * Version 2 (ADR 0181) adds what AI deciding needs, all optional: `ai` (a pairing Atticus applied
 * from an AI run: by `atticus`, never the person, joined `joined-by-ai`), `batch` (the batch that
 * wrote a line, so Undo removes exactly its lines), `rule` (a line a person's rule wrote, from
 * which correction), `match` (the rule a person's correction spreads, "Apply to similar") and the
 * action `unlink` (a person says the call reaches none of these). A version 1 line reads as it
 * is and means the same; a line that uses any of them says version 2.
 */
export const FACT_CORRECTIONS_SCHEMA_VERSION = 2 as const;

/** ADR 0181: who writes an AI pairing's line: Atticus, from the run, never the session or a person. */
export const AI_LINE_BY = "atticus";

/** ADR 0181: the AI run a pairing came from, and the bar it met to be applied. */
export const CorrectionAi = z.strictObject({
  runtime: z.enum(AI_RUNTIMES),
  run: z.string().trim().min(1),
  bar: DecideBar.optional(),
});
export type CorrectionAi = z.infer<typeof CorrectionAi>;

/** The fields of a fact a correction may not set: what it is, where it comes from, who checked it. */
export const FACT_FIXED_FIELDS = [
  "kind",
  "id",
  "repo",
  "commit",
  "cite",
  "verified",
  "by",
  "conf",
] as const;

/**
 * G1 (ADR 0174): what a person paired a call with on the canvas: an entry of a repo (its id when
 * paired, and its method and path, to find it again after a read gives it another id), or an
 * outside system's operation. The call's own fact is left as read; the join reads the pairing.
 */
export const CorrectionLink = z
  .strictObject({
    repo: z.string().min(1).optional(),
    system: z.string().min(1).optional(),
    entry: FactId.optional(),
    method: z.string().min(1).optional(),
    path: z.string().min(1),
  })
  .refine((l) => !!l.repo !== !!l.system, {
    message: "a link names a repo or an outside system, one of them",
  });
export type CorrectionLink = z.infer<typeof CorrectionLink>;

export const FactCorrection = z
  .strictObject({
    schemaVersion: z.union([z.literal(1), z.literal(FACT_CORRECTIONS_SCHEMA_VERSION)]),
    /** The fact's id, as the facts file had it when the person corrected it. */
    fact: FactId,
    /** What the assistant cited: the fact a correction is about when a read changes its id. */
    target: z.strictObject({
      kind: z.enum(FACT_KINDS),
      file: z.string().min(1),
      line: z.number().int().positive(),
      value: z.string().min(1),
    }),
    /**
     * wrong: the fact isn't so, and is left out; edit: its claim is what `set` says; link (G1,
     * ADR 0174): a call the person paired with the API in `link`, the fact itself unchanged.
     */
    action: z.enum(["wrong", "edit", "link", "unlink"]),
    /** For link: what the call reaches. */
    link: CorrectionLink.optional(),
    /** For edit: the fact's own fields with their new values (`value` sets the cite's value). */
    set: z.record(z.string().min(1), z.string()).optional(),
    /** For edit: the line the claim is on, when the assistant cited the wrong one. */
    line: z.number().int().positive().optional(),
    /** Why, in the person's words: required to mark a fact wrong. */
    reason: z.string().trim().min(1).max(500).optional(),
    /** The Git user who corrected it (ADR 0073); `atticus` for an AI pairing (ADR 0181). */
    by: z.string().min(1),
    at: z.iso.datetime({ offset: true }),
    /** Version 2 (ADR 0181): an AI pairing, with the run that made it. */
    ai: CorrectionAi.optional(),
    /** Version 2 (ADR 0181): the batch that wrote the line. */
    batch: BatchId.optional(),
    /** Version 2 (ADR 0181): a person's rule wrote it, from their correction. */
    rule: AppliedRule.optional(),
    /** Version 2 (ADR 0181): the rule the person's correction spreads (a path prefix, host or topic pattern). */
    match: z.string().trim().min(1).max(300).optional(),
  })
  .superRefine((c, ctx) => {
    const v2 = c.ai || c.batch || c.rule || c.match || c.action === "unlink";
    if (v2 && c.schemaVersion !== FACT_CORRECTIONS_SCHEMA_VERSION)
      ctx.addIssue({
        code: "custom",
        path: ["schemaVersion"],
        message: "ai, batch, rule, match and unlink are version 2's (ADR 0181)",
      });
    if (c.ai) {
      // ADR 0181: an AI decision is a pairing with a repo's entry, written by Atticus as the AI's.
      if (c.action !== "link" || !c.link?.repo)
        ctx.addIssue({
          code: "custom",
          path: ["ai"],
          message: "the AI only pairs a call with a repo's entry",
        });
      if (c.by !== AI_LINE_BY)
        ctx.addIssue({
          code: "custom",
          path: ["by"],
          message: `an AI pairing is written by ${AI_LINE_BY}, never as a person`,
        });
      if (c.rule || c.match)
        ctx.addIssue({ code: "custom", path: ["rule"], message: "an AI pairing carries no rule" });
    } else if (c.by === AI_LINE_BY && c.rule === undefined && c.action !== "wrong")
      ctx.addIssue({
        code: "custom",
        path: ["by"],
        message: `${AI_LINE_BY} writes only an AI pairing: say the run (ai)`,
      });
    if (c.action === "unlink") {
      if (c.target.kind !== "call")
        ctx.addIssue({
          code: "custom",
          path: ["target", "kind"],
          message: "only a call is unlinked",
        });
      if (c.link || c.set || c.line !== undefined)
        ctx.addIssue({
          code: "custom",
          path: ["link"],
          message: "an unlink names no API and sets nothing",
        });
      return;
    }
    if (c.action === "link") {
      if (!c.link)
        ctx.addIssue({
          code: "custom",
          path: ["link"],
          message: "a link says what the call reaches",
        });
      if (c.target.kind !== "call")
        ctx.addIssue({
          code: "custom",
          path: ["target", "kind"],
          message: "only a call is linked",
        });
      if (c.set || c.line !== undefined)
        ctx.addIssue({ code: "custom", path: ["set"], message: "a link sets nothing on the fact" });
      return;
    }
    if (c.link)
      ctx.addIssue({ code: "custom", path: ["link"], message: "only a link action has a link" });
    if (c.action === "wrong" && !c.reason)
      ctx.addIssue({ code: "custom", path: ["reason"], message: "say why the fact is wrong" });
    if (c.action === "edit") {
      if (!c.set && c.line === undefined)
        ctx.addIssue({
          code: "custom",
          path: ["set"],
          message: "an edit sets a field or the line",
        });
      for (const k of Object.keys(c.set ?? {}))
        if ((FACT_FIXED_FIELDS as readonly string[]).includes(k))
          ctx.addIssue({
            code: "custom",
            path: ["set", k],
            message: `${k} isn't a fact's claim: a correction can't set it`,
          });
    } else if (c.set || c.line !== undefined)
      ctx.addIssue({
        code: "custom",
        path: ["set"],
        message: "a fact marked wrong sets nothing",
      });
  });
export type FactCorrection = z.infer<typeof FactCorrection>;

/** The corrections of a file's text, one per line; a line that isn't one is a problem with its number. */
export function parseCorrections(text: string): {
  corrections: FactCorrection[];
  bad: { line: number; message: string }[];
} {
  const corrections: FactCorrection[] = [];
  const bad: { line: number; message: string }[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    if (!raw.trim()) return;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (e) {
      bad.push({ line: i + 1, message: `not JSON: ${(e as Error).message}` });
      return;
    }
    // W-paths: the target's file with `/`, as the facts it meets are read.
    const r = FactCorrection.safeParse(normalizeFactPaths(json));
    if (r.success) corrections.push(r.data);
    else
      bad.push({
        line: i + 1,
        message: r.error.issues
          .map((x) => `${x.path.join(".") || "(root)"}: ${x.message}`)
          .join("; "),
      });
  });
  return { corrections, bad };
}

/** One correction as its line in the file, keys in a fixed order. */
export function correctionLine(c: FactCorrection): string {
  const p = FactCorrection.parse(c);
  const order = [
    "schemaVersion",
    "fact",
    "target",
    "action",
    "set",
    "line",
    "link",
    "reason",
    "by",
    "at",
    "ai",
    "batch",
    "rule",
    "match",
  ];
  const out: Record<string, unknown> = {};
  for (const k of order)
    if ((p as Record<string, unknown>)[k] !== undefined) out[k] = (p as Record<string, unknown>)[k];
  return JSON.stringify(out);
}

type CallLike = { kind: string; id: string; cite: { file: string; line: number; value: string } };

/**
 * G1 (ADR 0174): every pairing (`link`) that meets a call, newest first: on its cited line by its
 * id or by what it cites, or by its id where an edit of the same fact moved it to the line it is
 * on now. One matcher for the verifier and the join.
 */
export function linksFor(f: CallLike, corrections: readonly FactCorrection[]): FactCorrection[] {
  if (f.kind !== "call") return [];
  const moved = corrections.some(
    (c) => c.action === "edit" && c.fact === f.id && c.line === f.cite.line,
  );
  // Newest first; of two at the same time, the later line in the file (ADR 0181: a rule's line
  // written in the same instant as the AI's it replaces).
  return corrections
    .map((c, i) => [c, i] as const)
    .filter(
      ([c]) =>
        ((c.action === "link" && !!c.link) || c.action === "unlink") &&
        c.target.kind === "call" &&
        c.target.file === f.cite.file &&
        ((c.target.line === f.cite.line && (c.fact === f.id || c.target.value === f.cite.value)) ||
          (moved && c.fact === f.id)),
    )
    .sort(([a, i], [b, j]) => (a.at < b.at ? 1 : a.at > b.at ? -1 : j - i))
    .map(([c]) => c);
}

/**
 * A pairing as the join reads it: what the call reaches, who said so, and (ADR 0181) the AI run.
 * Review round 48: `none` when a person's `unlink` is the newest (asked for with `declined`): the
 * call reaches nothing a person knows of, so an AI answer never joins it (the path is the call's).
 */
export type PairOnFile = CorrectionLink & { by: string; ai?: CorrectionAi; none?: true };

/**
 * G1 (ADR 0174): a repo's pairings, call fact id → what the person paired it with, from its
 * corrections file: the newest link per call (a repo's or an outside system's), met as linksFor
 * meets it. A link that meets no call is left out (the verifier says so). ADR 0181: an AI
 * pairing keeps its run (`ai`); a newer `unlink` withdraws any pairing. With `declined` (the
 * join's read, round 48), a person's newest `unlink` is kept as `none`, so the join knows a
 * person said "none" and an AI answer doesn't join the call.
 */
export function pairsFromCorrections(
  facts: readonly CallLike[],
  corrections: readonly FactCorrection[],
  o: { declined?: boolean } = {},
): Record<string, PairOnFile> {
  const out: Record<string, PairOnFile> = {};
  for (const f of facts) {
    const c = linksFor(f, corrections)[0];
    if (c?.action === "link" && c.link)
      out[f.id] = { ...c.link, by: c.by, ...(c.ai ? { ai: { ...c.ai } } : {}) };
    else if (o.declined && c?.action === "unlink" && !c.ai)
      out[f.id] = { path: c.target.value, by: c.by, none: true };
  }
  return out;
}
