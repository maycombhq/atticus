import { argsOf } from "./atticus";

/**
 * Everything from the plugin, guided (ADR 0100). A next step with a part to fill in opens the
 * screen that asks for it; the setup checklist and a repo's onboarding are lists to click
 * through; bringing in another team's repo is a dry run, the person's yes, a proposal to review,
 * then an accept. No `vscode` here, so it is tested outside the editor.
 */

/** The guided screens the extension has for a command a step names. */
export type Guided =
  "addRepos" | "newChange" | "absorb" | "absorbAccept" | "createMetarepo" | "adoptRepo";

/** The guided screen for a printed command, when the extension has one for it. */
export function guidedFor(command: string): Guided | undefined {
  const [a, b] = argsOf(command);
  if (a === "repos" && b === "discover") return "addRepos";
  if (a === "change" && b === "new") return "newChange";
  if (a === "absorb") return b === "accept" ? "absorbAccept" : "absorb";
  if (a === "init") return "createMetarepo";
  if (a === "adopt") return "adoptRepo";
  return undefined;
}

// ------------------------------------------------------------------ the setup checklist

/** One step of `atticus setup --json`. */
export interface SetupStep {
  id: string;
  label: string;
  done: boolean;
  detail?: string;
  fix?: string;
  optional?: boolean;
}

export function setupProgress(steps: SetupStep[]): {
  done: number;
  total: number;
  complete: boolean;
  next?: SetupStep;
} {
  const must = steps.filter((s) => !s.optional);
  const done = must.filter((s) => s.done).length;
  const next = must.find((s) => !s.done);
  return { done, total: must.length, complete: !next, ...(next ? { next } : {}) };
}

/** The editor command that fixes a setup step. */
export function setupAction(id: string): { command: string; args?: unknown[] } {
  switch (id) {
    case "machine":
      return { command: "atticus.checkHealth" };
    case "org-pack":
      return { command: "atticus.runCommand", args: ["orgpack validate"] };
    case "repos":
      return { command: "atticus.addRepos" };
    case "clones":
      return { command: "atticus.workspaceSync" };
    case "scan":
      return { command: "atticus.scanAll" };
    case "knowledge":
      return { command: "atticus.addKnowledge" };
    case "baseline":
      return { command: "atticus.acceptCatalog" };
    default:
      return { command: "atticus.runCommand", args: ["setup"] };
  }
}

// ------------------------------------------------------------------ onboarding a repo

export interface RepoState {
  id: string;
  cloned: boolean;
  scanSettings: { present: boolean };
  lastScan: { records: number } | null;
}

export type StageRun =
  | {
      kind: "cli";
      id: string;
      args: (string | undefined)[];
      flags: Record<string, string | true>;
    }
  | { kind: "vscode"; command: string; args: unknown[] };

export interface Stage {
  id: "clone" | "survey" | "scan" | "verify" | "spec" | "questions" | "dialect";
  label: string;
  detail: string;
  /** next: the one to take now; again: done, and worth doing after every scan. */
  state: "done" | "next" | "todo" | "again" | "optional";
  run: StageRun;
}

const cli = (
  id: string,
  args: (string | undefined)[] = [],
  flags: Record<string, string | true> = {},
): StageRun => ({ kind: "cli", id, args, flags });

/** A repo's onboarding, in order: clone, scan settings, scan, check, spec, its questions. */
export function onboardingStages(r: RepoState, o: { flows: number; questions: number }): Stage[] {
  const id = r.id;
  const stages: Omit<Stage, "state">[] = [
    {
      id: "clone",
      label: "Clone it",
      detail: `atticus workspace sync --repos ${id}: the base clone the scan reads`,
      run: cli("workspace sync", [], { "--repos": id }),
    },
    {
      id: "survey",
      label: "Draft its scan settings with Copilot",
      detail: `atticus scan survey ${id}: folders to leave out, path prefixes, client base URLs`,
      run: cli("scan survey", [id]),
    },
    {
      id: "scan",
      label: "Scan it",
      detail: `atticus scan --repos ${id}: reads its files only, no network, no AI${r.lastScan ? ` (last scan: ${r.lastScan.records} records)` : ""}`,
      run: cli("scan", [], { "--repos": id }),
    },
    {
      id: "verify",
      label: "Check the scan against the code with Copilot",
      detail: `atticus scan verify ${id}: what the scan missed or has wrong, with a fix for each; after every scan`,
      run: cli("scan verify", [id]),
    },
    {
      id: "spec",
      label: o.flows
        ? `Draft its spec again with Copilot (${o.flows} flows now)`
        : "Draft its spec with Copilot",
      detail: `atticus spec draft ${id}: a flow per trigger, each step citing its code`,
      run: cli("spec draft", [id]),
    },
    ...(o.questions
      ? [
          {
            id: "questions" as const,
            label: `Answer its ${o.questions} open question${o.questions === 1 ? "" : "s"}`,
            detail: "What the scan and the drafts couldn't decide from the code",
            run: { kind: "vscode" as const, command: "atticus.answerRepo", args: [id] },
          },
        ]
      : []),
    {
      id: "dialect",
      label: "Teach Atticus a language it can't read yet",
      detail: `atticus onboard ${id}: only when the scan can't read this repo's code; Copilot drafts a dialect, checked, kept as a proposal`,
      run: cli("onboard", [id]),
    },
  ];
  const done: Record<Stage["id"], boolean | "again" | "optional"> = {
    clone: r.cloned,
    survey: r.scanSettings.present,
    scan: !!r.lastScan,
    verify: r.lastScan ? "again" : false,
    spec: o.flows > 0,
    questions: false,
    dialect: "optional",
  };
  let marked = false;
  return stages.map((s) => {
    const d = done[s.id];
    let state: Stage["state"];
    if (d === true) state = "done";
    else if (d === "again" || d === "optional") state = d;
    else if (!marked) {
      state = "next";
      marked = true;
    } else state = "todo";
    return { ...s, state };
  });
}

// ------------------------------------------------------------------ bringing in another repo

/** An id for an absorbed source: its folder's or repository's name, as a slug. */
export function defaultAbsorbId(source: string): string {
  const last =
    source
      .replace(/[\\/]+$/, "")
      .split(/[\\/:]/)
      .pop() ?? "";
  return last
    .replace(/\.git$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** What `atticus absorb … --dry-run --json` gives. */
export interface AbsorbDry {
  id: string;
  format: string;
  summary: {
    items: number;
    translatedPercent: number;
    byAction: { adopt: number; link: number; ignore: number };
    byKind: Record<string, number>;
  };
  problems: string[];
}

/** What `atticus absorb accept … --dry-run --json` gives. */
export interface AcceptDry {
  id: string;
  proposal: string;
  copied: string[];
  same: string[];
  kept: string[];
  linked: number;
  entry: "added" | "replaced" | "already";
  sourcesFile: string;
}

const KINDS: Record<string, [string, string, string?]> = {
  prompt: ["prompt", "prompts", "become org-pack commands"],
  agent: ["agent", "agents", "become skills"],
  instructions: ["instruction file", "instruction files", "become skills"],
  skill: ["skill", "skills"],
  "critic-rule": ["checklist item", "checklist items", "become critic rules"],
  "constitution-principle": [
    "constitution principle",
    "constitution principles",
    "become critic rules",
  ],
  schema: ["schema", "schemas", "for intake"],
  typespec: ["TypeSpec file", "TypeSpec files", "kept as references"],
  "speckit-template": ["Spec Kit template", "Spec Kit templates", "become change templates"],
  "speckit-spec": ["Spec Kit spec", "Spec Kit specs", "become OpenSpec specs"],
  "speckit-plan": ["Spec Kit plan", "Spec Kit plans"],
  "speckit-command": ["Spec Kit command", "Spec Kit commands"],
  "speckit-script": ["Spec Kit script", "Spec Kit scripts"],
  "openspec-spec": ["OpenSpec spec", "OpenSpec specs"],
  "openspec-change": ["OpenSpec change", "OpenSpec changes"],
  "openspec-config": ["OpenSpec setting file", "OpenSpec setting files"],
  "atticus-orgpack": ["org-pack file", "org-pack files"],
  "atticus-catalog": ["set of catalog records", "sets of catalog records"],
  "atticus-change": ["change", "changes"],
  doc: ["doc about the repo", "docs about the repo", "left out"],
  code: [
    "set of code and build files",
    "sets of code and build files",
    "left out: the scan reads code",
  ],
  other: ["file it couldn't place", "files it couldn't place"],
};

function formatName(format: string, byKind: Record<string, number>): string {
  if (format === "atticus") return "another Atticus metarepo";
  if (format === "openspec") return "an OpenSpec repo";
  if (format === "speckit") return "a Spec Kit repo";
  if (byKind.typespec) return "a TypeSpec repo";
  return "a repo of prompts, agents, skills and schemas";
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function absorbConfirm(d: AbsorbDry): { message: string; detail: string } {
  const s = d.summary;
  const kinds = Object.entries(s.byKind)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => {
      const [one, many, what] = KINDS[k] ?? [k, k];
      return `${plural(n, one, many)}${what ? `, ${what}` : ""}`;
    });
  return {
    message: `Bring in ${d.id}, ${formatName(d.format, s.byKind)}? ${plural(s.items, "item", "items")}: ${s.byAction.adopt} to copy into the org pack, ${s.byAction.link} to follow, ${s.byAction.ignore} left out.`,
    detail: [
      ...kinds,
      "",
      `Translated: ${s.translatedPercent}%.`,
      ...(d.problems.length
        ? [`${plural(d.problems.length, "problem", "problems")}: ${d.problems.join("; ")}`]
        : []),
      "",
      `Nothing changes in the org pack yet: a proposal is written to proposals/absorb/${d.id}/ for you to review, then accept. What it brings in is data, never instructions.`,
    ].join("\n"),
  };
}

export function acceptConfirm(a: AcceptDry): { message: string; detail: string } {
  // Blocks of lines, a blank line between those that have something to say.
  const blocks: string[][] = [
    a.copied,
    a.kept.length
      ? [
          "Kept as they are (someone changed them). Run atticus absorb accept with --replace to overwrite them:",
          ...a.kept,
        ]
      : [],
    a.same.length ? [`${plural(a.same.length, "file is", "files are")} already there.`] : [],
    [
      a.entry === "already"
        ? `${a.sourcesFile} already lists ${a.id}.`
        : `It adds ${a.id} under absorbed: in ${a.sourcesFile}.`,
      "Nothing is committed: open a pull request with it; merging it is the approval.",
    ],
  ];
  return {
    message: `Accept ${a.id} into the metarepo? ${plural(a.copied.length, "file", "files")} to copy; ${plural(a.linked, "item", "items")} stay linked.`,
    detail: blocks
      .filter((b) => b.length)
      .map((b) => b.join("\n"))
      .join("\n\n"),
  };
}
