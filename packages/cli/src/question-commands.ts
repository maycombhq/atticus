import { stat } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  answerQuestion,
  changesDirOf,
  answerWords,
  listQuestions,
  QuestionError,
  questionsRelOf,
  QuestionScopeLevel,
  QuestionState,
  type Question,
} from "@maycombhq/core";
import { waitingQuestions } from "@maycombhq/planner";
import { gitUser } from "@maycombhq/workspace";
import type { Output } from "./commands.js";

/**
 * atticus questions list | show | answer (ADR 0078): the questions a step raised, as files in
 * questions/, and a person's answer written to the same file. The app's Questions page writes
 * the same file through the same functions. The older `atticus questions` (no subcommand)
 * still lists the knowledge gaps and their owner questions.
 */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const sentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

/**
 * "this repo (forge-notes)" or "every repo of type forge-service"; a stage's question, filed
 * under its change's id, is "this change (add-pins)".
 */
export function scopeWords(s: Question["scope"], short = false, change = false): string {
  const what = change ? "this change" : "this repo";
  if (s.level === "repo") return short ? what : `${what} (${s.id})`;
  return `every repo of type ${s.id}`;
}

/** A stage's question is filed under its change's id: say "this change" for it, not "this repo". */
async function isChange(root: string, id: string): Promise<boolean> {
  return stat(join(changesDirOf(root), id, "change.yaml")).then(
    () => true,
    () => false,
  );
}

/** The lines `atticus questions list` prints for one question; `change`: it is a change's. */
export function questionLines(q: Question, o: { change?: boolean } = {}): string[] {
  const lines = [
    `${q.id}  ${q.state}  ${q.repo}  (asked by ${q.askedBy.command} on ${q.askedBy.at.slice(0, 10)})`,
    `  ${q.question}`,
    ...q.options.map(
      (o, i) =>
        `  ${i + 1}. ${o.label}: ${sentence(o.means)} It would change: ${sentence(o.changes)}`,
    ),
    `  Evidence: ${q.evidence.join(", ")}`,
  ];
  if (q.answer)
    lines.push(
      `  Answered by ${q.answer.by} on ${q.answer.at.slice(0, 10)}: ${answerWords(q)} (${scopeWords(q.answer.scope, true, o.change)})`,
    );
  else if (q.state === "open")
    lines.push(
      `  Proposed scope: ${scopeWords(q.scope, false, o.change)}`,
      `  Answer: atticus questions answer ${q.id}${q.options.length ? " --option <n>, or" : ""} --text "your own words"`,
    );
  return lines;
}

/** `atticus questions list|answer …`; argv is the whole command line, parsed here. */
export async function questionsFiles(
  root: string,
  argv: string[],
  io: Output,
  deps: { now?: Date } = {},
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      root: { type: "string" },
      json: { type: "boolean" },
      state: { type: "string" },
      option: { type: "string" },
      text: { type: "string" },
      scope: { type: "string" },
      type: { type: "string" },
      by: { type: "string" },
    },
  });
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const [, command, id] = positionals;
  if (command === "list") {
    const state = str(values.state);
    if (state !== undefined && !QuestionState.safeParse(state).success) {
      io.err("--state is open, answered or retired.");
      return 2;
    }
    const r = await listQuestions(root, state ? { state: state as QuestionState } : {});
    for (const p of r.problems) io.err(`${p.file} isn't a valid question: ${p.message}`);
    // ADR 0117 addendum (2026-10-25): what the stages hold back over a stop's cap, from their
    // loop files, so a person sees what comes next.
    const waiting = !state || state === "open" ? await waitingQuestions(root) : [];
    if (values.json === true) {
      io.out(JSON.stringify({ ...r, waiting }, null, 2));
      return r.problems.length ? 1 : 0;
    }
    const changes = new Set<string>();
    for (const q of r.questions) if (await isChange(root, q.repo)) changes.add(q.repo);
    for (const q of r.questions)
      for (const l of questionLines(q, { change: changes.has(q.repo) })) io.out(l);
    const what = state ?? "";
    io.out(
      r.questions.length
        ? `${plural(r.questions.length, `${what ? `${what} ` : ""}question`)}.`
        : `No ${what ? `${what} ` : ""}questions.`,
    );
    if (waiting.length) {
      io.out(
        `${plural(waiting.length, "more question")} ${waiting.length === 1 ? "waits" : "wait"}, asked once the open ones are answered:`,
      );
      for (const w of waiting)
        io.out(
          `  ${w.change}, ${w.stage} stage: ${w.question}${w.evidence.length ? ` (${w.evidence.join(", ")})` : ""}`,
        );
      for (const rerun of [...new Set(waiting.map((w) => w.rerun))])
        io.out(`Run the stage again after answering: ${rerun}`);
    }
    return r.problems.length ? 1 : 0;
  }
  if (command === "show") {
    if (!id) {
      io.err(
        "questions show needs a question id, for example: atticus questions show q-1a2b3c4d5e6f",
      );
      return 2;
    }
    const q = (await listQuestions(root)).questions.find((x) => x.id === id);
    if (!q) {
      io.err(`No question ${id}: atticus questions list shows them.`);
      return 1;
    }
    if (values.json === true) io.out(JSON.stringify(q, null, 2));
    else for (const l of questionLines(q, { change: await isChange(root, q.repo) })) io.out(l);
    return 0;
  }
  if (command === "answer") {
    if (!id) {
      io.err(
        "questions answer needs a question id, for example: atticus questions answer q-1a2b3c4d5e6f --option 1",
      );
      return 2;
    }
    const opt = str(values.option);
    const text = str(values.text)?.trim() || undefined;
    if ((opt === undefined) === (text === undefined)) {
      io.err('Answer with --option <n> or --text "your own words", one of the two.');
      return 2;
    }
    const option = opt === undefined ? undefined : Number(opt);
    if (option !== undefined && (!Number.isInteger(option) || option < 1)) {
      io.err("--option is the number of an option, counting from 1.");
      return 2;
    }
    const scope = str(values.scope);
    if (scope !== undefined && !QuestionScopeLevel.safeParse(scope).success) {
      io.err("--scope is repo (this repo only) or repo-type (every repo of its type).");
      return 2;
    }
    try {
      const by = str(values.by)?.trim() || (await gitUser(root)).handle;
      const r = await answerQuestion(root, id, {
        ...(option !== undefined ? { option } : {}),
        ...(text !== undefined ? { text } : {}),
        ...(scope ? { scope: scope as QuestionScopeLevel } : {}),
        ...(str(values.type) ? { repoType: str(values.type)! } : {}),
        by,
        at: (deps.now ?? new Date()).toISOString(),
      });
      const q = r.question;
      io.out(
        `Answered ${q.id}: ${answerWords(q)} (for ${q.answer!.scope.level === "repo" ? `${(await isChange(root, q.repo)) ? "this change" : "this repo"}, ${q.repo}` : scopeWords(q.answer!.scope)}). Wrote ${questionsRelOf(root)}/${q.id}.yaml; commit it for review.`,
      );
      if (r.skill)
        io.out(
          r.skill.written
            ? `Also wrote it under Answers in ${r.skill.path}; review it in the same pull request.`
            : `${r.skill.path} isn't there yet, so the answer is kept in the question file, with that path.`,
        );
      if (r.hosts)
        io.out(
          r.hosts.added
            ? `Wrote ${r.hosts.host} under hosts for ${r.hosts.repo} in ${r.hosts.manifest}; review it in the same pull request.`
            : `${r.hosts.repo} already lists ${r.hosts.host} under hosts in ${r.hosts.manifest}.`,
        );
      io.out(`Next: ${q.rerun}`);
      return 0;
    } catch (e) {
      if (!(e instanceof QuestionError)) throw e;
      io.err(e.message);
      return e.code === "bad-answer" ? 2 : 1;
    }
  }
  io.err(
    `atticus questions ${command ?? ""} isn't a command: it is questions list, show or answer (atticus questions alone lists the knowledge gaps).`,
  );
  io.err(
    'Usage: atticus questions list [--state open|answered|retired] [--json], atticus questions show <id> [--json], or atticus questions answer <id> --option <n> | --text "..." [--scope repo|repo-type] [--type <repo type>]',
  );
  return 2;
}
