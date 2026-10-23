import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
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
import { answerApp, bundledHtml } from "./app-bundle";
import { diagramHash, panelHtml, type RunningApp } from "./app-panel";
import { changeDiagramHash, estimateHash } from "./change-map";
import { HISTORY_HASH } from "./history";
import { chatHandler } from "./chat";
import { CommandUi, SHOWN_SCHEME, showReadOnly, shownDocs } from "./command-ui";
import { FlowLenses } from "./codelens";
import { FILTER_PLACEHOLDER, FILTER_PROMPT, filterDescription } from "./filter";
import { urlsOf } from "./knowledge-data";
import { KnowledgeUi } from "./knowledge-ui";
import type { NextStep, OpenQuestion } from "./types";
import { SectionTree, type Section } from "./sidebar";
import { findingActions, flowHash, stepOf, type Item, type Open } from "./sidebar-data";
import { setupAction } from "./guided";
import { commandText } from "./cli";
import { copilotSetup, describeEnd, endActions, endFiles } from "./describe";
import { aiProgressTitle, runProgressTitle } from "./feedback";
import { pickLoading } from "./pick";
import { statusText, stepTitle, WORDS } from "./words";
import type { StepEnd } from "./runner";
import { checkRunStep, runEndMessage, runProgressMessage, runRefusedMessage } from "./run-step";
import type * as Api from "./api-types";
import { Service } from "./service";
import { attachPaths, START_WORDS, startTaskChat, TASK_PROMPT_FILE } from "./task-start";
import { AtticusView, WaitingView } from "./view";
import type { WaitingGroup } from "./waiting-data";

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

/** What the extension's own tests in VS Code look at (scripts/test-in-vscode.mjs). */
export interface AtticusHandles {
  ready: Promise<void>;
  view: AtticusView;
  waiting: WaitingView;
  sections: Record<string, SectionTree>;
  panel: () => vscode.WebviewPanel | undefined;
  service: Service;
  status: vscode.StatusBarItem;
  commands: CommandUi;
  /** A run-step message from the app's panel (ADR 0106), its replies posted to `post`. */
  runFromApp: (m: unknown, post: (reply: object) => void) => Promise<void>;
}

export function activate(context: vscode.ExtensionContext): AtticusHandles {
  const svc = new Service();
  const view = new AtticusView(svc);
  // ADR 0105: Waiting on you keeps the Questions view's id, so settings that name it still work.
  const waiting = new WaitingView(svc, view);
  const reg = (id: string, f: (...a: never[]) => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, f as (...a: unknown[]) => unknown),
    );
  context.subscriptions.push(
    svc,
    view,
    waiting,
    vscode.window.registerTreeDataProvider("atticus.view", view),
  );
  // Waiting on you, Changes and Knowledge are filtered, and say so in their description (ADR 0105).
  const treeViews: Record<string, vscode.TreeView<unknown>> = {};
  const waitingView = vscode.window.createTreeView("atticus.questions", {
    treeDataProvider: waiting,
  });
  treeViews.questions = waitingView as vscode.TreeView<unknown>;
  context.subscriptions.push(waitingView);
  // The sections that read the app's API (ADR 0093), in the sidebar's order (ADR 0105), and the
  // model runs at the bottom (ADR 0106), read from the command line.
  const SECTIONS: Section[] = ["changes", "knowledge", "repos", "catalog", "runs"];
  const sections = SECTIONS.map((name) => {
    const tree = new SectionTree(svc, name);
    if (name === "changes" || name === "knowledge" || name === "runs") {
      const tv = vscode.window.createTreeView(`atticus.${name}`, { treeDataProvider: tree });
      treeViews[name] = tv as vscode.TreeView<unknown>;
      context.subscriptions.push(tree, tv);
    } else
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
    // A metarepo made or adopted in this window shows its sections at once, not after a reload.
    void vscode.commands.executeCommand("setContext", "atticus.hasMetarepo", !!svc.root);
    void view.refresh().then(updateStatus);
    waiting.refresh();
    for (const t of sections) t.refresh();
    lenses.refresh();
  };

  // The open questions and the next step at a glance.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = "workbench.view.extension.atticus";
  context.subscriptions.push(status);
  const updateStatus = () => {
    if (!svc.root) return status.hide();
    // Without the command line nothing was read: say so, not "0 questions".
    status.text = svc.cliOk
      ? statusText(view.openQuestions, view.next, view.changeTitle)
      : "$(warning) Atticus: no command line";
    status.tooltip = view.next
      ? `Next: ${view.next.command}
${view.next.why}`
      : "Open the Atticus sidebar";
    status.show();
  };

  context.subscriptions.push(svc.onChanged(refreshAll));
  // Whatever read the Next section again, the status bar follows what it read last.
  context.subscriptions.push(view.onDidChangeTreeData(() => updateStatus()));
  // Specs, changes, the catalog and questions are files: follow them when they change.
  const files = vscode.workspace.createFileSystemWatcher(
    "**/{specs,catalog,openspec,questions,knowledge,org-pack}/**/*.{yaml,md}",
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
      void vscode.window
        .showWarningMessage(
          "This needs an Atticus metarepo open in the window (a folder with org-pack/). None is open.",
          "Open a metarepo",
          "Create one",
        )
        .then((p) => {
          if (p === "Open a metarepo") void vscode.commands.executeCommand("vscode.openFolder");
          else if (p === "Create one")
            void vscode.commands.executeCommand("atticus.createMetarepo");
        });
    else if (!svc.cliOk)
      void vscode.window
        .showWarningMessage(
          "Atticus can't run its command line (atticus). Install it, or set its path in the setting atticus.path.",
          "Check again",
        )
        .then((p) => p && vscode.commands.executeCommand("atticus.checkHealth"));
    return root && svc.cliOk ? root : undefined;
  };

  /** Show how a step ended: the first line in a notification, all of it in the output. */
  const showEnd = async (end: StepEnd) => {
    const lines = describeEnd(end);
    // ADR 0106: the last round's prompt and answer, a click away.
    const files = endFiles(end, svc.root ?? "");
    for (const l of lines) svc.log.appendLine(l);
    const actions = endActions(end, {
      copilot: !!vscode.extensions.getExtension("GitHub.copilot-chat"),
    });
    const show =
      end.state === "done"
        ? vscode.window.showInformationMessage
        : end.state === "failed" || end.state === "model-error"
          ? vscode.window.showErrorMessage
          : vscode.window.showWarningMessage;
    // No model stops every AI step, and a notice like one already in the bell isn't shown again:
    // a dialog, so a second click is never silent.
    const pick =
      end.state === "no-model"
        ? await vscode.window.showWarningMessage(
            lines[0]!,
            {
              modal: true,
              detail:
                "Atticus's AI steps run with GitHub Copilot in VS Code. Once Copilot is set up and signed in, run the step again.",
            },
            ...actions.filter((a) => a !== "Show details"),
          )
        : await show(lines[0]!, ...actions);
    if (pick === "Answer") await vscode.commands.executeCommand("atticus.answerQuestion");
    else if (pick === "Set up Copilot")
      // VS Code's own Copilot setup: sign in, or turn it on.
      await vscode.commands.executeCommand("atticus.installCopilot");
    else if (pick === "Pick a model")
      await vscode.commands.executeCommand("workbench.action.openSettings", "atticus.model");
    else if (pick === "Show details") svc.log.show(true);
    else {
      const f = files.find((x) => x.title === pick);
      if (f)
        await vscode.commands.executeCommand("atticus.openItem", { kind: "file", path: f.path });
    }
  };

  const runAi = async (
    args: string[],
    spec?: string,
    o: { title?: string; quiet?: boolean; progress?: (line: string) => void } = {},
  ) => {
    const root = needRoot();
    if (!root) return;
    const end = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Atticus: ${o.title ?? aiProgressTitle(args)}…`,
        cancellable: true,
      },
      (p, token) => {
        p.report({ message: `${commandText(args)}` });
        return svc.run(
          root,
          { args, ...(spec ? { spec } : {}) },
          (l) => {
            p.report({ message: l });
            o.progress?.(l);
          },
          token,
        );
      },
    );
    // Not awaited: the notice can sit in the bell, and what comes next mustn't wait on it.
    if (o.quiet && end.state === "done") for (const l of describeEnd(end)) svc.log.appendLine(l);
    else void showEnd(end);
    svc.fireChanged();
    return end;
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

  // ADR 0105 addendum: Waiting on you by change (the default) or by kind, remembered for the
  // workspace; the title bar shows the button for the other.
  const GROUP_KEY = "atticus.waitingGroup";
  const setGroup = (g: WaitingGroup) => {
    waiting.setGroup(g);
    void context.workspaceState.update(GROUP_KEY, g);
    void vscode.commands.executeCommand("setContext", GROUP_KEY, g);
  };
  setGroup(context.workspaceState.get<WaitingGroup>(GROUP_KEY) === "kind" ? "kind" : "change");
  reg("atticus.waitingByKind", () => setGroup("kind"));
  reg("atticus.waitingByChange", () => setGroup("change"));

  // A filter on Waiting on you, Changes and Knowledge, each its own for the session: the view's
  // description says it, and Clear filter (shown while one is on) removes it.
  const filtered: Record<string, { setFilter: (w: string) => void; filter: string }> = {
    questions: waiting,
    changes: sections[SECTIONS.indexOf("changes")]!,
    knowledge: sections[SECTIONS.indexOf("knowledge")]!,
    runs: sections[SECTIONS.indexOf("runs")]!,
  };
  const NAMES: Record<string, string> = {
    questions: "Waiting on you",
    changes: "Changes",
    knowledge: "Knowledge",
    runs: "Model runs",
  };
  const setFilter = (view: string, words: string) => {
    const w = words.trim();
    filtered[view]!.setFilter(w);
    const tv = treeViews[view];
    if (tv) tv.description = filterDescription(w);
    void vscode.commands.executeCommand("setContext", `atticus.filtered.${view}`, !!w);
  };
  for (const [command, view] of [
    ["atticus.filterWaiting", "questions"],
    ["atticus.filterChanges", "changes"],
    ["atticus.filterKnowledge", "knowledge"],
    ["atticus.filterRuns", "runs"],
  ] as const)
    reg(command, async () => {
      const words = await vscode.window.showInputBox({
        title: `Filter ${NAMES[view]}`,
        placeHolder: FILTER_PLACEHOLDER,
        prompt: FILTER_PROMPT,
        value: filtered[view]!.filter,
      });
      if (words !== undefined) setFilter(view, words);
    });
  for (const [command, view] of [
    ["atticus.clearFilterWaiting", "questions"],
    ["atticus.clearFilterChanges", "changes"],
    ["atticus.clearFilterKnowledge", "knowledge"],
    ["atticus.clearFilterRuns", "runs"],
  ] as const)
    reg(command, () => setFilter(view, ""));

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
  // ADR 0113: a task started in Copilot's agent mode with its context, nothing pasted.
  reg("atticus.startTask", async (item?: Item) => {
    const root = needRoot();
    if (!root) return;
    const change =
      item?.task?.change ?? (await commands.pickTarget(root, "change", START_WORDS.pickChange));
    if (!change) return;
    let task = item?.task?.id;
    if (!task) {
      let tasks: Api.Task[];
      try {
        tasks = await svc
          .api(root)
          .then((x) => x.get<Api.Task[]>(`/api/changes/${encodeURIComponent(change)}/tasks`));
      } catch (e) {
        // A read that failed is not "no tasks" (ADR 0119): say so, with the output.
        const why = e instanceof Error ? e.message : String(e);
        svc.log.appendLine(START_WORDS.tasksFailed(change, why));
        void vscode.window
          .showErrorMessage(START_WORDS.tasksFailed(change, why), WORDS.showOutput)
          .then((p) => p && svc.log.show());
        return;
      }
      if (!tasks.length) {
        void vscode.window.showWarningMessage(START_WORDS.noTasks(change));
        return;
      }
      task = (
        await vscode.window.showQuickPick(
          tasks.map((t) => ({
            label: `${t.id} ${t.description}`,
            description: `${t.repo}${t.done ? " · done" : ""}`,
            value: t.id,
          })),
          { title: START_WORDS.pickTask },
        )
      )?.value;
      if (!task) return;
    }
    const r = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: START_WORDS.reading(task) },
      () => svc.cli(root)(["task", "context", change, task!, "--markdown", "--root", root]),
    );
    if (r.code !== 0) {
      void vscode.window.showErrorMessage(
        START_WORDS.failed(r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`),
      );
      return;
    }
    const chat = startTaskChat(
      change,
      task,
      r.stdout,
      existsSync(join(root, ...TASK_PROMPT_FILE.split("/"))),
    );
    try {
      await vscode.commands.executeCommand("workbench.action.chat.open", chat);
      void vscode.window.showInformationMessage(START_WORDS.opened(task));
    } catch (e) {
      await vscode.env.clipboard.writeText(r.stdout);
      void vscode.window.showWarningMessage(START_WORDS.copied(task, (e as Error).message));
    }
  });
  // ADR 0113: files into a change, from the palette, a change in the sidebar or the Explorer.
  reg("atticus.attachToChange", (target?: vscode.Uri | Item, selected?: vscode.Uri[]) => {
    const root = needRoot();
    if (!root) return;
    const uri = target instanceof vscode.Uri ? target : undefined;
    const change =
      !uri && (target as Item | undefined)?.expand?.kind === "change"
        ? ((target as Item).expand as { change: string }).change
        : undefined;
    const paths = attachPaths(uri, selected);
    void commands.pickAndRun(root, "change attach", {
      args: [change, ...(paths.length ? [paths] : [])],
    });
  });
  /**
   * A step the app in a panel asks to run (ADR 0106): only the catalogue's AI steps, no argument
   * that starts with "-", run as the sidebar runs them (runAi: Copilot, consent, the checks), its
   * progress and its end posted back to the page.
   */
  const runFromApp = async (m: unknown, post: (reply: object) => void) => {
    const root = needRoot();
    const id = (m as { id?: unknown }).id;
    if (!root) return post(runEndMessage(id, undefined));
    let checked;
    try {
      checked = checkRunStep(m, await commands.load(root));
    } catch (e) {
      return post(
        runRefusedMessage(
          id,
          `The command line's commands couldn't be read: ${(e as Error).message}`,
        ),
      );
    }
    if (!checked) return;
    if (!checked.ok) {
      svc.log.appendLine(`The app asked to run a step, refused: ${checked.reason}`);
      return post(runRefusedMessage(checked.id, checked.reason));
    }
    const { id: runId, args, spec } = checked;
    svc.log.appendLine(`The app asked to run: atticus ${args.join(" ")}`);
    const end = await runAi(args, spec, {
      progress: (line) => post(runProgressMessage(runId, line)),
    });
    post(runEndMessage(runId, end));
  };

  // ADR 0106: an answer the run keeps in its record, not in a file, shown read-only.
  reg("atticus.openRunAnswer", async (runId?: unknown) => {
    const root = needRoot();
    if (!root || typeof runId !== "string") return;
    const r = await svc.cli(root)(["runs", "show", runId, "--json", "--root", root]);
    let answer: string | undefined;
    try {
      answer = (JSON.parse(r.stdout) as { answer?: string }).answer;
    } catch {
      // said below
    }
    if (answer === undefined)
      return void vscode.window.showWarningMessage(
        `The answer of ${runId} couldn't be read${r.stderr.trim() ? `: ${r.stderr.trim().split("\n")[0]}` : "."}`,
      );
    await showReadOnly(`${runId} answer.txt`, answer);
  });

  // ADR 0098: what is set up, as context keys the welcome views and the walkthrough read.
  const updateContext = async () => {
    const at = svc.root ?? svc.folder ?? context.extensionPath;
    const v = await svc.cli(at)(["--version"]);
    svc.cliOk = v.code === 0;
    void vscode.commands.executeCommand("setContext", "atticus.cliMissing", !svc.cliOk);
    void vscode.commands.executeCommand("setContext", "atticus.hasMetarepo", !!svc.root);
    void vscode.commands.executeCommand(
      "setContext",
      "atticus.copilotOk",
      !!vscode.extensions.getExtension("GitHub.copilot-chat"),
    );
  };
  context.subscriptions.push(
    // Another metarepo: forget what was read, so every section says Reading… again.
    vscode.workspace.onDidChangeWorkspaceFolders(
      () =>
        void updateContext().then(() => {
          for (const t of sections) t.reset();
          waiting.reset();
          refreshAll();
        }),
    ),
    vscode.extensions.onDidChange(() => void updateContext()),
    // A new atticus.path: look for the command line again, so the welcome goes or comes at once.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("atticus.path")) void updateContext().then(refreshAll);
    }),
  );
  reg("atticus.checkHealth", async () => {
    await updateContext();
    refreshAll();
    if (!svc.cliOk) {
      const pick = await vscode.window.showWarningMessage(
        "Atticus can't run its command line (atticus). Install it, or set its path in the setting atticus.path.",
        "How to install",
        "Set the path",
      );
      if (pick === "How to install")
        void vscode.env.openExternal(
          vscode.Uri.parse("https://github.com/maycombhq/atticus/blob/main/docs/guide/install.md"),
        );
      else if (pick === "Set the path")
        void vscode.commands.executeCommand("workbench.action.openSettings", "atticus.path");
      return;
    }
    const root = svc.root;
    if (root) await commands.checkHealth(root, false);
    else
      void vscode.window.showInformationMessage(
        "Atticus's command line is ready. Open or create a metarepo next.",
      );
  });
  reg("atticus.createMetarepo", () => commands.createMetarepo());
  reg("atticus.adoptRepo", () => commands.adoptRepo());
  reg("atticus.practiceSandbox", () => commands.practiceSandbox());
  reg(
    "atticus.addRepos",
    withRoot((root) => commands.addRepos(root)),
  );
  reg(
    "atticus.draftSpec",
    withRoot((root) => commands.pickAndRun(root, "spec draft")),
  );
  // ADR 0100: bring in another team's repo, onboard a repo, the setup checklist's steps.
  reg(
    "atticus.absorb",
    withRoot((root) => commands.absorb(root)),
  );
  reg("atticus.absorbAccept", (id?: unknown) => {
    const root = needRoot();
    if (root) void commands.absorbAccept(root, typeof id === "string" ? id : undefined);
  });
  reg("atticus.onboardRepo", (item?: Item | string) => {
    const root = needRoot();
    const repo =
      typeof item === "string"
        ? item
        : item?.expand?.kind === "repo"
          ? item.expand.repo
          : undefined;
    if (root) void commands.onboardRepo(root, repo);
  });
  reg(
    "atticus.addKnowledge",
    withRoot((root) => commands.addKnowledge(root)),
  );
  reg(
    "atticus.acceptCatalog",
    withRoot((root) => commands.acceptCatalog(root)),
  );
  reg(
    "atticus.openOrgPackOwner",
    withRoot((root) => commands.openOrgPackOwner(root)),
  );

  // ADR 0101: knowledge managed in the metarepo, and what a change needs from the organisation.
  const knowledge = new KnowledgeUi(svc, commands, { runAi, inTerminal, refreshAll });
  /** The row a menu was opened on, with what it carries. */
  const onItem =
    <K extends "knowledge" | "need" | "source">(
      key: K,
      f: (root: string, v: NonNullable<Item[K]>) => unknown,
    ) =>
    (item?: Item) => {
      const root = needRoot();
      const v = item?.[key];
      if (root && v) void f(root, v as NonNullable<Item[K]>);
    };
  reg(
    "atticus.addWiki",
    withRoot((root) => knowledge.addWiki(root)),
  );
  reg(
    "atticus.searchWikis",
    withRoot((root) => knowledge.search(root)),
  );
  reg("atticus.keepFound", (arg?: unknown) => {
    const root = needRoot();
    // A slug, or a search's row in the Knowledge section (its Keep… button).
    const slug =
      typeof arg === "string"
        ? arg
        : (arg as Item | undefined)?.expand?.kind === "find"
          ? (arg as { expand: { slug: string } }).expand.slug
          : undefined;
    if (root) void knowledge.keepFound(root, slug);
  });
  reg("atticus.keepCandidate", (slug?: unknown, id?: unknown) => {
    const root = needRoot();
    // A click passes the search and the candidate; the inline Keep button passes the row.
    let s = typeof slug === "string" ? slug : undefined;
    let c = typeof id === "string" ? id : undefined;
    const row = slug as Item | undefined;
    if (!s && row?.command?.command === "atticus.keepCandidate") {
      s = row.command.args?.[0] as string | undefined;
      c = row.command.args?.[1] as string | undefined;
    }
    if (root && s && c) void knowledge.keepCandidate(root, s, c);
  });
  reg(
    "atticus.syncSource",
    onItem("source", (root, id) => knowledge.syncSource(root, id)),
  );
  reg(
    "atticus.readSource",
    onItem("source", (root, id) => knowledge.readSource(root, id)),
  );
  reg(
    "atticus.tagSource",
    onItem("source", (root, id) => knowledge.tagSource(root, id)),
  );
  reg(
    "atticus.verifyItem",
    onItem("knowledge", (root, k) => knowledge.verify(root, k)),
  );
  reg(
    "atticus.correctItem",
    onItem("knowledge", (root, k) => knowledge.correct(root, k)),
  );
  reg(
    "atticus.rejectItem",
    onItem("knowledge", (root, k) => knowledge.reject(root, k)),
  );
  reg(
    "atticus.askAboutItem",
    onItem("knowledge", (root, k) => knowledge.ask(root, k)),
  );
  reg("atticus.openLinks", (item?: Item) => {
    const x = item?.knowledge ?? item?.need;
    if (x) void knowledge.openLinks(urlsOf(x), item?.label ?? "It");
  });
  reg("atticus.findNeeds", (arg?: Item | string) => {
    const root = needRoot();
    if (!root) return;
    const change =
      typeof arg === "string"
        ? arg
        : arg?.expand?.kind === "change" || arg?.expand?.kind === "needs"
          ? arg.expand.change
          : undefined;
    void (change ? knowledge.findNeeds(root, change) : commands.pickAndRun(root, "change needs"));
  });
  reg(
    "atticus.needDone",
    onItem("need", (root, n) => knowledge.markNeed(root, n, "done")),
  );
  reg(
    "atticus.needSkip",
    onItem("need", (root, n) => knowledge.markNeed(root, n, "skip")),
  );
  reg(
    "atticus.needReopen",
    onItem("need", (root, n) => knowledge.markNeed(root, n, "reopen")),
  );
  reg(
    "atticus.openNeedPage",
    onItem("need", (root, n) => knowledge.openNeedPage(root, n)),
  );
  reg("atticus.raiseNeeds", (arg?: Item | string) => {
    const root = needRoot();
    if (!root) return;
    const change =
      typeof arg === "string"
        ? arg
        : arg?.expand?.kind === "needs" || arg?.expand?.kind === "change"
          ? arg.expand.change
          : undefined;
    void knowledge.raiseNeeds(root, change);
  });
  reg("atticus.setupStep", (arg?: string | { step?: { id: string } }) => {
    const id = typeof arg === "string" ? arg : arg?.step?.id;
    if (!id) return vscode.commands.executeCommand("atticus.runCommand", "setup");
    const a = setupAction(id);
    return vscode.commands.executeCommand(a.command, ...(a.args ?? []));
  });
  // VS Code's own Copilot setup (Copilot is built into VS Code 1.143 and later); installing
  // Copilot Chat only in an older VS Code without it.
  reg("atticus.installCopilot", async () => {
    const s = copilotSetup(await vscode.commands.getCommands(true));
    return vscode.commands.executeCommand(s.command, ...s.args);
  });
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
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Atticus: recording “${c.label}” on the finding…`,
        },
        async () => {
          const api = await svc.api(root);
          await api.post(
            `/api/findings/${encodeURIComponent(f.change)}/${encodeURIComponent(f.id)}/action`,
            body,
          );
        },
      );
      void vscode.window.showInformationMessage(`${c.label}: done. ${f.summary}`);
      refreshAll();
    } catch (e) {
      svc.log.appendLine(`Couldn't act on the finding ${f.id}: ${(e as Error).message}`);
      void vscode.window
        .showErrorMessage(`Couldn't do that: ${(e as Error).message}`, "Show the output")
        .then((p) => p && svc.log.show(true));
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
  /** `atticus next`, with a note while it reads; the reason, with the output, when it can't. */
  const readNextShown = async (root: string) => {
    const r = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Atticus: ${runProgressTitle(["next"])}…`,
      },
      () => readNext(svc.cli(root), root),
    );
    if (!r.ok)
      void vscode.window
        .showErrorMessage(`Couldn't read the next step: ${r.message}`, "Show the output")
        .then((p) => p && svc.log.show(true));
    return r;
  };
  reg("atticus.next", async () => {
    const root = needRoot();
    if (!root) return;
    const r = await readNextShown(root);
    if (!r.ok) return;
    const n = r.value.next;
    if (!n)
      return void vscode.window.showInformationMessage(
        "Nothing to do next: everything is up to date.",
      );
    // A dialog: Run it is how to go on, and a notification slips into the bell.
    const pick = await vscode.window.showInformationMessage(
      `Next: ${stepTitle(n, view.changeTitle)}`,
      { modal: true, detail: `${n.why}\n\n${n.command}` },
      n.person ? "Take this step" : "Run it",
    );
    if (pick) await takeStep(root, n);
  });
  reg("atticus.runNext", async () => {
    const root = needRoot();
    if (!root) return;
    let n = view.next;
    if (!n) {
      const r = await readNextShown(root);
      if (!r.ok) return;
      n = r.value.next;
    }
    if (!n)
      return void vscode.window.showInformationMessage(
        "Nothing to do next: everything is up to date.",
      );
    return takeStep(root, n);
  });
  // Any step of the Next section, the next one or one after it (ADR 0100, 0101).
  // A click passes the step; an inline Run button passes the row, which holds it.
  reg("atticus.draftOrgPack", () => {
    const root = needRoot();
    if (root) void knowledge.draftOrgPack(root);
  });
  reg("atticus.reviewUnverified", () => {
    const root = needRoot();
    if (root) void knowledge.reviewUnverified(root);
  });
  // A manual step from Waiting on you (ADR 0105): what `atticus todo show` says, in a tab.
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SHOWN_SCHEME, shownDocs),
  );
  reg("atticus.showManualStep", (ref?: unknown) => {
    const root = needRoot();
    if (root && typeof ref === "string") void commands.showManualStep(root, ref);
  });
  reg("atticus.runStep", async (arg?: NextStep | { step?: unknown }) => {
    const root = needRoot();
    if (!root) return;
    const n =
      arg && typeof arg.step === "object" && arg.step ? (arg.step as NextStep) : (arg as NextStep);
    if (!n || typeof n.command !== "string")
      return vscode.commands.executeCommand("atticus.runNext");
    return takeStep(root, n);
  });
  /** A step the way its kind needs: with Copilot, answered, run, filled in, or a person's. */
  const takeStep = async (root: string, n: NextStep): Promise<unknown> => {
    // Raising a change's needs: its open needs, one after another, to mark (ADR 0101).
    if (n.step === "raise-needs") return knowledge.raiseNeeds(root, n.change);
    // The org pack from the wikis, and checking what changes use (ADR 0101).
    if (n.step === "orgpack-draft" || n.step === "accept-orgpack")
      return knowledge.draftOrgPack(root);
    if (n.step === "verify-knowledge") return knowledge.reviewUnverified(root);
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
    // A part to fill in: the screen that asks for it (ADR 0100).
    if (/<[^>]+>/.test(a.command) && (await commands.fillIn(root, a.command))) return;
    // A person's step: typed into a terminal, not run.
    inTerminal(root, "Atticus", argsOf(a.command), false);
    void vscode.window.showInformationMessage(`A person takes this step: ${n.why}`);
  };

  for (const name of Object.keys(STEP_COMMANDS) as StepCommand[]) {
    const step = STEP_COMMANDS[name];
    reg(`atticus.${name}`, async (target?: unknown) => {
      const root = needRoot();
      if (!root) return;
      // A repo or change from those the metarepo has, read while the list is open.
      const t =
        typeof target === "string"
          ? target
          : await commands.pickTarget(root, step.target, `Atticus: which ${step.target}?`);
      if (!t?.trim()) return;
      await runAi(step.args(t.trim()), name === "spec" ? t.trim() : undefined);
    });
  }

  reg("atticus.answerQuestion", async (id?: string, option?: number) => {
    const root = needRoot();
    if (!root) return;
    const cli = svc.cli(root);
    const read = async () => {
      const r = await readOpenQuestions(cli, root);
      if (!r.ok) throw new Error(r.message);
      return r.value;
    };
    let q: OpenQuestion | undefined;
    if (id) {
      // The question clicked: the ones the Questions section read, else read now.
      const known = Array.isArray(view.questions) ? view.questions : undefined;
      let open: OpenQuestion[];
      try {
        open = known?.some((x) => x.id === id)
          ? known
          : await vscode.window.withProgress(
              {
                location: vscode.ProgressLocation.Window,
                title: "Atticus: reading the question…",
              },
              read,
            );
      } catch (e) {
        return void vscode.window
          .showErrorMessage(
            `Couldn't read the questions: ${(e as Error).message}`,
            "Show the output",
          )
          .then((p) => p && svc.log.show(true));
      }
      q = open.find((x) => x.id === id);
      if (!q)
        return void vscode.window.showWarningMessage(
          `${id} isn't an open question any more: it was answered, or its step ran again.`,
        );
    } else {
      const pick = await pickLoading(
        {
          title: "Atticus: which question?",
          reading: "Reading the open questions…",
          empty: "No question is waiting for an answer.",
          log: svc.log,
        },
        async () =>
          (await read()).map((x) => ({
            label: x.question,
            description: x.repo,
            detail: x.id,
            q: x,
          })),
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
    const asked = q;
    const given = answer;
    const done = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Atticus: writing the answer to ${asked.id}…`,
      },
      () => answerQuestion(cli, root, asked.id, given),
    );
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
  // A repo's questions one after another, until the person stops.
  reg("atticus.answerRepo", async (node?: string | { questions?: { id: string }[] }) => {
    // A row of the Questions section, or a repo's id (the onboarding list, ADR 0100).
    const qs =
      typeof node === "string"
        ? (Array.isArray(view.questions) ? view.questions : []).filter((q) => q.repo === node)
        : (node?.questions ?? []);
    if (!qs.length)
      return void vscode.window.showInformationMessage(
        typeof node === "string"
          ? `${node} has no open question.`
          : "No question is waiting for an answer.",
      );
    for (const q of qs) {
      const before = view.openQuestions;
      await vscode.commands.executeCommand("atticus.answerQuestion", q.id);
      await view.refresh();
      if (view.openQuestions === before) break;
    }
  });

  reg("atticus.ask", async () => {
    const root = needRoot();
    if (!root) return;
    const question = await vscode.window.showInputBox({
      title: "Atticus: ask the catalog",
      prompt:
        "A plain question, for example: which systems call forge-ledger? The answer shows the query it ran.",
      ignoreFocusOut: true,
    });
    if (!question?.trim()) return;
    const r = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Atticus: ${runProgressTitle(["ask"])}…`,
      },
      () => svc.cli(root)(["ask", question.trim(), "--root", root]),
    );
    const lines = [...r.stdout.trimEnd().split("\n"), ...r.stderr.trimEnd().split("\n")].filter(
      Boolean,
    );
    svc.log.appendLine(`--- The catalog's answer to “${question.trim()}” (exit ${r.code})`);
    for (const l of lines) svc.log.appendLine(l);
    svc.log.show(true);
    const say =
      r.code === 0 ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
    void say(
      lines.length
        ? `${lines[0]}${lines.length > 1 ? " (all of it in the Atticus output)" : ""}`
        : "The catalog had no answer to that.",
    );
  });

  // The app in a VS Code tab (ADR 0091): the one atticus ui the service runs for this window.
  let panel: vscode.WebviewPanel | undefined;
  // The app in a tab. ADR 0097: from the extension's own files (media/app), its calls answered
  // through the local API, so nothing on 127.0.0.1 is framed; ADR 0091's framed page when the
  // files aren't there or the setting atticus.appIn says "frame".
  let panelMode: "bundled" | "frame" | undefined;
  const appDir = vscode.Uri.joinPath(context.extensionUri, "media", "app");
  const bundled = () =>
    vscode.workspace.getConfiguration("atticus").get<string>("appIn", "panel") !== "frame" &&
    existsSync(join(appDir.fsPath, "index.html"));
  /** Tell an open bundled app that files changed, so its views read again. */
  const toApp = (event: { type: string; path?: string }) => {
    if (panel && panelMode === "bundled") void panel.webview.postMessage({ type: "event", event });
  };
  // The app also follows what the sidebar doesn't: proposals, inputs, the model runs and the
  // prompt history (ADR 0119), so its Model runs and Prompt history screens update too.
  const appFiles = vscode.workspace.createFileSystemWatcher(
    "**/{specs,catalog,openspec,questions,knowledge,org-pack,proposals,inputs,.runs,history}/**/*",
  );
  const toAppPath = (u: vscode.Uri) =>
    toApp({ type: "file.changed", path: vscode.workspace.asRelativePath(u, false) });
  context.subscriptions.push(
    appFiles,
    appFiles.onDidChange(toAppPath),
    appFiles.onDidCreate(toAppPath),
    appFiles.onDidDelete(toAppPath),
  );
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
    // Beside the code when asked from it (a CodeLens, a step), so both are read together.
    const column = o?.beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
    const mode = bundled() ? "bundled" : "frame";
    if (panel && panelMode !== mode) panel.dispose();
    if (panel && mode === "bundled") {
      // Already open: go to the view, keeping what the person arranged.
      void panel.webview.postMessage({ type: "navigate", hash: hash || "#/dashboard" });
      panel.reveal(undefined, !!o?.beside);
      return;
    }
    if (!panel) {
      panel = vscode.window.createWebviewPanel(
        "atticus.app",
        "Atticus",
        { viewColumn: column, preserveFocus: !!o?.beside },
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          ...(mode === "bundled" ? { localResourceRoots: [appDir] } : {}),
        },
      );
      panelMode = mode;
      panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "atticus.svg");
      panel.onDidDispose(() => {
        panel = undefined;
        panelMode = undefined;
      });
      if (mode === "bundled") {
        const web = panel.webview;
        web.onDidReceiveMessage(async (m: unknown) => {
          // ADR 0106: Run with Copilot, asked from the app (run-step.ts has the messages' shapes).
          if ((m as { type?: unknown } | null)?.type === "run-step")
            return void runFromApp(m, (r) => void web.postMessage(r));
          const api = await svc.api(root);
          const reply = await answerApp(m, (method, path, body) => api.request(method, path, body));
          if (reply) void web.postMessage(reply);
        });
      }
    }
    if (mode === "bundled") {
      const web = panel.webview;
      const index = readFileSync(join(appDir.fsPath, "index.html"), "utf8");
      web.html = bundledHtml(index, {
        base: `${web.asWebviewUri(appDir).toString()}/`,
        cspSource: web.cspSource,
        nonce: randomBytes(16).toString("base64url"),
        hash: hash || "#/dashboard",
      });
    } else {
      const external = (await vscode.env.asExternalUri(vscode.Uri.parse(a.url))).toString(true);
      panel.webview.html = panelHtml(`${external.replace(/\/$/, "")}/${hash ?? ""}`);
    }
    panel.reveal(undefined, !!o?.beside);
  });
  reg("atticus.diagram", async (target?: string) => {
    const t =
      target ??
      (await vscode.window.showInputBox({
        title: "Atticus: open on the Architecture canvas",
        prompt:
          "Which repo? Its name, or a node id such as system:payments; add a flow's id or words to open a flow. Empty: the estate.",
        ignoreFocusOut: true,
      }));
    if (t === undefined) return;
    await vscode.commands.executeCommand("atticus.showApp", diagramHash(t));
  });

  // ADR 0108: a change's picture, in the Atticus tab.
  reg("atticus.changeDiagram", async (change?: string) => {
    const c =
      change ??
      (await vscode.window.showInputBox({
        title: "Atticus: the Change diagram",
        prompt: "Which change? Its id, such as add-transfer-limit.",
        ignoreFocusOut: true,
      }));
    if (!c?.trim()) return;
    await vscode.commands.executeCommand("atticus.showApp", changeDiagramHash(c.trim()));
  });

  // ADR 0109: a change's estimate, in the Atticus tab.
  reg("atticus.estimate", async (change?: string) => {
    const c =
      change ??
      (await vscode.window.showInputBox({
        title: "Atticus: the Estimate",
        prompt: "Which change? Its id, such as add-transfer-limit.",
        ignoreFocusOut: true,
      }));
    if (!c?.trim()) return;
    await vscode.commands.executeCommand("atticus.showApp", estimateHash(c.trim()));
  });
  // ADR 0110: the prompts sent to @atticus (and Claude Code's, with the plugin) and their replies.
  reg("atticus.promptHistory", () =>
    vscode.commands.executeCommand("atticus.showApp", HISTORY_HASH),
  );

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
  // When the window opens: what is set up; is the metarepo up to date, and is this machine ready?
  const ready = updateContext().then(() => {
    refreshAll();
    // Only where Atticus is in use: the extension also starts in other windows, for the walkthrough.
    if (svc.root && !vscode.extensions.getExtension("GitHub.copilot-chat"))
      void vscode.window
        .showWarningMessage(
          "Atticus's AI steps run with GitHub Copilot, which isn't set up in this VS Code yet.",
          "Set up Copilot",
        )
        .then((p) => p && vscode.commands.executeCommand("atticus.installCopilot"));
    if (svc.root && svc.cliOk)
      void commands
        .checkHealth(svc.root, true)
        .catch((e: unknown) =>
          svc.log.appendLine(WORDS.healthFailed(e instanceof Error ? e.message : String(e))),
        );
  });
  return {
    ready,
    view,
    waiting,
    sections: Object.fromEntries(sections.map((t, i) => [SECTIONS[i]!, t])),
    panel: () => panel,
    service: svc,
    status,
    commands,
    runFromApp,
  };
}

export function deactivate() {
  // Everything registered is in context.subscriptions.
}
