import type Parser from "web-tree-sitter";
import { syntaxLanguageOf, useSyntaxTree } from "./syntax.js";

/**
 * A file's declarations from its syntax tree (ADR 0118), for the outline context tool: every
 * node the grammar calls a declaration, definition or item that has a name, and a variable bound
 * to a function, nested as in the file. The annotations, decorators and attributes written on
 * each are given as written, with their lines. Nothing here says what a declaration means (an
 * endpoint, a job): the grammar's node names are the only rule, the same in every language, and
 * the model reading the outline decides. A function's body isn't read for more.
 */

export interface OutlineMark {
  line: number;
  /** As written, whitespace folded, at most 160 characters. */
  text: string;
}

export interface OutlineEntry {
  /** The line of its name. */
  line: number;
  /** How deep it is nested in other declarations; 0 at the top. */
  depth: number;
  /** The grammar's node name without its _declaration/_definition/_item/_spec: class, method. */
  kind: string;
  name: string;
  marks: OutlineMark[];
}

const DECL =
  /(_declaration|_definition|_item|_spec)$|^(class|module|method|singleton_method|function)$/;
/** Declarations that aren't a place in the code a reader looks for: imports, parameters, locals. */
const NOT =
  /import|package|^use_|using|parameter|variable|field|lexical|local|constant_declaration|enum_constant|extern|include|^decorated_definition$|^attribute/;
/** Annotations, decorators and attributes; not a type annotation (TypeScript, Python). */
const MARK =
  /^(?!.*type_annotation$)(.*_)?annotation$|^decorator$|^attribute(_item|_list|_group)?$/;
const CALLABLE = /method|function|constructor|^func|lambda|arrow|closure/;
const NAME = /(^|_)identifier$|^constant$|^name$|^word$/;
const MAX_DEPTH = 6;
const MAX_ENTRIES = 400;

const lineOf = (n: Parser.SyntaxNode) => n.startPosition.row + 1;
const fold = (s: string) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 160 ? `${t.slice(0, 159)}…` : t;
};

function nameOf(n: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  const named = n.childForFieldName("name");
  if (named) return named;
  return n.namedChildren.find((c) => NAME.test(c.type));
}

/** Its marks: its own children, those in its modifiers, and the marks written just before it. */
function marksOf(n: Parser.SyntaxNode): OutlineMark[] {
  const found: Parser.SyntaxNode[] = [];
  const before: Parser.SyntaxNode[] = [];
  for (let s = n.previousNamedSibling; s && MARK.test(s.type); s = s.previousNamedSibling)
    before.unshift(s);
  found.push(...before);
  for (const c of n.namedChildren) {
    if (MARK.test(c.type)) found.push(c);
    else if (/modifiers?$/.test(c.type))
      for (const m of c.namedChildren) if (MARK.test(m.type)) found.push(m);
  }
  return found.map((m) => ({ line: lineOf(m), text: fold(m.text) }));
}

function entryOf(n: Parser.SyntaxNode): { kind: string; name: Parser.SyntaxNode } | undefined {
  if (n.type === "variable_declarator") {
    const v = n.childForFieldName("value");
    const name = n.childForFieldName("name");
    if (v && name && /arrow_function|^function|lambda/.test(v.type))
      return { kind: "function", name };
    return undefined;
  }
  if (!DECL.test(n.type) || NOT.test(n.type)) return undefined;
  const name = nameOf(n);
  if (!name) return undefined;
  return {
    kind: n.type.replace(/_(declaration|definition|item|spec)$/, "").replace(/_/g, " "),
    name,
  };
}

/** The declarations of a file, or undefined when no grammar ships for its kind of file. */
export async function declarationOutline(
  path: string,
  text: string,
): Promise<OutlineEntry[] | undefined> {
  const lang = syntaxLanguageOf(path);
  if (!lang) return undefined;
  return useSyntaxTree(lang, text, (tree) => {
    const out: OutlineEntry[] = [];
    const visit = (n: Parser.SyntaxNode, depth: number) => {
      for (const c of n.namedChildren) {
        if (out.length >= MAX_ENTRIES) return;
        const e = entryOf(c);
        if (e) {
          out.push({
            line: lineOf(e.name),
            depth,
            kind: e.kind,
            name: fold(e.name.text),
            marks: marksOf(c.type === "variable_declarator" ? (c.parent ?? c) : c),
          });
          if (!CALLABLE.test(c.type) && depth + 1 < MAX_DEPTH) visit(c, depth + 1);
        } else if (!CALLABLE.test(c.type) && !(c.type === "variable_declarator")) visit(c, depth);
      }
    };
    visit(tree.rootNode, 0);
    return out;
  });
}
