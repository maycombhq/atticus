import { parse } from "yaml";
import type { z } from "zod";
import type { StageIssue } from "./loop.js";
import { schemaProblems } from "./schema-words.js";

/** Strip a Markdown code fence an assistant may put around its YAML. */
export const unfence = (text: string) =>
  text
    .replace(/\r\n/g, "\n")
    .replace(/^\s*```(?:ya?ml)?\s*\n/, "")
    .replace(/\n```\s*$/, "");

/** How to write a value YAML reads as it is written (S5): Atticus's own words. */
export const YAML_QUOTE_RULE = "quote any value containing { } [ ] : or # in double quotes";
const capitalQuote = `${YAML_QUOTE_RULE.charAt(0).toUpperCase()}${YAML_QUOTE_RULE.slice(1)}.`;

/** Parse YAML into a schema, the problems as blocking issues in plain words. */
export function parseYamlAs<S extends z.ZodType>(
  text: string,
  schema: S,
  fill: (data: Record<string, unknown>) => unknown,
  target: string,
): { value?: z.infer<S>; issues: StageIssue[] } {
  let data: unknown;
  const body = unfence(text);
  try {
    data = parse(body);
  } catch (e) {
    // S5: the failing line, by its number and as written, read off the parser's position.
    const line = (e as { linePos?: { line: number }[] }).linePos?.[0]?.line;
    const said = (e as Error).message.split("\n")[0]!.replace(/ at line \d+, column \d+:?$/, "");
    const written = line ? body.split("\n")[line - 1]?.trimEnd() : undefined;
    return {
      issues: [
        {
          rule: "stage.format",
          target,
          message: `The answer isn't YAML: ${said}${line ? `, at line ${line}: ${written ?? ""}` : ""}. ${capitalQuote}`,
          blocking: true,
          syntax: true,
          ...(line ? { line } : {}),
        },
      ],
    };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data))
    return {
      issues: [
        {
          rule: "stage.format",
          target,
          message: "The answer isn't a YAML mapping.",
          blocking: true,
        },
      ],
    };
  // The gaps the answer relies on (ADR 0117) are read by the loop, not the stage's schema.
  const { relies_on_gaps: _gaps, ...rest } = data as Record<string, unknown>;
  void _gaps;
  const r = schema.safeParse(fill(rest));
  if (!r.success) {
    // R2: in plain words, at the answer's line.
    const issues = r.error.issues.slice(0, 12);
    const words = schemaProblems("answer", body, issues);
    return {
      issues: issues.map((i, n) => {
        const line = Number(/^answer:(\d+): /.exec(words[n]!)?.[1]);
        return {
          rule: "stage.format",
          target: `${target}:${i.path.join(".")}`,
          message: words[n]!.replace(/^answer:(\d+): /, "In your answer at line $1: "),
          blocking: true,
          ...(line ? { line } : {}),
        };
      }),
    };
  }
  return { value: r.data as z.infer<S>, issues: [] };
}
