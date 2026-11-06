import { z } from "zod";
import { normalizeFactPaths } from "../fact-paths.js";
import { FactId, FACT_KINDS } from "./facts.js";

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

export const FACT_CORRECTIONS_SCHEMA_VERSION = 1 as const;

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
    schemaVersion: z.literal(FACT_CORRECTIONS_SCHEMA_VERSION),
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
    action: z.enum(["wrong", "edit", "link"]),
    /** For link: what the call reaches. */
    link: CorrectionLink.optional(),
    /** For edit: the fact's own fields with their new values (`value` sets the cite's value). */
    set: z.record(z.string().min(1), z.string()).optional(),
    /** For edit: the line the claim is on, when the assistant cited the wrong one. */
    line: z.number().int().positive().optional(),
    /** Why, in the person's words: required to mark a fact wrong. */
    reason: z.string().trim().min(1).max(500).optional(),
    /** The Git user who corrected it (ADR 0073). */
    by: z.string().min(1),
    at: z.iso.datetime({ offset: true }),
  })
  .superRefine((c, ctx) => {
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
  return corrections
    .filter(
      (c) =>
        c.action === "link" &&
        !!c.link &&
        c.target.kind === "call" &&
        c.target.file === f.cite.file &&
        ((c.target.line === f.cite.line && (c.fact === f.id || c.target.value === f.cite.value)) ||
          (moved && c.fact === f.id)),
    )
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/**
 * G1 (ADR 0174): a repo's pairings, call fact id → what the person paired it with, from its
 * corrections file: the newest link per call (a repo's or an outside system's), met as linksFor
 * meets it. A link that meets no call is left out (the verifier says so).
 */
export function pairsFromCorrections(
  facts: readonly CallLike[],
  corrections: readonly FactCorrection[],
): Record<string, CorrectionLink & { by: string }> {
  const out: Record<string, CorrectionLink & { by: string }> = {};
  for (const f of facts) {
    const c = linksFor(f, corrections)[0];
    if (c?.link) out[f.id] = { ...c.link, by: c.by };
  }
  return out;
}
