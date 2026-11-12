import type { CommandInfo } from "./command-catalog.js";

/**
 * Beta.27 review, final round: a step's reason, written for the command line, in the app's words,
 * built on the server where the reason is composed (`changeNextStep`'s `nextStepApp`), so a page
 * never cuts real prose guessing at commands. Only the commands Atticus has (the help catalog's
 * words) go, each with the arguments it takes: ids (dotted ones too), `--flags` with their values
 * and `<placeholders>`, stopping at `:` `;` `,` or the sentence's end. A `/atticus-x` slash command
 * goes with its bracketed clause only; one that leads its sentence is said as "This step". As the
 * cockpit's in-app words (`inAppWords`): a bracketed command goes, and the flags a terminal passes
 * are named as the app's own choices. "Atticus" (capitalised), words that only look like a command
 * ("what atticus knows") and backticked text that isn't a command stay as they are.
 *
 * Review of the fix: a bracketed alternative that is a command (", or atticus …", "or atticus …",
 * "atticus …, or …") goes as one unit and the rest of the bracket stays ("(Release › Raise the
 * release PRs)"); an empty bracket goes. A command a verb takes ("run atticus critic … again",
 * "Use atticus …") is said as what it does, from the app ("run the critic again from the app",
 * "mark the hand-off done from the app"); one that a "then", "and" or "or" joins
 * on its own goes with that word; one that is the subject after "and" or "then" is said as
 * Atticus; a bare word after a command's flags is the sentence's, never an argument.
 */

export type CommandShape = Pick<CommandInfo, "words" | "args" | "flags">;

/** Words that never are an argument: the sentence goes on after the command. */
const STOP = new Set(
  "a an and are as at be but by each every for from if in into is it its of on once or so that the then this to until when which while with without".split(
    " ",
  ),
);

/** The lead-in a command's removal takes with it ("…, then record it with atticus …"). */
const LEAD_IN = /(?:,\s*)?(?:\b(?:by running|by|with|using|running|type)\s+)?$/;

/** A conjunction that joins the command alone ("…), then atticus verify x --write, so …"). */
const JOIN = /(?:,\s*)?\b(?:then|and|or)[ \t]+$/;

/** A verb that takes the command ("run atticus critic … again", "Use atticus …"). */
const VERB = /\b([Rr]un|[Uu]se)[ \t]+$/;

/** A command that is its clause's subject: a word that isn't a stop word comes next. */
function subjectNext(rest: string): boolean {
  const w = /^[ \t]+([a-z][\w'-]*)/.exec(rest)?.[1];
  return !!w && !STOP.has(w);
}

const PLACEHOLDER = /^<[^>\s]+>/;
const QUOTED = /^(?:'[^']*'|"[^"]*")/;
const FLAG = /^--[a-z][\w-]*(?:=\S*)?/;
const TOKEN = /^[^\s,;:`()]+/;

interface Match {
  /** Where the command's text ends (after its arguments). */
  end: number;
  /** The command's words (`["critic"]`, `["handoff", "done"]`), when it is one Atticus has. */
  words?: readonly string[];
}

/** The planning stages a `change <stage>` or `plan <stage>` command runs. */
const STAGES = new Set(["proposal", "feature", "design", "architecture", "stories", "tasks"]);

/**
 * Beta.27 final fixes: what a verb's command does, named, so the sentence never says "run it"
 * with no "it" before it: "run the critic", "run the architecture stage", "mark the hand-off
 * done". The verb is the sentence's ("Run" or "Use", its case kept) unless the action has its own.
 */
function actionOf(verb: string, words: readonly string[] | undefined): string {
  const cap = /^[A-Z]/.test(verb);
  const say = (v: string, rest: string) => `${cap ? v[0]!.toUpperCase() + v.slice(1) : v} ${rest}`;
  const [w0, w1] = words ?? [];
  if (!w0) return `${verb} it`;
  if (w0 === "handoff" && w1 === "done") return say("mark", "the hand-off done");
  if (w0 === "handoff") return `${verb} the hand-off`;
  if (w0 === "critic") return `${verb} the critic`;
  if ((w0 === "change" || w0 === "plan") && w1 && STAGES.has(w1)) return `${verb} the ${w1} stage`;
  if (w0 === "verify") return `${verb} the facts check`;
  if (w0 === "map" || w0 === "scan") return say("read", "the repo");
  if (w0 === "workspace" && w1 === "sync") return say("sync", "the workspace");
  if (w0 === "questions") return `${verb} Questions`;
  return `${verb} the ${words!.join(" ")} step`;
}

/** The command's arguments from `at` on (after its words), argument-shaped tokens only. */
function argumentsEnd(text: string, at: number, c: CommandShape | undefined): number {
  let i = at;
  let positional = 0;
  // Review of the fix: after a flag, a bare word is the sentence's ("--stale tops up …").
  let flagged = false;
  const slots = !c ? 0 : c.args.some((a) => a.many) ? Infinity : c.args.length;
  const flags = new Map((c?.flags ?? []).map((f) => [f.name, f.value !== undefined]));
  for (;;) {
    const ws = /^[ \t]+/.exec(text.slice(i));
    if (!ws) break;
    const from = i + ws[0].length;
    const rest = text.slice(from);
    let len: number;
    const flag = FLAG.exec(rest);
    if (flag) {
      flagged = true;
      len = flag[0].length;
      const name = flag[0].split("=")[0]!;
      const v = flag[0].includes("=") ? undefined : /^[ \t]+/.exec(rest.slice(len));
      if (v) {
        // The value a flag takes (the help says it does): quoted, a placeholder, or a token; a
        // flag the help doesn't name takes a quoted value or a placeholder only.
        const after = rest.slice(len + v[0].length);
        const value =
          QUOTED.exec(after) ??
          PLACEHOLDER.exec(after) ??
          (flags.get(name) ? TOKEN.exec(after) : null);
        if (value && !value[0].startsWith("--"))
          len += v[0].length + value[0].replace(/\.+$/, "").length;
      }
    } else if (PLACEHOLDER.test(rest)) {
      len = PLACEHOLDER.exec(rest)![0].length;
      positional++;
    } else if (QUOTED.test(rest) && positional < slots) {
      len = QUOTED.exec(rest)![0].length;
      positional++;
    } else {
      const t = TOKEN.exec(rest)?.[0];
      if (!t || positional >= slots || flagged) break;
      // A sentence's end: the token's own trailing full stop isn't the argument's.
      const word = t.replace(/\.+$/, "");
      if (!word || STOP.has(word.toLowerCase()) || /^[A-Z]/.test(word)) break;
      len = word.length;
      positional++;
      i = from + len;
      if (word.length < t.length) break;
      continue;
    }
    i = from + len;
  }
  return i;
}

/** An `atticus <words>` command Atticus has, at `at` (on "atticus"). */
function commandAt(text: string, at: number, catalog: readonly CommandShape[]): Match | undefined {
  const after = text.slice(at + "atticus".length);
  if (!/^[ \t]+[a-z]/.test(after)) return undefined;
  let best: { c: CommandShape; len: number } | undefined;
  for (const c of catalog) {
    if (!c.words.length) continue;
    const re = new RegExp(`^[ \\t]+${c.words.map(escape).join("[ \\t]+")}(?![\\w-])`);
    const m = re.exec(after);
    if (m && (!best || c.words.length > best.c.words.length)) best = { c, len: m[0].length };
  }
  if (!best) return undefined;
  const start = at + "atticus".length + best.len;
  return { end: argumentsEnd(text, start, best.c), words: best.c.words };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether `at` starts a sentence or a clause after ": " (the command is its subject). */
function leadsClause(text: string, at: number): "sentence" | "clause" | undefined {
  const before = text.slice(0, at);
  if (/^\s*$/.test(before) || /[.!?]\s+$/.test(before)) return "sentence";
  if (/[:;]\s+$/.test(before)) return "clause";
  return undefined;
}

/** Takes out the commands from `text` (as found by `find`), with their lead-in. */
function takeOut(text: string, find: RegExp, end: (at: number, m: string) => Match | undefined) {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(find)) {
    const at = m.index;
    if (at < last) continue;
    const found = end(at, m[0]);
    if (found === undefined) continue;
    let stop = found.end;
    const rest = text.slice(stop);
    const before = text.slice(last, at);
    const lead = leadsClause(text, at);
    const verb = VERB.exec(before);
    if (verb) {
      // Review of the fix: "run atticus critic … again" says "run the critic again from the
      // app"; beta.27 final fixes: the action named, never an "it" with nothing before it.
      const adverb = /^[ \t]+(?:again|first)\b/.exec(rest)?.[0] ?? "";
      out += `${before.slice(0, verb.index)}${actionOf(verb[1]!, found.words)}${adverb} from the app`;
      stop += adverb.length;
    } else if (lead && /^[ \t]+[a-z]/.test(rest)) {
      // The command is the sentence's subject ("atticus verify x checks …"): the step says it.
      out += before + (lead === "sentence" ? "This step" : "this step");
    } else if (/\b(?:and|then)[ \t]+$/.test(before) && subjectNext(rest)) {
      // Review of the fix: "…, and atticus verify x checks them": Atticus does.
      out += before + "Atticus";
    } else if (JOIN.test(before) && /^\s*(?:[,.;:)]|$)/.test(rest)) {
      // Review of the fix: "…), then atticus verify x --write, so …": its "then" goes with it.
      out += before.replace(JOIN, "");
    } else {
      out += before.replace(LEAD_IN, "");
    }
    last = stop;
  }
  return out + text.slice(last);
}

const COMMAND = /^(?:atticus [a-z]|\/atticus-)/;

/**
 * Review of the fix: a bracket with a command in it: the command and the "or" that offers it go
 * as one unit, and what else the bracket says stays; a bracket left empty goes.
 */
function bracketsInAppWords(text: string): string {
  return text.replace(/(\s*)\(([^()]*)\)/g, (all, ws: string, inner: string) => {
    if (COMMAND.test(inner)) {
      // "(atticus todo, or Home › Manual steps in the app)": the alternative after it stays.
      const after = /^[^,;]*,[ \t]*or[ \t]+(.+)$/.exec(inner)?.[1];
      return after && !COMMAND.test(after) ? `${ws}(${after})` : "";
    }
    // "(X, or atticus …)" and "(or atticus …)": the "or" and its command go.
    const kept = inner.replace(/(?:,[ \t]*|^|[ \t]+)or[ \t]+(?:atticus [a-z]|\/atticus-).*$/, "");
    if (kept === inner) return all;
    return kept.trim() ? `${ws}(${kept.trim()})` : "";
  });
}

export function stepInAppWords(text: string, catalog: readonly CommandShape[]): string {
  // In brackets: a command to type, or an ADR to read, goes (the cockpit's own in-app words).
  let s = bracketsInAppWords(text)
    .replace(/\s*\(ADRs? \d{4}[^)]*\)/g, "")
    .replace(/\s*\(not-relevant --reason, or waive\)/g, " (Not relevant, or Waive)")
    .replace(/: pass --repo, or set metarepo under/g, ": set metarepo under");
  // Backticked: only a command Atticus has goes; any other code stays as it is.
  s = takeOut(s, /`(atticus [^`]*|\/atticus-[a-z-]+[^`]*)`/g, (at, m) => {
    const inner = m.slice(1, -1);
    if (inner.startsWith("/atticus-")) return { end: at + m.length };
    const c = commandAt(inner, 0, catalog);
    return c && c.end === inner.trimEnd().length
      ? { end: at + m.length, words: c.words }
      : undefined;
  });
  s = takeOut(s, /(?<![\w/.`-])\/atticus-[a-z][a-z-]*/g, (at, m) => ({
    end: argumentsEnd(s, at + m.length, undefined),
  }));
  s = takeOut(s, /(?<![\w/.`'"-])atticus(?=[ \t]+[a-z])/g, (at) => commandAt(s, at, catalog));
  return s
    .replace(/\s*\(\s*\)/g, "")
    .replace(/[ \t]+([.;,:)])/g, "$1")
    .replace(/[:;,]+(?=\.|$)/g, "")
    .replace(/,(?=,)/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

let cached: Promise<CommandShape[]> | undefined;

/** The commands Atticus has, from its help text (the help catalog, ADR 0096). */
export function commandShapes(): Promise<CommandShape[]> {
  cached ??= Promise.all([import("./main.js"), import("./command-catalog.js")]).then(([m, c]) =>
    c.commandCatalog(m.HELP_TEXT),
  );
  return cached;
}
