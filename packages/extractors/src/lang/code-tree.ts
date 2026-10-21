import type Parser from "web-tree-sitter";
import { useSyntaxTree, type ParsedAt, type SyntaxLanguage } from "./syntax.js";

/**
 * A small call layer over syntax trees (ADR 0060) that the built-in readers share: calls and
 * constructor calls with their callee, receiver, positional and named arguments, and string
 * literal values, the same way for Java, Kotlin, TypeScript/JavaScript, Python, Go, C# and
 * Scala. A call in a comment or a string is never a call, and nothing depends on spacing or
 * line breaks.
 */

export type Node = Parser.SyntaxNode;

export const isComment = (n: Node) => /comment$/.test(n.type);

/** Named children, comments left out. */
export const kids = (n: Node | null | undefined): Node[] =>
  (n?.namedChildren ?? []).filter((c) => !isComment(c));

/** 1-based line a node starts on. */
export const lineOf = (n: Node) => n.startPosition.row + 1;

/** Every named node under `n` (itself included), in source order; comments left out. */
export function* descendants(n: Node): Generator<Node> {
  // A cursor walk: much cheaper than asking every node for its children.
  const cur = n.walk();
  try {
    let depth = 0;
    for (;;) {
      if (cur.nodeIsNamed && !/comment$/.test(cur.nodeType)) yield cur.currentNode;
      if (cur.gotoFirstChild()) {
        depth++;
        continue;
      }
      while (depth > 0 && !cur.gotoNextSibling()) {
        cur.gotoParent();
        depth--;
      }
      if (depth === 0) return;
    }
  } finally {
    cur.delete();
  }
}

/**
 * The syntax tree of a file, handed to `use`: the repo scan's shared tree when `at` gives a parse
 * cache (ADR 0067), else one parsed here and freed after. `use` must not keep nodes.
 */
export async function withTree<T>(
  lang: SyntaxLanguage,
  text: string,
  use: (root: Node) => T,
  at?: ParsedAt,
): Promise<T> {
  return useSyntaxTree(lang, text, (tree) => use(tree.rootNode), at);
}

const TYPE_ARGS = /^(type_arguments|type_argument_list)$/;

/** Leaf texts joined, comments and generic type arguments left out: `a.b.C`, `Entity`. */
export function compactName(n: Node): string {
  if (TYPE_ARGS.test(n.type) || isComment(n)) return "";
  if (n.childCount === 0) return n.text;
  return n.children.map(compactName).join("");
}

/** Leaf texts joined, comments left out: an expression or type as written, without spaces. */
export function compact(n: Node): string {
  if (isComment(n)) return "";
  if (n.childCount === 0 || isString(n)) return n.text;
  return n.children.map(compact).join("");
}

/** Do two nodes stand for the same place in the tree? */
export const same = (a: Node | null | undefined, b: Node | null | undefined) =>
  !!a && !!b && a.startIndex === b.startIndex && a.endIndex === b.endIndex && a.type === b.type;

/** A callee or type as dotted names (`proto.harbor.Ledger` → 4 names), when it is only names. */
export function namePath(n: Node | null | undefined): string[] | undefined {
  if (!n) return undefined;
  const t = compactName(n);
  return /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(t) ? t.split(".") : undefined;
}

// ---------------------------------------------------------------- strings

/**
 * A string literal's contents as written between its quotes (escapes are not decoded), for
 * every grammar here. A string with interpolation (`${x}`, f"{x}", $"{x}") is only read with
 * `templates`, and then as written. Python's implicit concatenation ("a" "b") is joined.
 * Anything that isn't a string literal gives undefined.
 */
export function stringValue(n: Node | null | undefined, templates = false): string | undefined {
  if (!n) return undefined;
  const t = n.text;
  switch (n.type) {
    case "string": {
      // JavaScript, TypeScript, Scala and Python share the name.
      const start = n.namedChildren.find((c) => c.type === "string_start");
      const end = n.namedChildren.find((c) => c.type === "string_end");
      if (start && end) {
        if (!templates && n.namedChildren.some((c) => c.type === "interpolation")) return undefined;
        return t.slice(start.endIndex - n.startIndex, end.startIndex - n.startIndex);
      }
      if (/^"""/.test(t)) return t.slice(3, -3);
      return t.slice(1, -1);
    }
    case "concatenated_string": {
      const parts = kids(n).map((c) => stringValue(c, templates));
      return parts.every((p) => p !== undefined) ? parts.join("") : undefined;
    }
    case "template_string":
      if (!templates && n.namedChildren.some((c) => c.type === "template_substitution"))
        return undefined;
      return t.slice(1, -1);
    case "string_literal":
    case "line_string_literal":
    case "multi_line_string_literal": {
      // Java, Kotlin and C#.
      if (
        !templates &&
        n.namedChildren.some((c) => /interpolat|_expression$|template/.test(c.type))
      )
        return undefined;
      const q = t.startsWith('"""') ? 3 : 1;
      return t.slice(q, t.length - q);
    }
    case "verbatim_string_literal":
      return t.slice(2, -1);
    case "raw_string_literal": {
      // Go `...`, C# """...""".
      const q = /^"+/.exec(t)?.[0].length ?? 1;
      return t.slice(q, t.length - q);
    }
    case "interpreted_string_literal":
      return t.slice(1, -1);
    case "interpolated_string_expression":
      return templates ? t.replace(/^\$@?"|^@\$"/, "").slice(0, -1) : undefined;
    default:
      return undefined;
  }
}

/** A key of an object or dictionary literal as written: `path`, `"path"`, `'path'`. */
export function keyOf(pair: Node): string | undefined {
  const k = pair.childForFieldName("key");
  if (!k) return undefined;
  return stringValue(k) ?? (/identifier$/.test(k.type) ? k.text : undefined);
}

/** The value under `key` in an object (JS) or dictionary (Python) literal. */
export function objectProperty(n: Node | undefined, key: string): Node | undefined {
  if (n?.type !== "object" && n?.type !== "dictionary") return undefined;
  for (const p of kids(n))
    if (p.type === "pair" && keyOf(p) === key) return p.childForFieldName("value") ?? undefined;
  return undefined;
}

/** Is this node a string literal of any of the grammars here? */
export const isString = (n: Node) =>
  /^(string|concatenated_string|template_string|string_literal|line_string_literal|multi_line_string_literal|verbatim_string_literal|raw_string_literal|interpreted_string_literal|interpolated_string_expression)$/.test(
    n.type,
  );

// ---------------------------------------------------------------- calls

export interface CodeCall {
  node: Node;
  /** A constructor call: `new X(...)` (Java, JS, C#). */
  isNew: boolean;
  /** The callee as dotted names when it is only names: `spark.read.table` → 3 names. */
  path?: string[];
  /** The called name: the method, function or constructed type. */
  name: string;
  nameNode: Node;
  /** What the method is called on, if anything. */
  receiver?: Node;
  /** Generic type arguments as written: `Entity<Order>` → ["Order"]. */
  typeArgs: string[];
  /** Positional arguments (an argument wrapper is unwrapped to its expression). */
  args: Node[];
  /** Named arguments: Python `name=x`, Kotlin `name = x`, C# `name: x`. */
  kwargs: Map<string, Node>;
  /** Line of the called name. */
  line: number;
}

const field = (n: Node, name: string) => n.childForFieldName(name) ?? undefined;

/** The receiver and name node of a callee expression. */
function split(callee: Node): { receiver?: Node; name?: Node; typeArgs?: Node } {
  switch (callee.type) {
    case "member_expression": // JS
      return { receiver: field(callee, "object"), name: field(callee, "property") };
    case "attribute": // Python
      return { receiver: field(callee, "object"), name: field(callee, "attribute") };
    case "selector_expression": // Go
      return { receiver: field(callee, "operand"), name: field(callee, "field") };
    case "field_expression": // Scala
      return { receiver: field(callee, "value"), name: field(callee, "field") };
    case "member_access_expression": {
      // C#
      const nm = field(callee, "name");
      if (nm?.type === "generic_name")
        return {
          receiver: field(callee, "expression"),
          name: kids(nm).find((c) => c.type === "identifier"),
          typeArgs: kids(nm).find((c) => c.type === "type_argument_list"),
        };
      return { receiver: field(callee, "expression"), name: nm };
    }
    case "navigation_expression": {
      // Kotlin
      const suffix = kids(callee).find((c) => c.type === "navigation_suffix");
      return {
        receiver: kids(callee)[0],
        name: kids(suffix).find((c) => c.type === "simple_identifier"),
      };
    }
    case "generic_name": // C# Set<T>()
      return {
        name: kids(callee).find((c) => c.type === "identifier"),
        typeArgs: kids(callee).find((c) => c.type === "type_argument_list"),
      };
    case "generic_function": // Scala f[T](...)
      return { ...split(field(callee, "function")!), typeArgs: field(callee, "type_arguments") };
    case "qualified_name": {
      // C# type: A.B, A.B<T>
      const k = kids(callee);
      const last = k.at(-1);
      return { receiver: k.length > 1 ? k[0] : undefined, ...(last ? split(last) : {}) };
    }
    case "generic_type": {
      // Java and TS new X<T>()
      const base = kids(callee)[0];
      return {
        ...(base ? split(base) : {}),
        typeArgs: kids(callee).find((c) => c.type === "type_arguments"),
      };
    }
    case "scoped_type_identifier": {
      const k = kids(callee);
      return { receiver: k[0], name: k.at(-1) };
    }
    case "user_type": {
      const k = kids(callee).filter((c) => c.type === "type_identifier");
      return { name: k.at(-1), typeArgs: kids(callee).find((c) => c.type === "type_arguments") };
    }
    default:
      return /identifier$|^this$|^self$/.test(callee.type) ? { name: callee } : {};
  }
}

/** Arguments of an argument list, positional and named. */
function argumentsOf(list: Node | undefined): { args: Node[]; kwargs: Map<string, Node> } {
  const args: Node[] = [];
  const kwargs = new Map<string, Node>();
  if (!list) return { args, kwargs };
  if (
    !/^(arguments|argument_list|value_arguments|call_suffix)$/.test(list.type) &&
    list.type !== "attribute_argument_list"
  ) {
    // A tagged template or a lambda passed without parentheses.
    args.push(list);
    return { args, kwargs };
  }
  for (const a of kids(list)) {
    if (a.type === "keyword_argument") {
      // Python name=value
      const k = field(a, "name");
      const v = field(a, "value");
      if (k && v) kwargs.set(k.text, v);
    } else if (a.type === "argument") {
      // C#: [name:] expression
      const nc = kids(a).find((c) => c.type === "name_colon");
      const v = kids(a)
        .filter((c) => c.type !== "name_colon" && c.type !== "modifier")
        .at(-1);
      if (!v) continue;
      if (nc) kwargs.set(kids(nc)[0]?.text ?? nc.text.replace(/:$/, ""), v);
      else args.push(v);
    } else if (a.type === "value_argument") {
      // Kotlin: [name =] expression
      const k = kids(a);
      const v = k.at(-1);
      if (!v) continue;
      if (k.length > 1 && k[0]!.type === "simple_identifier") kwargs.set(k[0]!.text, v);
      else args.push(v);
    } else if (a.type === "value_arguments") {
      const inner = argumentsOf(a);
      args.push(...inner.args);
      for (const [k, v] of inner.kwargs) kwargs.set(k, v);
    } else if (a.type === "annotated_lambda" || a.type === "lambda_literal") args.push(a);
    else if (!/^type_arguments$/.test(a.type)) args.push(a);
  }
  return { args, kwargs };
}

/** A call node read the same way in every grammar here; undefined for anything else. */
export function callOf(n: Node): CodeCall | undefined {
  let callee: Node | undefined;
  let list: Node | undefined;
  let isNew = false;
  let receiver: Node | undefined;
  let nameNode: Node | undefined;
  let typeArgs: Node | undefined;
  switch (n.type) {
    case "call_expression": {
      // JS, Go, Scala: function + arguments; Kotlin: callee + call_suffix.
      callee = field(n, "function");
      list = field(n, "arguments");
      typeArgs = field(n, "type_arguments");
      if (!callee) {
        callee = kids(n)[0];
        const suffix = kids(n).find((c) => c.type === "call_suffix");
        typeArgs = kids(suffix).find((c) => c.type === "type_arguments");
        list = suffix;
      }
      break;
    }
    case "call": // Python
      callee = field(n, "function");
      list = field(n, "arguments");
      break;
    case "invocation_expression": // C#
      callee = field(n, "function");
      list = field(n, "arguments");
      break;
    case "new_expression": // JS
      callee = field(n, "constructor");
      list = field(n, "arguments");
      typeArgs = field(n, "type_arguments");
      isNew = true;
      break;
    case "object_creation_expression": // Java, C#
      callee = field(n, "type");
      list = field(n, "arguments");
      isNew = true;
      break;
    case "method_invocation": {
      // Java: object.name(arguments)
      receiver = field(n, "object");
      nameNode = field(n, "name");
      list = field(n, "arguments");
      typeArgs = field(n, "type_arguments");
      break;
    }
    default:
      return undefined;
  }
  if (callee) {
    const s = split(callee);
    receiver = s.receiver;
    nameNode = s.name;
    typeArgs ??= s.typeArgs;
  }
  if (!nameNode) return undefined;
  const { args, kwargs } = argumentsOf(list);
  const path =
    n.type === "method_invocation"
      ? receiver
        ? namePath(receiver)?.concat(nameNode.text)
        : [nameNode.text]
      : namePath(callee);
  return {
    node: n,
    isNew,
    ...(path ? { path } : {}),
    name: nameNode.text,
    nameNode,
    ...(receiver ? { receiver } : {}),
    typeArgs: kids(typeArgs).map((t) => compactName(t)),
    args,
    kwargs,
    line: lineOf(nameNode),
  };
}

/** Every call in a tree, in source order. */
export function callsIn(root: Node): CodeCall[] {
  const out: CodeCall[] = [];
  for (const n of descendants(root)) {
    const c = callOf(n);
    if (c) out.push(c);
  }
  return out;
}

/**
 * The name an expression is assigned to: `const c = <n>`, `c := <n>`, `this.stub = <n>` (→ stub),
 * `val c = <n>`, `var c = <n>;`. Undefined when the value isn't assigned to a name.
 */
export function assignedName(n: Node): string | undefined {
  let v = n;
  while (
    v.parent &&
    /^(await_expression|await|parenthesized_expression|as_expression|non_null_expression|expression_list|equals_value_clause)$/.test(
      v.parent.type,
    )
  )
    v = v.parent;
  const p = v.parent;
  if (!p) return undefined;
  const lastName = (x: Node | null | undefined) => {
    const first = x?.type === "expression_list" ? kids(x)[0] : x;
    return namePath(first)?.at(-1);
  };
  switch (p.type) {
    case "variable_declarator": // JS, Java, C#
      return lastName(p.childForFieldName("name") ?? kids(p).find((c) => c.type === "identifier"));
    case "assignment": // Python
    case "assignment_expression": // JS, Java, C#
    case "assignment_statement": // Go
    case "short_var_declaration": // Go
      return same(p.childForFieldName("left"), v)
        ? undefined
        : lastName(p.childForFieldName("left"));
    case "var_spec": // Go
      return lastName(p.childForFieldName("name"));
    case "property_declaration": // Kotlin
      return kids(kids(p).find((c) => c.type === "variable_declaration")).find(
        (c) => c.type === "simple_identifier",
      )?.text;
    default:
      return undefined;
  }
}

/** Function and lambda nodes: where an enclosing call stops being "the call this is in". */
export const FUNCTION_NODE =
  /^(function_declaration|function_definition|function_expression|arrow_function|method_definition|method_declaration|lambda|lambda_expression|lambda_literal|anonymous_function|func_literal|generator_function_declaration|class_body|class_declaration|class_definition)$/;

/** The calls `n` is an argument of, innermost first, up to the function it is written in. */
export function enclosingCalls(n: Node): CodeCall[] {
  const out: CodeCall[] = [];
  for (let p = n.parent; p && !FUNCTION_NODE.test(p.type); p = p.parent) {
    const c = callOf(p);
    if (c) out.push(c);
  }
  return out;
}
