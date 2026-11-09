import { describe, expect, it } from "vitest";
import { globMatcher } from "../src/glob.js";

// The code tools' path globs (grep paths, files, every .gitignore line of a scanned repo) run on
// the main thread with no time limit, so they're matched in linear time, never by a backtracking
// regular expression (final review, 2.0.0-beta.21).

const m = (glob: string, path: string, anyDepth?: boolean) =>
  globMatcher(glob, anyDepth).test(path);

describe("globMatcher", () => {
  it("matches as the glob syntax says", () => {
    expect(m("*.java", "src/main/App.java")).toBe(true);
    expect(m("*.java", "App.java")).toBe(true);
    expect(m("*.java", "App.javax")).toBe(false);
    expect(m("src/**/*.java", "src/main/java/App.java")).toBe(true);
    expect(m("src/**/*.java", "src/App.java")).toBe(true);
    expect(m("src/**/*.java", "lib/src/App.java")).toBe(false);
    expect(m("src/*.java", "src/a/App.java")).toBe(false);
    expect(m("**", "a/b/c")).toBe(true);
    expect(m("a/**", "a/b/c")).toBe(true);
    expect(m("a/**", "b/a/c")).toBe(false);
    expect(m("?.md", "a.md")).toBe(true);
    expect(m("?.md", "ab.md")).toBe(false);
    expect(m("?", "/")).toBe(false);
    expect(m("[ab].md", "b.md")).toBe(true);
    expect(m("[!ab].md", "b.md")).toBe(false);
    expect(m("[!ab].md", "c.md")).toBe(true);
    expect(m("[a-c]x", "dx")).toBe(false);
    expect(m("*.{ts,js}", "x/y.js")).toBe(true);
    expect(m("*.{ts,js}", "y.ts")).toBe(true);
    expect(m("*.{ts,js}", "y.md")).toBe(false);
    expect(m("{src,lib}/*.ts", "lib/a.ts")).toBe(true);
    expect(m("{src,lib}/*.ts", "x/lib/a.ts")).toBe(false);
    expect(m("/top.md", "top.md")).toBe(true);
    expect(m("/top.md", "a/top.md")).toBe(false);
    expect(m("./docs/*.md", "docs/a.md")).toBe(true);
    expect(m("a.b", "axb")).toBe(false);
    expect(m("a+(b)", "a+(b)")).toBe(true);
    expect(m("[x", "[x")).toBe(true);
    expect(m("{x", "{x")).toBe(true);
    expect(m("generated", "generated", true)).toBe(true);
    expect(m("generated", "a/generated", true)).toBe(true);
    expect(m("tools/scratch.ts", "a/tools/scratch.ts", false)).toBe(false);
  });

  it("an invalid class still throws, as before", () => {
    expect(() => globMatcher("[z-a]")).toThrow();
  });

  it("a glob built to backtrack still answers at once", () => {
    const path = `src/${"a".repeat(40)}.java`;
    const started = Date.now();
    for (const k of [8, 12, 16, 40]) {
      expect(m(`${"*a".repeat(k)}!`, path)).toBe(false);
      expect(m(`**/${"**a".repeat(k)}!`, path)).toBe(false);
      expect(m(`{${"*a".repeat(k)}!,x}`, path)).toBe(false);
    }
    expect(m(`${"*a".repeat(12)}.java`, path)).toBe(true);
    expect(Date.now() - started).toBeLessThan(250);
  });
});
