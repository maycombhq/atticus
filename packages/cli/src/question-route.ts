import { parseArgs } from "node:util";
import { QuestionError, QuestionRole, routeQuestion } from "@maycombhq/core";
import { gitUser } from "@maycombhq/workspace";
import type { Output } from "./commands.js";

const USAGE =
  "Usage: atticus questions route <id> --to product|architecture|analysis|delivery [--by who]";

/** The roles in a person's words, for what the command says. */
const WORDS: Record<string, string> = {
  product: "the product owner",
  architecture: "the architect",
  analysis: "the business analyst",
  delivery: "the tech lead",
};

/**
 * atticus questions route <id> --to <role> (ADR 0191): a person moves a question to the role that
 * answers it, as the app's Route does. The question keeps its answer; `routed` says from which
 * role, by whom and when.
 */
export async function questionRouteCommand(
  root: string,
  argv: string[],
  io: Output,
  o: { now?: Date } = {},
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv.slice(2),
      allowPositionals: true,
      options: { to: { type: "string" }, by: { type: "string" }, root: { type: "string" } },
    });
  } catch (e) {
    io.err(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  const id = parsed.positionals[0];
  const to = QuestionRole.safeParse(parsed.values.to);
  if (!id || !to.success) {
    io.err(USAGE);
    return 2;
  }
  const by = parsed.values.by ?? (await gitUser(root)).handle;
  try {
    const q = await routeQuestion(root, id, {
      role: to.data,
      by,
      at: (o.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z"),
    });
    io.out(
      q.routed
        ? `${q.id} goes to ${WORDS[to.data]} now${q.routed.from ? ` (it was ${WORDS[q.routed.from]}'s)` : ""}.`
        : `${q.id} is ${WORDS[to.data]}'s already.`,
    );
    return 0;
  } catch (e) {
    if (e instanceof QuestionError) {
      io.err(e.message);
      return e.code === "not-found" ? 1 : 2;
    }
    throw e;
  }
}
