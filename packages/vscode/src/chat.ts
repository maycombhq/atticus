import * as vscode from "vscode";
import {
  actionFor,
  argsOf,
  readNext,
  readOpenQuestions,
  STEP_COMMANDS,
  type StepCommand,
} from "./atticus";
import type { CommandUi } from "./command-ui";
import { answersFrom, buildArgv, howToRun, matchCommand } from "./commands";
import { changeMapMarkdown, type ChangeMapJson } from "./change-map";
import { parseJson } from "./cli";
import { block, describeEnd, endFiles } from "./describe";
import { ChatSessions, promptText, recordChat, recordingStream } from "./history";
import type { StepEnd } from "./runner";
import { stepTitle, WORDS } from "./words";
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

/** Open the prompt and Open the answer: the last round's files, a click away (ADR 0106). */
export function showFiles(stream: vscode.ChatResponseStream, end: StepEnd, root: string) {
  for (const f of endFiles(end, root))
    stream.button({
      command: "atticus.openItem",
      arguments: [{ kind: "file", path: f.path }],
      title: f.title,
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
    "change small": "small",
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
  stream.markdown(`**Next: ${stepTitle(n)}** (${inline(n.command)})${block([n.why])}`);
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

/**
 * `@atticus /run <command…>` (ADR 0096): any command of the catalogue. What it prints comes back
 * here; an AI step runs here with Copilot's model; a shared write shows its dry run and a button
 * the person clicks to approve; a server opens a terminal.
 */
async function runTyped(
  svc: Service,
  ui: CommandUi,
  root: string,
  line: string,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  model: vscode.LanguageModelChat,
) {
  const cat = await ui.load(root);
  const m = line.trim() ? matchCommand(cat, line) : undefined;
  if (!m) {
    stream.markdown(
      line.trim()
        ? `No atticus command starts with ${inline(line.trim())}. Pick one from the list:`
        : "Pick a command from the list, by area, or type it after /run (for example /run spec check nadiengine).",
    );
    stream.button({ command: "atticus.runCommand", title: "Pick a command" });
    return;
  }
  const { answers, missing } = answersFrom(m.command, m.rest);
  if (missing.length) {
    stream.markdown(
      `${inline(`atticus ${m.command.id}`)} still needs ${missing.join(", ")}. Fill it in from the lists:`,
    );
    stream.button({
      command: "atticus.runCommand",
      arguments: [m.command.id, answers],
      title: `Fill in and run ${m.command.id}`,
    });
    return;
  }
  const argv = buildArgv(m.command, answers);
  const how = howToRun(m.command);
  if (how.mode === "ai") {
    stream.markdown(
      `Running ${inline(`atticus ${argv.join(" ")} --handoff`)} with Copilot's model.\n`,
    );
    const spec = m.command.id === "spec draft" ? argv[2] : undefined;
    const end = await svc.run(
      root,
      { args: argv, ...(spec ? { spec } : {}) },
      (l) => stream.progress(l),
      token,
      model,
    );
    const lines = describeEnd(end);
    stream.markdown(`\n**${lines[0]}**`);
    if (end.state === "question") for (const q of end.questions) showQuestion(stream, q);
    else if (lines.length > 1) stream.markdown(block(lines.slice(1)));
    showFiles(stream, end, root);
    return;
  }
  if (how.mode === "terminal") {
    await vscode.commands.executeCommand("atticus.runCommand", m.command.id, answers);
    stream.markdown(`Started ${inline(`atticus ${argv.join(" ")}`)} in a terminal.`);
    return;
  }
  stream.progress(`Running atticus ${argv.join(" ")}...`);
  const dryArgv = how.mode === "approve" ? argv.filter((a) => a !== how.flag) : argv;
  const r = await svc.cli(root)([...dryArgv, "--root", root], token);
  const out = [...r.stdout.trimEnd().split("\n"), ...r.stderr.trimEnd().split("\n")].filter(
    Boolean,
  );
  stream.markdown(
    `${how.mode === "approve" ? "The dry run of" : "Ran"} ${inline(`atticus ${dryArgv.join(" ")}`)} : ${WORDS.endedWith(r.code)}${block(out.slice(0, 200).length ? out.slice(0, 200) : ["(nothing printed)"])}`,
  );
  if (out.length > 200)
    stream.markdown(`${out.length - 200} more lines are in the Atticus output.`);
  if (how.mode === "approve")
    stream.button({
      command: "atticus.runApproved",
      arguments: [dryArgv, how.flag],
      title: `Approve and run (${how.flag})`,
    });
  svc.fireChanged();
}

/**
 * The participant, with each request and its reply recorded in the prompt history (ADR 0110):
 * the request as typed, then everything the reply streamed as markdown, through `atticus
 * history add`. Recording never holds the reply up, and a failure to record is never the chat's.
 */
export function chatHandler(
  svc: Service,
  commands?: () => CommandUi,
  sessions = new ChatSessions(),
): vscode.ChatRequestHandler {
  const handle = participant(svc, commands);
  return async (request, context, stream, token) => {
    const root = svc.root;
    if (!root) return handle(request, context, stream, token);
    const rec = recordingStream(stream);
    let ended: (text: string) => void = () => undefined;
    const response = new Promise<string>((r) => (ended = r));
    void recordChat(svc.cli(root), root, {
      session: sessions.sessionFor(request, context.history),
      ...(request.command ? { command: `/${request.command}` } : {}),
      prompt: promptText(request),
      response,
    });
    try {
      return await handle(request, context, rec.stream, token);
    } finally {
      ended(rec.text());
    }
  };
}

function participant(svc: Service, commands?: () => CommandUi): vscode.ChatRequestHandler {
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
          "Use a command: /next, /survey <repo>, /verify <repo>, /spec <repo>, /feature <change>, /architecture <change>, /stories <change>, /small <change>, /answer, /diagram [repo], /changemap <change>, /estimate <change>, /new <title>, /run <command> or /ask <question>.\n\n",
        );
      return next(svc, root, stream, token);
    }
    if (cmd === "answer") return answer(svc, root, stream, token);
    if (cmd === "run" && commands)
      return runTyped(svc, commands(), root, request.prompt, stream, token, request.model);
    if (cmd === "new") {
      const t = request.prompt.trim();
      stream.markdown(
        t
          ? `Starting the change ${inline(t)}: pick its type, then write its brief.`
          : "Say what the change is: /new Let members pin a message",
      );
      if (t) await vscode.commands.executeCommand("atticus.newChange", t);
      return;
    }
    if (cmd === "diagram") {
      const t = request.prompt.trim();
      await vscode.commands.executeCommand("atticus.diagram", t);
      stream.markdown(
        t
          ? `Opened ${inline(t)} in the Atticus tab. On the Architecture canvas, drag boxes to rearrange them; Keep saves the arrangement.`
          : "Opened the estate on the Architecture canvas, in the Atticus tab.",
      );
      stream.button({ command: "atticus.diagram", arguments: [t], title: "Open it again" });
      return;
    }
    if (cmd === "changemap") {
      const change = request.prompt.trim().split(/\s+/)[0];
      if (!change) {
        stream.markdown("Say the change: /changemap add-transfer-limit");
        return;
      }
      stream.progress(`Drawing ${change}...`);
      const r = await svc.cli(root)(["change", "map", change, "--json", "--root", root], token);
      const m = parseJson<ChangeMapJson>(r.stdout);
      if (!m) {
        stream.markdown(block([r.stderr.trim() || WORDS.endedWith(r.code)]));
        return;
      }
      stream.markdown(changeMapMarkdown(m));
      if (m.flows)
        stream.button({
          command: "atticus.changeDiagram",
          arguments: [change],
          title: "Open the Change diagram",
        });
      return;
    }
    if (cmd === "estimate") {
      const change = request.prompt.trim().split(/\s+/)[0];
      if (!change) {
        stream.markdown("Say the change: /estimate add-transfer-limit");
        return;
      }
      stream.progress(`Sizing ${change}...`);
      const r = await svc.cli(root)(["change", "estimate", change, "--root", root], token);
      stream.markdown(
        block(
          [...r.stdout.trimEnd().split("\n"), ...r.stderr.trimEnd().split("\n")].filter(Boolean),
        ),
      );
      if (r.code === 0)
        stream.button({
          command: "atticus.estimate",
          arguments: [change],
          title: "Open the Estimate",
        });
      return;
    }
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
      showFiles(stream, end, root);
      return;
    }
    if (lines.length > 1) stream.markdown(block(lines.slice(1)));
    showFiles(stream, end, root);
    if (end.state === "done")
      stream.button({
        command: "workbench.action.chat.open",
        arguments: [{ query: "@atticus /next" }],
        title: "What's next?",
      });
  };
}
