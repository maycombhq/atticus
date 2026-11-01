import { stat } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  acceptProposal,
  answerQuestion,
  changesDirOf,
  checkedProposals,
  proposalOf,
  proposalsRelOf,
  answerWords,
  listQuestions,
  QuestionError,
  questionsRelOf,
  QuestionScopeLevel,
  QuestionState,
  type Question,
} from "@maycombhq/core";
// The light entry: listing the questions needn't load the whole planner (waiting.ts).
import { waitingQuestions } from "@maycombhq/planner/waiting";
import { gitUser } from "@maycombhq/workspace";
import type { Output } from "./commands.js";
import { routeQuestions, type RoutedQuestions } from "./question-routing.js";

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

/**
 * Who a question goes to, what change rests on it and how many calls its answer joins (ADR 0140),
 * as `atticus questions list` prints them.
 */
export function aboutLines(about: RoutedQuestions["about"][string] | undefined): string[] {
  if (!about) return [];
  const o = about.owner;
  return [
    "team" in o ? `  Owner: ${o.team}${o.name ? ` (${o.name})` : ""}` : `  Owner: none (${o.none})`,
    ...(about.restsOn.length
      ? [
          `  Ask it first: ${about.restsOn.join(", ")} ${about.restsOn.length === 1 ? "is a change in flight that rests" : "are changes in flight that rest"} on it.`,
        ]
      : []),
    ...(about.joins ? [`  Its answer joins ${plural(about.joins, "call")}.`] : []),
  ];
}

type Proposal = NonNullable<RoutedQuestions["about"][string]["proposal"]>;

/**
 * An open question's proposed answer (ADR 0144, Q5), every cited line checked, and how a person
 * accepts it. The assistant proposed it; nobody has answered until a person accepts.
 */
export function proposalLines(q: Question, p: Proposal): string[] {
  const what =
    p.answer.option !== undefined
      ? `option ${p.answer.option}, ${q.options[p.answer.option - 1]?.label ?? "?"}`
      : `"${p.answer.text}"`;
  return [
    `  Proposed by ${p.by} (not answered yet): ${what}. ${sentence(p.why)}`,
    ...p.cites.map(
      (c) =>
        `    Cites ${c.repo ?? q.repo} ${c.file}:${c.line}: "${c.quote}" (checked: it is on that line)`,
    ),
    `  Accept it as your answer: atticus questions answer ${q.id} --accept-proposal`,
  ];
}

/** The lines `atticus questions list` prints for one question; `change`: it is a change's. */
export function questionLines(
  q: Question,
  o: { change?: boolean; about?: RoutedQuestions["about"][string] } = {},
): string[] {
  const lines = [
    `${q.id}  ${q.state}  ${q.repo}  (asked by ${q.askedBy.command} on ${q.askedBy.at.slice(0, 10)})`,
    `  ${q.question}`,
    ...aboutLines(o.about),
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
      ...(o.about?.proposal ? proposalLines(q, o.about.proposal) : []),
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
      mine: { type: "boolean" },
      "accept-proposal": { type: "boolean" },
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
    const listed = await listQuestions(root, state ? { state: state as QuestionState } : {});
    for (const p of listed.problems) io.err(`${p.file} isn't a valid question: ${p.message}`);
    // ADR 0140: in the order to ask them, each with its owner; --mine, the person's teams' only.
    const mine =
      values.mine === true ? str(values.by)?.trim() || (await gitUser(root)).handle : undefined;
    const routed = await routeQuestions(root, listed.questions, mine ? { mine } : {});
    for (const p of routed.problems) io.err(`${p.file}: ${p.message}`);
    const r = { ...listed, questions: routed.questions };
    // ADR 0117 addendum (2026-10-25): what the stages hold back over a stop's cap, from their
    // loop files, so a person sees what comes next.
    const waiting = !state || state === "open" ? await waitingQuestions(root) : [];
    if (values.json === true) {
      io.out(
        JSON.stringify(
          { ...r, about: routed.about, ...(routed.me ? { me: routed.me } : {}), waiting },
          null,
          2,
        ),
      );
      return r.problems.length ? 1 : 0;
    }
    if (routed.me)
      io.out(
        routed.me.teams.length
          ? `The questions for ${routed.me.handle}'s ${routed.me.teams.length === 1 ? "team" : "teams"}: ${routed.me.teams.map((t) => (t.name ? `${t.id} (${t.name})` : t.id)).join(", ")}.`
          : `${routed.me.handle} is on no team in org-pack/roles.yaml, so no question is theirs: add them under a team's people (roles.yaml schemaVersion 2), or list every question without --mine.`,
      );
    const changes = new Set<string>();
    for (const q of r.questions) if (await isChange(root, q.repo)) changes.add(q.repo);
    for (const q of r.questions)
      for (const l of questionLines(q, { change: changes.has(q.repo), about: routed.about[q.id] }))
        io.out(l);
    const what = state ? `${state} ` : "";
    const yours = routed.me ? " for your teams" : "";
    io.out(
      r.questions.length
        ? `${plural(r.questions.length, `${what}question`)}${yours}.`
        : `No ${what}questions${yours}.`,
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
    // ADR 0144 (Q5): its proposed answer, shown only once every line it cites holds.
    const p = q.state === "open" ? await proposalOf(root, q.id) : undefined;
    const proposal = p?.ok && p.proposal ? { ...p.proposal, file: p.file } : undefined;
    if (values.json === true) io.out(JSON.stringify(proposal ? { ...q, proposal } : q, null, 2));
    else {
      const routed = await routeQuestions(root, [q]);
      const about = routed.about[q.id];
      for (const l of questionLines(q, {
        change: await isChange(root, q.repo),
        ...(about ? { about: { ...about, ...(proposal ? { proposal } : {}) } } : {}),
      }))
        io.out(l);
      if (p && !p.ok && !p.stale)
        io.out(
          `  A proposed answer is on file (${p.file}) but doesn't check, so it isn't shown: ${p.problems.join(" ")}`,
        );
    }
    return 0;
  }
  if (command === "proposed") {
    // ADR 0144 (Q5): every proposal on file, checked as the person will see it; the assistant's loop.
    const all = await checkedProposals(root);
    const dir = `${proposalsRelOf(root)}/questions`;
    if (values.json === true) {
      io.out(JSON.stringify({ dir, proposals: all }, null, 2));
      return all.some((p) => !p.ok && !p.stale) ? 1 : 0;
    }
    if (!all.length) {
      io.out(
        `No proposed answers yet. /atticus-propose writes one per open question to ${dir}/<question id>.yaml.`,
      );
      return 0;
    }
    for (const p of all) {
      if (p.ok) io.out(`${p.id}  checked: every line it cites says what it quotes (${p.file}).`);
      else if (p.stale) io.out(`${p.id}  nothing to propose: ${p.problems.join(" ")}`);
      else {
        io.out(`${p.id}  doesn't check, so nobody sees it (${p.file}):`);
        for (const x of p.problems) io.out(`  ${x}`);
      }
    }
    const bad = all.filter((p) => !p.ok && !p.stale).length;
    const ok = all.filter((p) => p.ok).length;
    io.out(
      bad
        ? `${plural(bad, "proposal")} ${bad === 1 ? "doesn't" : "don't"} check: fix each citation from the file's line, or remove the proposal.`
        : `${plural(ok, "proposal")} checked. A person accepts each with atticus questions answer <id> --accept-proposal, or on the Questions page.`,
    );
    return bad ? 1 : 0;
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
    const accept = values["accept-proposal"] === true;
    if (accept && (opt !== undefined || text !== undefined)) {
      io.err(
        "--accept-proposal takes the proposed answer: give it alone, or answer with --option or --text instead.",
      );
      return 2;
    }
    if (!accept && (opt === undefined) === (text === undefined)) {
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
      const at = (deps.now ?? new Date()).toISOString();
      const scoped = {
        ...(scope ? { scope: scope as QuestionScopeLevel } : {}),
        ...(str(values.type) ? { repoType: str(values.type)! } : {}),
      };
      // ADR 0144 (Q5): the assistant's proposal, checked again, becomes this person's answer.
      const r = accept
        ? await acceptProposal(root, id, { ...scoped, by, at })
        : await answerQuestion(root, id, {
            ...(option !== undefined ? { option } : {}),
            ...(text !== undefined ? { text } : {}),
            ...scoped,
            by,
            at,
          });
      const q = r.question;
      io.out(
        `Answered ${q.id}: ${answerWords(q)} (for ${q.answer!.scope.level === "repo" ? `${(await isChange(root, q.repo)) ? "this change" : "this repo"}, ${q.repo}` : scopeWords(q.answer!.scope)}). Wrote ${questionsRelOf(root)}/${q.id}.yaml; commit it for review.`,
      );
      if (accept)
        io.out(
          `It was the assistant's proposal; you accepted it, so it is recorded as answered by ${q.answer!.by}.`,
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
      if (r.system)
        io.out(
          r.system.added
            ? `Wrote the system ${r.system.id} (boundary ${r.system.boundary}, alias ${r.system.host}) into ${r.system.profile}, so the calls to ${r.system.host} go to it; review it in the same pull request, and give it a better name and an owner there if you like.`
            : `${r.system.profile} already has ${r.system.id}, which names ${r.system.host}.`,
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
    `atticus questions ${command ?? ""} isn't a command: it is questions list, show, proposed or answer (atticus questions alone lists the knowledge gaps).`,
  );
  io.err(
    'Usage: atticus questions list [--state open|answered|retired] [--mine] [--json], atticus questions show <id> [--json], atticus questions proposed [--json], or atticus questions answer <id> --option <n> | --text "..." | --accept-proposal [--scope repo|repo-type] [--type <repo type>]',
  );
  return 2;
}
