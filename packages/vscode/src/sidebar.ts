import * as vscode from "vscode";
import type * as Api from "./api-types";
import type { Service } from "./service";
import {
  artifactItems,
  changeItems,
  evidenceItems,
  findingItems,
  flowItems,
  kindItems,
  recordItems,
  repoChildren,
  repoItems,
  stepItems,
  type Item,
} from "./sidebar-data";

/**
 * The sidebar's sections beyond Next (ADR 0093): Repos, Changes and Catalog. Each reads the app's
 * local API, which the service starts once for the window. Each shows a loading row while it
 * reads, the reason when it can't, and says so when there is nothing. Clicking an item runs
 * atticus.openItem with what it opens.
 */

type Node = Item | { id: string; state: "loading" | "error" | "empty"; message: string };
const isItem = (n: Node): n is Item => !("state" in n);

export type Section = "repos" | "changes" | "catalog";

const EMPTY: Record<Section, string> = {
  repos:
    "No repos yet. Add them to a repos.manifest.yaml in org-pack/profiles, then run atticus workspace sync.",
  changes:
    "No changes yet. Start one with atticus change new, or /atticus-feature in Copilot Chat.",
  catalog: "The catalog is empty. Run atticus scan.",
};

export class SectionTree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  /** Each change's detail, read when it opens, for its findings' files. */
  private readonly details = new Map<string, Api.ChangeDetail>();
  private onboarding: Api.OnboardingView | undefined;
  private flowCounts = new Map<string, number>();

  constructor(
    private readonly svc: Service,
    private readonly section: Section,
  ) {}

  refresh() {
    this.details.clear();
    this.onboarding = undefined;
    this.changed.fire(undefined);
  }

  private async top(root: string): Promise<Item[]> {
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
    return kindItems(await api.get<Api.KindCount[]>("/api/catalog/kinds"));
  }

  private async below(root: string, it: Item): Promise<Item[]> {
    const x = it.expand!;
    const paths = this.svc.paths(root);
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
        return artifactItems(d, paths);
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
      case "kind":
        return recordItems(
          await api.get<Api.RecordPage>(`/api/catalog/${enc(x.recordKind)}?limit=200`),
          paths,
        );
      case "evidence":
        return evidenceItems(x, paths);
    }
  }

  async getChildren(node?: Node): Promise<Node[]> {
    const root = this.svc.root;
    if (!root)
      return [
        {
          id: "no-root",
          state: "empty",
          message: "Open the metarepo folder (the one with org-pack/).",
        },
      ];
    if (node && (!isItem(node) || !node.expand)) return [];
    try {
      const items = node ? await this.below(root, node as Item) : await this.top(root);
      if (!items.length)
        return [
          {
            id: `${node?.id ?? this.section}:empty`,
            state: "empty",
            message: node ? "Nothing here yet." : EMPTY[this.section],
          },
        ];
      return items;
    } catch (e) {
      return [
        { id: `${node?.id ?? this.section}:error`, state: "error", message: (e as Error).message },
      ];
    }
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (!isItem(node)) {
      const t = new vscode.TreeItem(node.message);
      t.id = node.id;
      t.tooltip = node.message;
      t.iconPath = new vscode.ThemeIcon(node.state === "error" ? "warning" : "info");
      if (node.state === "error")
        t.command = { command: "atticus.showLog", title: "Show the commands run" };
      return t;
    }
    const t = new vscode.TreeItem(
      node.label,
      node.expand
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    t.id = `${this.section}:${node.id}`;
    if (node.description) t.description = node.description;
    if (node.tooltip) t.tooltip = node.tooltip;
    if (node.icon) t.iconPath = new vscode.ThemeIcon(node.icon);
    if (node.context) t.contextValue = node.context;
    if (node.open)
      t.command = { command: "atticus.openItem", title: "Open", arguments: [node.open] };
    return t;
  }

  dispose() {
    this.changed.dispose();
  }
}
