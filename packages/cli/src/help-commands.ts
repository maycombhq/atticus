import type { Output } from "./commands.js";
import { commandCatalog } from "./command-catalog.js";
import { nearestCommand } from "./flags.js";

/**
 * `atticus help [command]` (ADR 0119 item 2): one command's usage and options, as the full help
 * writes them, instead of all 230 lines. With no words it is the full help.
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

export function helpCommand(words: string[], help: string, io: Output): number {
  if (!words.length) {
    io.out(help);
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
    io.err("atticus help lists every command.");
    return 2;
  }
  for (const b of found) for (const l of b.lines) io.out(l.replace(/^ {2}/, ""));
  io.out("");
  io.out("Every command also takes --root <dir> (the metarepo) and --by <handle> (who is acting).");
  const id = commandOf(words, ids);
  if (id) io.out(`atticus explain ${id} says what it does in plain words.`);
  return 0;
}
