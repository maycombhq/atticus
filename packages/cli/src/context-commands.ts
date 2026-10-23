import { readToolCalls, recordToolCalls, TOOL_LIMITS, ToolSession } from "@maycombhq/ai";
import { CONTEXT_TOOLS } from "@maycombhq/index";
import { metarepoToolBox } from "./code-tools.js";
import type { Output } from "./commands.js";

/**
 * `atticus context ...` (ADR 0107 addendum): the context tools a step's model may call beside
 * its pack, as commands. `show`, `walk` and `code` are for a person (and the MCP server);
 * `tools` prints the definitions and caps, and `call` runs one tool as a model asked for it:
 * the VS Code extension runs it for each tool call Copilot's model makes, with the run's id, so
 * the call and what it returned are kept in that run's record and the caps hold across calls.
 * Every one only reads.
 */

const box = (root: string) => metarepoToolBox(root);

/** Run one tool for a person: its text, or the refusal as an error (exit 2). */
async function runFor(
  root: string,
  name: string,
  input: Record<string, unknown>,
  io: Output,
): Promise<number> {
  try {
    io.out(await box(root).call(name, input));
    return 0;
  } catch (e) {
    io.err((e as Error).message);
    return (e as Error).name === "ToolError" ? 2 : 1;
  }
}

export function contextShow(root: string, id: string, io: Output): Promise<number> {
  return runFor(root, "show", { id }, io);
}

export function contextWalk(
  root: string,
  id: string,
  o: { hops?: number; kinds?: string[]; limit?: number },
  io: Output,
): Promise<number> {
  return runFor(
    root,
    "walk",
    {
      id,
      ...(o.hops ? { hops: o.hops } : {}),
      ...(o.kinds?.length ? { kinds: o.kinds } : {}),
      ...(o.limit ? { limit: o.limit } : {}),
    },
    io,
  );
}

export function contextCode(
  root: string,
  o: { id?: string; repo?: string; path?: string; line?: number; around?: number },
  io: Output,
): Promise<number> {
  return runFor(
    root,
    "show_code",
    {
      ...(o.id ? { id: o.id } : {}),
      ...(o.repo ? { repo: o.repo } : {}),
      ...(o.path ? { path: o.path } : {}),
      ...(o.line ? { line: o.line } : {}),
      ...(o.around !== undefined ? { context: o.around } : {}),
    },
    io,
  );
}

/**
 * atticus context grep <pattern> [--regex] [--ignore-case] [--repo r] [--paths glob] [--limit n]
 * (ADR 0118): the lines of the workspace clones that match, each repo:path:line.
 */
export function contextGrep(
  root: string,
  pattern: string,
  o: { regex?: boolean; ignoreCase?: boolean; repo?: string; paths?: string; limit?: number },
  io: Output,
): Promise<number> {
  return runFor(
    root,
    "grep",
    {
      pattern,
      ...(o.regex ? { regex: true } : {}),
      ...(o.ignoreCase ? { ignoreCase: true } : {}),
      ...(o.repo ? { repo: o.repo } : {}),
      ...(o.paths ? { paths: o.paths } : {}),
      ...(o.limit ? { limit: o.limit } : {}),
    },
    io,
  );
}

/** atticus context files <glob> [--repo r] [--limit n]: the clones' paths a glob matches. */
export function contextFiles(
  root: string,
  glob: string,
  o: { repo?: string; limit?: number },
  io: Output,
): Promise<number> {
  return runFor(
    root,
    "files",
    { glob, ...(o.repo ? { repo: o.repo } : {}), ...(o.limit ? { limit: o.limit } : {}) },
    io,
  );
}

/** atticus context outline <repo> <path>: a file's declarations, or its headings or keys. */
export function contextOutline(root: string, repo: string, path: string, io: Output) {
  return runFor(root, "outline", { repo, path }, io);
}

/** atticus context tools [--json]: the tools, their input schemas and the caps. */
export function contextTools(o: { json?: boolean }, io: Output): number {
  if (o.json) {
    io.out(JSON.stringify({ tools: CONTEXT_TOOLS, limits: TOOL_LIMITS }, null, 2));
    return 0;
  }
  for (const t of CONTEXT_TOOLS) io.out(`${t.name}: ${t.description}`);
  io.out(
    `At most ${TOOL_LIMITS.rounds} rounds of tool calls in a run, ${TOOL_LIMITS.tokens} tokens from tools in all, ${TOOL_LIMITS.perCall} from one call.`,
  );
  return 0;
}

/**
 * atticus context call <tool> --input <json> [--run <run>] [--round n] [--json]: one tool call
 * a model made. With --run, the call is kept in that run's record and the run's token cap
 * holds: once the run's tools have returned their tokens, a call is refused and the record says
 * the cap stopped it. The text printed is exactly what the model is given back (data, wrapped).
 */
export async function contextCall(
  root: string,
  name: string,
  o: { input?: string; run?: string; round?: number; json?: boolean },
  io: Output,
): Promise<number> {
  let input: Record<string, unknown> = {};
  if (o.input !== undefined) {
    try {
      const v = JSON.parse(o.input) as unknown;
      if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("not an object");
      input = v as Record<string, unknown>;
    } catch {
      io.err(
        '--input is the tool\'s input as a JSON object, for example --input \'{"id":"forge-ledger"}\'.',
      );
      return 2;
    }
  }
  const existing = o.run ? await readToolCalls(root, o.run) : undefined;
  if (o.run && !existing) {
    io.err(`There is no run ${o.run}. atticus runs lists them.`);
    return 2;
  }
  // ADR 0118: show_code may show a line an earlier grep or outline call of the run returned.
  const session = new ToolSession(
    metarepoToolBox(root, existing?.tools?.calls),
    {},
    existing?.tools,
  );
  const before = session.calls.length;
  const call = await session.run(o.round ?? 1, { name, input });
  if (o.run)
    await recordToolCalls(root, o.run, (t) => ({
      offered: CONTEXT_TOOLS.map((d) => d.name),
      calls: [...(t?.calls ?? []), ...session.calls.slice(before)],
      ...(session.stopped ? { stopped: session.stopped } : {}),
    }));
  if (o.json)
    io.out(
      JSON.stringify(
        {
          output: call.output,
          tokens: call.tokens,
          ...(call.error ? { error: true } : {}),
          ...(session.stopped ? { stopped: session.stopped } : {}),
        },
        null,
        2,
      ),
    );
  else io.out(call.output);
  return 0;
}
