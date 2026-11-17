/**
 * Path globs for the code tools (grep `paths`, files, and every .gitignore line of a scanned
 * repo), matched in linear time. A glob is compiled to a small automaton and run over the path
 * one character at a time with a set of live states, so no glob, however its `*`s are laid out,
 * can backtrack: these run on the main thread with no time limit (final review, 2.0.0-beta.21).
 */

import { hasLineEnd, neededText, plainOf, plainTest, tidy } from "./glob-plain.js";

/** One step of the automaton: a character test, a fork, or the end. */
type State =
  | { kind: "char"; test: (c: string) => boolean; out: number }
  | { kind: "split"; outs: number[] }
  | { kind: "match" };

export interface GlobMatcher {
  test(path: string): boolean;
}

const notSlash = (c: string) => c !== "/";
/** What a regular expression's `.` matches, as the globs did before: not a line end. */
const anyChar = (c: string) => c !== "\n" && c !== "\r" && c !== "\u2028" && c !== "\u2029";

/** Sets of live states, and steps between them, one matcher remembers at most. */
const REMEMBERED = 4096;

class Builder {
  readonly states: State[] = [];
  add(s: State): number {
    this.states.push(s);
    return this.states.length - 1;
  }
  /** `c*` looping on a test, then on to next. */
  loop(test: (c: string) => boolean, next: number): number {
    const split = this.add({ kind: "split", outs: [] });
    const ch = this.add({ kind: "char", test, out: split });
    (this.states[split] as { outs: number[] }).outs.push(ch, next);
    return split;
  }
  /** `(?:.*\/)?` then next: any folders, or none. */
  folders(next: number): number {
    const slash = this.add({ kind: "char", test: (c) => c === "/", out: next });
    return this.add({ kind: "split", outs: [this.loop(anyChar, slash), next] });
  }
}

/**
 * The states for glob text g, ending at next; returns its start. `**` any folders, `*` and `?`
 * within one name, `[...]` a class, `{a,b}` either.
 */
function compile(b: Builder, g: string, next: number): number {
  // Built right to left, each piece's start handed to the one before it.
  type Piece = (next: number) => number;
  const pieces: Piece[] = [];
  for (let i = 0; i < g.length; i++) {
    const ch = g[i]!;
    if (ch === "*") {
      if (g[i + 1] === "*") {
        const slash = g[i + 2] === "/";
        pieces.push(slash ? (n) => b.folders(n) : (n) => b.loop(anyChar, n));
        i += slash ? 2 : 1;
      } else pieces.push((n) => b.loop(notSlash, n));
    } else if (ch === "?") pieces.push((n) => b.add({ kind: "char", test: notSlash, out: n }));
    else if (ch === "[") {
      const end = g.indexOf("]", i + 2);
      if (end < 0) pieces.push(lit("["));
      else {
        const body = g
          .slice(i + 1, end)
          .replace(/^!/, "^")
          .replace(/\\/g, "\\\\");
        // One character against one class: no repetition, so nothing to backtrack.
        const re = new RegExp(`^[${body}]$`);
        pieces.push((n) => b.add({ kind: "char", test: (c) => re.test(c), out: n }));
        i = end;
      }
    } else if (ch === "{") {
      const end = g.indexOf("}", i);
      if (end < 0) pieces.push(lit("{"));
      else {
        const parts = g
          .slice(i + 1, end)
          .split(",")
          .map((p) => {
            let t = tidy(p);
            if (t.startsWith("/")) t = t.slice(1);
            return t;
          });
        // Compile each part now so an invalid class throws when the glob is made.
        const probe = new Builder();
        for (const p of parts) compile(probe, p, probe.add({ kind: "match" }));
        pieces.push((n) => b.add({ kind: "split", outs: parts.map((p) => compile(b, p, n)) }));
        i = end;
      }
    } else pieces.push(lit(ch));
  }
  let at = next;
  for (let k = pieces.length - 1; k >= 0; k--) at = pieces[k]!(at);
  return at;

  function lit(c: string): Piece {
    return (n) => b.add({ kind: "char", test: (x) => x === c, out: n });
  }
}

/**
 * A glob as a matcher over a repo-relative path. A glob with no / matches a name at any depth;
 * a leading / anchors it at the top.
 */
export function globMatcher(
  glob: string,
  anyDepth = !glob.replace(/\/$/, "").includes("/"),
): GlobMatcher {
  let g = tidy(glob);
  if (g.startsWith("/")) {
    g = g.slice(1);
    anyDepth = false;
  }
  const b = new Builder();
  const end = b.add({ kind: "match" });
  let start = compile(b, g, end);
  if (anyDepth) start = b.folders(start);
  const states = b.states;

  // The common .gitignore lines need no automaton (the field report of 2.0.0-beta.28.3: a folder
  // of clones took hours to read, each file matched against each of a few hundred lines by an
  // automaton that made a set a character). A plain name, `*.ext` and `name*` are told by the
  // path's own end or start. A path with a line end in it is left to the automaton, whose `**`
  // never spans one.
  const plain = plainOf(g, anyDepth);
  const needed = neededText(g);

  /** Adds a state and every state its forks reach to the set. */
  const close = (set: Set<number>, s: number) => {
    const stack = [s];
    while (stack.length) {
      const at = stack.pop()!;
      if (set.has(at)) continue;
      set.add(at);
      const st = states[at]!;
      if (st.kind === "split") for (const o of st.outs) stack.push(o);
    }
  };

  // Every other glob: the same automaton, with each set of live states and each step from one
  // worked out once and remembered (paths of one repo share their characters and their sets).
  // Still linear in the path, and no glob can backtrack. What is remembered is bounded: past the
  // bound a step is worked out again each time, as it always was.
  interface Live {
    set: number[];
    accepts: boolean;
    /** By character code: the next set, or null when nothing is left alive. */
    next: Map<number, Live | null>;
    /** The same for the ASCII codes, which most of a path is: read without a lookup by key. */
    ascii: (Live | null | undefined)[];
  }
  const lives = new Map<string, Live>();
  let remembered = 0;
  const liveOf = (set: Set<number>): Live => {
    const sorted = [...set].sort((x, y) => x - y);
    const key = sorted.join(",");
    const had = lives.get(key);
    if (had) return had;
    const made: Live = { set: sorted, accepts: set.has(end), next: new Map(), ascii: [] };
    if (lives.size < REMEMBERED) lives.set(key, made);
    return made;
  };
  const first = new Set<number>();
  close(first, start);
  const begin = liveOf(first);
  const step = (from: Live, code: number): Live | null => {
    const had = code < 128 ? from.ascii[code] : from.next.get(code);
    if (had !== undefined) return had;
    const c = String.fromCharCode(code);
    const next = new Set<number>();
    for (const s of from.set) {
      const st = states[s]!;
      if (st.kind === "char" && st.test(c)) close(next, st.out);
    }
    const to = next.size ? liveOf(next) : null;
    if (remembered < REMEMBERED) {
      remembered++;
      if (code < 128) from.ascii[code] = to;
      else from.next.set(code, to);
    }
    return to;
  };

  return {
    test(path: string): boolean {
      if (plain && !hasLineEnd(path)) return plainTest(plain, path);
      if (needed && !path.includes(needed)) return false;
      let live = begin;
      for (let i = 0; i < path.length; i++) {
        const to = step(live, path.charCodeAt(i));
        if (!to) return false;
        live = to;
      }
      return live.accepts;
    },
  };
}
