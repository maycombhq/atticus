import { relative, sep } from "node:path";
import * as vscode from "vscode";
import type * as Api from "./api-types";
import type { Service } from "./service";
import { citeLenses, type Lens } from "./sidebar-data";
import { WORDS } from "./words";

/**
 * Flow steps and records in the code (ADR 0093, 0094): above each line a spec flow or a catalog
 * record cites, a CodeLens says which. A flow step's lens opens the flow beside the code with the
 * step marked; a record's opens its YAML. One API call per file (GET /api/cites), made when the
 * file is first shown and again after Refresh or a spec or catalog change. Only repos whose code
 * is on this machine (an open folder named for the repo, or its base clone) get lenses; the
 * settings atticus.codeLens and atticus.codeLens.records turn them off.
 */
export class FlowLenses implements vscode.CodeLensProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;
  private repos: Promise<string[]> | undefined;
  private readonly files = new Map<string, Promise<Lens[]>>();
  /** The last reason lenses couldn't be read, said once in the output. */
  private lastProblem: string | undefined;

  constructor(private readonly svc: Service) {}

  /** Read again (a spec or catalog file changed, or Refresh). */
  refresh() {
    this.repos = undefined;
    this.files.clear();
    this.changed.fire();
  }

  /** The repos citations can name: the manifests' and the specs'. */
  private async knownRepos(root: string): Promise<string[]> {
    const api = await this.svc.api(root);
    const [o, s] = await Promise.all([
      api.get<Api.OnboardingView>("/api/onboarding").catch(() => ({ repos: [] })),
      api.get<Api.SpecList>("/api/specs").catch(() => ({ repos: [] })),
    ]);
    return [...new Set([...o.repos.map((r) => r.id), ...s.repos.map((r) => r.repo)])];
  }

  private async lensesFor(root: string, repo: string, path: string): Promise<Lens[]> {
    const api = await this.svc.api(root);
    const list = await api.get<Api.CiteList>(
      `/api/cites?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}`,
    );
    const records = vscode.workspace
      .getConfiguration("atticus")
      .get<boolean>("codeLens.records", true);
    return citeLenses(list, this.svc.paths(root), { records });
  }

  async provideCodeLenses(doc: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    const root = this.svc.root;
    if (!root || doc.uri.scheme !== "file") return [];
    const paths = this.svc.paths(root);
    let lenses: Lens[] = [];
    try {
      this.repos ??= this.knownRepos(root);
      for (const repo of await this.repos) {
        const dir = paths.codeRoot(repo);
        if (!dir) continue;
        const rel = relative(dir, doc.uri.fsPath);
        if (!rel || rel.startsWith("..") || rel === doc.uri.fsPath) continue;
        const key = `${repo}\u0000${rel}`;
        let p = this.files.get(key);
        if (!p) {
          p = this.lensesFor(root, repo, rel.split(sep).join("/"));
          this.files.set(key, p);
        }
        lenses = await p;
        break;
      }
    } catch (e) {
      this.repos = undefined;
      this.files.clear();
      // Lenses are drawn all the time: the output says why they're missing, once per reason.
      const why = e instanceof Error ? e.message : String(e);
      if (why !== this.lastProblem) this.svc.log.appendLine(WORDS.lensesFailed(why));
      this.lastProblem = why;
      return [];
    }
    this.lastProblem = undefined;
    return lenses
      .filter((l) => l.line >= 1 && l.line <= doc.lineCount)
      .map(
        (l) =>
          new vscode.CodeLens(new vscode.Range(l.line - 1, 0, l.line - 1, 0), {
            title: l.title,
            tooltip: l.tooltip,
            command: "atticus.openItem",
            arguments: [l.open, { beside: true }],
          }),
      );
  }

  dispose() {
    this.changed.dispose();
  }
}
