import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setFlagsFromString } from "node:v8";
import Parser from "web-tree-sitter";
import type { ParsedAt } from "./parsed.js";

export type { ParsedAt } from "./parsed.js";

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

/**
 * Grammars run as baseline WebAssembly code only. They are generated C with very large
 * functions, and V8's optimising compiler needed up to 2.2 GB of transient memory to tier one up
 * (measured: TSX; TypeScript 1.3 GB, Kotlin 0.5 GB), against about 0.1 GB for the process
 * otherwise. Where the machine didn't have it the process died ("Fatal process out of memory:
 * Zone", exit 0x80000003): the test-worker crashes under parallel load (ADR 0067). A file parses
 * up to about twice as slowly as baseline code, but each is parsed once per scan now and no time
 * goes to compiling; the M1 exit scan stayed about twice as fast as before the parse cache. Set
 * before the runtime compiles anything; Atticus runs no other WebAssembly.
 */
function baselineWasmOnly(): void {
  setFlagsFromString("--no-wasm-tier-up");
  setFlagsFromString("--no-wasm-dynamic-tiering");
}

async function language(lang: SyntaxLanguage): Promise<Parser.Language> {
  ready ??= (baselineWasmOnly(), Parser.init());
  await ready;
  if (!languages.has(lang)) languages.set(lang, Parser.Language.load(grammarFile(lang)));
  return languages.get(lang)!;
}

/**
 * Where a grammar's WebAssembly is. Groovy's is vendored in grammars/ (its package brings a
 * native build we don't need). The others are tree-sitter-wasms': installed from npm, Atticus is
 * one bundled package (@maycombhq/atticus, ADR 0124 addendum D-npm2) in which this module keeps
 * its place, packages/extractors/dist/lang/, and the grammars are copied to
 * vendor/tree-sitter-wasms/out/ four folders up; elsewhere (a checkout, the offline bundle) they
 * come from node_modules. `here` is this module's URL (a test passes another).
 */
export function grammarFile(lang: SyntaxLanguage, here: string = import.meta.url): string {
  if (lang === "groovy")
    return fileURLToPath(new URL("../../grammars/tree-sitter-groovy.wasm", here));
  const name = `tree-sitter-${lang}.wasm`;
  const shipped = fileURLToPath(new URL(`../../../../vendor/tree-sitter-wasms/out/${name}`, here));
  return existsSync(shipped) ? shipped : require.resolve(`tree-sitter-wasms/out/${name}`);
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
  const tree = parser.parse(text);
  live++;
  // Freed once: a second delete would free the same WebAssembly memory twice.
  const free = tree.delete.bind(tree);
  let freed = false;
  tree.delete = () => {
    if (freed) return;
    freed = true;
    live--;
    free();
  };
  return tree;
}

let live = 0;
/** Trees parsed and not yet freed in this process: for tests that prove trees don't leak. */
export const liveTrees = () => live;

/**
 * Hand a file's syntax tree to `use`. With a parse cache the tree is the scan's shared one,
 * parsed once for every reader of the file and freed when it leaves the cache or the scan ends
 * (never while `use` runs); without one it is parsed here and freed after. `use` must not keep
 * nodes past its return: the tree may be freed then.
 */
export async function useSyntaxTree<T>(
  lang: SyntaxLanguage,
  text: string,
  use: (tree: Parser.Tree) => T | Promise<T>,
  at?: ParsedAt,
): Promise<T> {
  if (at?.cache)
    return at.cache.use(`tree:${lang}`, at.path, text, (t) => parseSyntax(lang, t), use, {
      pool: "native",
      freeze: false,
      dispose: (tree) => tree.delete(),
    });
  const tree = await parseSyntax(lang, text);
  try {
    return await use(tree);
  } finally {
    tree.delete();
  }
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
  at?: ParsedAt,
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
  return useSyntaxTree(lang, text, (tree) => matchesOf(q, tree), at);
}

function matchesOf(
  q: Parser.Query,
  tree: Parser.Tree,
): { captures: Record<string, { value: string; line: number }>; line: number }[] {
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
  return out;
}
