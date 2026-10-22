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
import { diagramHash, panelHtml, type RunningApp } from "./app-panel";
import { chatHandler } from "./chat";
import { CommandUi } from "./command-ui";
import { FlowLenses } from "./codelens";
import { SectionTree, type Section } from "./sidebar";
import { findingActions, flowHash, stepOf, type Item, type Open } from "./sidebar-data";
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
  // The sections that read the app's API (ADR 0093): Repos, Changes and Catalog.
  const sections = (["repos", "changes", "knowledge", "catalog"] as Section[]).map((name) => {
    const tree = new SectionTree(svc, name);
    context.subscriptions.push(
      tree,
      vscode.window.registerTreeDataProvider(`atticus.${name}`, tree),
    );
    return tree;
  });
  const lenses = new FlowLenses(svc);
  context.subscriptions.push(
    lenses,
    vscode.languages.registerCodeLensProvider(
      { scheme: "file" },
      {
        onDidChangeCodeLenses: lenses.onDidChangeCodeLenses,
        provideCodeLenses: (doc) =>
          vscode.workspace.getConfiguration("atticus").get<boolean>("codeLens", true)
            ? lenses.provideCodeLenses(doc)
            : [],
      },
    ),
  );
  const refreshAll = () => {
    void view.refresh().then(updateStatus);
    for (const t of sections) t.refresh();
    lenses.refresh();
  };

  // The open questions and the next step at a glance.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = "workbench.view.extension.atticus";
  context.subscriptions.push(status);
  const updateStatus = () => {
    if (!svc.root) return status.hide();
    const q = view.openQuestions;
    const parts = [q === undefined ? "" : `${q} question${q === 1 ? "" : "s"}`];
    if (view.next)
      parts.push(view.next.person ? "next: a person's step" : `next: ${view.next.step}`);
    status.text = `$(shield) Atticus${parts.some(Boolean) ? `: ${parts.filter(Boolean).join(" · ")}` : ""}`;
    status.tooltip = view.next
      ? `Next: ${view.next.command}
${view.next.why}`
      : "Open the Atticus sidebar";
    status.show();
  };

  context.subscriptions.push(svc.onChanged(refreshAll));
  // Specs, changes, the catalog and questions are files: follow them when they change.
  const files = vscode.workspace.createFileSystemWatcher(
    "**/{specs,catalog,openspec,questions}/**/*.{yaml,md}",
  );
  let pending: ReturnType<typeof setTimeout> | undefined;
  const soon = () => {
    clearTimeout(pending);
    pending = setTimeout(refreshAll, 1500);
  };
  for (const ev of [files.onDidCreate, files.onDidChange, files.onDidDelete])
    context.subscriptions.push(ev(soon));
  context.subscriptions.push(files, { dispose: () => clearTimeout(pending) });

  const participant = vscode.chat.createChatParticipant(
    "atticus.chat",
    chatHandler(svc, () => commands),
  );
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "atticus.svg");
  context.subscriptions.push(participant);

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

  reg("atticus.refresh", refreshAll);

  // ADR 0096: every command the command line has, from its own catalogue.
  const commands = new CommandUi(svc, { runAi, inTerminal, refreshAll });
  const withRoot = (f: (root: string) => unknown) => () => {
    const root = needRoot();
    if (root) void f(root);
  };
  reg(
    "atticus.runCommand",
    (id?: string, preset?: { args?: string[]; flags?: Record<string, string | true> }) => {
      const root = needRoot();
      if (root) void commands.pickAndRun(root, id, preset ?? {});
    },
  );
  reg("atticus.runApproved", (argv: string[], flag: string) => {
    const root = needRoot();
    if (!root || !Array.isArray(argv) || typeof flag !== "string") return;
    // The person's click in the chat, then the same yes in the editor, before the shared write.
    void commands.approveAndRun(root, argv, flag).then((p) => {
      if (p) {
        for (const l of p.lines) svc.log.appendLine(l);
        void vscode.window.showInformationMessage(
          `atticus ${argv.slice(0, 2).join(" ")}: ${p.lines[0] ?? "done"}`,
        );
        refreshAll();
      }
    });
  });
  reg("atticus.newChange", (title?: string) => {
    const root = needRoot();
    if (root) void commands.newChange(root, typeof title === "string" ? title : undefined);
  });
  reg("atticus.repoCommand", (item?: Item) => {
    const root = needRoot();
    const repo = item?.expand?.kind === "repo" ? item.expand.repo : undefined;
    if (root) void (repo ? commands.forItem(root, "repo", repo) : commands.pickAndRun(root));
  });
  reg("atticus.changeCommand", (item?: Item) => {
    const root = needRoot();
    const change = item?.expand?.kind === "change" ? item.expand.change : undefined;
    if (root) void (change ? commands.forItem(root, "change", change) : commands.pickAndRun(root));
  });
  reg("atticus.runTask", (item?: Item) => {
    const root = needRoot();
    if (root && item?.task)
      void commands.pickAndRun(root, "task run", { args: [item.task.change, item.task.id] });
  });
  reg(
    "atticus.checkHealth",
    withRoot((root) => commands.checkHealth(root, false)),
  );
  // The everyday ones, one click from the sidebar's title bars.
  const shortcut: [string, string][] = [
    ["atticus.scanAll", "scan"],
    ["atticus.estateJoin", "estate join"],
    ["atticus.workspaceSync", "workspace sync"],
    ["atticus.sourcesSync", "sources sync"],
    ["atticus.knowledgeScan", "knowledge scan"],
    ["atticus.knowledgeAsk", "knowledge ask"],
    ["atticus.upgrade", "upgrade"],
    ["atticus.setup", "setup"],
    ["atticus.digest", "digest"],
  ];
  for (const [name, id] of shortcut)
    reg(
      name,
      withRoot((root) => commands.pickAndRun(root, id)),
    );
  reg("atticus.openItem", async (o: Open, how?: { beside?: boolean }): Promise<unknown> => {
    if (o.kind === "app")
      return vscode.commands.executeCommand("atticus.showApp", o.hash, how ?? {});
    if (o.kind === "missing") return void vscode.window.showWarningMessage(o.message);
    if (o.kind === "pick") {
      const pick = await vscode.window.showQuickPick(
        o.choices.map((c) => ({ label: c.label, ...(c.detail ? { detail: c.detail } : {}), c })),
        { placeHolder: o.title },
      );
      return pick ? vscode.commands.executeCommand("atticus.openItem", pick.c.open) : undefined;
    }
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(o.path));
      const line = Math.max(0, Math.min((o.line ?? 1) - 1, doc.lineCount - 1));
      const range = new vscode.Range(line, 0, line, 0);
      await vscode.window.showTextDocument(doc, {
        preview: true,
        selection: range,
        viewColumn: vscode.ViewColumn.One,
      });
    } catch {
      void vscode.window.showWarningMessage(`${o.path} isn't there. Scan or sync again.`);
    }
  });
  // A finding's action from the sidebar (ADR 0094): the API's own action, so the critic's rules
  // apply; the person picks it, gives what it needs, and confirms a patch before it is applied.
  reg("atticus.findingAction", async (item: Item) => {
    const root = needRoot();
    const f = item?.finding;
    if (!root || !f) return;
    const choices = findingActions(f);
    const pick = await vscode.window.showQuickPick(
      choices.map((c) => ({ label: c.label, c })),
      { title: f.summary, placeHolder: "What do you want to do with this finding?" },
    );
    if (!pick) return;
    const c = pick.c;
    const body: Record<string, string> = { action: c.action };
    if (c.askedOf) body.askedOf = c.askedOf;
    if (c.needs === "askedOf") {
      const who = await vscode.window.showInputBox({
        title: f.summary,
        prompt: "Who should answer? A person's handle or a role.",
        ignoreFocusOut: true,
      });
      if (!who?.trim()) return;
      body.askedOf = who.trim();
    }
    if (c.needs === "reason") {
      const why = await vscode.window.showInputBox({
        title: f.summary,
        prompt:
          c.action === "edit-and-apply"
            ? "What did you change? It is kept with the finding."
            : "Why? It is kept with the finding, and the critic learns from it.",
        ignoreFocusOut: true,
      });
      if (!why?.trim()) return;
      body.reason = why.trim();
    }
    if (c.action === "apply") {
      const ok = await vscode.window.showWarningMessage(
        `Apply the fix to ${f.artifact}?`,
        { modal: true, detail: f.fix.patch ?? f.fix.text },
        "Apply",
      );
      if (ok !== "Apply") return;
    }
    try {
      const api = await svc.api(root);
      await api.post(
        `/api/findings/${encodeURIComponent(f.change)}/${encodeURIComponent(f.id)}/action`,
        body,
      );
      void vscode.window.showInformationMessage(`${c.label}: done. ${f.summary}`);
      refreshAll();
    } catch (e) {
      void vscode.window.showErrorMessage(`Couldn't do that: ${(e as Error).message}`);
    }
  });
  reg("atticus.showStep", (item: Item) => {
    const s = stepOf(item.id);
    if (s)
      void vscode.commands.executeCommand("atticus.showApp", flowHash(s.repo, s.flow, s.n), {
        beside: true,
      });
  });
  reg("atticus.showFlow", (item: Item) => {
    if (item.open?.kind === "app")
      void vscode.commands.executeCommand("atticus.showApp", item.open.hash);
  });
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

  // The app in a VS Code tab (ADR 0091): the one atticus ui the service runs for this window.
  let panel: vscode.WebviewPanel | undefined;
  reg("atticus.showApp", async (hash?: string, o?: { beside?: boolean }) => {
    const root = needRoot();
    if (!root) return;
    let a: RunningApp;
    try {
      a = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Starting the Atticus app..." },
        () => svc.runningApp(root),
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
    // Beside the code when asked from it (a CodeLens, a step), so both are read together.
    const column = o?.beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
    if (!panel) {
      panel = vscode.window.createWebviewPanel(
        "atticus.app",
        "Atticus",
        { viewColumn: column, preserveFocus: !!o?.beside },
        // The app runs in the frame; the panel's own page has no script (its CSP allows none).
        { enableScripts: true, retainContextWhenHidden: true },
      );
      panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "atticus.svg");
      panel.onDidDispose(() => (panel = undefined));
    }
    panel.webview.html = panelHtml(src);
    panel.reveal(undefined, !!o?.beside);
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

  void view.refresh().then(updateStatus);
  // When the window opens: is the metarepo up to date, and is this machine ready?
  if (svc.root) void commands.checkHealth(svc.root, true).catch(() => undefined);
}

export function deactivate() {
  // Everything registered is in context.subscriptions.
}
