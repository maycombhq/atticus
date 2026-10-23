import { existsSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import type * as Api from "./api-types";
import type { CommandUi, CommandUiDeps, Printed } from "./command-ui";
import {
  candidatePick,
  correctArgv,
  correctChoices,
  defaultSourceId,
  itemTitle,
  keepArgv,
  keepKinds,
  KIND_WORDS,
  listFromText,
  needArgv,
  needDescription,
  newestFind,
  snapshotOpen,
  SOURCE_KINDS,
  sourcesAddArgv,
  urlsOf,
  type FindCandidate,
  type FindSummary,
  type KnowledgeEntry,
  type NeedEntry,
  type Url,
  type WikiAnswers,
  type WikiType,
} from "./knowledge-data";
import { readFind, readFinds, readKnowledgeList } from "./knowledge-read";
import { parseJson } from "./cli";
import { findOutcome, runProgressTitle } from "./feedback";
import { pickLoading, pickManyLoading } from "./pick";
import type { Service } from "./service";
import { isUnverified } from "./waiting-data";

/**
 * Knowledge managed in the metarepo, from the editor (ADR 0101): add a wiki or docs repo, sync
 * and read a source, review an item (verify, correct, reject), search the wikis for a phrase and
 * keep what Copilot finds, and a change's needs (find them, then mark each done or not needed).
 * Every step runs the command line, which does every check; AI steps run with Copilot's model.
 * Nothing here writes to a shared system: reviews, sources and needs are files in the metarepo,
 * committed through a pull request.
 */

const ID = /^[a-z0-9][a-z0-9-]*$/;

export class KnowledgeUi {
  constructor(
    private readonly svc: Service,
    private readonly c: CommandUi,
    private readonly d: CommandUiDeps,
  ) {}

  private rel(root: string) {
    return this.svc.paths(root).knowledgeRel ?? "knowledge";
  }

  /** Run a local command, say what it printed, and read the sections again. */
  private async run(root: string, argv: string[]): Promise<Printed> {
    const p = await this.c.captured(root, argv);
    this.c.showPrinted(argv, p);
    this.d.refreshAll();
    return p;
  }

  // ------------------------------------------------------------------ sources

  /** A wiki or docs repo into sources.yaml, then synced and read with Copilot if the person wants. */
  async addWiki(root: string) {
    const kind = await vscode.window.showQuickPick(
      [
        {
          label: "$(repo) A git repo",
          detail:
            "An Azure DevOps or GitHub wiki (both are git repositories), or a docs repo. Read at a recorded commit.",
          type: "git" as WikiType,
        },
        {
          label: "$(folder) A folder on this machine",
          detail: "A folder of Markdown pages",
          type: "markdown-folder" as WikiType,
        },
        {
          label: "$(globe) Confluence or SharePoint",
          detail:
            "These need their adapter wired to the command line: Atticus prints the entry for sources.yaml, and doesn't save it yet",
          type: "confluence" as WikiType,
        },
      ],
      { title: "Atticus: add a wiki or docs repo", ignoreFocusOut: true },
    );
    if (!kind) return;
    let type = kind.type;
    if (type === "confluence") {
      const which = await vscode.window.showQuickPick(
        [
          { label: "Confluence", type: "confluence" as WikiType },
          { label: "SharePoint", type: "sharepoint" as WikiType },
        ],
        { title: "Which one?", ignoreFocusOut: true },
      );
      if (!which) return;
      type = which.type;
    }
    const location = await this.askLocation(root, type);
    if (!location) return;
    const id = (
      await vscode.window.showInputBox({
        title: "Atticus: its name in sources.yaml",
        prompt: "Lowercase letters, digits and dashes. Its items and snapshots are named after it.",
        value: defaultSourceId(location),
        validateInput: (v) =>
          ID.test(v.trim()) ? undefined : "Lowercase letters, digits and dashes",
        ignoreFocusOut: true,
      })
    )?.trim();
    if (!id) return;
    const a: WikiAnswers = {
      type,
      location,
      id,
      kinds: [],
      save: type !== "confluence" && type !== "sharepoint",
    };
    if (type === "git") {
      const path = await vscode.window.showInputBox({
        title: "Atticus: the folder its pages are in (optional)",
        prompt:
          "A folder inside the repository, for example docs. Leave it empty for the whole repository.",
        ignoreFocusOut: true,
      });
      if (path === undefined) return;
      const ref = await vscode.window.showInputBox({
        title: "Atticus: the branch or tag to read (optional)",
        prompt: "Leave it empty for the repository's default branch.",
        ignoreFocusOut: true,
      });
      if (ref === undefined) return;
      const how = await vscode.window.showQuickPick(
        [
          {
            label: "Clone it",
            description: "recommended",
            detail:
              "A local copy in the metarepo's local state (git-ignored), fetched again on every sync",
            submodule: false,
          },
          {
            label: "A submodule of the metarepo",
            detail:
              "Pinned at a commit in the metarepo's own history: a sync that moves it is committed and reviewed in a pull request",
            submodule: true,
          },
        ],
        { title: "Atticus: how to keep it", ignoreFocusOut: true },
      );
      if (!how) return;
      if (path.trim()) a.path = path.trim().replace(/\\/g, "/");
      if (ref.trim()) a.ref = ref.trim();
      a.submodule = how.submodule;
    }
    const kinds = await this.askKinds(`What ${id} is about`);
    if (kinds === undefined) return;
    a.kinds = kinds;
    const owner = await vscode.window.showInputBox({
      title: `Atticus: who owns ${id} (optional)`,
      prompt:
        "The team that keeps it, for example team-platform. Leave it empty if you don't know.",
      ignoreFocusOut: true,
    });
    if (owner === undefined) return;
    if (owner.trim()) a.owner = owner.trim();
    const argv = sourcesAddArgv(a);
    const p = await this.c.captured(root, argv);
    this.d.refreshAll();
    if (p.code !== 0) return this.c.showPrinted(argv, p);
    if (!a.save) {
      const pick = await vscode.window.showInformationMessage(
        `${type === "confluence" ? "Confluence" : "SharePoint"} needs its adapter wired to the command line before Atticus can read it. This is its entry for sources.yaml:`,
        { modal: true, detail: p.lines.join("\n") },
        "Show the commands run",
      );
      if (pick) this.svc.log.show(true);
      return;
    }
    // A dialog, not a notification: a notification slips into the bell before it is seen.
    const next = await vscode.window.showInformationMessage(
      `Added ${id} to sources.yaml.`,
      {
        modal: true,
        detail:
          "Commit sources.yaml through a pull request. Copy its pages now (a snapshot of what it holds) and read them into knowledge items with Copilot?",
      },
      "Sync and read it now",
      "Open sources.yaml",
    );
    if (next === "Sync and read it now") await this.syncAndRead(root, id);
    else if (next === "Open sources.yaml")
      await vscode.commands.executeCommand("atticus.openItem", {
        kind: "file",
        path:
          [
            join(root, "org-pack", "sources.yaml"),
            join(root, ".atticus", "org-pack", "sources.yaml"),
          ].find((f) => existsSync(f)) ?? join(root, "org-pack", "sources.yaml"),
      });
  }

  private async askLocation(root: string, type: WikiType): Promise<string | undefined> {
    if (type === "markdown-folder") {
      const picked = await vscode.window.showOpenDialog({
        title: "The folder of pages",
        openLabel: "Read this folder",
        canSelectFolders: true,
        canSelectFiles: false,
        defaultUri: vscode.Uri.file(root),
      });
      return picked?.[0]?.fsPath;
    }
    if (type === "git") {
      const where = await vscode.window.showQuickPick(
        [
          {
            label: "Its URL",
            detail: "For example https://dev.azure.example/forge/_git/forge.wiki",
            url: true,
          },
          {
            label: "A clone on this machine",
            detail: "A folder that is a git repository",
            url: false,
          },
        ],
        { title: "Atticus: where the repository is", ignoreFocusOut: true },
      );
      if (!where) return undefined;
      if (!where.url) {
        const picked = await vscode.window.showOpenDialog({
          title: "The repository's folder",
          openLabel: "Read this repository",
          canSelectFolders: true,
          canSelectFiles: false,
        });
        return picked?.[0]?.fsPath;
      }
      return (
        await vscode.window.showInputBox({
          title: "Atticus: the repository's URL",
          prompt: "The URL you would clone it with (https or ssh)",
          validateInput: (v) =>
            /^([a-z][a-z0-9+.-]*:\/\/\S+|[\w.-]+@[\w.-]+:\S+)$/i.test(v.trim())
              ? undefined
              : "A URL such as https://git.example.com/forge/platform-docs.git",
          ignoreFocusOut: true,
        })
      )?.trim();
    }
    return (
      await vscode.window.showInputBox({
        title: `Atticus: the ${type === "confluence" ? "Confluence space" : "SharePoint site"}'s address`,
        prompt: "An https:// address",
        validateInput: (v) =>
          /^https:\/\/\S+$/i.test(v.trim()) ? undefined : "An https:// address",
        ignoreFocusOut: true,
      })
    )?.trim();
  }

  /** The kinds of knowledge a source holds: the suggested ones, and the person's own. */
  private async askKinds(title: string): Promise<string[] | undefined> {
    const own = {
      label: "$(edit) Something else…",
      detail: "Your own words, as lowercase-with-dashes",
      id: "",
    };
    const picks = await vscode.window.showQuickPick(
      [...SOURCE_KINDS.map((k) => ({ label: k.label, description: k.id, id: k.id })), own],
      {
        title: `Atticus: ${title} (pick any; Enter for none)`,
        canPickMany: true,
        ignoreFocusOut: true,
      },
    );
    if (!picks) return undefined;
    const kinds = picks.filter((p) => p.id).map((p) => p.id);
    if (picks.some((p) => !p.id)) {
      const more = await vscode.window.showInputBox({
        title: "Atticus: your own kinds",
        prompt: "Split by commas, for example payments-runbook, data-standard",
        validateInput: (v) =>
          v
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean)
            .every((x) => ID.test(x))
            ? undefined
            : "Lowercase letters, digits and dashes, split by commas",
        ignoreFocusOut: true,
      });
      if (more === undefined) return undefined;
      kinds.push(
        ...more
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
      );
    }
    return [...new Set(kinds)];
  }

  /** Copy a source's pages, then read them with Copilot. */
  async syncAndRead(root: string, id: string) {
    const p = await this.run(root, ["sources", "sync", "--source", id]);
    // Exit 1 is a page that conflicts with code or a source it couldn't read: the snapshot is
    // still written when pages were read, so the scan can go on.
    if (p.code > 1) return;
    await this.d.runAi(["knowledge", "scan", "--source", id]);
    this.d.refreshAll();
  }

  async syncSource(root: string, id: string) {
    await this.run(root, ["sources", "sync", "--source", id]);
  }

  async readSource(root: string, id: string) {
    await this.d.runAi(["knowledge", "scan", "--source", id]);
    this.d.refreshAll();
  }

  async tagSource(root: string, id: string) {
    const kinds = await this.askKinds(`what ${id} is about`);
    if (kinds === undefined) return;
    const framework = await vscode.window.showInputBox({
      title: `Atticus: the frameworks ${id} is about (optional)`,
      prompt: "Split by commas, for example forge-ui, spring. Leave it empty for none.",
      ignoreFocusOut: true,
    });
    if (framework === undefined) return;
    const owner = await vscode.window.showInputBox({
      title: `Atticus: who owns ${id} (optional)`,
      prompt: "The team that keeps it. Leave it empty to keep it as it is.",
      ignoreFocusOut: true,
    });
    if (owner === undefined) return;
    const argv = [
      "sources",
      "tag",
      id,
      ...(kinds.length ? ["--kind", kinds.join(",")] : []),
      ...(framework.trim() ? ["--framework", framework.replace(/\s+/g, "")] : []),
      ...(owner.trim() ? ["--owner", owner.trim()] : []),
    ];
    if (argv.length === 3)
      return void vscode.window.showInformationMessage(
        "Nothing to tag: no kind, framework or owner given.",
      );
    await this.run(root, argv);
  }

  // ------------------------------------------------------------------ reviewing an item

  async verify(root: string, k: KnowledgeEntry) {
    const note = await vscode.window.showInputBox({
      title: `Atticus: verify “${itemTitle(k)}”`,
      prompt: "It is right as read. A note for the next person (optional).",
      ignoreFocusOut: true,
    });
    if (note === undefined) return;
    await this.run(root, [
      "knowledge",
      "verify",
      k.id,
      ...(note.trim() ? ["--note", note.trim()] : []),
    ]);
  }

  async reject(root: string, k: KnowledgeEntry) {
    const note = await vscode.window.showInputBox({
      title: `Atticus: reject “${itemTitle(k)}”`,
      prompt: "Why is it wrong? Plans and answers leave it out; the reason is kept with it.",
      validateInput: (v) => (v.trim() ? undefined : "Say why: the next person reads it"),
      ignoreFocusOut: true,
    });
    if (!note?.trim()) return;
    await this.run(root, ["knowledge", "reject", k.id, "--note", note.trim()]);
  }

  /** Correct one field or more: each picked with its value now, edited, then saved together. */
  async correct(root: string, k: KnowledgeEntry) {
    const choices = correctChoices(k);
    if (!choices.length)
      return void vscode.window.showWarningMessage(
        `A ${k.kind} has no fields a person can correct. Verify or reject it instead.`,
      );
    const sets: { field: string; value: string | string[]; label: string }[] = [];
    for (;;) {
      const save = {
        label: `$(check) Save ${sets.length === 1 ? "the correction" : `the ${sets.length} corrections`}`,
        detail: sets
          .map((s) => `${s.label}: ${Array.isArray(s.value) ? s.value.join(" | ") : s.value}`)
          .join("; "),
        field: "",
      };
      const pick = await vscode.window.showQuickPick(
        [
          ...(sets.length ? [save] : []),
          ...choices.map((c) => {
            const set = sets.find((s) => s.field === c.field);
            const now = set
              ? Array.isArray(set.value)
                ? set.value.join(" | ")
                : set.value
              : c.current;
            return {
              label: c.label,
              description: now ? (now.length > 80 ? `${now.slice(0, 77)}…` : now) : "(empty)",
              ...(set ? { detail: "corrected" } : c.list ? { detail: "a list" } : {}),
              field: c.field,
            };
          }),
        ],
        {
          title: `Atticus: correct “${itemTitle(k)}”`,
          placeHolder: sets.length ? "Correct another field, or save" : "Which field is wrong?",
          ignoreFocusOut: true,
        },
      );
      if (!pick) return;
      if (!pick.field) break;
      const c = choices.find((x) => x.field === pick.field)!;
      const before = sets.find((s) => s.field === c.field);
      const value = await vscode.window.showInputBox({
        title: `Atticus: ${c.label}`,
        prompt: c.list
          ? "One value after another, split by | (for example: topic name | partitions | owner)"
          : "What it should say",
        value: before
          ? Array.isArray(before.value)
            ? before.value.join(" | ")
            : before.value
          : c.current,
        ignoreFocusOut: true,
      });
      if (value === undefined) continue;
      const v = c.list ? listFromText(value) : value.trim();
      const same = c.list
        ? (v as string[]).join("|") === listFromText(c.current).join("|")
        : v === c.current;
      const rest = sets.filter((s) => s.field !== c.field);
      sets.splice(
        0,
        sets.length,
        ...rest,
        ...(same ? [] : [{ field: c.field, value: v, label: c.label }]),
      );
    }
    if (!sets.length) return;
    const note = await vscode.window.showInputBox({
      title: `Atticus: correct “${itemTitle(k)}”`,
      prompt: "Why, or where the right value comes from (optional)",
      ignoreFocusOut: true,
    });
    if (note === undefined) return;
    await this.run(root, correctArgv(k.id, sets, note));
  }

  /** A page's links (request forms, catalogue items), opened in the browser. */
  async openLinks(urls: Url[], what: string) {
    if (!urls.length) return void vscode.window.showInformationMessage(`${what} has no links.`);
    const u =
      urls.length === 1
        ? urls[0]
        : (
            await vscode.window.showQuickPick(
              urls.map((x) => ({ label: x.label ?? x.url, detail: x.url, x })),
              { title: `Atticus: ${what}'s links`, ignoreFocusOut: true },
            )
          )?.x;
    if (u) await vscode.env.openExternal(vscode.Uri.parse(u.url));
  }

  /** A question about the item, answered from the knowledge items only. */
  async ask(root: string, k: KnowledgeEntry) {
    const q = await vscode.window.showInputBox({
      title: "Atticus: ask the knowledge",
      prompt: "A plain question; the answer cites the items it comes from",
      value: `What does “${itemTitle(k)}” say about `,
      ignoreFocusOut: true,
    });
    if (!q?.trim()) return;
    // An AI step (ADR 0083): Copilot answers from the items only, and the command line checks it.
    await this.c.askKnowledge(root, q.trim());
  }

  // ------------------------------------------------------------------ searching the wikis

  /** Search every snapshot page for a phrase; Copilot reads the matching pages; keep what is right. */
  async search(root: string) {
    const phrase = (
      await vscode.window.showInputBox({
        title: "Atticus: search the wikis",
        prompt:
          "A term or phrase, for example Kafka topic or SSO intake. Copilot reads every page it is on for what isn't a knowledge item yet.",
        validateInput: (v) => (v.trim() ? undefined : "A term or phrase"),
        ignoreFocusOut: true,
      })
    )?.trim();
    if (!phrase) return;
    const o = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Atticus: reading the wiki sources…",
      },
      async () =>
        (await this.svc.api(root))
          .get<Api.OnboardingView>("/api/onboarding")
          .catch(() => undefined),
    );
    const wikis = o?.sources?.wikis ?? [];
    if (o && !wikis.length) {
      // A dialog: nothing can be searched until a wiki is added and synced.
      const add = await vscode.window.showInformationMessage(
        "No wiki to search yet.",
        {
          modal: true,
          detail:
            "Add a wiki or docs repo to sources.yaml and sync it: the search reads the pages copied then.",
        },
        "Add a wiki or docs repo…",
      );
      if (add) await this.addWiki(root);
      return;
    }
    let source: string | undefined;
    if (wikis.length > 1) {
      const pick = await vscode.window.showQuickPick(
        [
          { label: "Every source", id: "" },
          ...wikis.map((w) => ({
            label: w.id,
            description: `${w.type} · ${w.location}`,
            id: w.id,
          })),
        ],
        { title: `Atticus: where to search for “${phrase}”`, ignoreFocusOut: true },
      );
      if (!pick) return;
      source = pick.id || undefined;
    }
    // Quiet: this says how it ended, in its own words, instead of "the step is done".
    const end = await this.d.runAi(
      ["knowledge", "find", phrase, ...(source ? ["--source", source] : [])],
      undefined,
      { quiet: true },
    );
    this.d.refreshAll();
    if (end?.state !== "done") return;
    const out = findOutcome(end.messages);
    if (out.kind === "nothing") {
      // A dialog: the person asked, and the answer is the end of it.
      void vscode.window.showInformationMessage(out.message, {
        modal: true,
        detail:
          "The search reads the pages copied at the last sync. Try other words, or sync the wikis again (Sync the knowledge sources).",
      });
      return;
    }
    // The file the step wrote, as it printed it; else the newest search of the phrase.
    const slug =
      out.kind === "saved"
        ? out.slug
        : newestFind(await readFinds(this.svc.cli(root), root), phrase)?.slug;
    if (!slug) {
      const pick = await vscode.window.showWarningMessage(
        "The search ran, but Atticus couldn't find its saved file. The Searches list in the Knowledge section has it once it is there.",
        "Show the output",
      );
      if (pick) this.svc.log.show(true);
      return;
    }
    await this.keepFound(root, slug);
  }

  /** Keep one candidate of a saved search: a row's click or its Keep button. */
  async keepCandidate(root: string, slug: string, id: string) {
    const c = this.findOf(root, await readFinds(this.svc.cli(root), root), slug)?.candidates.find(
      (x) => x.id === id,
    );
    if (!c)
      return void vscode.window.showWarningMessage(
        `${id} isn't in the search ${slug} any more. Search the wikis again.`,
      );
    if (c.kept || c.known)
      return void vscode.window.showInformationMessage(
        c.kept
          ? `“${c.title}” was kept already, by ${c.kept.by}.`
          : `“${c.title}” is a knowledge item already: ${c.known}.`,
      );
    const as = await this.askKind(c);
    if (!as) return;
    await this.keepAll(root, slug, [{ c, as }]);
  }

  /** A saved search's candidates: as `knowledge finds --json` lists them, else its file. */
  private findOf(root: string, finds: FindSummary[], slug: string) {
    const listed = finds.find((x) => x.slug === slug);
    return listed?.list
      ? {
          phrase: listed.phrase,
          candidates: listed.list,
          pages: [...new Set(listed.list.map((c) => c.page).filter(Boolean))],
        }
      : readFind(root, this.rel(root), slug);
  }

  /** Keep each, say what was kept and where it shows, and show the Knowledge section. */
  private async keepAll(root: string, slug: string, picks: { c: FindCandidate; as: string }[]) {
    const kept: string[] = [];
    const failed: string[] = [];
    for (const { c, as } of picks) {
      const p = await this.c.captured(root, keepArgv(c, slug, as));
      (p.code === 0 ? kept : failed).push(as === c.kind ? c.title : `${c.title} (as ${as})`);
    }
    this.d.refreshAll();
    if (kept.length) void vscode.commands.executeCommand("atticus.knowledge.focus");
    if (failed.length) {
      const pick = await vscode.window.showWarningMessage(
        `Kept ${kept.length}; ${failed.length} couldn't be kept: ${failed.join(", ")}.`,
        "Show the output",
      );
      if (pick) this.svc.log.show(true);
    } else if (kept.length)
      void vscode.window.showInformationMessage(
        `Kept ${kept.join(", ")}: knowledge items with a green tick, verified by you, under Items in the Knowledge section. Commit ${this.rel(root)}/ through a pull request.`,
      );
  }

  /** What a saved search found: pick the candidates to keep, and what to keep each as. */
  async keepFound(root: string, given?: string) {
    let slug = given;
    let finds: FindSummary[] = [];
    if (!slug) {
      const pick = await pickLoading(
        {
          title: "Atticus: which search of the wikis?",
          reading: "Reading the searches…",
          empty: async () => {
            const go = await vscode.window.showInformationMessage(
              "No search of the wikis yet.",
              { modal: true, detail: "Search the wikis for a term or phrase first." },
              "Search the wikis…",
            );
            if (go) await this.search(root);
          },
          log: this.svc.log,
        },
        async () => {
          finds = await readFinds(this.svc.cli(root), root);
          return [...finds]
            .sort((a, b) => b.at.localeCompare(a.at))
            .map((f) => ({
              label: `“${f.phrase}”`,
              description: `${f.candidates} found · ${f.kept} kept · ${f.at.slice(0, 10)}`,
              slug: f.slug,
            }));
        },
      );
      if (!pick) return;
      slug = pick.slug;
    } else
      finds = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "Atticus: reading what it found…" },
        () => readFinds(this.svc.cli(root), root),
      );
    const f = this.findOf(root, finds, slug);
    if (!f) {
      const pick = await vscode.window.showWarningMessage(
        `Couldn't read the search ${slug} (${this.rel(root)}/finds/${slug}.yaml).`,
        "Show the output",
      );
      if (pick) this.svc.log.show(true);
      return;
    }
    const fresh = f.candidates.filter((c) => !c.known && !c.kept);
    if (!fresh.length) {
      void vscode.window.showInformationMessage(
        f.candidates.length
          ? `“${f.phrase}”: everything found is a knowledge item already (${f.candidates.length}). Open the search under Searches in the Knowledge section to see them.`
          : `“${f.phrase}”: nothing on the pages that isn't a knowledge item already.`,
      );
      return;
    }
    // New ones first, picked to start with; then those already kept or known, for reference.
    const sep = (label: string) => ({ label, kind: vscode.QuickPickItemKind.Separator });
    const others = f.candidates.filter((c) => c.known || c.kept);
    const items = [
      sep(`New (${fresh.length})`),
      ...fresh.map((c) => ({ ...candidatePick(c), c })),
      ...(others.length ? [sep(`Already known or kept (${others.length})`)] : []),
      ...others.map((c) => ({ ...candidatePick(c), c })),
    ] as (vscode.QuickPickItem & { c?: FindCandidate })[];
    const picked = (
      await pickManyLoading(
        {
          title: `Atticus: “${f.phrase}”: ${fresh.length} new, ${others.length} already known, on ${f.pages.length} page${f.pages.length === 1 ? "" : "s"}. Pick what to keep.`,
          reading: "Reading what it found…",
          placeholder: "Each quote was checked on its page. What you keep is verified by you.",
          empty: "Nothing to keep.",
          matchOnDetail: true,
        },
        () => items,
      )
    )?.flatMap((p) => (p.c && !p.c.known && !p.c.kept ? [{ c: p.c }] : []));
    if (!picked?.length) return;
    // One: ask its kind. More: keep each as found, unless the person wants to choose.
    let choose = true;
    if (picked.length > 1) {
      const how = await vscode.window.showQuickPick(
        [
          { label: "Keep each as the kind found", description: "recommended", choose: false },
          { label: "Choose the kind for each", choose: true },
        ],
        { title: `Atticus: keep ${picked.length}`, ignoreFocusOut: true },
      );
      if (!how) return;
      choose = how.choose;
    }
    const keep: { c: FindCandidate; as: string }[] = [];
    for (const { c } of picked) {
      const as = choose ? await this.askKind(c) : c.kind;
      if (!as) return;
      keep.push({ c, as });
    }
    await this.keepAll(root, slug, keep);
  }

  /** What to keep a found item as: only the kinds its record can be (ADR 0101), in plain words. */
  private async askKind(c: FindCandidate): Promise<string | undefined> {
    const kinds = keepKinds(c.kind);
    if (kinds.length === 1) return c.kind;
    const pick = await vscode.window.showQuickPick(
      kinds.map((k) => ({
        label: k,
        description: `${KIND_WORDS[k] ?? ""}${k === c.kind ? " · as found" : ""}`,
      })),
      { title: `Atticus: keep “${c.title}” as`, ignoreFocusOut: true },
    );
    return pick?.label;
  }

  // ------------------------------------------------------------------ a change's needs

  async findNeeds(root: string, change: string) {
    await this.d.runAi(["change", "needs", change]);
    this.d.refreshAll();
  }

  async markNeed(root: string, n: NeedEntry, action: "done" | "skip" | "reopen") {
    let note: string | undefined;
    if (action === "done") {
      note = await vscode.window.showInputBox({
        title: `Atticus: “${n.title}” is done`,
        prompt: `A note, for example the request's number (${n.catalogueItem ?? "a CTASK"}). Optional.`,
        ignoreFocusOut: true,
      });
      if (note === undefined) return;
    }
    if (action === "skip") {
      note = await vscode.window.showInputBox({
        title: `Atticus: “${n.title}” isn't needed`,
        prompt: "Why not? It is kept with the change, for the reviewer.",
        validateInput: (v) => (v.trim() ? undefined : "Say why"),
        ignoreFocusOut: true,
      });
      if (!note?.trim()) return;
    }
    await this.run(root, needArgv(action, n, note));
  }

  /** The page the need's knowledge item was read from, at its quote. */
  async openNeedPage(root: string, n: NeedEntry) {
    const { items } = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Atticus: finding the page it was read from…",
      },
      () => readKnowledgeList(this.svc.cli(root), root),
    );
    const k = items.find((i) => i.id === n.item);
    if (!k)
      return void vscode.window.showWarningMessage(
        `${n.item} isn't a knowledge item any more${n.page ? ` (it was read on ${n.page})` : ""}. Find the change's needs again.`,
      );
    await vscode.commands.executeCommand("atticus.openItem", snapshotOpen(k, this.svc.paths(root)));
  }

  /** A change's open needs, one after another: raise each, then mark it. */
  async raiseNeeds(root: string, change?: string) {
    for (;;) {
      // The list shows at once and is read while open; it comes back after each one is marked.
      const pick = await pickLoading(
        {
          title: `Atticus: ${change ? `${change}'s` : "the"} open needs. Raise each, then mark it.`,
          reading: "Reading the open needs…",
          empty: change ? `${change} has no open needs.` : "No change has an open need.",
          log: this.svc.log,
        },
        async () => {
          const r = await this.svc.cli(root)([
            "needs",
            ...(change ? ["--change", change] : []),
            "--json",
            "--root",
            root,
          ]);
          const all = parseJson<NeedEntry[]>(r.stdout);
          if (!Array.isArray(all))
            throw new Error(
              (r.stderr || r.stdout).trim().split("\n")[0] || `atticus needs exited ${r.code}`,
            );
          return all
            .filter((n) => n.status === "open")
            .map((n) => ({
              ...n,
              inputs: n.inputs ?? [],
              steps: n.steps ?? [],
              rules: n.rules ?? [],
            }))
            .map((n) => ({
              label: n.title,
              description: `${change ? "" : `${n.change} · `}${needDescription(n)}`,
              detail: n.why,
              n,
            }));
        },
      );
      if (!pick) return;
      const n = pick.n;
      const urls = urlsOf(n);
      const act = await vscode.window.showQuickPick(
        [
          ...urls.map((u) => ({
            label: `$(link-external) Open ${u.label ?? u.url}`,
            id: "url",
            u,
          })),
          {
            label: "$(check) It's raised or done…",
            detail: "Note the request's number if it has one",
            id: "done",
          },
          {
            label: "$(circle-slash) It isn't needed…",
            detail: "Say why: it is kept with the change",
            id: "skip",
          },
          { label: "$(book) Open the page it was read from", id: "page" },
        ],
        {
          title: `Atticus: ${n.title}`,
          placeHolder: n.steps.length ? `How: ${n.steps.join("; ")}` : n.why,
          ignoreFocusOut: true,
        },
      );
      if (!act) continue;
      if (act.id === "url" && "u" in act)
        await vscode.env.openExternal(vscode.Uri.parse(act.u.url));
      else if (act.id === "done" || act.id === "skip") await this.markNeed(root, n, act.id);
      else if (act.id === "page") return this.openNeedPage(root, n);
    }
  }

  // ------------------------------------------------------------------ the org pack, from the wikis

  /**
   * The profile's systems drafted from the knowledge (ADR 0101): every product and vendor the
   * wikis name that the org pack lacks, with its aliases and owner; the person picks what to
   * accept (verified ones picked to start with), and it goes into profile.yaml.
   */
  async draftOrgPack(root: string) {
    const r = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Atticus: ${runProgressTitle(["orgpack", "draft"])}…`,
      },
      () => this.svc.cli(root)(["orgpack", "draft", "--json", "--root", root]),
    );
    this.svc.log.appendLine(`--- atticus orgpack draft --json (exit ${r.code})`);
    if (r.stderr.trim()) this.svc.log.appendLine(r.stderr.trimEnd());
    const d = parseJson<{
      platform: string;
      file: string;
      proposals: {
        from: string;
        action: "add" | "update";
        system: { id: string; name: string; boundary: string; owner?: string; aliases: string[] };
        adds?: { aliases?: string[]; owner?: string };
        verified: boolean;
        verifiedBy?: string;
        quote?: string;
        notes: string[];
      }[];
    }>(r.stdout);
    if (!d) {
      const pick = await vscode.window.showWarningMessage(
        `Atticus couldn't draft the org pack: ${(r.stderr || r.stdout).trim().split("\n")[0] || `exit ${r.code}`}`,
        "Show the output",
      );
      if (pick) this.svc.log.show(true);
      return;
    }
    if (!d.proposals.length)
      return void vscode.window.showInformationMessage(
        `The ${d.platform} profile already has every system the knowledge items name.`,
      );
    const items = d.proposals.map((p) => ({
      label: `${p.verified ? "$(pass-filled) " : ""}${p.system.name}`,
      description:
        p.action === "add"
          ? `add · ${p.system.boundary}${p.system.owner ? ` · ${p.system.owner}` : ""}${p.system.aliases.length ? ` · also ${p.system.aliases.join(", ")}` : ""}`
          : `update ${p.system.id} · ${[p.adds?.aliases?.length ? `aliases ${p.adds.aliases.join(", ")}` : "", p.adds?.owner ? `owner ${p.adds.owner}` : ""].filter(Boolean).join(" · ")}`,
      detail: `${p.verified ? `Verified by ${p.verifiedBy}. ` : "Not yet verified. "}${p.quote ? `“${p.quote}”` : ""}${p.notes.length ? ` ${p.notes.join("; ")}.` : ""}`,
      picked: p.verified,
      p,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: `Atticus: systems for the ${d.platform} profile, from the wikis. Pick what to accept into profile.yaml.`,
      canPickMany: true,
      matchOnDescription: true,
      matchOnDetail: true,
      ignoreFocusOut: true,
    });
    if (!picked?.length) return;
    const argv = ["orgpack", "accept", d.platform, "--only", picked.map((x) => x.p.from).join(",")];
    const p = await this.c.captured(root, argv);
    this.d.refreshAll();
    if (p.code !== 0) return this.c.showPrinted(argv, p);
    const open = await vscode.window.showInformationMessage(
      `${p.lines[0] ?? "Accepted."} Commit profile.yaml through a pull request.`,
      "Open profile.yaml",
    );
    if (open)
      await vscode.commands.executeCommand("atticus.openItem", {
        kind: "file",
        path:
          [
            join(root, "org-pack", "profiles", d.platform, "profile.yaml"),
            join(root, ".atticus", "org-pack", "profiles", d.platform, "profile.yaml"),
          ].find((f) => existsSync(f)) ??
          join(root, "org-pack", "profiles", d.platform, "profile.yaml"),
      });
  }

  /** The knowledge items no person has verified yet, one after another, to verify, correct or reject. */
  async reviewUnverified(root: string) {
    for (;;) {
      const pick = await pickLoading(
        {
          title:
            "Atticus: the knowledge items no person has checked. Pick one to check it against its page.",
          reading: "Reading the knowledge items…",
          empty: "Every knowledge item has been checked by a person.",
          matchOnDetail: true,
          log: this.svc.log,
        },
        async () => {
          const { items, problem } = await readKnowledgeList(this.svc.cli(root), root);
          if (!items.length && problem) throw new Error(problem);
          return items.filter(isUnverified).map((k) => ({
            label: `${k.review?.state === "stale" ? "$(warning) " : ""}${itemTitle(k)}`,
            description: `${k.knowledgeKind ?? k.kind}${k.review?.state === "stale" ? " · its page changed: check again" : ""}`,
            detail: k.quote ? `“${k.quote.text}” (${k.quote.source}/${k.quote.page})` : "",
            k,
          }));
        },
      );
      if (!pick) return;
      const act = await vscode.window.showQuickPick(
        [
          { label: "$(book) Open the page it was read from", id: "page" },
          { label: "$(pass-filled) It's right", id: "verify" },
          { label: "$(edit) Correct it…", id: "correct" },
          { label: "$(error) It's wrong…", id: "reject" },
          ...urlsOf(pick.k).map((u) => ({
            label: `$(link-external) Open ${u.label ?? u.url}`,
            id: "url",
            u,
          })),
        ],
        { title: `Atticus: “${itemTitle(pick.k)}”`, ignoreFocusOut: true },
      );
      if (!act) continue;
      if (act.id === "page")
        await vscode.commands.executeCommand(
          "atticus.openItem",
          snapshotOpen(pick.k, this.svc.paths(root)),
          { beside: true },
        );
      else if (act.id === "verify") await this.verify(root, pick.k);
      else if (act.id === "correct") await this.correct(root, pick.k);
      else if (act.id === "reject") await this.reject(root, pick.k);
      else if ("u" in act) await vscode.env.openExternal(vscode.Uri.parse(act.u.url));
    }
  }
}
