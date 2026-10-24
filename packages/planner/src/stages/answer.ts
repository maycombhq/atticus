import { parse } from "yaml";
import type { z } from "zod";
import type { StageIssue } from "./loop.js";

/** Strip a Markdown code fence an assistant may put around its YAML. */
export const unfence = (text: string) =>
  text
    .replace(/\r\n/g, "\n")
    .replace(/^\s*```(?:ya?ml)?\s*\n/, "")
    .replace(/\n```\s*$/, "");

/** Parse YAML into a schema, the problems as blocking issues in plain words. */
export function parseYamlAs<S extends z.ZodType>(
  text: string,
  schema: S,
  fill: (data: Record<string, unknown>) => unknown,
  target: string,
): { value?: z.infer<S>; issues: StageIssue[] } {
  let data: unknown;
  try {
    data = parse(unfence(text));
  } catch (e) {
    return {
      issues: [
        {
          rule: "stage.format",
          target,
          message: `The answer isn't YAML: ${(e as Error).message.split("\n")[0]}`,
          blocking: true,
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
  if (!r.success)
    return {
      issues: r.error.issues.slice(0, 12).map((i) => ({
        rule: "stage.format",
        target: `${target}:${i.path.join(".")}`,
        message: `${i.path.join(".") || "(top)"}: ${i.message}`,
        blocking: true,
      })),
    };
  return { value: r.data as z.infer<S>, issues: [] };
}
