/**
 * Every Atticus command in the editor (ADR 0096), from `atticus commands --json`: the command
 * line's own catalogue, built from its help text, so a new command is offered as soon as the
 * command line has it. No `vscode` here: matching, building the arguments and deciding how a
 * command runs are tested outside the editor; extension.ts asks and runs.
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

export interface CatalogArg {
  name: string;
  kind: ArgKind;
  optional: boolean;
  many: boolean;
  choices?: string[];
}

export interface CatalogFlag {
  name: string;
  value?: string;
  required: boolean;
  summary?: string;
}

export interface CatalogCommand {
  id: string;
  words: string[];
  usage: string;
  summary: string;
  args: CatalogArg[];
  flags: CatalogFlag[];
  area: string;
  runs: "ai" | "shared" | "serve" | "local";
  approve?: string;
}

export interface Catalog {
  areas: { id: string; title: string }[];
  commands: CatalogCommand[];
}

/** Split a typed line into words, keeping "quoted parts" whole. */
export function splitWords(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}

/** The command a typed line names (the longest that fits), and the words after it. */
export function matchCommand(
  c: Catalog,
  line: string,
): { command: CatalogCommand; rest: string[] } | undefined {
  const words = splitWords(line.replace(/^atticus\s+/, ""));
  let best: CatalogCommand | undefined;
  for (const cmd of c.commands) {
    const n = cmd.words.length;
    if (n === 0 || n > words.length) continue;
    if (cmd.words.every((w, i) => words[i] === w) && (!best || n > best.words.length)) best = cmd;
  }
  return best ? { command: best, rest: words.slice(best.words.length) } : undefined;
}

export interface Answers {
  /** One per argument, in order; a list for an argument that takes many. */
  args: (string | string[] | undefined)[];
  /** Option → true for a switch, or its value. */
  flags: Record<string, string | true>;
}

export function buildArgv(cmd: CatalogCommand, a: Answers): string[] {
  const out = [...cmd.words];
  for (const v of a.args) {
    if (v === undefined) continue;
    if (Array.isArray(v)) out.push(...v);
    else out.push(v);
  }
  for (const [name, v] of Object.entries(a.flags)) {
    out.push(name);
    if (v !== true) out.push(v);
  }
  return out;
}

export type HowToRun =
  { mode: "ai" } | { mode: "approve"; flag: string } | { mode: "terminal" } | { mode: "run" };

/**
 * AI steps run with Copilot's model (the step runner); a write to a shared system runs as a dry
 * run first and asks the person before it adds its approve flag; a server keeps a terminal; the
 * rest runs and shows what it printed.
 */
export function howToRun(cmd: CatalogCommand): HowToRun {
  if (cmd.runs === "ai") return { mode: "ai" };
  if (cmd.runs === "shared" && cmd.approve) return { mode: "approve", flag: cmd.approve };
  if (cmd.runs === "serve") return { mode: "terminal" };
  return { mode: "run" };
}

/** Options the extension sets itself, never offered: the metarepo, JSON output, the run mode. */
const SET_BY_US = new Set(["--root", "--json", "--handoff", "--resume", "--mode"]);

/** The options a person may add (the approve flag is asked separately; required ones always). */
export function optionsOf(cmd: CatalogCommand): CatalogFlag[] {
  return cmd.flags.filter((f) => !f.required && !SET_BY_US.has(f.name) && f.name !== cmd.approve);
}

export interface PickItem {
  label: string;
  separator?: true;
  id?: string;
  description?: string;
  detail?: string;
}

const HOW: Record<CatalogCommand["runs"], string> = {
  ai: "with Copilot",
  shared: "asks you before it writes",
  serve: "keeps running",
  local: "",
};

/** Every command, by area, for a quick pick. */
export function pickList(c: Catalog): PickItem[] {
  const out: PickItem[] = [];
  const areas = [...c.areas, { id: "", title: "Other" }];
  const seen = new Set(c.areas.map((a) => a.id));
  for (const a of areas) {
    const these = c.commands.filter((x) => (a.id ? x.area === a.id : !seen.has(x.area)));
    if (!these.length && a.id) continue;
    out.push({ label: a.title, separator: true });
    for (const x of these)
      out.push({
        label: x.usage.replace(/^atticus /, ""),
        id: x.id,
        ...(HOW[x.runs] ? { description: HOW[x.runs] } : {}),
        detail: x.summary,
      });
  }
  return out;
}

/** The commands whose first argument is a repo or a change, for that item's menu. */
export function commandsFor(c: Catalog, kind: ArgKind): CatalogCommand[] {
  return c.commands.filter((x) => x.args[0]?.kind === kind);
}

/** The change types in org-pack/change-types.yaml (id and name), read without a YAML parser. */
export function changeTypesFrom(yaml: string): { id: string; name?: string }[] {
  const out: { id: string; name?: string }[] = [];
  for (const line of yaml.split(/\r?\n/)) {
    const id = /^\s*-\s+id:\s*["']?([a-z0-9][a-z0-9._-]*)["']?\s*$/.exec(line);
    if (id) {
      out.push({ id: id[1]! });
      continue;
    }
    const name = /^\s+name:\s*["']?(.+?)["']?\s*$/.exec(line);
    const last = out[out.length - 1];
    if (name && last && last.name === undefined) last.name = name[1]!;
  }
  return out;
}

/** The brief `atticus change new` asks for. */
export function briefPathFrom(out: string): string | undefined {
  return /Write the brief: (\S+)/.exec(out)?.[1];
}

/**
 * The words typed after a command (`@atticus /run spec draft nadiengine --force`): the arguments
 * in order, the options with their values, and what is still missing to run it.
 */
export function answersFrom(
  cmd: CatalogCommand,
  rest: string[],
): { answers: Answers; missing: string[] } {
  const args: (string | string[])[] = [];
  const flags: Record<string, string | true> = { ...requiredSwitches(cmd) };
  const loose: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i]!;
    if (w.startsWith("--")) {
      const [name, inline] = w.split("=", 2) as [string, string | undefined];
      const f = cmd.flags.find((x) => x.name === name);
      if (inline !== undefined) flags[name] = inline;
      else if (f?.value && rest[i + 1] !== undefined && !rest[i + 1]!.startsWith("--"))
        flags[name] = rest[++i]!;
      else flags[name] = true;
    } else loose.push(w);
  }
  cmd.args.forEach((a, i) => {
    if (a.many) {
      const all = loose.splice(0);
      if (all.length) args[i] = all;
    } else if (loose.length) args[i] = loose.shift()!;
  });
  const missing = [
    ...cmd.args.filter((a, i) => !a.optional && args[i] === undefined).map((a) => a.name),
    ...cmd.flags
      .filter((f) => f.required && !(f.name in flags) && cmd.id !== "questions answer")
      .map((f) => f.name),
  ];
  return { answers: { args, flags }, missing };
}

/** Required options that take no value (critic … --resume): set them, never ask. */
export function requiredSwitches(cmd: CatalogCommand): Record<string, true> {
  const out: Record<string, true> = {};
  for (const f of cmd.flags) if (f.required && !f.value) out[f.name] = true;
  return out;
}
