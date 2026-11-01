import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import * as vscode from "vscode";
import { answerQuestion } from "./atticus";
import { showReadOnly, type CommandUi } from "./command-ui";
import { commandText } from "./cli";
import { agentFilePath, agentForStep, openForStep, promptFilePath } from "./copilot-agent";
import { JOBS, limitOf, runtimeMaxInput, TRAFFIC_SOURCES, type Job, type JobArgs } from "./jobs";
import { proposalWhat } from "./waiting-data";
import type { Service } from "./service";
import type { OpenQuestion } from "./types";
import { WORDS } from "./words";

/**
 * beta.10's jobs in VS Code (jobs.ts says what each runs): asked for with the metarepo's own
 * lists, run through the command line as Run a command runs it, a report shown whole in a
 * read-only tab, and the app page or Copilot Chat step that goes with it a click away. Plus the
 * Questions view's Accept as my answer and My teams'.
 */

export interface JobsDeps {
  svc: Service;
  commands: CommandUi;
  needRoot: () => string | undefined;
  reg: (id: string, f: (...a: never[]) => unknown) => unknown;
  refreshAll: () => void;
  /** The open questions on show, for Accept as my answer from the palette. */
  questions: () => OpenQuestion[] | undefined;
  /** My teams' on or off in the Questions view. */
  setMine: (on: boolean) => void;
  /** A long-running command in a terminal the person sees and types into (map --all). */
  inTerminal: (root: string, name: string, args: string[]) => unknown;
}

/** Open a step in Copilot Chat: agent mode where its agent file is, else its prompt file. */
export async function openChatStep(root: string, step: string, target?: string): Promise<void> {
  const a = agentForStep(step);
  const there = (rel: string) => existsSync(join(root, ...rel.split("/")));
  const open = openForStep(step, target, {
    agentFileThere: !!a && there(agentFilePath(a.agent)),
    promptFileThere: !!a?.slash && there(promptFilePath(a.slash.replace(/^atticus-/, ""))),
  });
  const slash = a?.slash ?? `atticus-${step}`;
  try {
    if (open.kind === "agent") {
      await vscode.commands.executeCommand("workbench.action.chat.open", open.chat);
      void vscode.window.showInformationMessage(
        WORDS.copilotAgentOpened(open.agent, open.stepClass),
      );
      return;
    }
    // No agent file: the slash command itself, from the prompt file atticus assistant-files writes
    // (the participant's /map would read the whole repo, not the gaps).
    if (!there(promptFilePath(slash.replace(/^atticus-/, ""))))
      return void vscode.window.showWarningMessage(WORDS.promptFileMissing(slash));
    await vscode.commands.executeCommand("workbench.action.chat.open", {
      query: `/${slash}${target ? ` ${target}` : ""}`,
      isPartialQuery: true,
    });
  } catch (e) {
    void vscode.window.showErrorMessage(WORDS.copilotAgentFallbackFailed((e as Error).message));
  }
}

export function registerJobs(d: JobsDeps) {
  const { svc, commands } = d;

  /** What a job needs, asked; undefined when the person stopped. */
  const ask = async (root: string, j: Job, given: JobArgs): Promise<JobArgs | undefined> => {
    const a: JobArgs = { ...given };
    const title = `Atticus: ${j.title}`;
    switch (j.needs) {
      case "repo":
        a.repo ??= await commands.pickTarget(root, "repo", title);
        return a.repo ? a : undefined;
      case "change":
        a.change ??= await commands.pickTarget(root, "change", title);
        return a.change ? a : undefined;
      case "repo-or-estate": {
        if (a.repo) return a;
        const how = await vscode.window.showQuickPick(
          [
            { label: WORDS.auditWhole, estate: true },
            { label: "One repo…", estate: false },
          ],
          { title },
        );
        if (!how) return undefined;
        if (how.estate) return a;
        a.repo = await commands.pickTarget(root, "repo", title);
        return a.repo ? a : undefined;
      }
      case "reference":
      case "traffic": {
        if (!a.file) {
          const f = await vscode.window.showOpenDialog({
            title: j.needs === "reference" ? WORDS.referencePick : WORDS.trafficPick,
            defaultUri: vscode.Uri.file(root),
            canSelectMany: false,
            openLabel: "Use it",
          });
          if (!f?.[0]) return undefined;
          a.file = f[0].fsPath;
        }
        if (j.needs === "traffic" && !a.source) {
          const s = await vscode.window.showQuickPick([...TRAFFIC_SOURCES], {
            title: WORDS.trafficSource,
          });
          if (!s) return undefined;
          a.source = s;
        }
        return a;
      }
      case "sheet": {
        if (a.file) return a;
        const here = join(root, "questions-sheet.yaml");
        const pick = existsSync(here)
          ? await vscode.window.showQuickPick(
              [
                { label: "questions-sheet.yaml", description: "in the metarepo", file: here },
                { label: WORDS.sheetOther, file: "" },
              ],
              { title: WORDS.sheetPick },
            )
          : { file: "" };
        if (!pick) return undefined;
        if (pick.file) a.file = pick.file;
        else {
          const f = await vscode.window.showOpenDialog({
            title: WORDS.sheetPick,
            defaultUri: vscode.Uri.file(root),
            canSelectMany: false,
            filters: { YAML: ["yaml", "yml"] },
          });
          if (!f?.[0]) return undefined;
          a.file = f[0].fsPath;
        }
        return a;
      }
      case "rename": {
        a.old ??= await commands.pickTarget(root, "repo", title);
        if (!a.old) return undefined;
        if (!a.new) {
          const v = await vscode.window.showInputBox({
            title,
            prompt: WORDS.newRepoId(a.old),
            ignoreFocusOut: true,
            validateInput: (x) =>
              /^[a-z0-9][a-z0-9._-]*$/.test(x.trim()) && x.trim() !== a.old
                ? undefined
                : "A lowercase id, not the old one.",
          });
          if (!v?.trim()) return undefined;
          a.new = v.trim();
        }
        return a;
      }
      case "limit": {
        if (a.maxTokens) return a;
        const read = (rel: string) => {
          try {
            return readFileSync(join(root, ...rel.split("/")), "utf8");
          } catch {
            return undefined;
          }
        };
        const preset =
          runtimeMaxInput(read("org-pack/runtime.yaml")) ??
          runtimeMaxInput(read(".atticus/org-pack/runtime.yaml"));
        const v = await vscode.window.showInputBox({
          title,
          prompt: WORDS.mapEstateLimit,
          ...(preset ? { value: preset } : {}),
          ignoreFocusOut: true,
          validateInput: (x) => (limitOf(x) ? undefined : WORDS.mapEstateBadLimit),
        });
        const n = v === undefined ? undefined : limitOf(v);
        if (!n) return undefined;
        a.maxTokens = n;
        return a;
      }
      default:
        return a;
    }
  };

  /** Afterwards: the app page and the chat step that go with it, a click away. */
  const after = (root: string, j: Job, a: JobArgs, first: string, code: number) => {
    const buttons = [
      ...(j.app ? [WORDS.openInApp] : []),
      ...(j.chat ? [WORDS.openInChat] : []),
      ...(j.command === "atticus.questionsSheet" && code === 0 ? [WORDS.applySheet] : []),
      WORDS.showOutput,
    ];
    const show =
      code === 0 ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
    void show(`Atticus: ${first}`, ...buttons).then((pick) => {
      if (pick === WORDS.openInApp && j.app)
        void vscode.commands.executeCommand("atticus.showApp", j.app(a));
      else if (pick === WORDS.openInChat && j.chat) {
        const c = j.chat(a);
        void openChatStep(root, c.step, c.target);
      } else if (pick === WORDS.applySheet)
        void vscode.commands.executeCommand("atticus.questionsApply");
      else if (pick === WORDS.showOutput) svc.log.show(true);
    });
  };

  const runJob = async (j: Job, given: JobArgs = {}) => {
    const root = d.needRoot();
    if (!root) return;
    const a = await ask(root, j, given);
    if (!a) return;
    if (j.how === "chat") {
      const c = j.chat!(a);
      return openChatStep(root, c.step, c.target);
    }
    const argv = j.argv(a);
    // ADR 0161: map --all runs all day in a terminal, where the person types s, r and q.
    if (j.how === "terminal") return void d.inTerminal(root, "Atticus: map the estate", argv);
    if (j.how === "confirm") {
      const yes = await vscode.window.showWarningMessage(
        j.command === "atticus.repoRename"
          ? WORDS.renameConfirm(a.old!, a.new!)
          : WORDS.specAcceptConfirm(a.repo!),
        { modal: true, detail: commandText(argv) },
        WORDS.confirmRun,
      );
      if (yes !== WORDS.confirmRun) return;
    }
    const p = await commands.captured(root, argv);
    if (j.how === "report")
      await showReadOnly(
        `atticus ${argv.map((x) => (isAbsolute(x) ? x.split(/[\\/]/).pop() : x)).join(" ")}.txt`,
        `${p.lines.join("\n") || WORDS.endedWith(p.code)}\n`,
      );
    // The sheet, opened to fill in.
    if (j.command === "atticus.questionsSheet" && p.code === 0) {
      const sheet = join(root, "questions-sheet.yaml");
      if (existsSync(sheet))
        await vscode.window.showTextDocument(vscode.Uri.file(sheet), { preview: false });
    }
    after(root, j, a, p.lines[0] ?? WORDS.endedWith(p.code), p.code);
    d.refreshAll();
  };

  for (const j of JOBS)
    d.reg(j.command, (...given: unknown[]) => {
      // From a row's menu (a repo or a change), from the Next view's hint, or from the palette.
      const first = given[0] as { expand?: { kind?: string; repo?: string; change?: string } };
      const a: JobArgs = {};
      if (typeof given[0] === "string") {
        if (j.needs === "change") a.change = given[0];
        else if (j.needs === "rename") {
          a.old = given[0];
          if (typeof given[1] === "string") a.new = given[1];
        } else if (j.needs === "repo" || j.needs === "repo-or-estate") a.repo = given[0];
      } else if (first?.expand?.kind === "repo" && first.expand.repo) {
        if (j.needs === "rename") a.old = first.expand.repo;
        else a.repo = first.expand.repo;
      } else if (first?.expand?.kind === "change" && first.expand.change)
        a.change = first.expand.change;
      return runJob(j, a);
    });

  // ADR 0144 (Q5): a checked proposal made the person's answer, recorded as theirs.
  d.reg("atticus.acceptProposal", async (given?: unknown) => {
    const root = d.needRoot();
    if (!root) return;
    const qs = (d.questions() ?? []).filter((q) => q.about?.proposal);
    let id =
      typeof given === "string"
        ? given
        : given && typeof given === "object" && "id" in given
          ? String((given as { id: string }).id).replace(/^question:/, "")
          : undefined;
    if (!id) {
      if (!qs.length) return void vscode.window.showInformationMessage(WORDS.noProposal);
      const pick = await vscode.window.showQuickPick(
        qs.map((q) => ({
          label: q.question,
          description: `${q.repo} · ${proposalWhat(q) ?? ""}`,
          detail: q.about?.proposal?.why,
          id: q.id,
        })),
        { title: "Atticus: accept which proposal as your answer?" },
      );
      if (!pick) return;
      id = pick.id;
    }
    const asked = id;
    const done = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Atticus: accepting the proposal for ${asked}…`,
      },
      () => answerQuestion(svc.cli(root), root, asked, { acceptProposal: true }),
    );
    for (const l of done.lines) svc.log.appendLine(l);
    svc.fireChanged();
    d.refreshAll();
    const first = done.lines[0] ?? (done.ok ? `Answered ${asked}.` : `Couldn't answer ${asked}.`);
    if (done.ok)
      void vscode.window
        .showInformationMessage(first, WORDS.runNextStep)
        .then((p) => p && vscode.commands.executeCommand("atticus.runNext"));
    else
      void vscode.window
        .showErrorMessage(first, "Show details")
        .then((p) => p && svc.log.show(true));
  });

  // A step opened in Copilot Chat from @atticus's button (/gaps): agent mode, else its prompt file.
  d.reg("atticus.openChatStep", (step?: unknown, target?: unknown) => {
    const root = d.needRoot();
    if (root && typeof step === "string")
      return openChatStep(root, step, typeof target === "string" ? target : undefined);
  });
  // ADR 0140: My teams' questions, or every one, from the Questions view's title bar.
  d.reg("atticus.questionsMine", () => d.setMine(true));
  d.reg("atticus.questionsAll", () => d.setMine(false));
}
