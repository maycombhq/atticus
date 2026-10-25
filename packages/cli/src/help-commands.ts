import type { Output } from "./commands.js";
import { AREAS, commandCatalog } from "./command-catalog.js";
import { nearestCommand } from "./flags.js";
import { isLegacy, topHelp } from "./top-commands.js";

/**
 * `atticus help [command]` (ADR 0119 item 2): one command's usage and options, as the full help
 * writes them, instead of all 230 lines. With no words, the twelve (ADR 0124 addendum D-cli);
 * with --all, every command grouped by area.
 */

/** The help's blocks: a command's line and the option lines written under it. */
function blocks(help: string): { line: string; lines: string[] }[] {
  const out: { line: string; lines: string[] }[] = [];
  let current: { line: string; lines: string[] } | undefined;
  for (const l of help.split("\n")) {
    if (/^ {2}atticus /.test(l)) {
      current = { line: l.trim(), lines: [l] };
      out.push(current);
    } else if (current && /^ {6,}\S/.test(l)) current.lines.push(l);
    else current = undefined;
  }
  return out;
}

/** The command a command line names: the longest catalogue id its words start with. */
export function commandOf(words: string[], ids: string[]): string | undefined {
  let best: string | undefined;
  for (const id of ids) {
    const w = id.split(" ");
    if (w.length <= words.length && w.every((x, i) => x === words[i]))
      if (!best || w.length > best.split(" ").length) best = id;
  }
  return best;
}

/**
 * The help grouped by area (ADR 0119), in the order a person meets them: setting up, repos,
 * knowledge, the catalog, changes, plans, release. Atticus's own quality commands (bench, eval,
 * conformance...) only with `all`. The lines are the full help's, unchanged, so each command reads
 * the same here, in `atticus help <command>` and in the catalogue.
 */
export function groupedHelp(
  help: string,
  o: {
    all?: boolean;
    /** Only the commands whose first word this keeps (atticus legacy). */
    only?: (first: string) => boolean;
    /** The lines in place of the help's own first ones. */
    head?: string[];
    /** The line that says what --all adds. */
    more?: string;
  } = {},
): string {
  const lines = help.split("\n");
  const first = lines.findIndex((l) => /^ {2}atticus /.test(l));
  const head = lines.slice(0, first);
  const areaOf = new Map(commandCatalog(help).map((c) => [c.usage, c.area]));
  const byArea = new Map<string, string[]>();
  const steps: string[] = [];
  const general: string[] = [];
  for (const b of blocks(help)) {
    const usage = b.line.split(/ {2,}/)[0]!;
    if (/^atticus (--help|--version)/.test(usage)) general.push(...b.lines);
    else if (/^atticus <step>/.test(usage)) steps.push(...b.lines);
    else {
      const first = /^atticus ([a-z][a-z-]*)/.exec(usage)?.[1] ?? "";
      if (o.only && !o.only(first)) continue;
      const area = areaOf.get(usage) ?? "start";
      byArea.set(area, [...(byArea.get(area) ?? []), ...b.lines]);
    }
  }
  const globals = lines.filter((l) => /^ {2}--/.test(l));
  const tail = lines
    .slice(lines.findLastIndex((l) => /^ {2}\S/.test(l)) + 1)
    .filter((l) => l.trim());
  const out = o.head ? [...o.head] : [...head.filter((l) => l.trim() !== "Usage:")];
  while (out.length && !out.at(-1)!.trim()) out.pop();
  out.push("");
  for (const a of AREAS) {
    if (a.id === "developer" && !o.all) continue;
    const body = byArea.get(a.id);
    if (!body?.length) continue;
    out.push(`${a.title}:`, ...body, "");
  }
  if (steps.length) out.push("Every AI step:", ...steps, "");
  out.push("Every command:", ...globals, ...general, "");
  if (!o.all)
    out.push(o.more ?? "atticus help --all also lists the commands for Atticus's own quality.");
  out.push(...tail);
  return out.join("\n");
}

/**
 * `atticus legacy` (ADR 0124 addendum D-cli): every command outside the twelve, grouped by area
 * as the full help groups them, each line as the full help writes it. Each still runs by its own
 * name, or as `atticus legacy <command>`.
 */
export function legacyHelp(help: string, o: { all?: boolean } = {}): string {
  return groupedHelp(help, {
    ...o,
    only: isLegacy,
    head: [
      "atticus legacy: every command outside the twelve atticus help shows.",
      "Each runs as before, by its own name (atticus scan) or as atticus legacy scan.",
    ],
    more: "atticus legacy --all also lists the commands for Atticus's own quality.",
  });
}

export function helpCommand(
  words: string[],
  help: string,
  io: Output,
  o: { all?: boolean } = {},
): number {
  if (!words.length) {
    io.out(o.all ? groupedHelp(help, o) : topHelp(help.split("\n")[0]!));
    return 0;
  }
  const asked = words.join(" ");
  const ids = commandCatalog(help).map((c) => c.id);
  const found = blocks(help).filter((b) => {
    const line = b.line.slice("atticus ".length);
    return line === asked || line.startsWith(`${asked} `);
  });
  if (!found.length) {
    const near = nearestCommand(words, ids);
    io.err(
      `atticus help has nothing for "${asked}".${near ? ` Did you mean atticus help ${near}?` : ""}`,
    );
    io.err("atticus help --all lists every command.");
    return 2;
  }
  for (const b of found) for (const l of b.lines) io.out(l.replace(/^ {2}/, ""));
  io.out("");
  io.out("Every command also takes --root <dir> (the metarepo) and --by <handle> (who is acting).");
  const id = commandOf(words, ids);
  if (id) io.out(`atticus explain ${id} says what it does in plain words.`);
  return 0;
}
