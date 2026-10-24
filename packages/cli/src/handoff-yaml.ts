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
export async function yamlAnswerProblems(
  file: string,
  request: { outputPath: string; outputIn?: string },
): Promise<string[]> {
  try {
    const raw = await readFile(file, "utf8");
    parse(raw.replace(/^```(?:ya?ml)?\s*\n|\n```\s*$/g, ""));
    const why = lensRunOf(request) ? lensAnswerProblem(raw) : undefined;
    return why ? [`${request.outputPath}: ${why}`] : [];
  } catch (e) {
    return [`${request.outputPath} isn't YAML: ${(e as Error).message.split("\n")[0]}`];
  }
}
