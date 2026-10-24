import {
  contextToolBox,
  defaultCodeDir,
  namesInCode,
  openIndex,
  workspaceRepos,
  type ContextToolOptions,
} from "@maycombhq/index";

/**
 * The context tools of a metarepo as this CLI offers them (ADR 0107 addendum, ADR 0118): the
 * index's tools, the code read from the base clones under workspace/, and the outline from the
 * syntax trees the readers parse (packages/extractors). The model runtime, `atticus context`,
 * the VS Code extension's tool calls and the MCP server all get them from here.
 */

/** Repos a step reads from a folder outside workspace/ (a survey of a folder), by id. */
const offered = new Map<string, string>();

/** Let the tools read a repo by its id from a folder outside workspace/, for this process. */
export function offerCodeDir(repo: string, dir: string): void {
  offered.set(repo, dir);
}

export function codeToolOptions(root: string): ContextToolOptions {
  return {
    codeDir: (r) => offered.get(r) ?? defaultCodeDir(root, r),
    repos: () => [...new Set([...workspaceRepos(root), ...offered.keys()])].sort(),
    // Loaded on first use: the readers are large, and most commands never outline a file.
    outline: async (path, text) =>
      (await import("@maycombhq/extractors")).declarationOutline(path, text),
  };
}

/** The tool box; `calls`, a run's earlier calls, gives show_code the hits they returned. */
export function metarepoToolBox(root: string, calls?: { name: string; output: string }[]) {
  return contextToolBox(root, () => openIndex(root), {
    ...codeToolOptions(root),
    ...(calls ? { calls } : {}),
  });
}

/**
 * The code search the critic checks a lens's "missing" names with (W1): a name is in the code
 * by its declaration in a source file, or as a file of a repo's tree (namesInCode, ADR 0118
 * addendum), cited `repo:path[:line]`. Registered for every command that runs the critic.
 */
export async function criticCodeSearch(
  root: string,
  names: string[],
): Promise<Map<string, string>> {
  const x = await import("@maycombhq/extractors");
  const r = await namesInCode(root, names, {
    ...codeToolOptions(root),
    outlines: (path) => x.syntaxLanguageOf(path) !== undefined,
  });
  return r.found;
}
