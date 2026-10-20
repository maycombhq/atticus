import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import Parser from "web-tree-sitter";

/**
 * Syntax trees for rules (ADR 0060): tree-sitter parsers for a dozen languages, shipped with
 * Atticus as prebuilt WebAssembly and loaded on first use. Nothing is downloaded or compiled.
 * A query's matches become places for a dialect rule, each capture with its text and line.
 */

const require = createRequire(import.meta.url);

/** Languages with a grammar in the bundle, by name as a rule writes it. */
export const SYNTAX_LANGUAGES = [
  "java",
  "kotlin",
  "typescript",
  "tsx",
  "javascript",
  "c_sharp",
  "python",
  "go",
  "scala",
  "ruby",
  "php",
  "rust",
  "groovy",
] as const;
export type SyntaxLanguage = (typeof SYNTAX_LANGUAGES)[number];

const BY_EXTENSION: [RegExp, SyntaxLanguage][] = [
  [/\.java$/i, "java"],
  [/\.kts?$/i, "kotlin"],
  [/\.tsx$/i, "tsx"],
  [/\.[cm]?ts$/i, "typescript"],
  [/\.[cm]?jsx?$/i, "javascript"],
  [/\.cs$/i, "c_sharp"],
  [/\.py$/i, "python"],
  [/\.go$/i, "go"],
  [/\.scala$/i, "scala"],
  [/\.rb$/i, "ruby"],
  [/\.php$/i, "php"],
  [/\.rs$/i, "rust"],
  [/(\.groovy|\.gradle|(^|\/)Jenkinsfile(\.[^/]*)?)$/i, "groovy"],
];

/** The language a file's name says, if a grammar for it ships. */
export const syntaxLanguageOf = (path: string): SyntaxLanguage | undefined =>
  BY_EXTENSION.find(([re]) => re.test(path))?.[1];

let ready: Promise<void> | undefined;
const languages = new Map<SyntaxLanguage, Promise<Parser.Language>>();
const queries = new Map<string, Parser.Query>();
const parsers = new Map<SyntaxLanguage, Parser>();

async function language(lang: SyntaxLanguage): Promise<Parser.Language> {
  ready ??= Parser.init();
  await ready;
  if (!languages.has(lang))
    languages.set(
      lang,
      Parser.Language.load(
        // Groovy is vendored in grammars/ (its package brings a native build we don't need).
        lang === "groovy"
          ? fileURLToPath(new URL("../../grammars/tree-sitter-groovy.wasm", import.meta.url))
          : require.resolve(`tree-sitter-wasms/out/tree-sitter-${lang}.wasm`),
      ),
    );
  return languages.get(lang)!;
}

/** A file's syntax tree. */
export async function parseSyntax(lang: SyntaxLanguage, text: string): Promise<Parser.Tree> {
  // The runtime initialises on first use: load the language before making a parser.
  const l = await language(lang);
  // One parser per language, reused: a parser lives in the WebAssembly heap until deleted, so
  // one per file would grow it without bound. Parsing is synchronous, so reuse is safe.
  let parser = parsers.get(lang);
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(l);
    parsers.set(lang, parser);
  }
  return parser.parse(text);
}

/** The tree as tree-sitter prints it, with node names a query uses; long trees are cut. */
export async function syntaxOutline(
  lang: SyntaxLanguage,
  text: string,
  maxChars = 4000,
): Promise<string> {
  const tree = await parseSyntax(lang, text);
  const s = tree.rootNode.toString();
  tree.delete();
  return s.length > maxChars ? `${s.slice(0, maxChars)} ...` : s;
}

export class SyntaxQueryError extends Error {
  override name = "SyntaxQueryError";
}

/** A capture's value: a string literal's contents without its quotes, else the text as written. */
function valueOf(node: Parser.SyntaxNode): string {
  const t = node.text;
  if (/string|char/i.test(node.type)) {
    const m = /^(?:[a-zA-Z@$]*)(["'`]{1,3})([\s\S]*)\1$/.exec(t);
    if (m) return m[2]!;
  }
  return t;
}

/** A query's matches in a file: each capture's value and line (1-based). */
export async function querySyntax(
  lang: SyntaxLanguage,
  text: string,
  query: string,
): Promise<{ captures: Record<string, { value: string; line: number }>; line: number }[]> {
  const l = await language(lang);
  const key = `${lang}\u0000${query}`;
  let q = queries.get(key);
  if (!q) {
    try {
      q = l.query(query);
    } catch (e) {
      throw new SyntaxQueryError(`the ${lang} query doesn't compile: ${(e as Error).message}`);
    }
    queries.set(key, q);
  }
  const tree = await parseSyntax(lang, text);
  const out: { captures: Record<string, { value: string; line: number }>; line: number }[] = [];
  for (const m of q.matches(tree.rootNode)) {
    // A pattern whose predicates failed comes back with no captures.
    if (m.captures.length === 0) continue;
    const captures: Record<string, { value: string; line: number }> = {};
    for (const c of m.captures)
      if (!(c.name in captures))
        captures[c.name] = { value: valueOf(c.node), line: c.node.startPosition.row + 1 };
    const first = m.captures.reduce((a, b) => (b.node.startIndex < a.node.startIndex ? b : a));
    out.push({ captures, line: first.node.startPosition.row + 1 });
  }
  tree.delete();
  return out;
}
