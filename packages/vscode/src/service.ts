import { existsSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { AtticusApi } from "./api";
import { startApp, type RunningApp } from "./app-panel";
import { cliRunner, resolveCommand, type CliOptions } from "./cli";
import { codeRootFor, type Paths } from "./sidebar-data";
import { runSpec, runStep, type RunnerDeps, type StepEnd } from "./runner";
import type { Cancel, Cli } from "./types";
import { pickModel } from "./vscode-model";

/**
 * What every part of the extension shares (ADR 0090): the metarepo, the `atticus` command line
 * from the settings, the "Atticus" output channel (every command run and its exit code), and
 * running an AI step. Nothing here sends anything anywhere: the only network use is the Copilot
 * model, through vscode.lm, in vscode-model.ts.
 */
export class Service {
  readonly log: vscode.OutputChannel;
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires after a command that may have changed the metarepo's files. */
  readonly onChanged = this.changed.event;

  constructor() {
    this.log = vscode.window.createOutputChannel("Atticus");
  }

  /** The workspace folder holding org-pack/ (or .atticus/org-pack/), else the first folder. */
  get root(): string | undefined {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const meta = folders.find(
      (f) =>
        existsSync(join(f.uri.fsPath, "org-pack")) ||
        existsSync(join(f.uri.fsPath, ".atticus", "org-pack")),
    );
    return (meta ?? folders[0])?.uri.fsPath;
  }

  cliOptions(root: string): CliOptions {
    const atticusPath = vscode.workspace.getConfiguration("atticus").get<string>("path", "atticus");
    return { atticusPath, cwd: root, log: (l) => this.log.appendLine(l) };
  }

  cli(root: string): Cli {
    return cliRunner(this.cliOptions(root));
  }

  /** How to start atticus, for a terminal. */
  command(root: string) {
    return resolveCommand(this.cliOptions(root));
  }

  fireChanged() {
    this.changed.fire();
  }

  private app: Promise<RunningApp> | undefined;

  /**
   * The app, `atticus ui --embed vscode` on a free port, started once per window for the tab and
   * the sidebar (ADR 0091, 0093), and again if it stops.
   */
  runningApp(root: string): Promise<RunningApp> {
    if (!this.app) {
      const started = startApp(this.cliOptions(root));
      this.app = started;
      const drop = () => {
        if (this.app === started) this.app = undefined;
      };
      started.then((a) => a.onExit(drop), drop);
    }
    return this.app;
  }

  /** The app's API, starting the app if it isn't running. */
  async api(root: string): Promise<AtticusApi> {
    const a = await this.runningApp(root);
    return new AtticusApi(a.url, a.token);
  }

  /** Where the metarepo and the repos' code are, for the sidebar's links. */
  paths(root: string): Paths {
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => ({
      name: f.name,
      path: f.uri.fsPath,
    }));
    return {
      root,
      codeRoot: (repo) => codeRootFor(repo, root, folders, existsSync),
      catalogRel: existsSync(join(root, ".atticus", "catalog")) ? ".atticus/catalog" : "catalog",
      exists: existsSync,
    };
  }

  /** Run an AI step (or /spec's draft-and-check loop) with Copilot's model. */
  async run(
    root: string,
    o: { args: string[]; spec?: string },
    progress: (line: string) => void,
    token: Cancel,
    chatModel?: vscode.LanguageModelChat,
  ): Promise<StepEnd> {
    const d: RunnerDeps = {
      root,
      cli: this.cli(root),
      model: () => pickModel(chatModel),
      progress: (l) => {
        this.log.appendLine(l);
        progress(l);
      },
    };
    try {
      return o.spec ? await runSpec(o.spec, d, token) : await runStep(o.args, d, token);
    } finally {
      this.fireChanged();
    }
  }

  dispose() {
    void this.app?.then(
      (a) => a.stop(),
      () => undefined,
    );
    this.changed.dispose();
    this.log.dispose();
  }
}
