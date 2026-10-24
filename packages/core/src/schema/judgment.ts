import { z } from "zod";
import { IsoDateTime } from "./common.js";

/**
 * A judgment (ADR 0117, C5): a closed question about meaning that a model answered (or a
 * person, or a check), kept as judgments/<kind>/<key>.yaml in the metarepo. The key is a hash
 * of exactly what was judged, so the same inputs read the stored verdict instead of asking the
 * model again, and a changed input asks again for its own judgment only. Committed for review
 * as questions/ is; a person can override a verdict, and the override is kept beside what it
 * replaced.
 */

export const JUDGMENT_SCHEMA_VERSION = 1 as const;

/** The kind of judgment, e.g. same-question, covers-field, states-value, applies. */
export const JudgmentKind = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,63}$/, "a judgment kind is lower case words joined by -");

/** The hash of the inputs: 24 hex characters. */
export const JudgmentKey = z
  .string()
  .regex(/^[0-9a-f]{24}$/, "a judgment key is 24 hex characters");

/** Words a verdict rests on, checked word for word against the input it names. */
export const JudgmentQuote = z.strictObject({
  /** Which input the words are from (an input's name, e.g. "new" or "existing"). */
  of: z.string().min(1),
  text: z.string().trim().min(1),
});
export type JudgmentQuote = z.infer<typeof JudgmentQuote>;

/** Who settled it: a deterministic check, a model run, or a person. */
export const JudgmentConfirmer = z.discriminatedUnion("by", [
  z.strictObject({
    by: z.literal("check"),
    /** The check that settled it, e.g. "veto:different-ids" or "verbatim". */
    rule: z.string().min(1),
  }),
  z.strictObject({
    by: z.literal("ai"),
    /** The run that answered: a run id under .runs/, or a recording's. */
    run: z.string().min(1),
    model: z.string().min(1).optional(),
  }),
  z.strictObject({
    by: z.literal("person"),
    /** The Git user who decided. */
    name: z.string().min(1),
  }),
]);
export type JudgmentConfirmer = z.infer<typeof JudgmentConfirmer>;

/** A verdict: one word of the kind's closed set, or the candidate ids chosen. */
export const JudgmentVerdict = z.union([z.string().min(1), z.array(z.string().min(1))]);
export type JudgmentVerdict = z.infer<typeof JudgmentVerdict>;

export const Judgment = z.strictObject({
  schemaVersion: z.literal(JUDGMENT_SCHEMA_VERSION),
  kind: JudgmentKind,
  key: JudgmentKey,
  verdict: JudgmentVerdict,
  /** A normalised value the verdict carries, e.g. a lead time as { min, max, unit }. */
  value: z.unknown().optional(),
  quotes: z.array(JudgmentQuote).default([]),
  /** One sentence: why, in the judge's words. */
  why: z.string().trim().min(1).optional(),
  /** What was judged, as hashed into the key, for a person to read. */
  inputs: z.record(z.string(), z.unknown()),
  confirmedBy: JudgmentConfirmer,
  /** When a person overrode it: the verdict and confirmer it replaced. */
  overrides: z
    .strictObject({
      verdict: JudgmentVerdict,
      value: z.unknown().optional(),
      confirmedBy: JudgmentConfirmer,
    })
    .optional(),
  at: IsoDateTime,
});
export type Judgment = z.infer<typeof Judgment>;
