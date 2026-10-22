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
  optionsOf,
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
import { discoveredFrom, isMetarepoName } from "./start";

/**
 * Every Atticus command in VS Code (ADR 0096). The list comes from `atticus commands --json`, so
 * it is the command line's own; each argument is asked with a picker for its kind (a repo, a
 * change, a question…), then the options. AI steps run with Copilot's model; a command that
 * writes to a shared system runs as a dry run first and asks the person before it adds its
 * approve flag; a server gets a terminal; the rest runs and shows what it printed.
 */

export interface CommandUiDeps {
  runAi: (args: string[], spec?: string) => Promise<void>;
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

  /** Pick a command from every one, or from those given, by area. */
  async pick(
    root: string,
    only?: CatalogCommand[],
    title?: string,
  ): Promise<CatalogCommand | undefined> {
    const cat = await this.load(root);
    const list = only ? { ...cat, commands: only } : cat;
    const developer = vscode.workspace
      .getConfiguration("atticus")
      .get<boolean>("showDeveloperCommands", false);
    const items = pickList(list, { developer }).map((i) =>
      i.separator
        ? { label: i.label, kind: vscode.QuickPickItemKind.Separator }
        : {
            label: i.label,
            ...(i.description ? { description: i.description } : {}),
            ...(i.detail ? { detail: i.detail } : {}),
            id: i.id,
          },
    );
    const p = await vscode.window.showQuickPick(items, {
      title: title ?? "Run an Atticus command",
      placeHolder: "Type to find a command by its words or what it does",
      matchOnDescription: true,
      matchOnDetail: true,
      ignoreFocusOut: true,
    });
    const id = (p as { id?: string } | undefined)?.id;
    return id ? cat.commands.find((c) => c.id === id) : undefined;
  }

  // ------------------------------------------------------------------ pickers by kind

  private async quick(
    title: string,
    items: { label: string; description?: string; detail?: string; value: string }[],
    empty: string,
  ): Promise<string | undefined> {
    if (!items.length) {
      void vscode.window.showWarningMessage(empty);
      return undefined;
    }
    const p = await vscode.window.showQuickPick(items, {
      title,
      matchOnDescription: true,
      ignoreFocusOut: true,
    });
    return p?.value;
  }

  private async askArg(
    root: string,
    cmd: CatalogCommand,
    a: CatalogArg,
    before: (string | string[] | undefined)[],
  ): Promise<string | string[] | undefined | null> {
    const title = `atticus ${cmd.id}: ${a.name}${a.optional ? " (optional)" : ""}`;
    const api = () => this.svc.api(root);
    const enc = encodeURIComponent;
    const kind: ArgKind = a.kind;
    if (kind === "repo") {
      const [o, s] = await Promise.all([
        api().then((x) => x.get<Api.OnboardingView>("/api/onboarding")),
        api()
          .then((x) => x.get<Api.SpecList>("/api/specs"))
          .catch(() => ({ repos: [] })),
      ]);
      const ids = [...new Set([...o.repos.map((r) => r.id), ...s.repos.map((r) => r.repo)])];
      return this.quick(
        title,
        ids.map((id) => ({ label: id, value: id })),
        "No repos yet: add them to a repos.manifest.yaml in org-pack/profiles.",
      );
    }
    if (kind === "change") {
      const cs = await api().then((x) => x.get<Api.ChangeSummary[]>("/api/changes"));
      return this.quick(
        title,
        cs.map((c) => ({ label: c.title, description: `${c.id} · ${c.state}`, value: c.id })),
        "No changes yet: start one with Atticus: New change.",
      );
    }
    if (kind === "question") {
      const q = await readOpenQuestions(this.svc.cli(root), root);
      return this.quick(
        title,
        q.ok
          ? q.value.map((x) => ({
              label: x.question,
              description: x.repo,
              detail: x.id,
              value: x.id,
            }))
          : [],
        "No question is waiting for an answer.",
      );
    }
    if (kind === "finding") {
      const change = typeof before[0] === "string" ? before[0] : undefined;
      if (!change)
        return vscode.window.showInputBox({
          title,
          prompt: "The finding's id",
          ignoreFocusOut: true,
        });
      const fs = await api().then((x) =>
        x.get<Api.Finding[]>(`/api/findings?change=${enc(change)}`),
      );
      return this.quick(
        title,
        fs
          .filter((f) => (f.state ?? "open") === "open")
          .map((f) => ({
            label: f.summary,
            description: `${f.severity} · ${f.artifact}`,
            value: f.id,
          })),
        `${change} has no open findings.`,
      );
    }
    if (kind === "flow") {
      const x = await api();
      const { repos } = await x.get<Api.SpecList>("/api/specs");
      const items: { label: string; description: string; value: string }[] = [];
      for (const r of repos)
        for (const f of (await x.get<Api.SpecView>(`/api/specs/${enc(r.repo)}`)).flows)
          items.push({ label: f.name, description: `${f.id} · ${r.repo}`, value: f.id });
      return this.quick(title, items, "No repo has a spec yet: draft one with atticus spec draft.");
    }
    if (kind === "system") {
      const page = await api().then((x) => x.get<Api.RecordPage>("/api/catalog/System?limit=500"));
      return this.quick(
        title,
        page.items.map((r) => ({ label: r.name ?? r.id, description: r.id, value: r.id })),
        "The catalog has no systems yet: run atticus scan.",
      );
    }
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
        title: `Atticus: ${commandText(argv)}`,
        cancellable: true,
      },
      (_p, token) => this.svc.cli(root)([...argv, "--root", root], token),
    );
    const lines = [...r.stdout.trimEnd().split("\n"), ...r.stderr.trimEnd().split("\n")].filter(
      Boolean,
    );
    this.svc.log.appendLine(`--- ${commandText(argv)} (exit ${r.code})`);
    for (const l of lines) this.svc.log.appendLine(l);
    return { code: r.code, lines };
  }

  private async showPrinted(argv: string[], p: Printed) {
    const first = p.lines[0] ?? (p.code === 0 ? "Done." : `It exited ${p.code}.`);
    const show =
      p.code === 0 ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
    const pick = await show(`atticus ${argv.slice(0, 2).join(" ")}: ${first}`, "Show the output");
    if (pick) this.svc.log.show(true);
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
      if (p) await this.showPrinted(argv, p);
    } else {
      const p = await this.captured(root, argv);
      if (cmd.id === "change new" && p.code === 0) await this.afterNewChange(root, p);
      else await this.showPrinted(argv, p);
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
      const cat = await this.load(root);
      const cmd = id ? cat.commands.find((c) => c.id === id) : await this.pick(root, only, title);
      if (!cmd) {
        if (id) void vscode.window.showWarningMessage(`This atticus has no command ${id}.`);
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
    const cat = await this.load(root);
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
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(join(root, brief)));
    await vscode.window.showTextDocument(doc, { preview: false });
    const pick = await vscode.window.showInformationMessage(
      `${p.lines[0]} Write the brief, save it, then run the feature stage.`,
      "Run the feature stage",
    );
    if (pick) await this.d.runAi(["change", "feature", id]);
  }

  // ------------------------------------------------------------------ starting from nothing (ADR 0098)

  /** Run in a folder that isn't a metarepo yet (init, adopt, sandbox): no --root. */
  private async plain(cwd: string, argv: string[]): Promise<Printed> {
    const r = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Atticus: ${commandText(argv)}` },
      () => this.svc.cli(cwd)(argv),
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
    const pick = await vscode.window.showInformationMessage(
      `${what}: ${folder}. Open it in this window?`,
      "Open it",
    );
    if (pick)
      await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(folder), false);
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
    } else await this.showPrinted(["adopt"], p);
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
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(join(root, rel, "profiles", platform, "repos.manifest.yaml")),
      );
      await vscode.window.showTextDocument(doc);
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
    if (dry.code !== 0 || !found.repos.length) return this.showPrinted(argv, dry);
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
    await this.showPrinted(argv, p);
    this.d.refreshAll();
  }

  /** Doctor and the upgrade check, when the window opens: say what needs a look. */
  async checkHealth(root: string, quiet: boolean) {
    const up = await this.svc.cli(root)(["upgrade", "--check", "--root", root]);
    if (up.code === 1) {
      const pick = await vscode.window.showWarningMessage(
        `Atticus: ${up.stdout.split("\n")[0] ?? "the metarepo needs an upgrade"}`,
        "Upgrade",
        "Show what",
      );
      if (pick === "Upgrade") await this.pickAndRun(root, "upgrade");
      else if (pick === "Show what") {
        this.svc.log.appendLine(up.stdout.trimEnd());
        this.svc.log.show(true);
      }
    }
    const doc = await this.svc.cli(root)(["doctor", "--json", "--root", root]);
    let problems: string[];
    try {
      problems = healthProblems(JSON.parse(doc.stdout) as Api.Doctor);
    } catch {
      problems = doc.code === 0 ? [] : [doc.stderr.trim() || "atticus doctor couldn't run"];
    }
    if (problems.length) {
      for (const l of problems) this.svc.log.appendLine(`doctor: ${l}`);
      const pick = await vscode.window.showWarningMessage(
        `Atticus: this machine has ${problems.length} thing${problems.length === 1 ? "" : "s"} to fix. ${problems[0]}`,
        "Show all",
      );
      if (pick) this.svc.log.show(true);
    } else if (!quiet)
      void vscode.window.showInformationMessage(
        "Atticus: this machine and the metarepo are ready.",
      );
  }
}
