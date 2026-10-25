import { z } from "zod";
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
    /** wrong: the fact isn't so, and is left out; edit: its claim is what `set` says. */
    action: z.enum(["wrong", "edit"]),
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
    const r = FactCorrection.safeParse(json);
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
  const order = ["schemaVersion", "fact", "target", "action", "set", "line", "reason", "by", "at"];
  const out: Record<string, unknown> = {};
  for (const k of order)
    if ((p as Record<string, unknown>)[k] !== undefined) out[k] = (p as Record<string, unknown>)[k];
  return JSON.stringify(out);
}
