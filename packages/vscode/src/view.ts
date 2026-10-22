import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { readNext, readOpenQuestions } from "./atticus";
import { parseJson } from "./cli";
import { setupProgress, type SetupStep } from "./guided";
import type { Service } from "./service";
import { questionGroups } from "./sidebar-data";
import type { NextStep, OpenQuestion } from "./types";
import { questionLabel, stepTitle } from "./words";

/**
 * The Next section (ADR 0090, 0098, 0100): the next step in plain words with a Run button, the
 * steps after it, the setup checklist until the catalog is accepted, and Open the app. The Questions section: the open questions by repo; click one to
 * answer it. Both read `atticus next` and `atticus questions` once; each shows a loading line
 * while it reads, the reason when it can't, and says so when there is nothing.
 */

type Node =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "next"; step: NextStep }
  | { kind: "then"; step: NextStep }
  | { kind: "no-next" }
  | { kind: "setup"; steps: SetupStep[] }
  | { kind: "setup-step"; step: SetupStep }
  | { kind: "app" }
  | { kind: "no-root" };

/** How many of the steps after the next one to show. */
const THEN = 4;

export class AtticusView implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly questionsChanged = new vscode.EventEmitter<void>();
  /** Fires when the questions were read again, for the Questions section. */
  readonly onQuestions = this.questionsChanged.event;
  private nodes: Node[] = [{ kind: "loading" }];
  private loading: Promise<void> | undefined;

  constructor(private readonly svc: Service) {}

  /** The next step last read, for Run. */
  next: NextStep | undefined;
  /** Whether a metarepo was open, and the command line ran, when last read. */
  get hasMetarepo(): boolean {
    return !!this.svc.root && this.svc.cliOk;
  }
  /** The open questions last read: undefined while reading, a message when they couldn't be. */
  questions: OpenQuestion[] | string | undefined;
  /** How many questions were open when last read, for the status bar. */
  get openQuestions(): number | undefined {
    return Array.isArray(this.questions) ? this.questions.length : undefined;
  }

  refresh(): Promise<void> {
    this.nodes = [{ kind: "loading" }];
    this.questions = undefined;
    this.changed.fire(undefined);
    this.questionsChanged.fire();
    this.loading = this.load().finally(() => {
      this.loading = undefined;
      this.changed.fire(undefined);
      this.questionsChanged.fire();
    });
    return this.loading;
  }

  private async load() {
    const root = this.svc.root;
    // No metarepo, or no command line: empty, so VS Code shows the welcome (package.json
    // viewsWelcome) with what to do first (ADR 0098).
    if (!root || !this.svc.cliOk) {
      this.nodes = [];
      this.questions = [];
      this.next = undefined;
      return;
    }
    const cli = this.svc.cli(root);
    const [n, q, setup] = await Promise.all([
      readNext(cli, root),
      readOpenQuestions(cli, root),
      cli(["setup", "--json", "--root", root]).then((r) =>
        parseJson<{ steps?: SetupStep[]; baselined?: boolean }>(r.stdout),
      ),
    ]);
    this.titles.clear();
    const nodes: Node[] = [];
    if (!n.ok) nodes.push({ kind: "error", message: `Couldn't read the next step: ${n.message}` });
    else if (n.value.next) {
      nodes.push({ kind: "next", step: n.value.next });
      for (const s of n.value.steps.slice(1, 1 + THEN)) nodes.push({ kind: "then", step: s });
    } else nodes.push({ kind: "no-next" });
    // The setup checklist, until the catalog is accepted.
    if (setup?.steps?.length && !setup.baselined) nodes.push({ kind: "setup", steps: setup.steps });
    this.next = n.ok ? n.value.next : undefined;
    this.questions = q.ok ? q.value : `Couldn't read the questions: ${q.message}`;
    nodes.push({ kind: "app" });
    this.nodes = nodes;
  }

  getChildren(node?: Node): Node[] {
    if (node?.kind === "setup") return node.steps.map((step) => ({ kind: "setup-step", step }));
    return node ? [] : this.nodes;
  }

  /** Each change's title from its change.yaml, read once a refresh. */
  private readonly titles = new Map<string, string | undefined>();
  private changeTitle = (id: string): string | undefined => {
    if (!this.titles.has(id)) {
      let title: string | undefined;
      for (const dir of ["openspec", join(".atticus", "openspec")])
        try {
          const text = readFileSync(
            join(this.svc.root ?? "", dir, "changes", id, "change.yaml"),
            "utf8",
          );
          title = /^title:\s*(.+)$/m
            .exec(text)?.[1]
            ?.trim()
            .replace(/^(["'])(.*)\1$/, "$2");
          if (title) break;
        } catch {
          // not in this layout
        }
      this.titles.set(id, title);
    }
    return this.titles.get(id);
  };

  getTreeItem(node: Node): vscode.TreeItem {
    const item = (label: string, o: Partial<vscode.TreeItem> = {}) =>
      Object.assign(new vscode.TreeItem(label), o);
    switch (node.kind) {
      case "loading":
        return item("Reading the metarepo...", { iconPath: new vscode.ThemeIcon("loading~spin") });
      case "no-root":
        return item("Open the metarepo folder (the one with org-pack/).", {
          iconPath: new vscode.ThemeIcon("info"),
        });
      case "error":
        return item(node.message, {
          iconPath: new vscode.ThemeIcon("warning"),
          tooltip: `${node.message}\nThe commands run are in the Atticus output.`,
          command: { command: "atticus.showLog", title: "Show the commands run" },
        });
      case "next":
        return item(stepTitle(node.step, this.changeTitle), {
          contextValue: "atticus.next",
          tooltip: new vscode.MarkdownString(
            `**Next:** ${node.step.why}\n\n\`${node.step.command}\``,
          ),
          description: node.step.person ? "your step" : "next",
          iconPath: new vscode.ThemeIcon("arrow-right"),
          command: { command: "atticus.runNext", title: "Run the next step" },
        });
      case "then":
        return item(stepTitle(node.step, this.changeTitle), {
          tooltip: new vscode.MarkdownString(`${node.step.why}\n\n\`${node.step.command}\``),
          description: "then",
          iconPath: new vscode.ThemeIcon("circle-small"),
        });
      case "setup": {
        const p = setupProgress(node.steps);
        return item(`Set up: ${p.done} of ${p.total} done`, {
          id: "setup",
          collapsibleState: p.complete
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.Expanded,
          description: p.complete ? "accept the catalog" : p.next ? `next: ${p.next.label}` : "",
          tooltip: "The setup checklist (atticus setup), until the catalog is accepted",
          iconPath: new vscode.ThemeIcon("checklist"),
        });
      }
      case "setup-step": {
        const s = node.step;
        return item(s.label, {
          id: `setup:${s.id}`,
          description: s.done ? s.detail : s.optional ? "optional" : s.detail,
          tooltip: new vscode.MarkdownString(
            `${s.label}${s.detail ? `: ${s.detail}` : ""}${s.done ? "" : `\n\n${s.fix ?? ""}\n\nClick to do it.`}`,
          ),
          iconPath: new vscode.ThemeIcon(
            s.done ? "pass-filled" : s.optional ? "circle-small" : "circle-large-outline",
          ),
          ...(s.done
            ? {}
            : {
                contextValue: "atticus.setupStep",
                command: { command: "atticus.setupStep", title: "Do it", arguments: [s.id] },
              }),
        });
      }
      case "no-next":
        return item("Nothing to do next: everything is up to date.", {
          iconPath: new vscode.ThemeIcon("check"),
        });
      case "app":
        return item("Open the app", {
          iconPath: new vscode.ThemeIcon("type-hierarchy"),
          tooltip:
            "The app with its diagrams, in a VS Code tab. Atticus: Open the app in the browser opens it there instead.",
          command: { command: "atticus.showApp", title: "Open the app" },
        });
    }
  }

  dispose() {
    this.changed.dispose();
    this.questionsChanged.dispose();
  }
}

type QNode =
  | { kind: "state"; message: string; icon: string }
  | { kind: "repo"; repo: string; questions: OpenQuestion[] }
  | { kind: "question"; q: OpenQuestion };

/** The Questions section (ADR 0098): the open questions by repo, read with the Next section. */
export class QuestionsView implements vscode.TreeDataProvider<QNode> {
  private readonly changed = new vscode.EventEmitter<QNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly next: AtticusView) {
    next.onQuestions(() => this.changed.fire(undefined));
  }

  getChildren(node?: QNode): QNode[] {
    if (node?.kind === "repo") return node.questions.map((q) => ({ kind: "question", q }));
    if (node) return [];
    const q = this.next.questions;
    if (q === undefined)
      return [{ kind: "state", message: "Reading the questions...", icon: "loading~spin" }];
    if (!this.next.hasMetarepo) return [];
    if (typeof q === "string") return [{ kind: "state", message: q, icon: "warning" }];
    if (!q.length)
      return [{ kind: "state", message: "No question is waiting for an answer.", icon: "check" }];
    return questionGroups(q).map((g) => ({ kind: "repo", repo: g.repo, questions: g.questions }));
  }

  getTreeItem(node: QNode): vscode.TreeItem {
    if (node.kind === "state") {
      const t = new vscode.TreeItem(node.message);
      t.iconPath = new vscode.ThemeIcon(node.icon);
      return t;
    }
    if (node.kind === "repo") {
      const t = new vscode.TreeItem(node.repo, vscode.TreeItemCollapsibleState.Expanded);
      t.description = `${node.questions.length} open`;
      t.iconPath = new vscode.ThemeIcon("repo");
      t.contextValue = "atticus.questionRepo";
      t.id = `questions:${node.repo}`;
      return t;
    }
    const l = questionLabel(node.q.question);
    const t = new vscode.TreeItem(l.label);
    t.id = `question:${node.q.id}`;
    t.tooltip = new vscode.MarkdownString(
      `${node.q.question}\n\n${node.q.options.map((o, i) => `${i + 1}. **${o.label}**${o.means ? `: ${o.means}` : ""}`).join("\n")}\n\nClick to answer.`,
    );
    t.description = [l.description, node.q.options.length ? `${node.q.options.length} options` : ""]
      .filter(Boolean)
      .join(" · ");
    t.iconPath = new vscode.ThemeIcon("question");
    t.command = { command: "atticus.answerQuestion", title: "Answer", arguments: [node.q.id] };
    return t;
  }

  dispose() {
    this.changed.dispose();
  }
}
