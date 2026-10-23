import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { readOpenQuestions } from "./atticus";
import type * as Api from "./api-types";
import { commandText } from "./cli";
import {
  briefPathFrom,
  buildArgv,
  changeTypesFrom,
  commandsFor,
  howToRun,
  matchCommand,
  optionsOf,
  presetFrom,
  pickList,
  requiredSwitches,
  type Answers,
  type ArgKind,
  type Catalog,
  type CatalogArg,
  type CatalogCommand,
} from "./commands";
import type { Service } from "./service";
import { healthProblems } from "./sidebar-data";
import {
  absorbConfirm,
  acceptConfirm,
  defaultAbsorbId,
  guidedFor,
  onboardingStages,
  type AbsorbDry,
  type AcceptDry,
  type Stage,
} from "./guided";
import { runProgressTitle } from "./feedback";
import { pickLoading } from "./pick";
import type { StepEnd } from "./runner";
import { discoveredFrom, isMetarepoName } from "./start";

/**
 * Every Atticus command in VS Code (ADR 0096). The list comes from `atticus commands --json`, so
 * it is the command line's own; each argument is asked with a picker for its kind (a repo, a
 * change, a question…), then the options. AI steps run with Copilot's model; a command that
 * writes to a shared system runs as a dry run first and asks the person before it adds its
 * approve flag; a server gets a terminal; the rest runs and shows what it printed.
 */

export interface CommandUiDeps {
  /**
   * Run an AI step with Copilot's model; how it ended, or undefined when it didn't start. Its
   * progress says what it is doing in plain words; quiet leaves saying how a done step ended to
   * the caller (a search of the wikis says what it found).
   */
  runAi: (
    args: string[],
    spec?: string,
    o?: { title?: string; quiet?: boolean },
  ) => Promise<StepEnd | undefined>;
  inTerminal: (root: string, name: string, args: string[], run?: boolean) => vscode.Terminal;
  refreshAll: () => void;
}

/** What a run printed, kept for the chat. */
export interface Printed {
  code: number;
  lines: string[];
}

export class CommandUi {
  private catalog: Promise<Catalog> | undefined;

  constructor(
    private readonly svc: Service,
    private readonly d: CommandUiDeps,
  ) {}

  /** The command line's catalogue, read once a window. */
  load(root: string): Promise<Catalog> {
    if (!this.catalog) {
      const c = this.svc
        .cli(root)(["commands", "--json"])
        .then((r) => {
          if (r.code !== 0) throw new Error(r.stderr.trim() || `atticus commands exited ${r.code}`);
          return JSON.parse(r.stdout) as Catalog;
        });
      this.catalog = c;
      c.catch(() => (this.catalog = undefined));
    }
    return this.catalog;
  }

  /** The catalogue, with a note while it is read the first time (atticus commands --json). */
  private loadShown(root: string): Promise<Catalog> {
    if (this.catalog) return this.catalog;
    return Promise.resolve(
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Atticus: reading the command line's commands…",
        },
        () => this.load(root),
      ),
    );
  }

  /** Pick a command from every one, or from those given, by area. */
  async pick(
    root: string,
    only?: CatalogCommand[],
    title?: string,
  ): Promise<CatalogCommand | undefined> {
    const developer = vscode.workspace
      .getConfiguration("atticus")
      .get<boolean>("showDeveloperCommands", false);
    let cat: Catalog | undefined;
    const p = await pickLoading<vscode.QuickPickItem & { id?: string }>(
      {
        title: title ?? "Run an Atticus command",
        reading: "Reading the command line's commands…",
        placeholder: "Type to find a command by its words or what it does",
        empty: "There is no command to run here.",
        matchOnDetail: true,
        log: this.svc.log,
      },
      async () => {
        cat = await this.load(root);
        const list = only ? { ...cat, commands: only } : cat;
        return pickList(list, { developer }).map((i) =>
          i.separator
            ? { label: i.label, kind: vscode.QuickPickItemKind.Separator }
            : {
                label: i.label,
                ...(i.description ? { description: i.description } : {}),
                ...(i.detail ? { detail: i.detail } : {}),
                id: i.id,
              },
        );
      },
    );
    return p?.id && cat ? cat.commands.find((c) => c.id === p.id) : undefined;
  }

  // ------------------------------------------------------------------ pickers by kind

  /** A pick list that shows at once and reads its items while open (0.3.1). */
  private async quick(
    title: string,
    items:
      | { label: string; description?: string; detail?: string; value: string }[]
      | (() => Promise<{ label: string; description?: string; detail?: string; value: string }[]>),
    empty: string | (() => unknown),
    reading = "Reading…",
  ): Promise<string | undefined> {
    const p = await pickLoading(
      { title, reading, empty, log: this.svc.log },
      typeof items === "function" ? items : () => items,
    );
    return p?.value;
  }

  /** A repo or a change, picked from those the metarepo has. */
  async pickTarget(root: string, kind: "repo" | "change", title: string) {
    const v = await this.askArg(
      root,
      { id: title, summary: "", args: [], flags: [] } as unknown as CatalogCommand,
      { name: kind, kind, optional: false, many: false },
      [],
      title,
    );
    return typeof v === "string" ? v : undefined;
  }

  private async askArg(
    root: string,
    cmd: CatalogCommand,
    a: CatalogArg,
    before: (string | string[] | undefined)[],
    named?: string,
  ): Promise<string | string[] | undefined | null> {
    const title = named ?? `atticus ${cmd.id}: ${a.name}${a.optional ? " (optional)" : ""}`;
    const api = () => this.svc.api(root);
    const enc = encodeURIComponent;
    const kind: ArgKind = a.kind;
    // Each list shows at once and is read while it is open.
    if (kind === "repo")
      return this.quick(
        title,
        async () => {
          const [o, s] = await Promise.all([
            api().then((x) => x.get<Api.OnboardingView>("/api/onboarding")),
            api()
              .then((x) => x.get<Api.SpecList>("/api/specs"))
              .catch(() => ({ repos: [] })),
          ]);
          const ids = [...new Set([...o.repos.map((r) => r.id), ...s.repos.map((r) => r.repo)])];
          return ids.map((id) => ({ label: id, value: id }));
        },
        "No repos yet: add them first (Atticus: Add repos).",
        "Reading the repos…",
      );
    if (kind === "change")
      return this.quick(
        title,
        async () =>
          (await api().then((x) => x.get<Api.ChangeSummary[]>("/api/changes"))).map((c) => ({
            label: c.title,
            description: `${c.id} · ${c.state}`,
            value: c.id,
          })),
        "No changes yet: start one with Atticus: New change.",
        "Reading the changes…",
      );
    if (kind === "question")
      return this.quick(
        title,
        async () => {
          const q = await readOpenQuestions(this.svc.cli(root), root);
          if (!q.ok) throw new Error(q.message);
          return q.value.map((x) => ({
            label: x.question,
            description: x.repo,
            detail: x.id,
            value: x.id,
          }));
        },
        "No question is waiting for an answer.",
        "Reading the open questions…",
      );
    if (kind === "finding") {
      const change = typeof before[0] === "string" ? before[0] : undefined;
      if (!change)
        return vscode.window.showInputBox({
          title,
          prompt: "The finding's id",
          ignoreFocusOut: true,
        });
      return this.quick(
        title,
        async () =>
          (await api().then((x) => x.get<Api.Finding[]>(`/api/findings?change=${enc(change)}`)))
            .filter((f) => (f.state ?? "open") === "open")
            .map((f) => ({
              label: f.summary,
              description: `${f.severity} · ${f.artifact}`,
              value: f.id,
            })),
        `${change} has no open findings.`,
        "Reading the findings…",
      );
    }
    if (kind === "flow")
      return this.quick(
        title,
        async () => {
          const x = await api();
          const { repos } = await x.get<Api.SpecList>("/api/specs");
          const items: { label: string; description: string; value: string }[] = [];
          for (const r of repos)
            for (const f of (await x.get<Api.SpecView>(`/api/specs/${enc(r.repo)}`)).flows)
              items.push({ label: f.name, description: `${f.id} · ${r.repo}`, value: f.id });
          return items;
        },
        "No repo has a spec yet: draft one with atticus spec draft.",
        "Reading the flows…",
      );
    if (kind === "system")
      return this.quick(
        title,
        async () =>
          (
            await api().then((x) => x.get<Api.RecordPage>("/api/catalog/System?limit=500"))
          ).items.map((r) => ({ label: r.name ?? r.id, description: r.id, value: r.id })),
        "The catalog has no systems yet: run atticus scan.",
        "Reading the catalog's systems…",
      );
    if (kind === "choice" && a.choices)
      return this.quick(
        title,
        a.choices.map((c) => ({ label: c, value: c })),
        "There is nothing to choose.",
      );
    if (kind === "path") {
      const folder = /dir|folder/.test(a.name);
      const picked = await vscode.window.showOpenDialog({
        title,
        canSelectMany: a.many,
        canSelectFiles: !folder,
        canSelectFolders: folder,
        defaultUri: vscode.Uri.file(root),
      });
      if (!picked?.length) return a.optional ? undefined : null;
      const paths = picked.map((u) => u.fsPath);
      return a.many ? paths : paths[0];
    }
    const v = await vscode.window.showInputBox({
      title,
      prompt: `${cmd.summary}${a.optional ? " Leave it empty to leave it out." : ""}`,
      ignoreFocusOut: true,
    });
    if (v === undefined) return null;
    return v.trim() ? (a.many ? v.trim().split(/\s+/) : v.trim()) : a.optional ? undefined : null;
  }

  /** The change types of the org pack, for change new's --type. */
  private changeTypes(root: string): { id: string; name?: string }[] {
    for (const f of [
      join(root, "org-pack", "change-types.yaml"),
      join(root, ".atticus", "org-pack", "change-types.yaml"),
    ])
      if (existsSync(f)) return changeTypesFrom(readFileSync(f, "utf8"));
    return [];
  }

  private async askFlagValue(root: string, cmd: CatalogCommand, name: string, hint?: string) {
    if (cmd.id === "change new" && name === "--type") {
      const types = this.changeTypes(root);
      if (types.length)
        return this.quick(
          "The kind of change",
          types.map((t) => ({
            label: t.id,
            ...(t.name ? { description: t.name } : {}),
            value: t.id,
          })),
          "",
        );
    }
    if (name === "--repo")
      return this.askArg(
        root,
        cmd,
        { name: "repo", kind: "repo", optional: false, many: false },
        [],
      );
    if (name === "--change")
      return this.askArg(
        root,
        cmd,
        { name: "change", kind: "change", optional: false, many: false },
        [],
      );
    const v = await vscode.window.showInputBox({
      title: `atticus ${cmd.id} ${name}`,
      prompt: hint ? `Its value (for example ${hint})` : "Its value",
      ignoreFocusOut: true,
    });
    return v?.trim() || undefined;
  }

  /** Ask for each argument not given yet, the required options, then any options to add. */
  async ask(
    root: string,
    cmd: CatalogCommand,
    preset: Partial<Answers> = {},
  ): Promise<Answers | undefined> {
    const args: (string | string[] | undefined)[] = [...(preset.args ?? [])];
    for (const [i, a] of cmd.args.entries()) {
      if (args[i] !== undefined) continue;
      const v = await this.askArg(root, cmd, a, args);
      if (v === null || (v === undefined && !a.optional)) return undefined;
      args[i] = v;
    }
    const flags: Record<string, string | true> = {
      ...requiredSwitches(cmd),
      ...(preset.flags ?? {}),
    };
    for (const f of cmd.flags.filter((x) => x.required && !(x.name in flags))) {
      // Two required options joined by "|" (questions answer --option | --text): one of them.
      const v = await this.askFlagValue(root, cmd, f.name, f.value);
      if (v === undefined || v === null) continue;
      flags[f.name] = Array.isArray(v) ? v.join(",") : v;
      if (cmd.id === "questions answer") break;
    }
    const options = optionsOf(cmd).filter((f) => !(f.name in flags));
    if (options.length) {
      const chosen = await vscode.window.showQuickPick(
        options.map((f) => ({
          label: f.name,
          description: f.value ? `takes a value, e.g. ${f.value}` : "",
          ...(f.summary ? { detail: f.summary } : {}),
          f,
        })),
        {
          title: `atticus ${cmd.id}: options (none needed; press Enter to run)`,
          canPickMany: true,
          ignoreFocusOut: true,
        },
      );
      if (chosen === undefined) return undefined;
      for (const c of chosen) {
        if (!c.f.value) flags[c.f.name] = true;
        else {
          const v = await this.askFlagValue(root, cmd, c.f.name, c.f.value);
          if (typeof v === "string") flags[c.f.name] = v;
        }
      }
    }
    return { args, flags };
  }

  // ------------------------------------------------------------------ running

  /** Run and keep what it printed: the output channel gets all of it. */
  async captured(root: string, argv: string[]): Promise<Printed> {
    const r = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Atticus: ${runProgressTitle(argv)}…`,
        cancellable: true,
      },
      (p, token) => {
        p.report({ message: `${commandText(argv)}` });
        return this.svc.cli(root)([...argv, "--root", root], token);
      },
    );
    const lines = [...r.stdout.trimEnd().split("\n"), ...r.stderr.trimEnd().split("\n")].filter(
      Boolean,
    );
    this.svc.log.appendLine(`--- ${commandText(argv)} (exit ${r.code})`);
    for (const l of lines) this.svc.log.appendLine(l);
    return { code: r.code, lines };
  }

  /**
   * Say what a run printed, without waiting for the person: a notification's promise settles only
   * when it is closed, and it can sit in the bell for good, so what comes after (the sections
   * read again, the next stage) never waits on it.
   */
  showPrinted(argv: string[], p: Printed): void {
    const first = p.lines[0] ?? (p.code === 0 ? "Done." : `It exited ${p.code}.`);
    const show =
      p.code === 0 ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
    void show(`atticus ${argv.slice(0, 2).join(" ")}: ${first}`, "Show the output").then((pick) => {
      if (pick) this.svc.log.show(true);
    });
  }

  /** A shared write: the dry run, then the person's yes, then the run with the approve flag. */
  async approveAndRun(root: string, argv: string[], flag: string): Promise<Printed | undefined> {
    const dry = await this.captured(
      root,
      argv.filter((a) => a !== flag),
    );
    const ok = await vscode.window.showWarningMessage(
      `This writes to a shared system: ${commandText([...argv.filter((a) => a !== flag), flag])}`,
      {
        modal: true,
        detail: `What the dry run says:\n\n${dry.lines.slice(-25).join("\n") || "(nothing)"}`,
      },
      "Approve and run",
    );
    if (ok !== "Approve and run") return undefined;
    return this.captured(root, [...argv.filter((a) => a !== flag), flag]);
  }

  /** Run a command as its kind needs. */
  async run(root: string, cmd: CatalogCommand, a: Answers): Promise<void> {
    const argv = buildArgv(cmd, a);
    const how = howToRun(cmd);
    if (how.mode === "ai") {
      const spec = cmd.id === "spec draft" && typeof a.args[0] === "string" ? a.args[0] : undefined;
      await this.d.runAi(argv, spec);
    } else if (how.mode === "terminal") {
      this.d.inTerminal(root, `Atticus ${cmd.id}`, [...argv, "--root", root]);
      return;
    } else if (how.mode === "approve") {
      const p = await this.approveAndRun(root, argv, how.flag);
      if (p) this.showPrinted(argv, p);
    } else {
      const p = await this.captured(root, argv);
      if (cmd.id === "change new" && p.code === 0) await this.afterNewChange(root, p);
      else this.showPrinted(argv, p);
    }
    this.d.refreshAll();
  }

  /** The whole flow: pick (or take) a command, ask what it needs, run it. */
  async pickAndRun(
    root: string,
    id?: string,
    preset: Partial<Answers> = {},
    only?: CatalogCommand[],
    title?: string,
  ) {
    try {
      const cmd = id
        ? (await this.loadShown(root)).commands.find((c) => c.id === id)
        : await this.pick(root, only, title);
      if (!cmd) {
        if (id)
          void vscode.window.showWarningMessage(
            `This atticus has no command ${id}. It may be older than this extension: upgrade it, then try again.`,
          );
        return;
      }
      const a = await this.ask(root, cmd, preset);
      if (a) await this.run(root, cmd, a);
    } catch (e) {
      const pick = await vscode.window.showErrorMessage(
        `Couldn't run it: ${(e as Error).message}`,
        "Show the commands run",
      );
      if (pick) this.svc.log.show(true);
    }
  }

  /** Every command that takes this repo or change, with it filled in. */
  async forItem(root: string, kind: "repo" | "change", value: string) {
    let cat: Catalog;
    try {
      cat = await this.loadShown(root);
    } catch (e) {
      const pick = await vscode.window.showErrorMessage(
        `Couldn't read the command line's commands: ${(e as Error).message}`,
        "Show the output",
      );
      if (pick) this.svc.log.show(true);
      return;
    }
    await this.pickAndRun(
      root,
      undefined,
      { args: [value] },
      commandsFor(cat, kind),
      kind === "repo" ? `Run on the repo ${value}` : `Run on the change ${value}`,
    );
  }

  /** A new change: its title and type, then the brief to write, then the feature stage. */
  async newChange(root: string, title?: string) {
    const t =
      title ??
      (await vscode.window.showInputBox({
        title: "Atticus: New change",
        prompt: "What the change is, in a few words (for example: Let members pin a message)",
        ignoreFocusOut: true,
      }));
    if (!t?.trim()) return;
    await this.pickAndRun(root, "change new", { args: [t.trim()] });
  }

  private async afterNewChange(root: string, p: Printed) {
    const brief = briefPathFrom(p.lines.join("\n"));
    if (!brief) return this.showPrinted(["change", "new"], p);
    const id = brief.split("/").slice(-2)[0]!;
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(join(root, brief)));
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch {
      return this.showPrinted(["change", "new"], p);
    }
    // Not a dialog: the person writes the brief first. The Next section offers the stage too.
    const pick = await vscode.window.showInformationMessage(
      `${p.lines[0]} Write the brief, save it, then run the feature stage (it is also the next step in the Next section).`,
      "Run the feature stage",
    );
    if (pick) await this.d.runAi(["change", "feature", id]);
  }

  // ------------------------------------------------------------------ starting from nothing (ADR 0098)

  /** Run in a folder that isn't a metarepo yet (init, adopt, sandbox): no --root. */
  private async plain(cwd: string, argv: string[]): Promise<Printed> {
    const r = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Atticus: ${runProgressTitle(argv)}…`,
      },
      (p) => {
        p.report({ message: `${commandText(argv)}` });
        return this.svc.cli(cwd)(argv);
      },
    );
    const lines = [...r.stdout.trimEnd().split("\n"), ...r.stderr.trimEnd().split("\n")].filter(
      Boolean,
    );
    this.svc.log.appendLine(`--- ${commandText(argv)} (exit ${r.code})`);
    for (const l of lines) this.svc.log.appendLine(l);
    return { code: r.code, lines };
  }

  private async openWhenDone(p: Printed, folder: string, what: string) {
    if (p.code !== 0) {
      const pick = await vscode.window.showErrorMessage(
        `${what} didn't work: ${p.lines.at(-1) ?? `exit ${p.code}`}`,
        "Show the output",
      );
      if (pick) this.svc.log.show(true);
      return;
    }
    const uri = vscode.Uri.file(folder);
    // An empty window opens it straight away; a window with a folder asks where (ADR 0100). A
    // notification would slip into the bell before it is seen.
    if (!vscode.workspace.workspaceFolders?.length) {
      void vscode.window.showInformationMessage(`${what}: ${folder}. Opening it.`);
      await vscode.commands.executeCommand("vscode.openFolder", uri, false);
      return;
    }
    const pick = await vscode.window.showInformationMessage(
      `${what}: ${folder}`,
      { modal: true, detail: "Open it now?" },
      "Open it here",
      "Open in a new window",
    );
    if (pick)
      await vscode.commands.executeCommand(
        "vscode.openFolder",
        uri,
        pick === "Open in a new window",
      );
  }

  private async pickParent(title: string): Promise<string | undefined> {
    const here = this.svc.folder;
    const picked = await vscode.window.showOpenDialog({
      title,
      canSelectFolders: true,
      canSelectFiles: false,
      openLabel: "Put it here",
      ...(here ? { defaultUri: vscode.Uri.file(join(here, "..")) } : {}),
    });
    return picked?.[0]?.fsPath;
  }

  /** A new metarepo: where, its name and its platform; then open it. */
  async createMetarepo() {
    const parent = await this.pickParent(
      "Where should the new metarepo go? (the folder it goes in)",
    );
    if (!parent) return;
    const name = await vscode.window.showInputBox({
      title: "Atticus: the metarepo's name",
      prompt: "Its folder's name: lowercase letters, digits and dashes (for example payments-meta)",
      validateInput: (v) =>
        isMetarepoName(v.trim())
          ? undefined
          : "Lowercase letters, digits, dots, dashes and underscores",
      ignoreFocusOut: true,
    });
    if (!name) return;
    const platform = await vscode.window.showInputBox({
      title: "Atticus: the platform",
      prompt:
        "The platform its repos belong to, in a word (for example payments). More can be added later.",
      validateInput: (v) =>
        isMetarepoName(v.trim()) ? undefined : "A word: lowercase letters, digits and dashes",
      ignoreFocusOut: true,
    });
    if (!platform) return;
    const folder = join(parent, name.trim());
    const p = await this.plain(parent, ["init", folder, "--platform", platform.trim()]);
    await this.openWhenDone(p, folder, "Made the metarepo");
  }

  /** Atticus in the open repo: it writes only .atticus/. */
  async adoptRepo() {
    const folder =
      this.svc.folder ??
      (
        await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          title: "Which repo?",
        })
      )?.[0]?.fsPath;
    if (!folder) return;
    const ok = await vscode.window.showInformationMessage(
      `Use Atticus in ${folder}? It writes only a .atticus/ folder there.`,
      { modal: true },
      "Use Atticus here",
    );
    if (ok !== "Use Atticus here") return;
    const p = await this.plain(folder, ["adopt", folder]);
    if (p.code === 0) {
      void vscode.window.showInformationMessage(p.lines[0] ?? "Atticus is set up in this repo.");
      this.d.refreshAll();
    } else this.showPrinted(["adopt"], p);
  }

  /** A practice metarepo with the invented Forge repos, to try Atticus on. */
  async practiceSandbox() {
    const parent = await this.pickParent("Where should the practice metarepo go?");
    if (!parent) return;
    const dir = join(parent, "atticus-practice");
    const p = await this.plain(parent, ["sandbox", "create", dir]);
    await this.openWhenDone(p, join(dir, "metarepo"), "Made the practice metarepo");
  }

  /** The platforms of the org pack (its profiles), for the manifest repos go into. */
  private platforms(root: string): string[] {
    for (const d of [
      join(root, "org-pack", "profiles"),
      join(root, ".atticus", "org-pack", "profiles"),
    ])
      if (existsSync(d))
        return readdirSync(d, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .sort();
    return [];
  }

  /** Repos into the manifest: found in a folder of clones or a Git host organisation, after a dry run. */
  async addRepos(root: string) {
    const how = await vscode.window.showQuickPick(
      [
        {
          label: "From a folder that holds the repos' clones",
          detail: "Atticus looks at each folder in it and says what kind of repo it is",
          id: "folder",
        },
        {
          label: "From a Git host organisation",
          detail: "The organisation or group the repos are in",
          id: "org",
        },
        {
          label: "Edit the manifest by hand",
          detail: "org-pack/profiles/<platform>/repos.manifest.yaml",
          id: "edit",
        },
      ],
      { title: "Atticus: add repos", ignoreFocusOut: true },
    );
    if (!how) return;
    const platforms = this.platforms(root);
    const platform =
      platforms.length === 1
        ? platforms[0]
        : await this.quick(
            "Which platform are they in?",
            platforms.map((x) => ({ label: x, value: x })),
            "The org pack has no platform yet: org-pack/profiles/<platform>/.",
          );
    if (!platform) return;
    if (how.id === "edit") {
      const rel = existsSync(join(root, "org-pack")) ? "org-pack" : join(".atticus", "org-pack");
      const file = join(root, rel, "profiles", platform, "repos.manifest.yaml");
      try {
        await vscode.window.showTextDocument(
          await vscode.workspace.openTextDocument(vscode.Uri.file(file)),
        );
      } catch {
        void vscode.window.showWarningMessage(
          `${file} isn't there yet. Add repos from a folder or a Git host organisation first; it is written then.`,
        );
      }
      return;
    }
    let target: string[];
    if (how.id === "folder") {
      const picked = await vscode.window.showOpenDialog({
        title: "The folder that holds the repos' clones",
        canSelectFolders: true,
        canSelectFiles: false,
      });
      if (!picked?.[0]) return;
      target = [picked[0].fsPath];
    } else {
      const org = await vscode.window.showInputBox({
        title: "The Git host organisation",
        prompt: "Its name as the Git host has it",
        ignoreFocusOut: true,
      });
      if (!org?.trim()) return;
      target = ["--org", org.trim()];
    }
    const argv = ["repos", "discover", ...target, "--platform", platform];
    const dry = await this.captured(root, [...argv, "--dry-run"]);
    const found = discoveredFrom(dry.lines.join("\n"));
    if (dry.code !== 0) return this.showPrinted(argv, dry);
    if (!found.repos.length) {
      const pick = await vscode.window.showWarningMessage(
        how.id === "folder"
          ? `No repo found in ${target[0]}: nothing was added. Pick the folder that holds the clones, each repo a folder in it.`
          : `No repo found in ${target[1]}: nothing was added. Check the organisation's name; the output says what the Git host answered.`,
        "Show the output",
      );
      if (pick) this.svc.log.show(true);
      return;
    }
    const ok = await vscode.window.showInformationMessage(
      `Add ${found.repos.length} repo${found.repos.length === 1 ? "" : "s"} to the ${platform} manifest?`,
      {
        modal: true,
        detail:
          found.repos
            .map((r) => `${r.id}: ${r.type}${r.evidence ? ` (${r.evidence})` : ""}`)
            .join("\n") +
          (found.questions
            ? `\n\n${found.questions} questions will need a person (the Questions section).`
            : ""),
      },
      "Add them",
    );
    if (ok !== "Add them") return;
    const p = await this.captured(root, argv);
    this.showPrinted(argv, p);
    this.d.refreshAll();
  }

  // ------------------------------------------------------------------ guided (ADR 0100)

  /** Run a command of the catalogue with what it needs given: nothing more is asked. */
  async runGiven(
    root: string,
    id: string,
    a: { args?: (string | undefined)[]; flags?: Record<string, string | true> },
  ): Promise<void> {
    const cat = await this.loadShown(root);
    const cmd = cat.commands.find((c) => c.id === id);
    if (!cmd)
      return void vscode.window.showWarningMessage(
        `This atticus has no command ${id}. It may be older than this extension: upgrade it, then try again.`,
      );
    await this.run(root, cmd, {
      args: a.args ?? [],
      flags: { ...requiredSwitches(cmd), ...(a.flags ?? {}) },
    });
  }

  /**
   * A printed command with a part to fill in (`atticus repos discover <folder>`): its guided
   * screen, else the command's own pickers with what it gives kept. False when it isn't a
   * command the catalogue has.
   */
  async fillIn(root: string, command: string): Promise<boolean> {
    switch (guidedFor(command)) {
      case "addRepos":
        await this.addRepos(root);
        return true;
      case "newChange":
        await this.newChange(root);
        return true;
      case "absorb":
        await this.absorb(root);
        return true;
      case "absorbAccept":
        await this.absorbAccept(root);
        return true;
      case "createMetarepo":
        await this.createMetarepo();
        return true;
      case "adoptRepo":
        await this.adoptRepo();
        return true;
    }
    const m = matchCommand(await this.load(root), command);
    if (!m) return false;
    await this.pickAndRun(root, m.command.id, presetFrom(m.command, m.rest));
    return true;
  }

  /** A command's --json output, with a progress note while it runs. */
  private async json<T>(
    root: string,
    argv: string[],
  ): Promise<{ ok: true; value: T; code: number } | { ok: false; printed: Printed }> {
    const r = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Atticus: ${runProgressTitle(argv)}…`,
      },
      (p) => {
        p.report({ message: `${commandText(argv)}` });
        return this.svc.cli(root)([...argv, "--root", root]);
      },
    );
    this.svc.log.appendLine(`--- ${commandText(argv)} (exit ${r.code})`);
    if (r.stderr.trim()) this.svc.log.appendLine(r.stderr.trimEnd());
    try {
      return { ok: true, value: JSON.parse(r.stdout) as T, code: r.code };
    } catch {
      const lines = [...r.stdout.trimEnd().split("\n"), ...r.stderr.trimEnd().split("\n")].filter(
        Boolean,
      );
      return { ok: false, printed: { code: r.code || 1, lines } };
    }
  }

  /**
   * Bring in another team's repo (atticus absorb): another metarepo, an OpenSpec, Spec Kit or
   * TypeSpec repo, or a repo of prompts, agents, skills and checklists. A dry run first; the
   * proposal only when the person says yes; then its summary, and accepting it.
   */
  async absorb(root: string) {
    const how = await vscode.window.showQuickPick(
      [
        {
          label: "A folder on this machine",
          detail:
            "Another metarepo, an OpenSpec, Spec Kit or TypeSpec repo, or a repo of prompts, agents, skills and checklists",
          id: "folder",
        },
        {
          label: "A Git URL",
          detail: "Cloned into the metarepo's local state to be read; nothing in it is run",
          id: "url",
        },
      ],
      { title: "Atticus: bring in from another repo", ignoreFocusOut: true },
    );
    if (!how) return;
    const source =
      how.id === "folder"
        ? (
            await vscode.window.showOpenDialog({
              title: "The repo to bring in",
              openLabel: "Bring this in",
              canSelectFolders: true,
              canSelectFiles: false,
            })
          )?.[0]?.fsPath
        : (
            await vscode.window.showInputBox({
              title: "Atticus: the Git URL",
              prompt: "For example https://git.example.com/payments/payments-meta.git",
              ignoreFocusOut: true,
            })
          )?.trim();
    if (!source) return;
    const id = (
      await vscode.window.showInputBox({
        title: "Atticus: its name in this metarepo",
        prompt: "Lowercase letters, digits and dashes. What it brings in is named after it.",
        value: defaultAbsorbId(source),
        validateInput: (v) =>
          /^[a-z0-9][a-z0-9-]*$/.test(v.trim())
            ? undefined
            : "Lowercase letters, digits and dashes",
        ignoreFocusOut: true,
      })
    )?.trim();
    if (!id) return;
    const mode = await vscode.window.showQuickPick(
      [
        {
          label: "Let Atticus choose for each item",
          description: "recommended",
          detail:
            "Prompts, agents, skills and checklists are copied; specs, schemas and another metarepo are followed",
          mode: undefined as string | undefined,
        },
        {
          label: "Copy everything it can translate",
          detail: "Own a copy: later changes on their side aren't followed",
          mode: "adopt",
        },
        {
          label: "Follow theirs; copy nothing",
          detail: "Read where it is; atticus absorb --refresh fetches it again",
          mode: "link",
        },
      ],
      { title: `Atticus: how to bring in ${id}`, ignoreFocusOut: true },
    );
    if (!mode) return;
    const argv = ["absorb", source, "--id", id, ...(mode.mode ? ["--mode", mode.mode] : [])];
    const dry = await this.json<AbsorbDry>(root, [...argv, "--dry-run", "--json"]);
    if (!dry.ok) return this.showPrinted(argv, dry.printed);
    const c = absorbConfirm(dry.value);
    const ok = await vscode.window.showInformationMessage(
      c.message,
      { modal: true, detail: c.detail },
      "Make the proposal",
    );
    if (ok !== "Make the proposal") return;
    const made = await this.json<{ proposal?: string }>(root, [...argv, "--json"]);
    if (!made.ok || !made.value.proposal)
      return this.showPrinted(argv, made.ok ? { code: made.code, lines: [] } : made.printed);
    this.d.refreshAll();
    // The summary as a page to read; its Markdown is a click away in the preview's title bar.
    const summary = vscode.Uri.file(join(root, made.value.proposal, "SUMMARY.md"));
    await vscode.commands.executeCommand("markdown.showPreview", summary);
    const pick = await vscode.window.showInformationMessage(
      `${id} is a proposal in ${made.value.proposal}/.`,
      {
        modal: true,
        detail:
          "Its summary is open. Read it, change any action you disagree with, then accept it into the metarepo.",
      },
      "Accept it",
    );
    if (pick) await this.absorbAccept(root, id);
  }

  /** The absorb proposals waiting in the metarepo, by id. */
  private absorbProposals(root: string): string[] {
    for (const d of [
      join(root, "proposals", "absorb"),
      join(root, ".atticus", "proposals", "absorb"),
    ])
      if (existsSync(d))
        return readdirSync(d, { withFileTypes: true })
          .filter((e) => e.isDirectory() && existsSync(join(d, e.name, "inventory.json")))
          .map((e) => e.name)
          .sort();
    return [];
  }

  /** Accept a reviewed absorb proposal: what it adopts copied in, its source followed. */
  async absorbAccept(root: string, given?: string) {
    const id =
      given ??
      (await this.quick(
        "Atticus: which proposal to accept?",
        this.absorbProposals(root).map((x) => ({ label: x, value: x })),
        "Nothing was brought in yet: Atticus: Bring in from another repo makes a proposal.",
      ));
    if (!id) return;
    const argv = ["absorb", "accept", id];
    const dry = await this.json<AcceptDry>(root, [...argv, "--dry-run", "--json"]);
    if (!dry.ok) return this.showPrinted(argv, dry.printed);
    const a = dry.value;
    if (!a.copied.length && !a.kept.length && a.entry === "already")
      return void vscode.window.showInformationMessage(
        `${id} is already in the metarepo: nothing left to copy.`,
      );
    const c = acceptConfirm(a);
    const pick = await vscode.window.showInformationMessage(
      c.message,
      { modal: true, detail: c.detail },
      "Accept",
      ...(a.kept.length ? ["Accept and overwrite the changed files"] : []),
    );
    if (!pick) return;
    const run = [...argv, ...(pick === "Accept" ? [] : ["--replace"])];
    const p = await this.captured(root, run);
    this.d.refreshAll();
    if (p.code !== 0) return this.showPrinted(run, p);
    const copied = run.includes("--replace") ? a.copied.length + a.kept.length : a.copied.length;
    const next = await vscode.window.showInformationMessage(
      `Accepted ${id}: ${copied ? `${copied} file${copied === 1 ? "" : "s"} copied into the metarepo` : "nothing to copy"}${a.linked ? `, ${a.linked} item${a.linked === 1 ? "" : "s"} followed through sources.yaml` : ""}. Commit it through a pull request: merging it is the approval.`,
      "Open Source Control",
    );
    if (next) await vscode.commands.executeCommand("workbench.view.scm");
  }

  /**
   * A repo's onboarding, one stage after another (ADR 0100): clone, scan settings, scan, check
   * the scan, spec, its questions. Each pick runs the stage and shows the list again, updated,
   * until the person closes it.
   */
  async onboardRepo(root: string, given?: string) {
    let repo = given;
    const readState = async () => {
      const api = await this.svc.api(root);
      const [o, specs, q] = await Promise.all([
        api.get<Api.OnboardingView>("/api/onboarding"),
        api.get<Api.SpecList>("/api/specs").catch((): Api.SpecList => ({ repos: [] })),
        readOpenQuestions(this.svc.cli(root), root),
      ]);
      return { o, specs, q };
    };
    if (!repo) {
      let none = false;
      repo = await this.quick(
        "Atticus: which repo to onboard?",
        async () => {
          const { o } = await readState();
          none = !o.repos.length;
          return o.repos.map((r) => ({
            label: r.id,
            description: r.lastScan ? "scanned" : r.cloned ? "not scanned" : "not cloned",
            value: r.id,
          }));
        },
        () => undefined,
        "Reading the repos…",
      );
      if (none) {
        // A dialog: the only way on is to add repos first.
        const add = await vscode.window.showInformationMessage(
          "No repos yet: add them first.",
          { modal: true, detail: "Atticus onboards the repos listed in a repos manifest." },
          "Add repos",
        );
        if (add) await this.addRepos(root);
        return;
      }
      if (!repo) return;
    }
    const name = repo;
    for (;;) {
      // The stages show at once, read while the list is open; it comes back after each one runs.
      const stage = await this.pickStage(name, async () => {
        const { o, specs, q } = await readState();
        const r = o.repos.find((x) => x.id === name);
        if (!r) throw new Error(`${name} isn't in a repos manifest.`);
        return onboardingStages(r, {
          flows: specs.repos.find((x) => x.repo === name)?.flows ?? 0,
          questions: q.ok ? q.value.filter((x) => x.repo === name).length : 0,
        });
      });
      if (!stage) return;
      if (stage.run.kind === "vscode")
        await vscode.commands.executeCommand(stage.run.command, ...stage.run.args);
      else await this.runGiven(root, stage.run.id, stage.run);
    }
  }

  private pickStage(repo: string, read: () => Promise<Stage[]>): Promise<Stage | undefined> {
    const ICON: Record<Stage["state"], string> = {
      done: "$(pass-filled)",
      next: "$(arrow-right)",
      todo: "$(circle-large-outline)",
      again: "$(refresh)",
      optional: "$(circle-small)",
    };
    const WORD: Record<Stage["state"], string> = {
      done: "done",
      next: "next",
      todo: "",
      again: "after every scan",
      optional: "only if needed",
    };
    return pickLoading<vscode.QuickPickItem & { stage: Stage }>(
      {
        title: `Atticus: onboard ${repo}`,
        reading: `Reading where ${repo} is…`,
        placeholder: "Pick a stage to run it; this list comes back when it's done. Esc to stop.",
        empty: `${repo} has no stages to show.`,
        matchOnDetail: true,
        log: this.svc.log,
        active: (i) => i.stage.state === "next",
      },
      async () =>
        (await read()).map((s) => ({
          label: `${ICON[s.state]} ${s.label}`,
          description: WORD[s.state],
          detail: s.detail,
          stage: s,
        })),
    ).then((p) => p?.stage);
  }

  /** Knowledge the catalog doesn't have from code: another repo, a wiki, files, or reading them. */
  async addKnowledge(root: string) {
    const pick = await vscode.window.showQuickPick(
      [
        {
          label: "$(cloud-download) Bring in from another repo",
          detail:
            "Another metarepo, an OpenSpec, Spec Kit or TypeSpec repo, or a repo of prompts, agents, skills and checklists",
          go: () => this.absorb(root),
        },
        {
          label: "$(repo) Add a wiki or docs repo…",
          detail:
            "An Azure DevOps or GitHub wiki, a docs repo or a folder of pages: saved into sources.yaml, then synced and read",
          go: () => vscode.commands.executeCommand("atticus.addWiki"),
        },
        {
          label: "$(search) Search the wikis for something new…",
          detail:
            "atticus knowledge find: a term or phrase; Copilot reads the pages it is on, then you keep what it found (a process, a request, a standard…)",
          go: () => vscode.commands.executeCommand("atticus.searchWikis"),
        },
        {
          label: "$(check-all) Keep what a search found…",
          detail:
            "atticus knowledge keep: a saved search's new items, kept as knowledge items you verified",
          go: () => vscode.commands.executeCommand("atticus.keepFound"),
        },
        {
          label: "$(pass) Check what no one has verified…",
          detail: "Each knowledge item a person hasn't checked: right, correct it, or wrong",
          go: () => vscode.commands.executeCommand("atticus.reviewUnverified"),
        },
        {
          label: "$(organization) Draft the org pack from the wikis…",
          detail:
            "atticus orgpack draft: the products and vendors the wikis name, as the profile's systems, to accept",
          go: () => vscode.commands.executeCommand("atticus.draftOrgPack"),
        },
        {
          label: "$(file-add) Add files",
          detail: "atticus intake add: diagrams, partner specs, exports, into inputs/",
          go: () => this.pickAndRun(root, "intake add"),
        },
        {
          label: "$(sync) Sync the sources",
          detail: "atticus sources sync: fetch every wiki source again",
          go: () => this.pickAndRun(root, "sources sync"),
        },
        {
          label: "$(sparkle) Read the sources with Copilot",
          detail: "atticus knowledge scan: patterns, standards, decisions, each citing its page",
          go: () => this.pickAndRun(root, "knowledge scan"),
        },
      ],
      { title: "Atticus: add knowledge", ignoreFocusOut: true },
    );
    if (pick) await (pick.go as () => Thenable<unknown>)();
  }

  /** The org pack's pack.yaml, to name its owner (the setup step org-pack-owner). */
  async openOrgPackOwner(root: string) {
    const file =
      [join(root, "org-pack", "pack.yaml"), join(root, ".atticus", "org-pack", "pack.yaml")].find(
        (f) => existsSync(f),
      ) ?? join(root, "org-pack", "pack.yaml");
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      const line = Math.max(
        0,
        doc
          .getText()
          .split(/\r?\n/)
          .findIndex((l) => /^owner:/.test(l)),
      );
      await vscode.window.showTextDocument(doc, {
        preview: false,
        selection: new vscode.Range(line, 0, line, doc.lineAt(line).text.length),
      });
      void vscode.window.showInformationMessage(
        "Set owner to the person who looks after the org pack (normally the platform lead), then commit it.",
      );
    } catch {
      void vscode.window.showWarningMessage(
        `${file} isn't there. Run atticus upgrade, or atticus init.`,
      );
    }
  }

  /** Accept the catalog as the baseline, after walking the map with the architect. */
  async acceptCatalog(root: string) {
    const pick = await vscode.window.showInformationMessage(
      "Accept the catalog as the baseline?",
      {
        modal: true,
        detail:
          "Changes are checked against the accepted catalog. Walk the ecosystem map with the architect first, then accept it and commit catalog/baseline.yaml through a pull request.",
      },
      "Open the map",
      "Accept it",
    );
    if (pick === "Open the map") await vscode.commands.executeCommand("atticus.showApp", "#/map");
    else if (pick === "Accept it") await this.pickAndRun(root, "baseline");
  }

  /** Doctor and the upgrade check, when the window opens: say what needs a look. */
  async checkHealth(root: string, quiet: boolean) {
    if (!quiet)
      return vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Atticus: checking this machine and the metarepo…",
        },
        () => this.checkHealthNow(root, false),
      );
    return this.checkHealthNow(root, true);
  }

  private async checkHealthNow(root: string, quiet: boolean) {
    const up = await this.svc.cli(root)(["upgrade", "--check", "--root", root]);
    // Not awaited: what is said mustn't hold the progress note, or the doctor's check, open.
    if (up.code === 1)
      void vscode.window
        .showWarningMessage(
          `Atticus: ${up.stdout.split("\n")[0] ?? "the metarepo needs an upgrade"}`,
          "Upgrade",
          "Show what",
        )
        .then((pick) => {
          if (pick === "Upgrade") void this.pickAndRun(root, "upgrade");
          else if (pick === "Show what") {
            this.svc.log.appendLine(up.stdout.trimEnd());
            this.svc.log.show(true);
          }
        });
    const doc = await this.svc.cli(root)(["doctor", "--json", "--root", root]);
    let problems: string[];
    try {
      problems = healthProblems(JSON.parse(doc.stdout) as Api.Doctor);
    } catch {
      problems = doc.code === 0 ? [] : [doc.stderr.trim() || "atticus doctor couldn't run"];
    }
    if (problems.length) {
      for (const l of problems) this.svc.log.appendLine(`doctor: ${l}`);
      void vscode.window
        .showWarningMessage(
          `Atticus: this machine has ${problems.length} thing${problems.length === 1 ? "" : "s"} to fix. ${problems[0]}`,
          "Show all",
        )
        .then((pick) => pick && this.svc.log.show(true));
    } else if (!quiet && up.code !== 1)
      void vscode.window.showInformationMessage(
        "Atticus: this machine and the metarepo are ready.",
      );
  }
}
