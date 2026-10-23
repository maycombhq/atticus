/**
 * Catching mistakes on the command line (ADR 0119 item 2). A flag no command knows (`--aprove`,
 * `--dryrun`) is refused with the nearest one, never ignored: on a command that writes, an
 * ignored flag means the write the person thought they'd stopped, or the one they thought they'd
 * asked for. A misspelled command gets the nearest command too.
 */

/** The `--name`s on a command line, up to `--`, without their `=value`. */
export function flagNames(argv: string[]): string[] {
  const out: string[] = [];
  for (const a of argv) {
    if (a === "--") break;
    if (a.startsWith("--") && a.length > 2) out.push(a.slice(2).split("=")[0]!);
  }
  return out;
}

/** The flags on a command line that no command knows, each once, in the order given. */
export function unknownFlags(argv: string[], known: ReadonlySet<string>): string[] {
  return [...new Set(flagNames(argv).filter((f) => !known.has(f)))];
}

/** Edit distance (insert, delete, change, swap two neighbours). */
export function distance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  return d[a.length]![b.length]!;
}

/**
 * The candidate nearest to a word, when it is near enough to be what was meant: a few letters
 * off for a long word, one for a short one, or the word with its hyphens left out.
 */
export function nearest(word: string, candidates: Iterable<string>): string | undefined {
  const w = word.toLowerCase();
  const flat = (s: string) => s.replace(/[-_\s]/g, "");
  const limit = w.length <= 4 ? 1 : w.length <= 8 ? 2 : 3;
  let best: { c: string; d: number } | undefined;
  for (const c of candidates) {
    const d = flat(c) === flat(w) ? 0 : distance(w, c.toLowerCase());
    if (d <= limit && (!best || d < best.d || (d === best.d && c < best.c))) best = { c, d };
  }
  return best?.c;
}

/** What to say for each unknown flag: the nearest known one, when there is one. */
export function unknownFlagMessages(unknown: string[], known: ReadonlySet<string>): string[] {
  return unknown.map((f) => {
    const n = nearest(f, known);
    return n ? `Unknown option --${f}. Did you mean --${n}?` : `Unknown option --${f}.`;
  });
}

/**
 * The command a person meant by misspelled words: the nearest command id, matching as many words
 * as were given (one word against first words, two against two-word commands).
 */
export function nearestCommand(words: string[], ids: string[]): string | undefined {
  const given = words.slice(0, 2).join(" ");
  if (!given) return undefined;
  const two = ids
    .filter((id) => id.split(" ").length >= 2)
    .map((id) => id.split(" ").slice(0, 2).join(" "));
  const one = ids.map((id) => id.split(" ")[0]!);
  const pool = words.length >= 2 ? [...new Set(two)] : [...new Set(one)];
  return nearest(given, pool) ?? (words.length >= 2 ? nearest(words[0]!, new Set(one)) : undefined);
}
