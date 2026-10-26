import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { readNext, readOpenQuestions } from "./atticus";
import { parseJson } from "./cli";
import type { SetupStep } from "./guided";
import { nextRow, type NextNode } from "./next-rows";
import { orgModelsOf, type Service } from "./service";
import { choicesFor, isStepClass } from "./step-models";
import { modelSettings } from "./vscode-model";
import { errorLabel } from "./feedback";
import { Loads } from "./loads";
import type { NextStep, OpenQuestion } from "./types";
import { filterItems } from "./filter";
import {
  questionsRows,
  readWaiting,
  waitingRows,
  type WaitingGroup,
  type WaitingRead,
  type WaitingRow,
} from "./waiting-data";

/**
 * The Next and Waiting section (ADR 0090, 0098, 0100; Phase D): the next step in plain words with
 * a Run button, the steps after it (each runs when clicked, as the next one does), then what
 * waits on you (WaitingView's rows, ADR 0105, under one row), the setup checklist until the
 * catalog is accepted, and Open the app. It reads `atticus next` and `atticus questions` once,
 * for the Questions view too (QuestionsView); each shows a loading line while it reads, the
 * reason when it can't, and says so when there is nothing.
 */

/** A row of what waits, under the Waiting on you row. */
type Under = { kind: "under"; row: WNode };
type Node = NextNode | Under;

/** How many of the steps after the next one to show. */
const THEN = 4;

export class AtticusView implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly questionsChanged = new vscode.EventEmitter<void>();
  /** Fires when the questions were read again, for Waiting on you. */
  readonly onQuestions = this.questionsChanged.event;
  private nodes: Node[] = [{ kind: "loading" }];
  private loading: Promise<void> | undefined;

  constructor(private readonly svc: Service) {}

  /** What waits on you, shown under the steps (Phase D). */
  private waiting: WaitingView | undefined;
  showWaiting(waiting: WaitingView): vscode.Disposable {
    this.waiting = waiting;
    // Its rows read on their own: draw them when they are in.
    return waiting.onDidChangeTreeData(() => this.changed.fire(undefined));
  }

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

  /** Which read is the latest: an older one that ends later never overwrites it. */
  private reads = 0;

  refresh(): Promise<void> {
    const read = ++this.reads;
    this.nodes = [{ kind: "loading" }];
    this.questions = undefined;
    this.changed.fire(undefined);
    this.questionsChanged.fire();
    this.loading = this.load(read)
      .catch((e: unknown) => {
        if (read !== this.reads) return;
        // Never left on "Reading…": say why, with the output a click away.
        const message = `Couldn't read the metarepo: ${(e as Error)?.message ?? String(e)}`;
        this.svc.log.appendLine(message);
        this.nodes = [{ kind: "error", message }, { kind: "app" }];
        if (this.questions === undefined) this.questions = message;
      })
      .finally(() => {
        if (read !== this.reads) return;
        this.loading = undefined;
        this.changed.fire(undefined);
        this.questionsChanged.fire();
      });
    // The views' own progress bars, beside their Reading rows.
    for (const viewId of ["atticus.view", "atticus.questions"])
      void vscode.window.withProgress({ location: { viewId } }, () =>
        (this.loading ?? Promise.resolve()).catch(() => undefined),
      );
    return this.loading;
  }

  private async load(read: number) {
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
    // Read again meanwhile (the command line found missing, another folder): that read wins.
    if (read !== this.reads) return;
    this.titles.clear();
    const nodes: Node[] = [];
    if (!n.ok) nodes.push({ kind: "error", message: `Couldn't read the next step: ${n.message}` });
    else if (n.value.next) {
      nodes.push({ kind: "next", step: n.value.next });
      for (const s of n.value.steps.slice(1, 1 + THEN)) nodes.push({ kind: "then", step: s });
    } else nodes.push({ kind: "no-next" });
    // What waits on you, under the steps (Phase D).
    if (this.waiting) nodes.push({ kind: "waiting" });
    // The setup checklist, until the catalog is accepted.
    if (setup?.steps?.length && !setup.baselined) nodes.push({ kind: "setup", steps: setup.steps });
    // What runs a step (ADR 0121 item 6), above Open the app.
    // ADR 0121 addendum: the next step's kind picks its model.
    if (n.ok && n.value.runs) {
      const c = isStepClass(n.value.next?.stepClass) ? n.value.next.stepClass : undefined;
      const org = orgModelsOf(root);
      nodes.push({
        kind: "runs",
        runs: n.value.runs,
        model: choicesFor(c, modelSettings(), c ? org[c] : undefined)[0]?.value ?? "",
        ...(c ? { stepClass: c } : {}),
      });
    }
    this.next = n.ok ? n.value.next : undefined;
    this.questions = q.ok ? q.value : `Couldn't read the questions: ${q.message}`;
    nodes.push({ kind: "app" });
    this.nodes = nodes;
  }

  getChildren(node?: Node): Node[] {
    if (node?.kind === "setup") return node.steps.map((step) => ({ kind: "setup-step", step }));
    const under = (rows: WNode[]): Node[] => rows.map((row) => ({ kind: "under", row }));
    if (node?.kind === "waiting") return under(this.waiting?.getChildren() ?? []);
    if (node?.kind === "under") return under(this.waiting?.getChildren(node.row) ?? []);
    return node ? [] : this.nodes;
  }

  /** Each change's title from its change.yaml, read once a refresh. */
  private readonly titles = new Map<string, string | undefined>();
  readonly changeTitle = (id: string): string | undefined => {
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
    if (node.kind === "under") return rowItem(node.row);
    const r = nextRow(node, this.changeTitle);
    const t = new vscode.TreeItem(
      r.label,
      r.expanded === undefined
        ? vscode.TreeItemCollapsibleState.None
        : r.expanded
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed,
    );
    if (r.id) t.id = r.id;
    if (r.description !== undefined) t.description = r.description;
    if (r.tooltip) t.tooltip = r.plain ? r.tooltip : new vscode.MarkdownString(r.tooltip);
    t.iconPath = new vscode.ThemeIcon(r.icon);
    if (r.context) t.contextValue = r.context;
    if (r.command)
      t.command = {
        command: r.command.command,
        title: r.command.title,
        ...(r.command.args ? { arguments: r.command.args } : {}),
      };
    return t;
  }

  dispose() {
    this.changed.dispose();
    this.questionsChanged.dispose();
  }
}

/** What waits on you (ADR 0105), as the tree view draws it. */
type WNode = WaitingRow | { id: string; state: "loading" | "error"; message: string };
const isRow = (n: WNode): n is WaitingRow => !("state" in n);

/** A row of what waits, or of the questions, as a tree item. */
function rowItem(node: WNode): vscode.TreeItem {
  if (!isRow(node)) {
    const t = new vscode.TreeItem(node.state === "error" ? errorLabel(node.message) : node.message);
    t.id = node.id;
    t.iconPath = new vscode.ThemeIcon(node.state === "loading" ? "loading~spin" : "warning");
    if (node.state === "error") {
      t.tooltip = `${node.message}

Click to see the commands run, in the Atticus output. Refresh to read it again.`;
      t.command = { command: "atticus.showLog", title: "Show the commands run" };
    }
    return t;
  }
  const t = new vscode.TreeItem(
    node.label,
    node.rows ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
  );
  t.id = node.id;
  if (node.description) t.description = node.description;
  if (node.tooltip)
    t.tooltip = node.markdown ? new vscode.MarkdownString(node.tooltip) : node.tooltip;
  if (node.icon)
    t.iconPath = new vscode.ThemeIcon(
      node.icon,
      node.color ? new vscode.ThemeColor(node.color) : undefined,
    );
  if (node.context) t.contextValue = node.context;
  if (node.command)
    t.command = {
      command: node.command.command,
      title: node.label,
      ...(node.command.args ? { arguments: node.command.args } : {}),
    };
  else if (node.open)
    t.command = { command: "atticus.openItem", title: "Open", arguments: [node.open] };
  return t;
}

/**
 * What waits on you (ADR 0105): what waits on a person across every change, drawn under the
 * steps in Next and Waiting (Phase D). The open questions have their own view, so they are left
 * out unless asked for; the rest it reads itself, when shown, with a "Reading…" row until then.
 * A refresh keeps the rows on show until they are read again.
 */
export class WaitingView implements vscode.TreeDataProvider<WNode> {
  private readonly changed = new vscode.EventEmitter<WNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly loads = new Loads<WaitingRead | string>();
  /** The questions last read, kept on show while the Next section reads them again. */
  private questions: OpenQuestion[] | string | undefined;
  /** By change (the default) or by kind (ADR 0105 addendum). */
  group: WaitingGroup = "change";
  /** The words the rows are filtered by, for this session; empty shows every row. */
  filter = "";

  constructor(
    private readonly svc: Service,
    private readonly next: AtticusView,
    /** Whether the open questions are among the rows (the Questions view has them). */
    private readonly withQuestions = false,
  ) {
    next.onQuestions(() => {
      if (next.questions !== undefined) this.questions = next.questions;
      this.changed.fire(undefined);
    });
  }

  /** Read again; what is on show stays until the new rows are read. */
  refresh() {
    this.loads.refresh();
    this.changed.fire(undefined);
  }

  /** Lay the rows out by change or by kind. */
  setGroup(group: WaitingGroup) {
    this.group = group;
    this.changed.fire(undefined);
  }

  /** Show only the rows that match these words; empty shows them all. */
  setFilter(words: string) {
    this.filter = words.trim();
    this.changed.fire(undefined);
  }

  /** Forget what was read (another metarepo opened): Reading… again. */
  reset() {
    this.questions = undefined;
    this.loads.clear();
    this.changed.fire(undefined);
  }

  private read(root: string): Promise<WaitingRead | string> {
    const p = readWaiting(this.svc.cli(root), root);
    void vscode.window.withProgress({ location: { viewId: "atticus.view" } }, () =>
      p.catch(() => undefined),
    );
    return p;
  }

  private failed(e: unknown): string {
    const message = (e as Error)?.message ?? String(e);
    this.svc.log.appendLine(`Couldn't read what waits on you: ${message}`);
    return message;
  }

  private rowsOf(w: WaitingRead | string | undefined): WNode[] {
    const q = this.questions ?? this.next.questions;
    if (w === undefined || q === undefined)
      return [{ id: "waiting:loading", state: "loading", message: "Reading what waits on you…" }];
    if (typeof w === "string") return [{ id: "waiting:error", state: "error", message: w }];
    return filterItems(
      waitingRows(q, w, this.group, { questions: this.withQuestions }),
      this.filter,
      "Waiting on you",
      "atticus.clearFilterWaiting",
      { kids: (r) => r.rows, withKids: (r, rows) => ({ ...r, rows }) },
    );
  }

  /** The section's rows, read (no "Reading…" row): for the tests in VS Code. */
  async children(node?: WNode): Promise<WNode[]> {
    const root = this.svc.root;
    if (!root || !this.svc.cliOk) return [];
    if (node) return this.getChildren(node);
    if (this.next.questions === undefined && this.questions === undefined)
      await new Promise<void>((done) => {
        const sub = this.next.onQuestions(() => {
          if (this.next.questions === undefined) return;
          sub.dispose();
          done();
        });
      });
    const w = await this.loads.wait(
      "",
      () => this.read(root),
      (e) => this.failed(e),
    );
    return this.rowsOf(w);
  }

  getChildren(node?: WNode): WNode[] {
    if (node) return isRow(node) ? (node.rows ?? []) : [];
    const root = this.svc.root;
    // No metarepo or no command line: empty, so the welcome says what to do first.
    if (!root || !this.svc.cliOk || !this.next.hasMetarepo) return [];
    const w = this.loads.get(
      "",
      () => this.read(root),
      () => this.changed.fire(undefined),
      (e) => this.failed(e),
    );
    return this.rowsOf(w);
  }

  getTreeItem(node: WNode): vscode.TreeItem {
    return rowItem(node);
  }

  dispose() {
    this.changed.dispose();
  }
}

/**
 * The Questions view (Phase D): the open questions by repo, as the Next and Waiting section read
 * them. A click opens the answer dialog, with the lines the question read beside its answers
 * (atticus.answerQuestion); a repo's button answers its questions one after another.
 */
export class QuestionsView implements vscode.TreeDataProvider<WaitingRow> {
  private readonly changed = new vscode.EventEmitter<WaitingRow | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly sub: vscode.Disposable;
  /** The questions last read, kept on show while they are read again. */
  private shown: OpenQuestion[] | string | undefined;

  constructor(private readonly next: AtticusView) {
    this.sub = next.onQuestions(() => {
      if (next.questions !== undefined) this.shown = next.questions;
      this.changed.fire(undefined);
    });
  }

  /** Forget what was read (another metarepo opened): Reading… again. */
  reset() {
    this.shown = undefined;
    this.changed.fire(undefined);
  }

  getChildren(node?: WaitingRow): WaitingRow[] {
    if (node) return node.rows ?? [];
    // No metarepo or no command line: empty, and the view isn't shown.
    if (!this.next.hasMetarepo) return [];
    return questionsRows(this.shown ?? this.next.questions);
  }

  getTreeItem(node: WaitingRow): vscode.TreeItem {
    return rowItem(node);
  }

  dispose() {
    this.sub.dispose();
    this.changed.dispose();
  }
}
