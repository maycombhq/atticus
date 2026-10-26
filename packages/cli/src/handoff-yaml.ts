import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { lensAnswerProblem, lensRunOf } from "@maycombhq/naysayer";

/**
 * The check `atticus handoff done` gives an answer that is not a change artifact (a lens review,
 * name proposals, definitions, template prose, story prose): it must be YAML. The command that
 * finishes the run reads it in full. An answer wrapped in a fenced code block is accepted, as the
 * parsers of those commands accept it. A critic lens's answer must be a review: a findings list
 * (empty when it found nothing). An empty reply or a refusal fails here, so it is offered again
 * rather than read in as a clean review.
 */

/**
 * A yaml error as the person who has to fix the file needs it (ADR 0115 addendum 2026-10-26): its
 * line and column, the message without the quoted source block the library appends, and the
 * rewrite that fixes the commonest answer slip, an unquoted colon in a value. A fenced answer is
 * parsed with its fence stripped, so its line is one further down in the file: the fence's own
 * line is added back, and the line named is the line to open.
 */
function yamlProblem(e: unknown, file: string, fenced: boolean): string {
  const err = e as Error & { linePos?: { line: number; col: number }[] };
  const first = err.message.split("\n")[0]!.replace(/ at line \d+, column \d+:?$/, "");
  const pos = err.linePos?.[0];
  const where = pos ? ` (line ${pos.line + (fenced ? 1 : 0)}, column ${pos.col})` : "";
  return `${file} isn't YAML${where}: ${first}. A value that holds a colon, a #, or a { } [ ] goes in double quotes.`;
}

export async function yamlAnswerProblems(
  file: string,
  request: { outputPath: string; outputIn?: string },
): Promise<string[]> {
  const raw = await readFile(file, "utf8").catch(() => undefined);
  if (raw === undefined) return [`${request.outputPath} can't be read`];
  const stripped = raw.replace(/^```(?:ya?ml)?\s*\n|\n```\s*$/g, "");
  try {
    parse(stripped);
  } catch (e) {
    return [yamlProblem(e, request.outputPath, stripped !== raw)];
  }
  const why = lensRunOf(request) ? lensAnswerProblem(raw) : undefined;
  return why ? [`${request.outputPath}: ${why}`] : [];
}
