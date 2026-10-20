import type Parser from "web-tree-sitter";
import { parseSyntax } from "./syntax.js";

/**
 * Calls in a Groovy file (Jenkinsfile, build.gradle), from its syntax tree (ADR 0060): each
 * call's name, its string arguments in order and its named arguments (`key: 'value'`, nested
 * ones included, as Jenkins' `recordCoverage(tools: [[pattern: '...']])` has), in source order.
 * Comments are never read; a string's value is its text without its quotes.
 */

type Node = Parser.SyntaxNode;

export interface GroovyCall {
  name: string;
  line: number;
  /** String arguments, in order (others are left out). */
  args: string[];
  /** Named arguments anywhere inside the call's argument list, first one wins. */
  named: Record<string, string>;
}

/** A string literal's value: its text without the quotes, ''' and """ included. */
function stringValue(n: Node): string | undefined {
  if (n.type !== "string_literal" && n.type !== "character_literal") return undefined;
  const t = n.text;
  const q = /^('''|""")/.test(t) ? 3 : 1;
  return t.length >= 2 * q ? t.slice(q, t.length - q) : undefined;
}

const kids = (n: Node | null | undefined) =>
  (n?.namedChildren ?? []).filter((c) => !/comment$/.test(c.type));

export async function groovyCalls(text: string): Promise<GroovyCall[]> {
  const tree = await parseSyntax("groovy", text);
  const out: { call: GroovyCall; at: number }[] = [];
  const walk = (n: Node) => {
    if (n.type === "method_invocation" || n.type === "juxt_function_call") {
      const name = n.childForFieldName("name");
      const list = n.childForFieldName(n.type === "method_invocation" ? "arguments" : "args");
      if (name) {
        const args: string[] = [];
        for (const a of kids(list)) {
          const v = stringValue(a);
          if (v !== undefined) args.push(v);
        }
        const named: Record<string, string> = {};
        const items = (x: Node) => {
          for (const c of kids(x)) {
            if (c.type === "map_item") {
              const k = c.childForFieldName("key")?.text;
              const v = c.childForFieldName("value");
              const s = v ? stringValue(v) : undefined;
              if (k && s !== undefined && !(k in named)) named[k] = s;
            }
            // Nested lists and maps, but not the closures of calls inside.
            if (c.type !== "closure" && c.type !== "method_invocation") items(c);
          }
        };
        items(list ?? n);
        out.push({
          call: { name: name.text, line: name.startPosition.row + 1, args, named },
          at: name.startIndex,
        });
      }
    }
    for (const c of kids(n)) walk(c);
  };
  walk(tree.rootNode);
  tree.delete();
  return out.sort((a, b) => a.at - b.at).map((x) => x.call);
}
