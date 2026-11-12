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
 */

export type CommandShape = Pick<CommandInfo, "words" | "args" | "flags">;

/** Words that never are an argument: the sentence goes on after the command. */
const STOP = new Set(
  "a an and are as at be but by each every for from if in into is it its of on once or so that the then this to until when which while with without".split(
    " ",
  ),
);

/** The lead-in a command's removal takes with it ("…, then record it with atticus …"). */
const LEAD_IN = /(?:,\s*)?(?:\b(?:by running|by|with|using|running|run|type)\s+)?$/;

const PLACEHOLDER = /^<[^>\s]+>/;
const QUOTED = /^(?:'[^']*'|"[^"]*")/;
const FLAG = /^--[a-z][\w-]*(?:=\S*)?/;
const TOKEN = /^[^\s,;:`()]+/;

interface Match {
  /** Where the command's text ends (after its arguments). */
  end: number;
}

/** The command's arguments from `at` on (after its words), argument-shaped tokens only. */
function argumentsEnd(text: string, at: number, c: CommandShape | undefined): number {
  let i = at;
  let positional = 0;
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
      if (!t || positional >= slots) break;
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
  return { end: argumentsEnd(text, start, best.c) };
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
function takeOut(text: string, find: RegExp, end: (at: number, m: string) => number | undefined) {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(find)) {
    const at = m.index;
    if (at < last) continue;
    const stop = end(at, m[0]);
    if (stop === undefined) continue;
    const rest = text.slice(stop);
    const lead = leadsClause(text, at);
    if (lead && /^[ \t]+[a-z]/.test(rest)) {
      // The command is the sentence's subject ("atticus verify x checks …"): the step says it.
      out += text.slice(last, at) + (lead === "sentence" ? "This step" : "this step");
    } else {
      const head = text.slice(last, at).replace(LEAD_IN, "");
      out += head;
    }
    last = stop;
  }
  return out + text.slice(last);
}

export function stepInAppWords(text: string, catalog: readonly CommandShape[]): string {
  let s = text
    // In brackets: a command to type, or an ADR to read, goes (the cockpit's own in-app words).
    .replace(/\s*\((?:atticus |\/atticus-)[^)]*\)/g, "")
    .replace(/\s*\(ADRs? \d{4}[^)]*\)/g, "")
    .replace(/\s*\(not-relevant --reason, or waive\)/g, " (Not relevant, or Waive)")
    .replace(/: pass --repo, or set metarepo under/g, ": set metarepo under");
  // Backticked: only a command Atticus has goes; any other code stays as it is.
  s = takeOut(s, /`(atticus [^`]*|\/atticus-[a-z-]+[^`]*)`/g, (at, m) => {
    const inner = m.slice(1, -1);
    if (inner.startsWith("/atticus-")) return at + m.length;
    const c = commandAt(inner, 0, catalog);
    return c && c.end === inner.trimEnd().length ? at + m.length : undefined;
  });
  s = takeOut(s, /(?<![\w/.`-])\/atticus-[a-z][a-z-]*/g, (at, m) =>
    argumentsEnd(s, at + m.length, undefined),
  );
  s = takeOut(s, /(?<![\w/.`'"-])atticus(?=[ \t]+[a-z])/g, (at) => commandAt(s, at, catalog)?.end);
  return s
    .replace(/[ \t]+([.;,:])/g, "$1")
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
