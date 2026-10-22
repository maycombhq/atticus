import { relative, sep } from "node:path";
import * as vscode from "vscode";
import type * as Api from "./api-types";
import type { Service } from "./service";
import { citesOf, flowHash, lensText, type Cite } from "./sidebar-data";

/**
 * Flow steps in the code (ADR 0093): above each line a spec flow cites, a CodeLens names the flow
 * and the step and says who confirmed it; clicking it opens the flow in the Atticus tab with the
 * step marked. Every spec's cited lines are read from the app's API once, when the first file is
 * opened, and again after a spec file changes. Only repos whose code is on this machine (an open
 * folder named for the repo, or its base clone) get lenses; the setting atticus.codeLens turns
 * them off.
 */

const MAX_PARALLEL = 8;

export class FlowLenses implements vscode.CodeLensProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;
  private index: Promise<Map<string, Map<string, Cite[]>>> | undefined;

  constructor(private readonly svc: Service) {}

  /** Read the flows again (a spec file changed, or Refresh). */
  refresh() {
    this.index = undefined;
    this.changed.fire();
  }

  private async load(root: string): Promise<Map<string, Map<string, Cite[]>>> {
    const api = await this.svc.api(root);
    const { repos } = await api.get<Api.SpecList>("/api/specs");
    const views: Api.FlowView[] = [];
    const jobs: (() => Promise<void>)[] = [];
    for (const r of repos) {
      const spec = await api.get<Api.SpecView>(`/api/specs/${encodeURIComponent(r.repo)}`);
      for (const f of spec.flows)
        jobs.push(async () => {
          views.push(
            await api.get<Api.FlowView>(
              `/api/specs/${encodeURIComponent(r.repo)}/flows/${encodeURIComponent(f.id)}`,
            ),
          );
        });
    }
    const run = async () => {
      for (let j = jobs.shift(); j; j = jobs.shift()) await j().catch(() => undefined);
    };
    await Promise.all(Array.from({ length: MAX_PARALLEL }, run));
    return citesOf(views);
  }

  async provideCodeLenses(doc: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    const root = this.svc.root;
    if (!root || doc.uri.scheme !== "file") return [];
    const paths = this.svc.paths(root);
    let index: Map<string, Map<string, Cite[]>>;
    try {
      this.index ??= this.load(root);
      index = await this.index;
    } catch {
      this.index = undefined;
      return [];
    }
    for (const [repo, files] of index) {
      const dir = paths.codeRoot(repo);
      if (!dir) continue;
      const rel = relative(dir, doc.uri.fsPath);
      if (rel.startsWith("..") || rel === doc.uri.fsPath) continue;
      const cites = files.get(rel.split(sep).join("/"));
      if (!cites) continue;
      return cites
        .filter((c) => c.line >= 1 && c.line <= doc.lineCount)
        .map(
          (c) =>
            new vscode.CodeLens(new vscode.Range(c.line - 1, 0, c.line - 1, 0), {
              title: lensText(c),
              tooltip: `Open ${c.name} in the Atticus tab, at ${c.n === 0 ? "its start" : `step ${c.n}`}`,
              command: "atticus.showApp",
              arguments: [flowHash(c.repo, c.flow, c.n), { beside: true }],
            }),
        );
    }
    return [];
  }

  dispose() {
    this.changed.dispose();
  }
}
