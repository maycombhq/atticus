import { request } from "node:http";
import * as vscode from "vscode";
import {
  actionFor,
  answerQuestion,
  argsOf,
  readNext,
  readOpenQuestions,
  STEP_COMMANDS,
  type StepCommand,
} from "./atticus";
import { diagramHash, panelHtml, startApp, type RunningApp } from "./app-panel";
import { chatHandler } from "./chat";
import { commandText } from "./cli";
import { describeEnd } from "./describe";
import type { StepEnd } from "./runner";
import { Service } from "./service";
import { AtticusView } from "./view";

/**
 * The Atticus extension (ADR 0090, plan 4.8): a thin runner of Atticus's AI steps with
 * Copilot's model through vscode.lm. Atticus's command line keeps every check; the extension
 * carries prompts and answers between it and the model, and shows what it did. No telemetry.
 */

const APP_PORT = 4321;

/** Whether something answers on the app's address yet. */
const answers = (url: string) =>
  new Promise<boolean>((done) => {
    const r = request(url, { method: "HEAD", timeout: 1000 }, (res) => {
      res.resume();
      done(true);
    });
    r.on("error", () => done(false));
    r.on("timeout", () => {
      r.destroy();
      done(false);
    });
    r.end();
  });

export function activate(context: vscode.ExtensionContext) {
  const svc = new Service();
  const view = new AtticusView(svc);
  const reg = (id: string, f: (...a: never[]) => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, f as (...a: unknown[]) => unknown),
    );
  context.subscriptions.push(
    svc,
    view,
    vscode.window.registerTreeDataProvider("atticus.view", view),
  );
  context.subscriptions.push(svc.onChanged(() => void view.refresh()));

  const participant = vscode.chat.createChatParticipant("atticus.chat", chatHandler(svc));
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "atticus.svg");
  context.subscriptions.push(participant);

  // The view follows the questions people answer in the app or the terminal.
  const watcher = vscode.workspace.createFileSystemWatcher("**/questions/*.yaml");
  for (const ev of [watcher.onDidCreate, watcher.onDidChange, watcher.onDidDelete])
    context.subscriptions.push(ev(() => void view.refresh()));
  context.subscriptions.push(watcher);

  const needRoot = (): string | undefined => {
    const root = svc.root;
    if (!root)
      void vscode.window.showWarningMessage(
        "Open the metarepo folder (the one with org-pack/) first.",
      );
    return root;
  };

  /** Show how a step ended: the first line in a notification, all of it in the output. */
  const showEnd = async (end: StepEnd) => {
    const lines = describeEnd(end);
    for (const l of lines) svc.log.appendLine(l);
    const actions = end.state === "question" ? ["Answer", "Show details"] : ["Show details"];
    const show =
      end.state === "done"
        ? vscode.window.showInformationMessage
        : end.state === "failed" || end.state === "model-error"
          ? vscode.window.showErrorMessage
          : vscode.window.showWarningMessage;
    const pick = await show(lines[0]!, ...actions);
    if (pick === "Answer") await vscode.commands.executeCommand("atticus.answerQuestion");
    else if (pick === "Show details") svc.log.show(true);
  };

  const runAi = async (args: string[], spec?: string) => {
    const root = needRoot();
    if (!root) return;
    const end = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Atticus: ${commandText(args)}`,
        cancellable: true,
      },
      (p, token) =>
        svc.run(root, { args, ...(spec ? { spec } : {}) }, (l) => p.report({ message: l }), token),
    );
    await showEnd(end);
  };

  /**
   * A deterministic command in a terminal the person sees: started as its own process when
   * atticus resolves to one (no shell quoting), else typed into a shell. With run false the
   * command is typed but not run, for the person to finish and run.
   */
  const inTerminal = (root: string, name: string, args: string[], run = true) => {
    const cmd = svc.command(root);
    const own = run && !cmd.shell;
    const t = own
      ? vscode.window.createTerminal({
          name,
          cwd: root,
          shellPath: cmd.file,
          shellArgs: [...cmd.prefix, ...args],
        })
      : vscode.window.createTerminal({ name, cwd: root });
    if (!own) t.sendText(commandText(args), run);
    t.show(true);
    if (run) svc.log.appendLine(`> ${commandText(args)} (in the terminal "${name}")`);
    return t;
  };

  reg("atticus.refresh", () => view.refresh());
  reg("atticus.showLog", () => svc.log.show());
  reg("atticus.next", async () => {
    const root = needRoot();
    if (!root) return;
    const r = await readNext(svc.cli(root), root);
    if (!r.ok)
      return void vscode.window.showErrorMessage(`Couldn't read the next step: ${r.message}`);
    const n = r.value.next;
    if (!n)
      return void vscode.window.showInformationMessage("Atticus has no next step to suggest.");
    const pick = await vscode.window.showInformationMessage(
      `Next: ${n.command}. ${n.why}`,
      "Run it",
    );
    if (pick) await vscode.commands.executeCommand("atticus.runNext");
  });
  reg("atticus.runNext", async () => {
    const root = needRoot();
    if (!root) return;
    let n = view.next;
    if (!n) {
      const r = await readNext(svc.cli(root), root);
      if (!r.ok)
        return void vscode.window.showErrorMessage(`Couldn't read the next step: ${r.message}`);
      n = r.value.next;
    }
    if (!n)
      return void vscode.window.showInformationMessage("Atticus has no next step to suggest.");
    const a = actionFor(n);
    if (a.kind === "ai") return runAi(a.args, a.spec);
    if (a.kind === "answer") return vscode.commands.executeCommand("atticus.answerQuestion");
    if (a.kind === "run") {
      const t = inTerminal(root, "Atticus", [...a.args, "--root", root]);
      // The view reads the files again once the command ends.
      const sub = vscode.window.onDidCloseTerminal((c) => {
        if (c === t) {
          sub.dispose();
          svc.fireChanged();
        }
      });
      context.subscriptions.push(sub);
      return;
    }
    // A person's step, or one with a part to fill in: typed into a terminal, not run.
    inTerminal(root, "Atticus", argsOf(a.command), false);
    void vscode.window.showInformationMessage(`A person takes this step: ${n.why}`);
  });

  for (const name of Object.keys(STEP_COMMANDS) as StepCommand[]) {
    const step = STEP_COMMANDS[name];
    reg(`atticus.${name}`, async (target?: string) => {
      const t =
        target ??
        (await vscode.window.showInputBox({
          prompt: `Which ${step.target}? (its id, as atticus lists it)`,
          ignoreFocusOut: true,
        }));
      if (!t?.trim()) return;
      await runAi(step.args(t.trim()), name === "spec" ? t.trim() : undefined);
    });
  }

  reg("atticus.answerQuestion", async (id?: string, option?: number) => {
    const root = needRoot();
    if (!root) return;
    const cli = svc.cli(root);
    const r = await readOpenQuestions(cli, root);
    if (!r.ok)
      return void vscode.window.showErrorMessage(`Couldn't read the questions: ${r.message}`);
    let q = r.value.find((x) => x.id === id);
    if (!q) {
      if (id)
        return void vscode.window.showWarningMessage(`${id} isn't an open question any more.`);
      if (!r.value.length)
        return void vscode.window.showInformationMessage("No question is waiting for an answer.");
      const pick = await vscode.window.showQuickPick(
        r.value.map((x) => ({ label: x.question, description: x.repo, detail: x.id, q: x })),
        { placeHolder: "Which question?", ignoreFocusOut: true },
      );
      if (!pick) return;
      q = pick.q;
    }
    let answer: { option: number } | { text: string } | undefined =
      option !== undefined ? { option } : undefined;
    if (!answer) {
      const own = { label: "In my own words...", n: 0 };
      const pick = await vscode.window.showQuickPick(
        [
          ...q.options.map((o, i) => ({
            label: `${i + 1}. ${o.label}`,
            detail: o.means,
            n: i + 1,
          })),
          own,
        ],
        { title: q.question, placeHolder: "Pick the answer", ignoreFocusOut: true },
      );
      if (!pick) return;
      if (pick.n) answer = { option: pick.n };
      else {
        const text = await vscode.window.showInputBox({
          title: q.question,
          prompt: "Your answer",
          ignoreFocusOut: true,
        });
        if (!text?.trim()) return;
        answer = { text: text.trim() };
      }
    }
    const done = await answerQuestion(cli, root, q.id, answer);
    svc.fireChanged();
    for (const l of done.lines) svc.log.appendLine(l);
    const first = done.lines[0] ?? (done.ok ? `Answered ${q.id}.` : `Couldn't answer ${q.id}.`);
    const next = done.lines.find((l) => l.startsWith("Next: "));
    if (done.ok) void vscode.window.showInformationMessage(next ? `${first} ${next}` : first);
    else
      void vscode.window
        .showErrorMessage(first, "Show details")
        .then((p) => p && svc.log.show(true));
  });
  reg("atticus.answer", () => vscode.commands.executeCommand("atticus.answerQuestion"));

  reg("atticus.ask", async () => {
    const root = needRoot();
    if (!root) return;
    const question = await vscode.window.showInputBox({
      prompt: "Ask the catalog a plain question",
      ignoreFocusOut: true,
    });
    if (!question?.trim()) return;
    const r = await svc.cli(root)(["ask", question.trim(), "--root", root]);
    svc.log.appendLine(r.stdout.trimEnd());
    svc.log.show(true);
  });

  // The app in a VS Code tab (ADR 0091): one atticus ui per window, started for the panel.
  let app: Promise<RunningApp> | undefined;
  let panel: vscode.WebviewPanel | undefined;
  context.subscriptions.push({
    dispose: () =>
      void app?.then(
        (a) => a.stop(),
        () => undefined,
      ),
  });
  const ensureApp = (root: string) => {
    if (!app) {
      const started = startApp(svc.cliOptions(root));
      app = started;
      started.then(
        (a) => a.onExit(() => (app === started ? (app = undefined) : undefined)),
        () => (app === started ? (app = undefined) : undefined),
      );
    }
    return app;
  };
  reg("atticus.showApp", async (hash?: string) => {
    const root = needRoot();
    if (!root) return;
    let a: RunningApp;
    try {
      a = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Starting the Atticus app..." },
        () => ensureApp(root),
      );
    } catch (e) {
      const pick = await vscode.window.showErrorMessage(
        `The Atticus app didn't start: ${(e as Error).message}`,
        "Show details",
      );
      if (pick) svc.log.show(true);
      return;
    }
    const external = (await vscode.env.asExternalUri(vscode.Uri.parse(a.url))).toString(true);
    const src = `${external.replace(/\/$/, "")}/${hash ?? ""}`;
    if (!panel) {
      panel = vscode.window.createWebviewPanel(
        "atticus.app",
        "Atticus",
        vscode.ViewColumn.Active,
        // The app runs in the frame; the panel's own page has no script (its CSP allows none).
        { enableScripts: true, retainContextWhenHidden: true },
      );
      panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "atticus.svg");
      panel.onDidDispose(() => (panel = undefined));
    }
    panel.webview.html = panelHtml(src);
    panel.reveal();
  });
  reg("atticus.diagram", async (target?: string) => {
    const t =
      target ??
      (await vscode.window.showInputBox({
        prompt:
          "Which repo? Its name, or a node id such as system:payments; add a flow's id or words to open a flow. Empty: the estate.",
        ignoreFocusOut: true,
      }));
    if (t === undefined) return;
    await vscode.commands.executeCommand("atticus.showApp", diagramHash(t));
  });

  reg("atticus.openApp", async () => {
    const root = needRoot();
    if (!root) return;
    inTerminal(root, "Atticus app", ["ui", "--port", String(APP_PORT), "--root", root]);
    const url = `http://127.0.0.1:${APP_PORT}/`;
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Starting the Atticus app...",
        cancellable: true,
      },
      async (_p, token) => {
        for (let i = 0; i < 60 && !token.isCancellationRequested; i++) {
          if (await answers(url)) {
            await vscode.env.openExternal(vscode.Uri.parse(url));
            return;
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        if (!token.isCancellationRequested)
          void vscode.window.showWarningMessage(
            `The app didn't answer on ${url}. The terminal "Atticus app" says why.`,
          );
      },
    );
  });

  void view.refresh();
}

export function deactivate() {
  // Everything registered is in context.subscriptions.
}
