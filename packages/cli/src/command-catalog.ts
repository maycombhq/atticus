import { isHandoffStep } from "./handoff-flag.js";

/**
 * Every command as data (ADR 0096), for an editor to offer them all: the words, the arguments and
 * what each refers to, the options, an area, and how it runs. Built from the help text itself, so
 * a command added to the help is in the catalogue at once; a test fails if one has no area.
 */

export type ArgKind =
  | "repo"
  | "change"
  | "flow"
  | "system"
  | "question"
  | "finding"
  | "record"
  | "path"
  | "choice"
  | "text";

export interface CommandArg {
  name: string;
  kind: ArgKind;
  optional: boolean;
  many: boolean;
  /** For a choice: the values. */
  choices?: string[];
}

export interface CommandFlag {
  name: string;
  /** The value it takes, as the help names it (`3`, `type`); none for a plain switch. */
  value?: string;
  required: boolean;
  summary?: string;
}

/**
 * How it runs: `ai`, a step an assistant does (it takes --handoff); `shared`, it writes to a
 * shared system once a person adds `approve` (otherwise a dry run); `serve`, it keeps running;
 * `local`, everything else.
 */
export type Runs = "ai" | "shared" | "serve" | "local";

export interface CommandInfo {
  id: string;
  words: string[];
  usage: string;
  summary: string;
  args: CommandArg[];
  flags: CommandFlag[];
  area: string;
  runs: Runs;
  /** For shared: the flag a person adds to approve the write (--approve, --send). */
  approve?: string;
}

export const AREAS = [
  { id: "start", title: "Set up and keep healthy" },
  { id: "repos", title: "Repos, scans and specs" },
  { id: "knowledge", title: "Knowledge and documents" },
  { id: "catalog", title: "The catalog" },
  { id: "changes", title: "Changes, findings and questions" },
  { id: "plan", title: "Plans, tasks and work items" },
  { id: "release", title: "Release" },
  { id: "developer", title: "For Atticus's own quality" },
] as const;

/** A command's area, by its first word, with the few exceptions by its whole id. */
const AREA_BY_WORD: Record<string, string> = {
  init: "start",
  adopt: "start",
  unadopt: "start",
  setup: "start",
  doctor: "start",
  upgrade: "start",
  support: "start",
  sandbox: "start",
  learn: "start",
  explain: "start",
  executors: "start",
  openspec: "start",
  "assistant-files": "start",
  ui: "start",
  index: "start",
  schema: "start",
  orgpack: "start",
  templates: "start",
  commands: "start",
  next: "changes",
  scan: "repos",
  spec: "repos",
  estate: "repos",
  "repo-type": "repos",
  repos: "repos",
  workspace: "repos",
  frameworks: "repos",
  dialect: "repos",
  onboard: "repos",
  baseline: "repos",
  drift: "repos",
  stub: "repos",
  ci: "repos",
  sources: "knowledge",
  knowledge: "knowledge",
  patterns: "knowledge",
  absorb: "knowledge",
  intake: "knowledge",
  triage: "knowledge",
  glossary: "knowledge",
  domain: "knowledge",
  catalog: "catalog",
  query: "catalog",
  impact: "catalog",
  ask: "catalog",
  guide: "catalog",
  diagram: "catalog",
  reconcile: "catalog",
  coverage: "catalog",
  feature: "catalog",
  alias: "catalog",
  site: "catalog",
  digest: "changes",
  change: "changes",
  finding: "changes",
  findings: "changes",
  critic: "changes",
  handoff: "changes",
  questions: "changes",
  plan: "plan",
  task: "plan",
  todo: "plan",
  needs: "changes",
  ado: "plan",
  tests: "plan",
  trace: "plan",
  initiative: "plan",
  outcome: "plan",
  release: "release",
  bench: "developer",
  eval: "developer",
  defences: "developer",
  plugin: "developer",
  conformance: "developer",
};
const AREA_BY_ID: Record<string, string> = {
  "spec hand-down": "changes",
  "spec hand-up": "changes",
  "ci archive-gate": "release",
};

/** What an argument refers to, by its name, with the exceptions by command. */
const KIND_BY_NAME: Record<string, ArgKind> = {
  repo: "repo",
  repos: "repo",
  change: "change",
  flow: "flow",
  system: "system",
  file: "path",
  files: "path",
  dir: "path",
  path: "path",
  a: "path",
  b: "path",
};
const KIND_BY_COMMAND: Record<string, ArgKind[]> = {
  "questions answer": ["question"],
  "change status": ["change"],
  "change handoff": ["change"],
  "change sync": ["change"],
  "change return": ["change"],
  "change archive": ["change"],
  finding: ["change", "finding"],
  findings: ["change"],
  impact: ["record"],
  drift: ["change"],
  trace: ["change"],
};

const SERVES = new Set(["ui", "stub serve"]);
const APPROVE_FLAGS = ["--approve", "--send"];

/** The command words: up to the first argument, option or quoted part. */
const isWord = (t: string) => /^[a-z][a-z-]*$/.test(t);

function parseArgs(id: string, usage: string): CommandArg[] {
  const out: CommandArg[] = [];
  const kinds = KIND_BY_COMMAND[id];
  // <name>, "<name>", [name], <name...>, <a|b|c>; not an option's value (--type <type>).
  const re = /(\[|"?<)([a-z][a-z|-]*?)(\.\.\.)?(>"?|\])(\.\.\.)?/g;
  for (const m of usage.matchAll(re)) {
    const before = usage.slice(0, m.index).trimEnd();
    if (/--[a-z-]+$/.test(before) || /--[a-z-]+ ?\|?$/.test(before)) continue;
    if (m[1] === "[" && !/^[a-z]+$/.test(m[2]!)) continue;
    const raw = m[2]!;
    const parts = raw.split("|");
    const isChoice = parts.length >= 3;
    const name = isChoice ? "choice" : parts[0]!;
    const kind: ArgKind =
      kinds?.[out.length] ?? (isChoice ? "choice" : (KIND_BY_NAME[name] ?? "text"));
    out.push({
      name,
      kind,
      optional: m[1] === "[",
      many: !!(m[3] || m[5]),
      ...(isChoice ? { choices: parts } : {}),
    });
  }
  return out;
}

function parseFlags(text: string, summaries: Map<string, string>): CommandFlag[] {
  const out = new Map<string, CommandFlag>();
  const re = /(--[a-z][a-z-]*)(?:[ =]("[^"]*"|<[^>]+>|[A-Za-z0-9][\w.,=-]*(?:\|[\w.-]+)*))?/g;
  for (const m of text.matchAll(re)) {
    const name = m[1]!;
    if (out.has(name)) continue;
    const before = text.slice(0, m.index);
    const opened = (before.match(/\[/g) ?? []).length - (before.match(/\]/g) ?? []).length;
    let value = m[2]?.replace(/^<|>$/g, "");
    // A value that is the next option or a command word isn't this one's value.
    if (value?.startsWith("--") || (value && /^[a-z]+$/.test(value) && !m[2]!.startsWith("<")))
      value = /^(m|n|t|s|k|f|c|d|o|p|file|dir|id)$/.test(value) ? value : undefined;
    const summary = summaries.get(name);
    out.set(name, {
      name,
      ...(value ? { value } : {}),
      // `<folder> | --org <org>`: the option is given instead of the argument, not as well.
      required: opened <= 0 && !/<[^>]+>\s*\|\s*$/.test(before),
      ...(summary ? { summary } : {}),
    });
  }
  return [...out.values()];
}

/** The commands of a help text, each with the option lines written under it. */
export function parseHelp(help: string): Omit<CommandInfo, "area" | "runs">[] {
  const out: Omit<CommandInfo, "area" | "runs">[] = [];
  let current: { line: string; more: string[] } | undefined;
  const blocks: { line: string; more: string[] }[] = [];
  for (const l of help.split("\n")) {
    if (/^ {2}atticus /.test(l)) {
      current = { line: l.trim(), more: [] };
      blocks.push(current);
    } else if (current && /^ {6,}\[?--|^ {6,}\(/.test(l)) current.more.push(l.trim());
    else if (!/^ {6,}/.test(l)) current = undefined;
  }
  for (const b of blocks) {
    if (/^atticus (--help|--version|<step>)/.test(b.line)) continue;
    // The usage and the summary are split by a run of spaces.
    const cut = b.line.search(/ {2,}/);
    const usage = cut > 0 ? b.line.slice(0, cut) : b.line;
    const summary = cut > 0 ? b.line.slice(cut).trim() : "";
    const tokens = usage.split(" ").slice(1);
    const words: string[] = [];
    for (const t of tokens) {
      if (!isWord(t)) break;
      words.push(t);
    }
    const id = words.join(" ");
    const summaries = new Map<string, string>();
    for (const m of b.more) {
      const c = m.search(/ {2,}/);
      const opt = c > 0 ? m.slice(0, c) : m;
      const what = c > 0 ? m.slice(c).trim() : "";
      for (const f of opt.matchAll(/--[a-z][a-z-]*/g)) if (what) summaries.set(f[0], what);
    }
    const optionText = [
      usage,
      summary,
      // Each option line's option part only: its description may hold brackets of its own.
      ...b.more.map((m) => {
        const c = m.search(/ {2,}/);
        return `[${(c > 0 ? m.slice(0, c) : m).replace(/^\[|\]$/g, "")}]`;
      }),
    ].join(" ");
    out.push({
      id,
      words,
      usage,
      summary,
      args: parseArgs(id, usage.slice(`atticus ${id}`.length)),
      flags: parseFlags(optionText, summaries),
    });
  }
  return out;
}

export function commandCatalog(help: string): CommandInfo[] {
  const seen = new Set<string>();
  return parseHelp(help).map((parsed) => {
    // A second form of the same words (critic … --resume, absorb --refresh) is named by the
    // option that sets it apart, so every id is one command.
    let c = parsed;
    if (seen.has(c.id)) {
      const mark = c.flags.find((f) => f.required) ?? c.flags[0];
      if (mark) c = { ...c, id: `${c.id} ${mark.name}` };
    }
    seen.add(c.id);
    const area = AREA_BY_ID[c.id] ?? AREA_BY_WORD[c.words[0] ?? ""] ?? "";
    const approve = APPROVE_FLAGS.find((f) => c.flags.some((x) => x.name === f));
    const runs: Runs = isHandoffStep(c.words[0], c.words[1])
      ? "ai"
      : SERVES.has(c.id)
        ? "serve"
        : approve
          ? "shared"
          : "local";
    return { ...c, area, runs, ...(approve && runs === "shared" ? { approve } : {}) };
  });
}
