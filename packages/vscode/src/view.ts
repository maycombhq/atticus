import * as vscode from "vscode";
import { readNext, readOpenQuestions } from "./atticus";
import type { Service } from "./service";
import type { NextStep, OpenQuestion } from "./types";

/**
 * The "Atticus" side view (ADR 0090): the next step with a Run button, the open questions (click
 * one to answer it), and Open the app. It shows a loading line while it reads, the reason when
 * it can't read, and says so when there is nothing.
 */

type Node =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "next"; step: NextStep }
  | { kind: "no-next" }
  | { kind: "questions"; questions: OpenQuestion[] }
  | { kind: "question"; q: OpenQuestion }
  | { kind: "app" }
  | { kind: "no-root" };

export class AtticusView implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private nodes: Node[] = [{ kind: "loading" }];
  private loading: Promise<void> | undefined;

  constructor(private readonly svc: Service) {}

  /** The next step last read, for Run. */
  next: NextStep | undefined;
  /** How many questions were open when last read, for the status bar. */
  openQuestions: number | undefined;

  refresh(): Promise<void> {
    this.nodes = [{ kind: "loading" }];
    this.changed.fire(undefined);
    this.loading = this.load().finally(() => {
      this.loading = undefined;
      this.changed.fire(undefined);
    });
    return this.loading;
  }

  private async load() {
    const root = this.svc.root;
    if (!root) {
      this.nodes = [{ kind: "no-root" }];
      return;
    }
    const cli = this.svc.cli(root);
    const [n, q] = [await readNext(cli, root), await readOpenQuestions(cli, root)];
    const nodes: Node[] = [];
    if (!n.ok) nodes.push({ kind: "error", message: `Couldn't read the next step: ${n.message}` });
    else if (n.value.next) nodes.push({ kind: "next", step: n.value.next });
    else nodes.push({ kind: "no-next" });
    this.next = n.ok ? n.value.next : undefined;
    this.openQuestions = q.ok ? q.value.length : undefined;
    if (!q.ok) nodes.push({ kind: "error", message: `Couldn't read the questions: ${q.message}` });
    else nodes.push({ kind: "questions", questions: q.value });
    nodes.push({ kind: "app" });
    this.nodes = nodes;
  }

  getChildren(node?: Node): Node[] {
    if (!node) return this.nodes;
    if (node.kind === "questions")
      return node.questions.map((q) => ({ kind: "question", q }) as Node);
    return [];
  }

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
        return item(`Next: ${node.step.command}`, {
          contextValue: "atticus.next",
          tooltip: node.step.why,
          description: node.step.person ? "a person's step" : "",
          iconPath: new vscode.ThemeIcon("arrow-right"),
          command: { command: "atticus.runNext", title: "Run the next step" },
        });
      case "no-next":
        return item("No next step to suggest.", { iconPath: new vscode.ThemeIcon("check") });
      case "questions":
        return item(
          node.questions.length ? `Open questions (${node.questions.length})` : "No open questions",
          {
            collapsibleState: node.questions.length
              ? vscode.TreeItemCollapsibleState.Expanded
              : vscode.TreeItemCollapsibleState.None,
            iconPath: new vscode.ThemeIcon("question"),
          },
        );
      case "question":
        return item(node.q.question, {
          description: node.q.repo,
          tooltip: `${node.q.id}: ${node.q.question}\nClick to answer.`,
          command: { command: "atticus.answerQuestion", title: "Answer", arguments: [node.q.id] },
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
  }
}
