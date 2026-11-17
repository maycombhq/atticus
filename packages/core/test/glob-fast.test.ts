import { describe, expect, it } from "vitest";
import { globMatcher } from "../src/glob.js";
import { ignoredBy, ignoreRules } from "../src/repo-files.js";

// A folder of clones took hours to read (field report, 2.0.0-beta.28.3): every file of a clone
// was matched against every line of its .gitignore by an automaton that made a set for each
// character of each path. The matcher answers the same for every glob and path, and a long
// .gitignore over a large clone is read in a moment.

/** The glob syntax as a regular expression: the reference the matcher must agree with. */
function reference(glob: string, anyDepth = !glob.replace(/\/$/, "").includes("/")): RegExp {
  let g = glob.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (g.startsWith("/")) {
    g = g.slice(1);
    anyDepth = false;
  }
  const part = (t: string): string => {
    let re = "";
    for (let i = 0; i < t.length; i++) {
      const c = t[i]!;
      if (c === "*") {
        if (t[i + 1] === "*") {
          const slash = t[i + 2] === "/";
          re += slash ? "(?:.*/)?" : ".*";
          i += slash ? 2 : 1;
        } else re += "[^/]*";
      } else if (c === "?") re += "[^/]";
      else if (c === "[" && t.indexOf("]", i + 2) >= 0) {
        const end = t.indexOf("]", i + 2);
        re += `[${t
          .slice(i + 1, end)
          .replace(/^!/, "^")
          .replace(/\\/g, "\\\\")}]`;
        i = end;
      } else if (c === "{" && t.indexOf("}", i) >= 0) {
        const end = t.indexOf("}", i);
        re += `(?:${t
          .slice(i + 1, end)
          .split(",")
          .map((p) => part(p.trim().replace(/^\.\//, "").replace(/^\//, "")))
          .join("|")})`;
        i = end;
      } else re += c.replace(/[.+^${}()|[\]\\/-]/g, "\\$&");
    }
    return re;
  };
  return new RegExp(`^${anyDepth ? "(?:.*/)?" : ""}${part(g)}$`);
}

const GLOBS = [
  "generated",
  "node_modules",
  "*.class",
  "*.log",
  "*",
  "**",
  "?",
  "a*",
  "npm-debug.log*",
  "~$*",
  "*~",
  "*.s?o",
  "*_i.[ch]",
  "[Bb]in",
  "[Dd]ebug*",
  "*.{ts,js}",
  "{src,lib}/*.ts",
  "/top.md",
  "/build",
  "docs/*.md",
  "docs/**",
  "**/gen/**",
  "**/gen",
  "a/**/b",
  "src/**/*.java",
  "tmp/*.log",
  "a.b",
  "a+(b)",
  "[x",
  "{x",
  ".env",
  ".env.*",
  "*.",
  "x*y*z",
  "*a*a*a",
  "target/classes",
  "./docs/*.md",
  "*.log*",
  "**/*.log",
  "***",
  "a**b",
  "*/",
];

const PATHS = [
  "",
  "a",
  "generated",
  "a/generated",
  "generated/a",
  "node_modules/x/index.js",
  "x.class",
  "a/b/c/X.class",
  "x.classy",
  ".class",
  "a.log",
  "a/b.log",
  "a.log.1",
  "npm-debug.log",
  "npm-debug.log.3",
  "a/npm-debug.log.3",
  "~$report.docx",
  "a/~$x",
  "x~",
  "a.sXo",
  "a/lib_i.c",
  "Bin",
  "bin",
  "a/bin",
  "Debug-x",
  "y.ts",
  "x/y.js",
  "lib/a.ts",
  "x/lib/a.ts",
  "top.md",
  "a/top.md",
  "build",
  "a/build",
  "docs/a.md",
  "docs/a/b.md",
  "x/docs/a.md",
  "gen",
  "a/gen",
  "a/gen/b",
  "gen/b",
  "a/b",
  "a/x/b",
  "a/x/y/b",
  "src/main/java/App.java",
  "src/App.java",
  "tmp/a.log",
  "x/tmp/a.log",
  "a.b",
  "axb",
  "a+(b)",
  "[x",
  "{x",
  ".env",
  ".env.local",
  "a/.env",
  "x.",
  "xyz",
  "x1y2z",
  "x/y/z",
  "aaa",
  "banana",
  "target/classes",
  "a/target/classes",
  "a\nb/x.class",
  "a/b\n.class",
  "a /generated",
  "dir/",
  "/",
  "a//b",
];

describe("the glob matcher answers as the syntax says, for every glob and path", () => {
  for (const anyDepth of [undefined, true, false] as const)
    it(`agrees with the syntax's own regular expression (anyDepth ${String(anyDepth)})`, () => {
      const wrong: string[] = [];
      for (const g of GLOBS) {
        const m = globMatcher(g, anyDepth);
        const ref = reference(g, anyDepth);
        // Twice: an answer remembered is the answer worked out.
        for (let round = 0; round < 2; round++)
          for (const p of PATHS)
            if (m.test(p) !== ref.test(p)) wrong.push(`${g} on ${JSON.stringify(p)}`);
      }
      expect(wrong).toEqual([]);
    });

  it("a long .gitignore over a large clone is read in a moment", () => {
    // 300 lines, in the shapes the common templates use, over 5,000 paths: 1.5 million answers.
    const shapes = [
      "*.ext%d",
      "[Bb]uild%d/",
      "**/gen%d/**",
      "tmp%d/*.log",
      "*.s%d.cache",
      "/top%d",
      "out%d/",
      "*_i%d.[ch]",
      "~$%d*",
      "name%d",
    ];
    const text = Array.from({ length: 300 }, (_, i) =>
      shapes[i % shapes.length]!.replace("%d", String(i)),
    ).join("\n");
    const rules = ignoreRules(text, "");
    expect(rules).toHaveLength(300);
    const paths = Array.from(
      { length: 5000 },
      (_, f) =>
        `services/module-${f % 40}/src/main/java/forge/payments/p${f % 25}/Handler${f}.java`,
    );
    const started = Date.now();
    let ignored = 0;
    for (const p of paths) if (ignoredBy(rules, p, false)) ignored++;
    const ms = Date.now() - started;
    expect(ignored).toBe(0);
    expect(ignoredBy(rules, "a/b/x.ext10", false)).toBe(true);
    expect(ignoredBy(rules, "a/gen2/b/c.java", false)).toBe(true);
    expect(ignoredBy(rules, "a/name9", false)).toBe(true);
    expect(ignoredBy(rules, "a/~$8report", false)).toBe(true);
    // It took 11 seconds before (7 microseconds an answer); a slow shared runner is allowed for.
    expect(ms).toBeLessThan(3000);
  });

  it("a glob built to need many states still answers, and keeps no more than its bound", () => {
    // (a|b)*a(a|b)^k style: sets of states grow with every path; the matcher stops remembering.
    const g = `*a${"?".repeat(14)}`;
    const m = globMatcher(g);
    const ref = reference(g);
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const started = Date.now();
    for (let i = 0; i < 4000; i++) {
      let p = "";
      for (let k = 0; k < 30; k++) p += rand() < 0.5 ? "a" : "b";
      expect(m.test(p)).toBe(ref.test(p));
    }
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
