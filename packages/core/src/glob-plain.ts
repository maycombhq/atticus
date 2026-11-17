/**
 * The .gitignore lines and path globs that need no automaton (the field report of
 * 2.0.0-beta.28.3: a folder of clones took hours to read, each file of each clone matched
 * against each of a few hundred .gitignore lines by an automaton that made a set a character).
 * Most lines are a plain name, `*.ext` or `name*`: told by the path's own end or start. Used by
 * `globMatcher` (glob.ts) and by the walker's rules (repo-files.ts); the automaton answers every
 * other glob, and every path with a line end in it.
 */

const LINE_END = /[\n\r\u2028\u2029]/;

/** A glob's text as written: trimmed, \ as /, a leading ./ dropped. */
export function tidy(glob: string): string {
  return glob.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * A glob that is told by the path's own text, with no automaton: the whole path (`is`), the
 * path or its end after a `/` (`name`: `node_modules` at any depth), the path's end (`suffix`:
 * `*.class`), or the start of its last name (`prefix`: `npm-debug.log*`). True of paths with no
 * line end in them (`hasLineEnd`), which the automaton's `**` never spans.
 */
export interface PlainGlob {
  kind: "is" | "name" | "suffix" | "prefix";
  text: string;
}

/** Whether a path has a line end in it: such a path is the automaton's, never a plain test's. */
export function hasLineEnd(path: string): boolean {
  return LINE_END.test(path);
}

/** The plain test a glob comes to, as `globMatcher` reads it; undefined for any other glob. */
export function plainGlob(
  glob: string,
  anyDepth = !glob.replace(/\/$/, "").includes("/"),
): PlainGlob | undefined {
  let g = tidy(glob);
  if (g.startsWith("/")) {
    g = g.slice(1);
    anyDepth = false;
  }
  return plainOf(g, anyDepth);
}

/** The same for a glob `globMatcher` has tidied already (its own text, its depth settled). */
export function plainOf(g: string, anyDepth: boolean): PlainGlob | undefined {
  const special = /[*?[{]/;
  if (!special.test(g)) return { kind: anyDepth ? "name" : "is", text: g };
  if (!anyDepth) return undefined;
  const rest = g.slice(1);
  // `*.ext` at any depth: the path ends with it (what is before it in the name is `*`'s).
  if (g.startsWith("*") && rest && !special.test(rest) && !rest.includes("/"))
    return { kind: "suffix", text: rest };
  const head = g.slice(0, -1);
  // `name*` at any depth: the last name starts with it.
  if (g.endsWith("*") && head && !special.test(head) && !head.includes("/"))
    return { kind: "prefix", text: head };
  return undefined;
}

/** A plain glob's answer for a path with no line end in it. */
export function plainTest(g: PlainGlob, path: string): boolean {
  switch (g.kind) {
    case "is":
      return path === g.text;
    case "name":
      return (
        path === g.text ||
        (path.endsWith(g.text) && path.charCodeAt(path.length - g.text.length - 1) === 47)
      );
    case "suffix":
      return path.endsWith(g.text);
    case "prefix":
      return path.startsWith(g.text, path.lastIndexOf("/") + 1);
  }
}

/**
 * The longest plain text every path a glob matches must hold (`_i.` of `*_i.[ch]`, `gen` of a
 * line for any folder named gen): a path without it is no match, told before the automaton
 * runs. The glob as `globMatcher` tidied it; "" when it has no plain text outside its `{a,b}`.
 */
export function neededText(g: string): string {
  let best = "";
  let run = "";
  const cut = () => {
    if (run.length > best.length) best = run;
    run = "";
  };
  for (let i = 0; i < g.length; i++) {
    const ch = g[i]!;
    if (ch === "*") {
      cut();
      // `**/` is any folders or none: its `/` is its own, never text a path must hold.
      if (g[i + 1] === "*") i += g[i + 2] === "/" ? 2 : 1;
    } else if (ch === "?") cut();
    else if (ch === "[" && g.indexOf("]", i + 2) >= 0) {
      cut();
      i = g.indexOf("]", i + 2);
    } else if (ch === "{" && g.indexOf("}", i) >= 0) {
      cut();
      i = g.indexOf("}", i);
    } else run += ch;
  }
  cut();
  return best;
}
