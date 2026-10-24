import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import type * as Api from "./api-types";
import { emptyBelow, errorLabel, loadingLabel } from "./feedback";
import { filterTree, filterWords, itemText, noMatchRow, RESOLVED_BELOW } from "./filter";
import { Loads } from "./loads";
import {
  actionRow,
  candidateItems,
  findItems,
  itemsOfGroup,
  knowledgeGroupItems,
  knowledgeItemRows,
  knowledgeTop,
  lastScanItems,
  needItems,
  needsNode,
  wikiItems,
  type FindSummary,
  type KnowledgeEntry,
  type NeedEntry,
  type ScanReport,
} from "./knowledge-data";
import {
  readFind,
  readFinds,
  readKnowledgeList,
  readNeeds,
  readScanReport,
  readSnapshots,
} from "./knowledge-read";
import { parseRuns, runChildren, runItems } from "./runs-data";
import type { Service } from "./service";
import {
  artifactItems,
  changeDirOf,
  changeItems,
  evidenceItems,
  findingItems,
  flowItems,
  kindItems,
  recordItems,
  repoChildren,
  repoItems,
  stepItems,
  targetItems,
  taskItems,
  type Item,
} from "./sidebar-data";
import { WORDS } from "./words";

/**
 * The sidebar's sections beyond Next (ADR 0093): Repos, Changes, Knowledge and Catalog. Each
 * reads the app's local API, which the service starts once for the window, and the command
 * line's JSON (the knowledge items, a change's needs: ADR 0101). Each shows a loading row while
 * it reads, the reason when it can't, and says so when there is nothing. Clicking an item runs
 * atticus.openItem with what it opens, or the step a row names.
 */

type Node =
  /** Under a filter, a row shown for what matched below it carries those rows (ADR 0105). */
  | (Item & { shown?: Node[] })
  | {
      id: string;
      state: "loading" | "error" | "empty";
      /** The message is the row's label; for an error, the reason after "Couldn't read this". */
      message: string;
      /** An empty section's first step, run by clicking the row (ADR 0100). */
      action?: { label: string; command: string };
    };
const isItem = (n: Node): n is Item => !("state" in n);

export type Section = "repos" | "changes" | "catalog" | "knowledge" | "runs";

/** What an empty section says, and the step that fills it, one click away. */
const EMPTY: Record<Section, { message: string; label: string; command: string }> = {
  repos: {
    message:
      "No repos yet. Add them from a folder of clones or a Git host organisation (atticus repos discover), then onboard each one.",
    label: "No repos yet: add them",
    command: "atticus.addRepos",
  },
  changes: {
    message: "No changes yet. Start one: its title and type, then the brief.",
    label: "No changes yet: start one",
    command: "atticus.newChange",
  },
  catalog: {
    message: "The catalog is empty. Scan the repos (atticus scan): it reads files only.",
    label: "The catalog is empty: scan the repos",
    command: "atticus.scanAll",
  },
  knowledge: {
    message:
      "No knowledge sources yet. Add a wiki or docs repo (atticus sources add), bring in another team's repo, or add files (atticus intake add).",
    label: "No knowledge yet: add a wiki or docs repo",
    command: "atticus.addWiki",
  },
  runs: {
    message:
      "No model runs yet. An AI step makes one: its prompt and the model's answer are kept under .runs/.",
    label: "No model runs yet: run the next step",
    command: "atticus.runNext",
  },
};

/** Each section's name and its Clear filter command, for the row a filter that matches nothing leaves. */
const FILTERED: Record<Section, { name: string; clear: string }> = {
  repos: { name: "Repos", clear: "atticus.refresh" },
  changes: { name: "Changes", clear: "atticus.clearFilterChanges" },
  catalog: { name: "Catalog", clear: "atticus.refresh" },
  knowledge: { name: "Knowledge", clear: "atticus.clearFilterKnowledge" },
  runs: { name: "Model runs", clear: "atticus.clearFilterRuns" },
};

/** What the Knowledge section read once a refresh. */
interface KnowledgeState {
  items: KnowledgeEntry[];
  problem?: string;
  report?: ScanReport;
  finds: FindSummary[];
}

export class SectionTree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  /** Each change's detail, read when it opens, for its findings' files. */
  private readonly details = new Map<string, Api.ChangeDetail>();
  /** Each change's needs, read when it opens (ADR 0101). */
  private readonly needs = new Map<string, NeedEntry[] | undefined>();
  private onboarding: Api.OnboardingView | undefined;
  private flowCounts = new Map<string, number>();
  private knowledge: Promise<KnowledgeState> | undefined;

  constructor(
    private readonly svc: Service,
    private readonly section: Section,
  ) {}

  private readonly loads = new Loads<Node[]>();

  /** The words the section is filtered by, for this session (ADR 0105); empty shows every row. */
  filter = "";

  /** Show only the rows that match these words; empty shows them all. */
  setFilter(words: string) {
    this.filter = words.trim();
    this.changed.fire(undefined);
  }

  /** What the loads keep a part's rows under: the section's top under a filter is its own. */
  private keyOf(node: Item | undefined) {
    if (node) return node.id;
    return filterWords(this.filter).length ? `filter:${this.filter}` : "";
  }

  /** Read again; what is on show stays until the new rows are read. */
  refresh() {
    this.details.clear();
    this.needs.clear();
    this.knowledge = undefined;
    this.loads.refresh();
    this.changed.fire(undefined);
  }

  /** Forget what was read (another metarepo opened): every part shows Reading… again. */
  reset() {
    this.details.clear();
    this.needs.clear();
    this.onboarding = undefined;
    this.knowledge = undefined;
    this.loads.clear();
    this.changed.fire(undefined);
  }

  /** The knowledge items, the last scan's report and the saved searches, read once a refresh. */
  private knowledgeState(root: string): Promise<KnowledgeState> {
    this.knowledge ??= (async () => {
      const rel = this.svc.paths(root).knowledgeRel ?? "knowledge";
      const cli = this.svc.cli(root);
      const [list, finds] = await Promise.all([readKnowledgeList(cli, root), readFinds(cli, root)]);
      const report = readScanReport(root, rel);
      return {
        items: list.items,
        ...(list.problem ? { problem: list.problem } : {}),
        ...(report ? { report } : {}),
        finds,
      };
    })();
    const k = this.knowledge;
    k.catch(() => {
      if (this.knowledge === k) this.knowledge = undefined;
    });
    return k;
  }

  private async top(root: string): Promise<Item[]> {
    // ADR 0106: what Atticus asked a model and what came back, from the command line.
    if (this.section === "runs") {
      const r = await this.svc.cli(root)(["runs", "--json", "--root", root]);
      if (r.code !== 0)
        throw new Error(
          (r.stderr.trim() || r.stdout.trim() || WORDS.endedWith(r.code)).split("\n")[0],
        );
      return runItems(parseRuns(r.stdout));
    }
    const api = await this.svc.api(root);
    if (this.section === "repos") {
      const [o, specs] = await Promise.all([
        api.get<Api.OnboardingView>("/api/onboarding"),
        api.get<Api.SpecList>("/api/specs"),
      ]);
      this.onboarding = o;
      this.flowCounts = new Map(specs.repos.map((r) => [r.repo, r.flows]));
      return repoItems(o);
    }
    if (this.section === "changes")
      return changeItems(await api.get<Api.ChangeSummary[]>("/api/changes"));
    if (this.section === "knowledge") {
      const [o, k] = await Promise.all([
        api.get<Api.OnboardingView>("/api/onboarding"),
        this.knowledgeState(root),
      ]);
      this.onboarding = o;
      const sources = (o.sources?.wikis.length ?? 0) + (o.sources?.absorbed.length ?? 0);
      // Nothing at all yet: the section's own empty row, with its first step.
      if (!sources && !k.items.length && !k.finds.length) return [];
      return knowledgeTop({
        sourcesPath: o.sources?.path ?? "org-pack/sources.yaml",
        sources,
        items: k.items,
        ...(k.problem ? { problem: k.problem } : {}),
        ...(k.report ? { report: k.report } : {}),
        finds: k.finds,
      });
    }
    return kindItems(await api.get<Api.KindCount[]>("/api/catalog/kinds"));
  }

  private async needsOf(root: string, d: Api.ChangeDetail): Promise<NeedEntry[] | undefined> {
    if (!this.needs.has(d.id))
      this.needs.set(d.id, await readNeeds(this.svc.cli(root), root, d.id, changeDirOf(d)));
    return this.needs.get(d.id);
  }

  private async below(root: string, it: Item): Promise<Item[]> {
    const x = it.expand!;
    const paths = this.svc.paths(root);
    if (x.kind === "run") return runChildren(x.run, paths);
    const api = await this.svc.api(root);
    const enc = encodeURIComponent;
    switch (x.kind) {
      case "repo": {
        const r = this.onboarding?.repos.find((y) => y.id === x.repo);
        return r ? repoChildren(r, this.flowCounts.get(x.repo) ?? 0, paths) : [];
      }
      case "flows":
        return flowItems(await api.get<Api.SpecView>(`/api/specs/${enc(x.repo)}`));
      case "flow":
        return stepItems(
          await api.get<Api.FlowView>(`/api/specs/${enc(x.repo)}/flows/${enc(x.flow)}`),
          paths,
        );
      case "change": {
        const d = await api.get<Api.ChangeDetail>(`/api/changes/${enc(x.change)}`);
        this.details.set(x.change, d);
        const rows = artifactItems(d, paths);
        // What it needs from the organisation, before its tasks (ADR 0101).
        let needs: Item;
        try {
          needs = needsNode(d.id, await this.needsOf(root, d));
        } catch (e) {
          needs = {
            id: `needs:${d.id}`,
            label: "Needs",
            description: "couldn't be read",
            tooltip: (e as Error).message,
            icon: "warning",
            command: { command: "atticus.showLog" },
          };
        }
        const at = rows.findIndex((r) => r.id.startsWith("tasks:"));
        rows.splice(at < 0 ? rows.length : at, 0, needs);
        return rows;
      }
      case "needs": {
        const d =
          this.details.get(x.change) ??
          (await api.get<Api.ChangeDetail>(`/api/changes/${enc(x.change)}`));
        const md = join(root, changeDirOf(d), "needs.md");
        let text = "";
        try {
          text = readFileSync(md, "utf8");
        } catch {
          // needs.md isn't written: each need still opens the file's place
        }
        return needItems((await this.needsOf(root, d)) ?? [], md, text);
      }
      case "findings": {
        const d =
          this.details.get(x.change) ??
          (await api.get<Api.ChangeDetail>(`/api/changes/${enc(x.change)}`));
        return findingItems(
          await api.get<Api.Finding[]>(`/api/findings?change=${enc(x.change)}`),
          d,
          paths,
        );
      }
      case "tasks":
        return taskItems(
          x.change,
          await api.get<Api.Task[]>(`/api/changes/${enc(x.change)}/tasks`),
        );
      case "targets":
        return targetItems(
          await api.get<Api.TargetFlowList>(`/api/changes/${enc(x.change)}/target-flows`),
        );
      case "kind":
        return recordItems(
          await api.get<Api.RecordPage>(`/api/catalog/${enc(x.recordKind)}?limit=200`),
          paths,
        );
      case "sources": {
        const s = this.onboarding?.sources;
        const add = actionRow(
          "add-wiki",
          "Add a wiki or docs repo…",
          "atticus.addWiki",
          "An Azure DevOps or GitHub wiki, a docs repo, or a folder of Markdown: saved into sources.yaml, then synced and read with Copilot.",
        );
        if (!s) return [add];
        const snaps = readSnapshots(
          root,
          paths.knowledgeRel ?? "knowledge",
          s.wikis.map((w) => w.id),
        );
        return [...wikiItems(s, snaps, paths), add];
      }
      case "knowledge-items":
        return knowledgeGroupItems((await this.knowledgeState(root)).items);
      case "knowledge-group":
        return knowledgeItemRows(
          itemsOfGroup((await this.knowledgeState(root)).items, x.group),
          paths,
        );
      case "last-scan": {
        const k = await this.knowledgeState(root);
        return k.report ? lastScanItems(k.report, k.items, paths) : [];
      }
      case "finds":
        return [
          actionRow(
            "search-wikis",
            "Search the wikis…",
            "atticus.searchWikis",
            "A term or phrase: every page it is on is read with Copilot for what isn't an item yet.",
          ),
          ...findItems((await this.knowledgeState(root)).finds),
        ];
      case "find": {
        // What the search found, as the command line lists it; else its saved file.
        const listed = (await this.knowledgeState(root)).finds.find((f) => f.slug === x.slug);
        const cands =
          listed?.list ??
          readFind(root, paths.knowledgeRel ?? "knowledge", x.slug)?.candidates ??
          [];
        return candidateItems(x.slug, cands);
      }
      case "evidence":
        return evidenceItems(x, paths);
    }
  }

  /** A part's rows, read (no "Reading…" row): for the tests in VS Code, and a part read at once. */
  async children(node?: Node): Promise<Node[]> {
    const root = this.svc.root;
    if (!root || !this.svc.cliOk) return [];
    if (node && isItem(node) && node.shown) return node.shown;
    if (node && (!isItem(node) || !node.expand)) return [];
    return this.loads.wait(
      this.keyOf(node as Item | undefined),
      () => this.read(root, node as Item | undefined),
      (e) => this.failed(node, e),
    );
  }

  /**
   * The rows to show now (0.3.1): a "Reading…" row until a part is first read, then its rows; a
   * refresh keeps the rows on show, with the view's progress bar, until they are read again.
   */
  getChildren(node?: Node): Node[] {
    const root = this.svc.root;
    // No metarepo or no command line: empty, so the view's welcome says what to do first.
    if (!root || !this.svc.cliOk) return [];
    if (node && isItem(node) && node.shown) return node.shown;
    if (node && (!isItem(node) || !node.expand)) return [];
    const it = node as Item | undefined;
    const shown = this.loads.get(
      this.keyOf(it),
      () => this.read(root, it),
      () => this.changed.fire(it),
      (e) => this.failed(it, e),
    );
    return (
      shown ?? [
        {
          id: `${it?.id ?? this.section}:loading`,
          state: "loading",
          message: loadingLabel(this.section, it?.expand?.kind),
        },
      ]
    );
  }

  /** Read a part, with the view's progress bar while it reads. */
  private read(root: string, node: Item | undefined): Promise<Node[]> {
    const words = node ? "" : this.filter;
    const p = filterWords(words).length ? this.filtered(root, words) : this.rows(root, node);
    void vscode.window.withProgress({ location: { viewId: `atticus.${this.section}` } }, () =>
      p.catch(() => undefined),
    );
    return p;
  }

  /**
   * The section's top rows under a filter (ADR 0105): a row that matches keeps all it holds; a
   * row shows when what is below it matches, with only that. Below is looked at where it is read
   * with the section (the Knowledge section's parts); a change shows when it matches itself.
   */
  private async filtered(root: string, words: string): Promise<Node[]> {
    const top = await this.rows(root, undefined);
    // An empty section says what fills it, filter or not.
    if (!top.some(isItem)) return top;
    interface T {
      node: Node;
      kids?: T[];
      cut?: boolean;
    }
    const resolve = (ns: Node[], depth: number): Promise<T[]> =>
      Promise.all(
        ns.map(async (n): Promise<T> => {
          if (!isItem(n) || !n.expand || !RESOLVED_BELOW.has(n.expand.kind) || depth > 3)
            return { node: n };
          try {
            return { node: n, kids: await resolve(await this.below(root, n), depth + 1) };
          } catch {
            return { node: n };
          }
        }),
      );
    const kept = filterTree(await resolve(top, 0), words, {
      text: (t) => (isItem(t.node) ? itemText(t.node) : ""),
      kids: (t) => t.kids,
      withKids: (t, kids) => ({ node: t.node, kids, cut: true }),
    });
    const out = (ts: T[]): Node[] =>
      ts.map((t) => (t.cut && isItem(t.node) ? { ...t.node, shown: out(t.kids ?? []) } : t.node));
    const f = FILTERED[this.section];
    return kept.length ? out(kept) : [noMatchRow(words, f.name, f.clear)];
  }

  /** A part's rows, or the row that says it is empty. */
  private rows(root: string, node: Item | undefined): Promise<Node[]> {
    return (async (): Promise<Node[]> => {
      const items = node ? await this.below(root, node) : await this.top(root);
      if (items.length) return items;
      return [
        {
          id: `${node?.id ?? this.section}:empty`,
          state: "empty",
          message: node ? emptyBelow(node.expand!.kind) : EMPTY[this.section].message,
          ...(node ? {} : { action: EMPTY[this.section] }),
        },
      ];
    })();
  }

  private failed(node: Item | undefined, e: unknown): Node[] {
    const message = (e as Error)?.message ?? String(e);
    this.svc.log.appendLine(`Couldn't read the ${this.section} section: ${message}`);
    return [{ id: `${node?.id ?? this.section}:error`, state: "error", message }];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (!isItem(node)) {
      const label =
        node.state === "error" ? errorLabel(node.message) : (node.action?.label ?? node.message);
      const t = new vscode.TreeItem(label);
      t.id = node.id;
      t.tooltip =
        node.state === "error"
          ? `${node.message}\n\nClick to see the commands run, in the Atticus output. Refresh to read it again.`
          : node.message;
      t.iconPath = new vscode.ThemeIcon(
        node.state === "loading"
          ? "loading~spin"
          : node.state === "error"
            ? "warning"
            : node.action
              ? "add"
              : "info",
      );
      if (node.action) t.command = { command: node.action.command, title: node.action.label };
      if (node.state === "error")
        t.command = { command: "atticus.showLog", title: "Show the commands run" };
      return t;
    }
    // A row shown for what matched below it opens to show that (its own id, so it does).
    const t = new vscode.TreeItem(
      node.label,
      node.shown
        ? vscode.TreeItemCollapsibleState.Expanded
        : node.expand
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None,
    );
    t.id = `${this.section}:${node.id}${node.shown ? ":filtered" : ""}`;
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

  dispose() {
    this.changed.dispose();
  }
}
