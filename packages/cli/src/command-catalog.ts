import type { ParseArgsOptionsConfig } from "node:util";
import { optionsFor } from "@maycombhq/ai/cli-options";
import { isHandoffStep } from "./handoff-steps.js";
import { aliasArgv, isLegacy } from "./top-commands.js";

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
  /**
   * The approve flag is needed only with this option and value (task run: `--level pr`, the push
   * and PR); without it the command runs once, as it is, with no dry run before it. Additive: an
   * editor that doesn't read it treats the command as a shared write.
   */
  approveWhen?: { flag: string; value: string };
  /**
   * Outside the twelve `atticus help` shows (ADR 0124 addendum D-cli): listed by `atticus legacy`,
   * still run by its own name. Additive: an editor that doesn't read it offers every command.
   */
  legacy: boolean;
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
  probe: "start",
  secret: "start",
  upgrade: "start",
  support: "start",
  sandbox: "start",
  learn: "start",
  explain: "start",
  executors: "start",
  openspec: "start",
  "assistant-files": "start",
  ui: "start",
  mcp: "start",
  index: "start",
  schema: "start",
  orgpack: "start",
  templates: "start",
  commands: "start",
  legacy: "start",
  next: "changes",
  scan: "repos",
  verify: "repos",
  join: "repos",
  map: "repos",
  spec: "repos",
  estate: "repos",
  // ADR 0196: canaries, beside the sample audit.
  canary: "repos",
  "repo-type": "repos",
  // ADR 0176, 0177: reading rules, and skills and agents, set up for the organisation.
  rules: "repos",
  // ADR 0178: Copilot proposes pairings of a repo's calls with another box's APIs.
  connect: "repos",
  // ADR 0180: the organisation's component types.
  types: "start",
  skills: "start",
  repo: "repos",
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
  standards: "knowledge",
  knowledge: "knowledge",
  patterns: "knowledge",
  absorb: "knowledge",
  intake: "knowledge",
  triage: "knowledge",
  glossary: "knowledge",
  domain: "knowledge",
  catalog: "catalog",
  query: "catalog",
  context: "catalog",
  cites: "catalog",
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
  stage: "changes",
  critic: "changes",
  handoff: "changes",
  questions: "changes",
  plan: "plan",
  task: "plan",
  stories: "plan",
  todo: "plan",
  needs: "changes",
  waiting: "changes",
  watch: "changes",
  runs: "changes",
  history: "changes",
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
  "change release-prs": ["change"],
  "change return": ["change"],
  "change archive": ["change"],
  finding: ["change", "finding"],
  findings: ["change"],
  impact: ["record"],
  drift: ["change"],
  trace: ["change"],
};

const SERVES = new Set(["ui", "stub serve", "mcp"]);
const APPROVE_FLAGS = ["--approve", "--send"];
/**
 * Commands whose write to a shared system is one option's (round 22): `task run` runs the task
 * itself (a dry run would be the whole run), and only `--level pr` pushes and opens a PR.
 */
const LOCAL_ALWAYS = new Set(["handoff done"]);
const APPROVE_WHEN: Record<string, { flag: string; value: string }> = {
  "task run": { flag: "--level", value: "pr" },
  // ADR 0181 part 4: Run all ready tasks runs each task itself; only --level pr pushes and opens PRs.
  "task run-ready": { flag: "--level", value: "pr" },
  task: { flag: "--level", value: "pr" },
};

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

/**
 * The options a usage requires (review round 47): those outside brackets, but not one of a set
 * of alternatives. `a | b | c` (each with its value and what follows it up to the next `|`) is
 * one of them, so none is required alone; options before the first alternative are required
 * whichever is given (`--reason "..." --org-wide | --type <t>`: --reason). What is inside
 * brackets, angle brackets or quotes is never read here.
 */
export function requiredFlags(usage: string): Set<string> {
  let masked = "";
  let depth = 0;
  let quoted = false;
  for (const ch of usage) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "[" || ch === "<")) depth++;
    else if (!quoted && (ch === "]" || ch === ">")) depth = Math.max(0, depth - 1);
    masked += depth || quoted || ch === '"' || ch === "]" || ch === ">" ? "_" : ch;
  }
  const tokens = masked.split(/\s+/).filter(Boolean);
  const flagOf = (t: string) => (/^--[a-z]/.test(t) ? t.split("=")[0]! : undefined);
  const bar = tokens.indexOf("|");
  if (bar < 0) return new Set(tokens.map(flagOf).filter((f): f is string => !!f));
  // Before the first `|`: everything but the first alternative (the last option there).
  const first = tokens
    .slice(0, bar)
    .map(flagOf)
    .filter((f): f is string => !!f);
  return new Set(first.slice(0, -1));
}

function parseFlags(
  text: string,
  summaries: Map<string, string>,
  required: ReadonlySet<string>,
  options: ParseArgsOptionsConfig,
): CommandFlag[] {
  const out = new Map<string, CommandFlag>();
  const re = /(--[a-z][a-z-]*)(?:[ =]("[^"]*"|<[^>]+>|[A-Za-z0-9][\w.,=-]*(?:\|[\w.-]+)*))?/g;
  for (const m of text.matchAll(re)) {
    const name = m[1]!;
    if (out.has(name)) continue;
    // Review round 47: the value as the help names it (`--resume run`, `--dir path`), and none
    // for a switch; the command line's own type decides which, where it knows the flag.
    const type = options[name.slice(2)]?.type;
    let value = m[2]?.replace(/^<|>$/g, "");
    if (value?.startsWith("--") || type === "boolean") value = undefined;
    else if (type === "string") value ??= "value";
    const summary = summaries.get(name);
    out.set(name, {
      name,
      ...(value ? { value } : {}),
      required: required.has(name),
      ...(summary ? { summary } : {}),
    });
  }
  return [...out.values()];
}

/** The commands of a help text, each with the option lines written under it. */
export function parseHelp(help: string): Omit<CommandInfo, "area" | "runs" | "legacy">[] {
  const out: Omit<CommandInfo, "area" | "runs" | "legacy">[] = [];
  let current: { line: string; more: string[]; below?: string } | undefined;
  const blocks: { line: string; more: string[]; below?: string }[] = [];
  for (const l of help.split("\n")) {
    if (/^ {2}atticus /.test(l)) {
      current = { line: l.trim(), more: [] };
      blocks.push(current);
    } else if (current && /^ {6,}\[?--|^ {6,}\(/.test(l)) current.more.push(l.trim());
    // A command too long for the column has its description on the line under it.
    else if (current && !current.more.length && current.below === undefined && /^ {6,}\S/.test(l))
      current.below = l.trim();
    else if (!/^ {6,}/.test(l)) current = undefined;
  }
  for (const b of blocks) {
    if (/^atticus (--help|--version|<step>)/.test(b.line)) continue;
    // The usage and the summary are split by a run of spaces.
    const cut = b.line.search(/ {2,}/);
    const usage = cut > 0 ? b.line.slice(0, cut) : b.line;
    const written = cut > 0 ? b.line.slice(cut).trim() : (b.below ?? "");
    // The options a summary lists at its end are read as options; the summary keeps its words.
    const summary = written.replace(/(\s*\[[^\]]*--[^\]]*\](\.\.\.)?)+\s*$/, "");
    const tokens = usage.split(" ").slice(1);
    const named: string[] = [];
    for (const t of tokens) {
      if (!isWord(t)) break;
      named.push(t);
    }
    // Review round 47: `secret set|check|forget <name>` is three commands, each with its id.
    const after = tokens[named.length];
    const ways = after && /^[a-z][a-z-]*(\|[a-z][a-z-]*)+$/.test(after) ? after.split("|") : [];
    const summaries = new Map<string, string>();
    for (const m of b.more) {
      const c = m.search(/ {2,}/);
      const opt = c > 0 ? m.slice(0, c) : m;
      const what = c > 0 ? m.slice(c).trim() : "";
      for (const f of opt.matchAll(/--[a-z][a-z-]*/g)) if (what) summaries.set(f[0], what);
    }
    // Two spaces after the usage: the summary's first word is never the last option's value.
    // Review round 47: the usage, the options the summary lists at its end and the option lines
    // only, never a flag the summary's words name (`map --all's waiting loop`).
    const optionText = [
      `${usage} `,
      written.slice(summary.length),
      // Each option line's option part only: its description may hold brackets of its own.
      ...b.more.map((m) => {
        const c = m.search(/ {2,}/);
        return `[${(c > 0 ? m.slice(0, c) : m).replace(/^\[|\]$/g, "")}]`;
      }),
    ].join(" ");
    const required = requiredFlags(usage);
    // A summary's words may say how a person approves the write (`a dry run until you add
    // --approve`): that flag is the command's, never required (the person's yes adds it).
    const approves = APPROVE_FLAGS.filter((f) => new RegExp(`${f}(?![a-z-])`).test(written));
    const rest = usage.slice(
      `atticus ${[...named, ...(ways.length ? [after!] : [])].join(" ")}`.length,
    );
    for (const words of ways.length ? ways.map((w) => [...named, w]) : [named]) {
      const id = words.join(" ");
      const flags = parseFlags(optionText, summaries, required, optionsFor(words));
      for (const name of approves)
        if (!flags.some((f) => f.name === name)) flags.push({ name, required: false });
      out.push({ id, words, usage, summary, args: parseArgs(id, rest), flags });
    }
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
    // `handoff done --approve` is a pr-level task run's yes, asked for by the refusal that names
    // it: Done itself checks and builds locally, so an editor runs it once, never a dry run first.
    const approve = LOCAL_ALWAYS.has(c.id)
      ? undefined
      : APPROVE_FLAGS.find((f) => c.flags.some((x) => x.name === f));
    // `critic <change>` takes --handoff too (its lenses one at a time); `critic --resume` is a
    // person's way to read answers in, and `critic stats` reads. A new name (stories) runs as the
    // command it names (plan stories).
    const [w0, w1] = aliasArgv(
      c.words,
      c.words.map((_, i) => i),
    );
    const runs: Runs =
      isHandoffStep(w0, w1) || c.id === "critic" || c.id === "map"
        ? "ai"
        : SERVES.has(c.id)
          ? "serve"
          : approve
            ? "shared"
            : "local";
    return {
      ...c,
      area,
      runs,
      ...(approve && runs === "shared" ? { approve } : {}),
      ...(approve && runs === "shared" && APPROVE_WHEN[c.id]
        ? { approveWhen: APPROVE_WHEN[c.id] }
        : {}),
      legacy: isLegacy(c.words[0]),
    };
  });
}
