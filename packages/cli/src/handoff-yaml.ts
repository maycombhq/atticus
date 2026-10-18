import { readFile } from "node:fs/promises";
import { parse } from "yaml";

/**
 * The check `atticus handoff done` gives an answer that is not a change artifact (a lens review,
 * name proposals, definitions, template prose, story prose): it must be YAML. The command that
 * finishes the run reads it in full. An answer wrapped in a fenced code block is accepted, as the
 * parsers of those commands accept it.
 */
export async function yamlAnswerProblems(
  file: string,
  request: { outputPath: string },
): Promise<string[]> {
  try {
    const text = (await readFile(file, "utf8")).replace(/^```(?:ya?ml)?\s*\n|\n```\s*$/g, "");
    parse(text);
    return [];
  } catch (e) {
    return [`${request.outputPath} isn't YAML: ${(e as Error).message.split("\n")[0]}`];
  }
}
