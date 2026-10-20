import type Parser from "web-tree-sitter";
import { parseSyntax } from "./syntax.js";
import type { AnnValue, Annotation, Call, Decl, DeclKind, JavaFile } from "./java.js";

/**
 * Java and Kotlin read from their syntax trees (ADR 0060), into the same JavaFile the Spring
 * extractor, dialects and the framework learner use: declarations with their annotations and
 * enclosing type, and method calls with their arguments. Comments and strings are never taken
 * for code, and nothing depends on line breaks or spacing.
 */

type Node = Parser.SyntaxNode;

const named = (n: Node | null | undefined): Node[] =>
  (n?.namedChildren ?? []).filter((c) => !/comment$/.test(c.type));
const line = (n: Node) => n.startPosition.row + 1;
const lastSegment = (s: string) => s.split(".").pop()!;

/** Leaf texts joined: an expression as written, without spaces. */
function compact(n: Node): string {
  if (n.childCount === 0 || /string/.test(n.type)) return n.text;
  return n.children.map(compact).join("");
}

// ---------------------------------------------------------------- string literals

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", s: " " };

/** A Java string literal's value (escapes decoded). */
function javaString(n: Node): string {
  let out = "";
  for (const c of n.namedChildren) {
    if (c.type === "string_fragment" || c.type === "multiline_string_fragment") out += c.text;
    else if (c.type === "escape_sequence") {
      const e = c.text.slice(1);
      out +=
        ESCAPES[e] ??
        (/^u[0-9a-fA-F]{4}$/.test(e) ? String.fromCharCode(parseInt(e.slice(1), 16)) : e);
    }
  }
  return out;
}

/** A Kotlin string literal's content as written between the quotes (templates kept). */
function kotlinString(n: Node): string {
  const t = n.text;
  const q = t.startsWith('"""') ? 3 : 1;
  return t.slice(q, t.length - q).replace(/\\(["\\$])/g, "$1");
}

const isString = (n: Node) => n.type === "string_literal" || n.type === "line_string_literal";

// ---------------------------------------------------------------- values

/** An expression as an annotation value: literals as text, a bare name as ${Name} in `shown`. */
function value(n: Node, kotlin: boolean): { v: AnnValue; shown?: AnnValue } {
  if (n.type === "element_value_array_initializer" || n.type === "collection_literal") {
    const items: string[] = [];
    const shown: string[] = [];
    let any = false;
    for (const c of named(n)) {
      const r = value(c, kotlin);
      const v = typeof r.v === "string" ? [r.v] : r.v;
      items.push(...v);
      if (r.shown !== undefined) any = true;
      const sh = r.shown ?? r.v;
      shown.push(...(typeof sh === "string" ? [sh] : sh));
    }
    return any ? { v: items, shown } : { v: items };
  }
  const parts = flatten(n, kotlin);
  const v = parts.map((p) => p.text).join("");
  return parts.some((p) => p.name)
    ? { v, shown: parts.map((p) => (p.name ? `\${${p.text}}` : p.text)).join("") }
    : { v };
}

/** "a" + Name.X + "b" as parts: literal text, or a name. */
function flatten(n: Node, kotlin: boolean): { text: string; name: boolean }[] {
  if (
    (n.type === "binary_expression" || n.type === "additive_expression") &&
    /\+/.test(n.child(1)?.text ?? "")
  ) {
    const [l, r] = [named(n)[0], named(n).at(-1)];
    return [...(l ? flatten(l, kotlin) : []), ...(r ? flatten(r, kotlin) : [])];
  }
  if (n.type === "parenthesized_expression" && named(n).length === 1)
    return flatten(named(n)[0]!, kotlin);
  if (isString(n)) return [{ text: kotlin ? kotlinString(n) : javaString(n), name: false }];
  if (/literal$/.test(n.type) || ["true", "false", "null"].includes(n.text))
    return [{ text: n.text, name: false }];
  return [{ text: compact(n), name: true }];
}

/** A call argument: its value when it is only string literals, and how it reads as written. */
function argument(n: Node, kotlin: boolean): { literal?: string; shown: string } {
  const parts: { text: string; lit: boolean }[] = [];
  const walk = (x: Node) => {
    if (
      (x.type === "binary_expression" || x.type === "additive_expression") &&
      x.child(1)?.text === "+"
    ) {
      walk(named(x)[0]!);
      walk(named(x).at(-1)!);
    } else if (isString(x))
      parts.push({ text: kotlin ? kotlinString(x) : javaString(x), lit: true });
    else parts.push({ text: compact(x), lit: false });
  };
  walk(n);
  const literal = parts.every((p) => p.lit) ? parts.map((p) => p.text).join("") : undefined;
  return {
    ...(literal !== undefined && literal !== "" ? { literal } : {}),
    shown: parts.map((p) => (p.lit ? p.text : `\${${p.text}}`)).join(""),
  };
}

// ---------------------------------------------------------------- annotations

function javaAnnotation(n: Node): Annotation {
  const nameNode = n.childForFieldName("name")!;
  const attrs: Record<string, AnnValue> = {};
  const shown: Record<string, AnnValue> = {};
  for (const a of named(n.childForFieldName("arguments"))) {
    const isPair = a.type === "element_value_pair";
    const key = isPair ? a.childForFieldName("key")!.text : "value";
    const val = isPair ? a.childForFieldName("value") : a;
    if (!val) continue;
    const r = value(val, false);
    attrs[key] = r.v;
    if (r.shown !== undefined) shown[key] = r.shown;
  }
  const out: Annotation = { name: lastSegment(nameNode.text), attrs, line: line(nameNode) };
  if (Object.keys(shown).length) out.named = shown;
  return out;
}

function kotlinAnnotation(n: Node): Annotation | undefined {
  const inv = named(n).find((c) => c.type === "constructor_invocation");
  const type = inv
    ? named(inv).find((c) => c.type === "user_type")
    : named(n).find((c) => c.type === "user_type");
  if (!type) return undefined;
  const attrs: Record<string, AnnValue> = {};
  const shown: Record<string, AnnValue> = {};
  for (const a of named(named(inv).find((c) => c.type === "value_arguments"))) {
    const kids = named(a);
    const key = kids.length > 1 && kids[0]!.type === "simple_identifier" ? kids[0]!.text : "value";
    const val = kids.at(-1);
    if (!val) continue;
    const r = value(val, true);
    attrs[key] = r.v;
    if (r.shown !== undefined) shown[key] = r.shown;
  }
  const out: Annotation = {
    name: lastSegment(type.text.replace(/<.*$/, "")),
    attrs,
    line: line(type),
  };
  if (Object.keys(shown).length) out.named = shown;
  return out;
}

function annotationsOf(n: Node, kotlin: boolean): Annotation[] {
  const mods = named(n).find((c) => c.type === "modifiers");
  if (!mods) return [];
  const out: Annotation[] = [];
  for (const c of named(mods)) {
    if (!kotlin && (c.type === "annotation" || c.type === "marker_annotation"))
      out.push(javaAnnotation(c));
    if (kotlin && c.type === "annotation") {
      const a = kotlinAnnotation(c);
      if (a) out.push(a);
    }
  }
  return out;
}

// ---------------------------------------------------------------- the walk

const JAVA_TYPES: Record<string, DeclKind> = {
  class_declaration: "class",
  interface_declaration: "interface",
  enum_declaration: "enum",
  record_declaration: "record",
  annotation_type_declaration: "annotation-type",
};

/** Simple names a type node names (generic arguments left out). */
function typeNames(n: Node | null | undefined): string[] {
  if (!n) return [];
  if (n.type === "type_identifier" || n.type === "scoped_type_identifier")
    return [lastSegment(n.text)];
  if (n.type === "generic_type") return typeNames(named(n)[0]);
  if (n.type === "user_type")
    return [
      lastSegment(
        named(n)
          .filter((c) => c.type === "type_identifier")
          .at(-1)?.text ?? n.text,
      ),
    ];
  return named(n).flatMap((c) => (c.type === "type_arguments" ? [] : typeNames(c)));
}

/** Parse a Java (or, with lang "kotlin", Kotlin) source file. */
export async function parseJavaTree(
  src: string,
  lang: "java" | "kotlin" = "java",
): Promise<JavaFile> {
  const tree = await parseSyntax(lang, src);
  const kotlin = lang === "kotlin";
  const decls: Decl[] = [];
  const calls: Call[] = [];
  /** Where each call's name is, so calls are listed in source order (a chain is read outside in). */
  const at = new Map<Call, number>();
  const imports: string[] = [];
  const constants: JavaFile["constants"] = [];
  const variables: JavaFile["variables"] = [];
  let packageName: string | undefined;
  const variable = (name: Node | null | undefined, type: Node | null | undefined) => {
    const t = typeNames(type)[0];
    if (name && t && t !== "var") variables.push({ name: name.text, type: t, line: line(name) });
  };

  const push = (n: Node, c: Call) => {
    calls.push(c);
    at.set(c, n.startIndex);
  };
  const walk = (n: Node, type: Decl | undefined, method: Decl | undefined): void => {
    const t = n.type;
    if (t === "package_declaration" || t === "package_header") {
      packageName ??= (named(n).find((c) => /identifier/.test(c.type)) ?? n).text;
      return;
    }
    if (t === "import_declaration") {
      const id = named(n).find((c) => /identifier/.test(c.type));
      if (id) imports.push(`${id.text}${named(n).some((c) => c.type === "asterisk") ? ".*" : ""}`);
      return;
    }
    if (t === "import_header") {
      const id = named(n).find((c) => c.type === "identifier");
      if (id)
        imports.push(`${id.text}${named(n).some((c) => c.type === "wildcard_import") ? ".*" : ""}`);
      return;
    }
    // Type declarations.
    const javaKind = !kotlin ? JAVA_TYPES[t] : undefined;
    const kotlinType = kotlin && (t === "class_declaration" || t === "object_declaration");
    if (javaKind || kotlinType) {
      const nameNode = kotlin
        ? named(n).find((c) => c.type === "type_identifier")
        : n.childForFieldName("name");
      if (!nameNode) return;
      const kind: DeclKind =
        javaKind ??
        (n.children.some((c) => c.type === "interface")
          ? "interface"
          : /\benum\b/.test(named(n).find((c) => c.type === "modifiers")?.text ?? "")
            ? "enum"
            : /\bannotation\b/.test(named(n).find((c) => c.type === "modifiers")?.text ?? "")
              ? "annotation-type"
              : "class");
      const supertypes = kotlin
        ? named(n)
            .filter((c) => c.type === "delegation_specifier")
            .flatMap((c) => typeNames(c))
        : [
            ...typeNames(n.childForFieldName("superclass")),
            ...typeNames(n.childForFieldName("interfaces")),
            ...typeNames(named(n).find((c) => c.type === "extends_interfaces")),
          ];
      const d: Decl = {
        kind,
        name: nameNode.text,
        line: line(nameNode),
        annotations: annotationsOf(n, kotlin),
        supertypes,
        ...(type ? { parent: type } : {}),
      };
      decls.push(d);
      const body = kotlin
        ? named(n).find((c) => c.type === "class_body" || c.type === "enum_class_body")
        : n.childForFieldName("body");
      // An annotation type's members are its attributes, not methods.
      if (body && kind !== "annotation-type") for (const c of named(body)) walk(c, d, undefined);
      return;
    }
    if (kotlin && t === "companion_object" && type) {
      for (const c of named(named(n).find((x) => x.type === "class_body")))
        walk(c, type, undefined);
      return;
    }
    // Typed variables: parameters and locals (fields are handled below).
    if (!kotlin && (t === "formal_parameter" || t === "local_variable_declaration")) {
      const ty = n.childForFieldName("type");
      if (t === "formal_parameter") variable(n.childForFieldName("name"), ty);
      else
        for (const d of named(n).filter((c) => c.type === "variable_declarator"))
          variable(d.childForFieldName("name"), ty);
    }
    if (kotlin && (t === "parameter" || t === "class_parameter")) {
      variable(
        named(n).find((c) => c.type === "simple_identifier"),
        named(n).find((c) => /type$/.test(c.type)),
      );
    }
    // Methods and constructors, inside a type.
    if (
      type &&
      !method &&
      (t === "method_declaration" ||
        t === "constructor_declaration" ||
        t === "compact_constructor_declaration" ||
        (kotlin && (t === "function_declaration" || t === "secondary_constructor")))
    ) {
      const nameNode = kotlin
        ? named(n).find((c) => c.type === "simple_identifier")
        : n.childForFieldName("name");
      const d: Decl = {
        kind: "method",
        name: nameNode?.text ?? (kotlin ? "constructor" : type.name),
        line: line(nameNode ?? n),
        annotations: annotationsOf(n, kotlin),
        supertypes: [],
        parent: type,
      };
      decls.push(d);
      // Parameters' types are variables; their annotations aren't the method's.
      for (const ps of named(n).filter((c) => /parameters$/.test(c.type)))
        for (const prm of named(ps))
          if (prm.type === "formal_parameter" || prm.type === "spread_parameter")
            variable(
              prm.childForFieldName("name") ?? named(prm).at(-1),
              prm.childForFieldName("type"),
            );
          else if (prm.type === "parameter")
            variable(
              named(prm).find((c) => c.type === "simple_identifier"),
              named(prm).find((c) => /type$/.test(c.type)),
            );
      for (const c of named(n))
        if (!/parameters$/.test(c.type) && c.type !== "modifiers") walk(c, type, d);
      return;
    }
    // Fields with annotations.
    if (
      type &&
      !method &&
      (t === "field_declaration" || (kotlin && t === "property_declaration"))
    ) {
      const anns = annotationsOf(n, kotlin);
      const names = kotlin
        ? named(named(n).find((c) => c.type === "variable_declaration")).filter(
            (c) => c.type === "simple_identifier",
          )
        : named(n)
            .filter((c) => c.type === "variable_declarator")
            .map((c) => c.childForFieldName("name")!)
            .filter(Boolean);
      // Typed fields, and String constants.
      const mods = named(n).find((c) => c.type === "modifiers")?.text ?? "";
      if (!kotlin) {
        const ty = n.childForFieldName("type");
        for (const d of named(n).filter((c) => c.type === "variable_declarator")) {
          variable(d.childForFieldName("name"), ty);
          const v = d.childForFieldName("value");
          if (/\bstatic\b/.test(mods) && /\bfinal\b/.test(mods) && ty?.text === "String" && v) {
            const lit = argument(v, false).literal;
            if (lit !== undefined)
              constants.push({
                owner: type.name,
                name: d.childForFieldName("name")!.text,
                value: lit,
                line: line(d),
              });
          }
        }
      } else {
        const vd = named(n).find((c) => c.type === "variable_declaration");
        const nm = named(vd).find((c) => c.type === "simple_identifier");
        variable(
          nm,
          named(vd).find((c) => /type$/.test(c.type)),
        );
        const v = named(n).find((c) => isString(c));
        if (/\bconst\b/.test(mods) && nm && v && !/\$\{|\$[A-Za-z_]/.test(v.text))
          constants.push({
            owner: type.name,
            name: nm.text,
            value: kotlinString(v),
            line: line(nm),
          });
      }
      if (anns.length)
        for (const nm of names)
          decls.push({
            kind: "field",
            name: nm.text,
            line: line(nm),
            annotations: anns,
            supertypes: [],
            parent: type,
          });
      for (const c of named(n)) if (c.type !== "modifiers") walk(c, type, method);
      return;
    }
    // Calls, inside a type.
    if (type && t === "method_invocation") {
      const obj = n.childForFieldName("object");
      const receiver =
        obj?.type === "identifier" || obj?.type === "this"
          ? obj.text
          : obj?.type === "field_access"
            ? obj.childForFieldName("field")?.text
            : undefined;
      const args = named(n.childForFieldName("arguments")).map((a) => argument(a, false));
      push(n.childForFieldName("name")!, {
        ...(receiver ? { receiver } : {}),
        method: n.childForFieldName("name")!.text,
        args: args.map((a) => a.literal),
        shown: args.map((a) => a.shown),
        line: line(n.childForFieldName("name")!),
        ...(method ? { inMethod: method } : {}),
        inType: type,
      });
    }
    if (type && kotlin && t === "call_expression") {
      const callee = named(n)[0];
      const suffix = named(n).find((c) => c.type === "call_suffix");
      let name: Node | undefined;
      let receiver: string | undefined;
      if (callee?.type === "simple_identifier") name = callee;
      else if (callee?.type === "navigation_expression") {
        name = named(named(callee).at(-1)).find((c) => c.type === "simple_identifier");
        const left = named(callee)[0];
        receiver =
          left?.type === "simple_identifier" || left?.type === "this_expression"
            ? left.text
            : left?.type === "navigation_expression"
              ? named(named(left).at(-1)).find((c) => c.type === "simple_identifier")?.text
              : undefined;
      }
      if (name && suffix) {
        const args = named(named(suffix).find((c) => c.type === "value_arguments")).map((a) =>
          argument(named(a).at(-1)!, true),
        );
        push(name, {
          ...(receiver ? { receiver } : {}),
          method: name.text,
          args: args.map((a) => a.literal),
          shown: args.map((a) => a.shown),
          line: line(name),
          ...(method ? { inMethod: method } : {}),
          inType: type,
        });
      }
    }
    for (const c of named(n)) walk(c, type, method);
  };
  walk(tree.rootNode, undefined, undefined);
  tree.delete();
  calls.sort((a, b) => at.get(a)! - at.get(b)!);
  return { ...(packageName ? { packageName } : {}), imports, decls, calls, constants, variables };
}
