import { describe, expect, it } from "vitest";
import { globMatcher } from "../src/glob.js";
import { ignoredBy, ignoreRules } from "../src/repo-files.js";
import { oldGlobMatcher, oldIgnoredBy, oldIgnoreRules } from "./glob-old.js";

/**
 * ADR 0199, the review (N2): the faster matcher against the one it replaced (release
 * 2.0.0-beta.28.3, kept in glob-old.ts), on seeded globs and paths, so the same cases run every
 * time: non-ASCII paths (the automaton's step for a code of 128 or more), a .gitignore's
 * negation and rule order, a directory-only plain rule, a plain rule in a nested .gitignore, and
 * the odd globs.
 */

/** A small seeded generator: the same sequence on every machine. */
function seeded(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  return {
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!,
  };
}

const NAMES = [
  "a",
  "b",
  "ab",
  "src",
  "gen",
  "x.log",
  "x.class",
  ".env",
  "é",
  "日本",
  "naïve.txt",
  "😀",
  "a b",
  "~$x",
];
const GLOB_PARTS = [
  "a",
  "b",
  "ab",
  "src",
  "gen",
  "x",
  ".log",
  ".class",
  ".env",
  "é",
  "日本",
  "😀",
  "~$",
  "*",
  "**",
  "**/",
  "/",
  "?",
  "[ab]",
  "[!a]",
  "[^a]",
  "[a-c]",
  "{a,b}",
  "{src,gen}/",
  ".",
  " ",
];
const ODD = [
  "",
  "/",
  "a/",
  "a\\b",
  "\\#x",
  "[!a]",
  "[^a]",
  " a",
  "a ",
  "  *.log  ",
  "**",
  "***",
  "*/",
  "/*",
  "!a",
  "#a",
  "[",
  "{",
  "[]",
  "{}",
  "a//b",
  "./a",
  "/./a",
  "é*",
  "*日本",
  "?😀",
];

function path(r: ReturnType<typeof seeded>): string {
  const n = 1 + r.int(4);
  return Array.from({ length: n }, () => r.pick(NAMES)).join("/");
}
function glob(r: ReturnType<typeof seeded>): string {
  const n = 1 + r.int(4);
  return Array.from({ length: n }, () => r.pick(GLOB_PARTS)).join("");
}
/** Both matchers for a glob, or that both refuse it. */
function both(g: string, anyDepth?: boolean) {
  let was: ReturnType<typeof oldGlobMatcher> | undefined;
  let now: ReturnType<typeof globMatcher> | undefined;
  let wasThrew = false;
  let nowThrew = false;
  try {
    was = oldGlobMatcher(g, anyDepth);
  } catch {
    wasThrew = true;
  }
  try {
    now = globMatcher(g, anyDepth);
  } catch {
    nowThrew = true;
  }
  return { was, now, wasThrew, nowThrew };
}

describe("the matcher answers as the one it replaced", () => {
  const r = seeded(20261116);
  const paths = [
    ...Array.from({ length: 300 }, () => path(r)),
    "",
    "/",
    "a",
    "a/",
    "a\\b",
    "#x",
    "\\#x",
    " a",
    "a ",
    "é/日本/😀.log",
    "日本/x.class",
    "a\nb/x.log",
    "a/ /b",
  ];

  it("on 4,000 seeded globs and the odd ones, at every depth setting, over ASCII and non-ASCII paths", () => {
    const globs = [...ODD, ...Array.from({ length: 4000 }, () => glob(r))];
    const wrong: string[] = [];
    let compared = 0;
    for (const g of globs)
      for (const anyDepth of [undefined, true, false] as const) {
        const m = both(g, anyDepth);
        if (m.wasThrew !== m.nowThrew) wrong.push(`${JSON.stringify(g)} throws differently`);
        if (!m.was || !m.now) continue;
        // Twice: a remembered step answers as one worked out.
        for (let round = 0; round < 2; round++)
          for (const p of paths) {
            compared++;
            if (m.was.test(p) !== m.now.test(p))
              wrong.push(`${JSON.stringify(g)} (${String(anyDepth)}) on ${JSON.stringify(p)}`);
          }
      }
    expect(wrong.slice(0, 20)).toEqual([]);
    expect(compared).toBeGreaterThan(5_000_000);
  }, 120_000);

  it("on seeded .gitignore files: negation, rule order, directory-only and nested files", () => {
    const LINES = [
      "a",
      "ab",
      "gen",
      "*.log",
      "*.class",
      "x.*",
      "~$*",
      ".env",
      "é",
      "*日本",
      "src/gen",
      "/a",
      "gen/",
      "a/",
      "é/",
      "!a",
      "!*.log",
      "!gen/",
      "!x.log",
      "!é",
      "**/gen/**",
      "src/**",
      "\\#x",
      "\\!a",
      "# a comment",
      "",
      "a b",
      "a ",
      " a",
      "[ab]",
      "!/src",
    ];
    const BASES = ["", "src", "a/b", "é"];
    const wrong: string[] = [];
    let compared = 0;
    for (let i = 0; i < 1500; i++) {
      // Up to three .gitignore files, each in its own folder, as the walker hands them down.
      const files = Array.from({ length: 1 + r.int(3) }, () => ({
        base: r.pick(BASES),
        text: Array.from({ length: 1 + r.int(6) }, () => r.pick(LINES)).join(
          r.pick(["\n", "\r\n"]),
        ),
      }));
      const was = files.flatMap((f) => oldIgnoreRules(f.text, f.base));
      const now = files.flatMap((f) => ignoreRules(f.text, f.base));
      expect(now.map((x) => [x.base, x.negate, x.dirOnly])).toEqual(
        was.map((x) => [x.base, x.negate, x.dirOnly]),
      );
      for (const p of paths)
        for (const isDir of [false, true]) {
          compared++;
          if (oldIgnoredBy(was, p, isDir) !== ignoredBy(now, p, isDir))
            wrong.push(`${JSON.stringify(files)} on ${JSON.stringify(p)} (dir ${String(isDir)})`);
        }
    }
    expect(wrong.slice(0, 10)).toEqual([]);
    expect(compared).toBeGreaterThan(900_000);
  }, 120_000);

  it("names the cases the review asked for, each by hand", () => {
    const ig = (text: string, base: string, p: string, isDir = false) => {
      const now = ignoredBy(ignoreRules(text, base), p, isDir);
      expect(now, `${JSON.stringify(text)} @${base} on ${p}`).toBe(
        oldIgnoredBy(oldIgnoreRules(text, base), p, isDir),
      );
      return now;
    };
    // Rule order and negation: the last line that matches decides.
    expect(ig("*.log\n!keep.log", "", "a/keep.log")).toBe(false);
    expect(ig("!keep.log\n*.log", "", "a/keep.log")).toBe(true);
    // A directory-only plain rule ignores the folder, never a file of that name.
    expect(ig("gen/", "", "a/gen", true)).toBe(true);
    expect(ig("gen/", "", "a/gen", false)).toBe(false);
    // A plain rule in a nested .gitignore is of its own folder only.
    expect(ig("gen", "src", "src/a/gen")).toBe(true);
    expect(ig("gen", "src", "lib/gen")).toBe(false);
    expect(ig("/gen", "src", "src/a/gen")).toBe(false);
    expect(ig("/gen", "src", "src/gen")).toBe(true);
    // Non-ASCII names, plain and with a star.
    expect(ig("日本", "", "a/日本")).toBe(true);
    expect(ig("*.日本", "", "é/x.日本")).toBe(true);
    expect(ig("é*", "", "a/été")).toBe(true);
    expect(ig("[!a]", "", "é")).toBe(true);
    // An escaped # is a name; spaces around a line go (the matcher trims its glob), as before.
    expect(ig("\\#x", "", "a/#x")).toBe(true);
    expect(ig("a  ", "", "a")).toBe(true);
    expect(ig(" a", "", "a")).toBe(true);
  });
});
