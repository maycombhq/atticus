import * as vscode from "vscode";
import {
  actionFor,
  argsOf,
  readNext,
  readOpenQuestions,
  STEP_COMMANDS,
  type StepCommand,
} from "./atticus";
import { block, describeEnd } from "./describe";
import type { Service } from "./service";
import type { NextStep, OpenQuestion } from "./types";

/**
 * The @atticus chat participant (ADR 0090). Each command runs the step runner, or reads
 * `atticus next` and `atticus questions`, and streams progress and the result into the chat.
 * What Atticus prints is shown in code blocks: it is data read from the repos, not markdown to
 * render.
 */

const inline = (s: string) => `\`${s.replace(/`/g, "'")}\``;

/** A question with a button for each option and one for the person's own words. */
export function showQuestion(stream: vscode.ChatResponseStream, q: OpenQuestion) {
  stream.markdown(`\n**${q.id}** (${q.repo})`);
  stream.markdown(
    block([
      q.question,
      ...q.options.map((o, i) => `${i + 1}. ${o.label}${o.means ? `: ${o.means}` : ""}`),
      `Evidence: ${q.evidence.join(", ")}`,
    ]),
  );
  q.options.forEach((o, i) =>
    stream.button({
      command: "atticus.answerQuestion",
      arguments: [q.id, i + 1],
      title: `${i + 1}. ${o.label}`,
    }),
  );
  stream.button({
    command: "atticus.answerQuestion",
    arguments: [q.id],
    title: "In my own words...",
  });
}

/** The chat command that runs a next step in the chat, when there is one. */
function chatQuery(n: NextStep): string | undefined {
  const a = actionFor(n);
  if (a.kind === "answer") return "@atticus /answer";
  if (a.kind !== "ai") return undefined;
  const w = a.args.slice(0, 2).join(" ");
  const t = a.args[2];
  const byWords: Record<string, StepCommand> = {
    "scan survey": "survey",
    "scan verify": "verify",
    "spec draft": "spec",
    "change feature": "feature",
    "change architecture": "architecture",
    "plan stories": "stories",
  };
  return byWords[w] && t ? `@atticus /${byWords[w]} ${t}` : undefined;
}

async function next(
  svc: Service,
  root: string,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
) {
  stream.progress("Reading the metarepo (atticus next)...");
  const r = await readNext(svc.cli(root), root, token);
  if (!r.ok) {
    stream.markdown(`Couldn't read the next step:${block([r.message])}`);
    return;
  }
  const n = r.value.next;
  if (!n) {
    stream.markdown("Atticus has no next step to suggest.");
    return;
  }
  stream.markdown(`**Next:** ${inline(n.command)}${block([n.why])}`);
  const q = chatQuery(n);
  if (q)
    stream.button({
      command: "workbench.action.chat.open",
      arguments: [{ query: q }],
      title: `Run ${q.replace("@atticus ", "")}`,
    });
  else if (actionFor(n).kind === "person")
    stream.markdown("A person takes this step: run the command above yourself.");
  else stream.button({ command: "atticus.runNext", title: "Run it" });
  if (r.value.steps.length > 1)
    stream.markdown(`\n${r.value.steps.length - 1} more after this one (atticus next --all).`);
}

async function answer(
  svc: Service,
  root: string,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
) {
  stream.progress("Reading the open questions...");
  const r = await readOpenQuestions(svc.cli(root), root, token);
  if (!r.ok) {
    stream.markdown(`Couldn't read the questions:${block([r.message])}`);
    return;
  }
  if (!r.value.length) {
    stream.markdown("No question is waiting for an answer.");
    return;
  }
  stream.markdown(
    `${r.value.length} open question${r.value.length === 1 ? "" : "s"}. Pick an answer; Atticus writes it to the question's file.`,
  );
  for (const q of r.value) showQuestion(stream, q);
}

export function chatHandler(svc: Service): vscode.ChatRequestHandler {
  return async (request, _context, stream, token) => {
    const root = svc.root;
    if (!root) {
      stream.markdown("Open the metarepo folder (the one with org-pack/) in VS Code first.");
      return;
    }
    const cmd = request.command;
    if (!cmd || cmd === "next") {
      if (!cmd && request.prompt.trim())
        stream.markdown(
          "Use a command: /next, /survey <repo>, /verify <repo>, /spec <repo>, /feature <change>, /architecture <change>, /stories <change>, /answer or /ask <question>.\n\n",
        );
      return next(svc, root, stream, token);
    }
    if (cmd === "answer") return answer(svc, root, stream, token);
    if (cmd === "ask") {
      const question = request.prompt.trim();
      if (!question) {
        stream.markdown("Say the question: /ask who calls forge-orders?");
        return;
      }
      stream.progress("Asking the catalog...");
      const r = await svc.cli(root)(["ask", question, "--root", root], token);
      stream.markdown(
        block(
          [...r.stdout.trimEnd().split("\n"), ...r.stderr.trimEnd().split("\n")].filter(Boolean),
        ),
      );
      return;
    }
    if (!(cmd in STEP_COMMANDS)) {
      stream.markdown(`@atticus has no /${cmd}.`);
      return;
    }
    const step = STEP_COMMANDS[cmd as StepCommand];
    let target = argsOf(`atticus ${request.prompt}`)[0];
    if (!target) {
      // The target the next step names, when it is this kind of step.
      const r = await readNext(svc.cli(root), root, token);
      const n = r.ok
        ? r.value.steps.find(
            (s) => actionFor(s).kind === "ai" && chatQuery(s)?.startsWith(`@atticus /${cmd} `),
          )
        : undefined;
      target = n ? (step.target === "repo" ? n.repo : n.change) : undefined;
      if (!target) {
        stream.markdown(`Say which ${step.target}: /${cmd} <${step.target}>`);
        return;
      }
    }
    const args = step.args(target);
    stream.markdown(
      `Running ${inline(`atticus ${args.join(" ")} --handoff`)} with Copilot's model.\n`,
    );
    const end = await svc.run(
      root,
      { args, ...(cmd === "spec" ? { spec: target } : {}) },
      (l) => stream.progress(l),
      token,
      request.model,
    );
    const lines = describeEnd(end);
    stream.markdown(`\n**${lines[0]}**`);
    if (end.state === "question") {
      for (const q of end.questions) showQuestion(stream, q);
      return;
    }
    if (lines.length > 1) stream.markdown(block(lines.slice(1)));
    if (end.state === "done")
      stream.button({
        command: "workbench.action.chat.open",
        arguments: [{ query: "@atticus /next" }],
        title: "What's next?",
      });
  };
}
