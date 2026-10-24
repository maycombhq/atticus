import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { COPY } from "../src/copy.js";
import { SCREENS } from "../src/app/screens.js";

// The words a person reads come from src/copy.ts (CLAUDE.md, definition of done). This check
// reads every screen's JSX and fails on English typed straight into it: text between tags, the
// attributes a person reads or hears (aria-label, placeholder, title and the app's own label
// props), and the literal branches of an expression shown as text.

const SRC = fileURLToPath(new URL("../src", import.meta.url));

/** Attributes whose value a person reads or a screen reader speaks. */
const READ_ATTRS = new Set([
  "aria-label",
  "aria-description",
  "aria-roledescription",
  "placeholder",
  "title",
  "alt",
  "label",
  "caption",
  "emptyText",
  "why",
  "meta",
  "detail",
  "sub",
]);

/**
 * Words allowed inline, each with its reason. Keep it short: a new entry needs a reason a
 * reviewer accepts.
 */
const ALLOWED: { file: string; text: string; why: string }[] = [];

const WORDS = /[A-Za-z]{2,}/;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  );
}

/** The hard-coded words in one file's JSX, as "line: text". */
function hardCoded(source: string, name = "x.tsx"): string[] {
  const sf = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const at = (n: ts.Node, text: string) =>
    found.push(`${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}: ${text.trim()}`);
  // The literals an expression can evaluate to: its string, a template's own words, and the
  // branches of ?:, || and ?? (and the right side of &&).
  const literals = (n: ts.Expression): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      if (WORDS.test(n.text)) at(n, n.text);
    } else if (ts.isTemplateExpression(n)) {
      const parts = [n.head.text, ...n.templateSpans.map((s) => s.literal.text)];
      if (parts.some((p) => WORDS.test(p))) at(n, parts.join("…"));
      for (const s of n.templateSpans) literals(s.expression);
    } else if (ts.isConditionalExpression(n)) {
      literals(n.whenTrue);
      literals(n.whenFalse);
    } else if (ts.isBinaryExpression(n)) {
      const op = n.operatorToken.kind;
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
        literals(n.left);
        literals(n.right);
      } else if (op === ts.SyntaxKind.AmpersandAmpersandToken) literals(n.right);
    } else if (ts.isParenthesizedExpression(n)) literals(n.expression);
  };
  const visit = (n: ts.Node): void => {
    if (ts.isJsxText(n) && WORDS.test(n.text)) at(n, n.text.replace(/\s+/g, " "));
    if (ts.isJsxAttribute(n) && READ_ATTRS.has(n.name.getText()) && n.initializer) {
      const i = n.initializer;
      if (ts.isStringLiteral(i)) {
        if (WORDS.test(i.text)) at(i, i.text);
      } else if (ts.isJsxExpression(i) && i.expression) literals(i.expression);
    }
    if (
      ts.isJsxExpression(n) &&
      n.expression &&
      (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent))
    )
      literals(n.expression);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

describe("the copy file", () => {
  it("catches English typed into JSX, and lets copy and code through", () => {
    const sample = [
      'const a = <button title="Replay the tour">Help</button>;',
      'const b = <input placeholder={x ? "Find a change" : COPY.app.loading} />;',
      "const c = <p>{ok ? T.saved : `${n} left to do`}</p>;",
      'const d = <span className="chip warn" aria-label={COPY.app.loading}>{T.done}</span>;',
      'const e = <Command text="atticus scan" />;',
    ].join("\n");
    expect(hardCoded(sample)).toEqual([
      "1: Replay the tour",
      "1: Help",
      "2: Find a change",
      "3: … left to do",
    ]);
  });

  it("finds no hard-coded English in the screens or the app shell", () => {
    const bad: string[] = [];
    for (const dir of ["screens", "app"]) {
      for (const file of files(join(SRC, dir))) {
        if (!/\.tsx$/.test(file)) continue;
        const rel = relative(SRC, file).replace(/\\/g, "/");
        for (const hit of hardCoded(readFileSync(file, "utf8"), file)) {
          const text = hit.slice(hit.indexOf(": ") + 2);
          if (ALLOWED.some((a) => a.file === rel && a.text === text)) continue;
          bad.push(`${rel}:${hit}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("gives every exception a reason", () => {
    expect(ALLOWED.filter((a) => a.why.trim().length < 10)).toEqual([]);
  });

  it("names every screen, section and phase from the copy file", () => {
    const source = readFileSync(join(SRC, "app", "screens.ts"), "utf8");
    expect(source.match(/label: "[^"]*"/g) ?? []).toEqual([]);
    const words = new Set(Object.values(COPY.nav.screens) as string[]);
    expect(SCREENS.filter((s) => s.id in COPY.nav.screens && !words.has(s.label))).toEqual([]);
    expect(SCREENS.every((s) => s.label.length > 0)).toBe(true);
  });
});
