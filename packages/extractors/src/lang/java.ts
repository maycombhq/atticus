import { parseJavaTree } from "./java-tree.js";

/**
 * What a Java or Kotlin file declares and calls, as the Spring extractor, dialects and the
 * framework learner read it. Parsed from the syntax tree (java-tree.ts, ADR 0060).
 */

/** An annotation attribute value: a string (concatenated literals), a list, or a bare name. */
export type AnnValue = string | string[];

export interface Annotation {
  /** Simple name, without package: "GetMapping". */
  name: string;
  /** Attributes; a single unnamed value is stored as "value". */
  attrs: Record<string, AnnValue>;
  /**
   * For attributes whose value has a bare name in it (a constant such as ApiPaths.CARDS, not a
   * string literal): the value with each name shown as ${Name}, e.g. "/v2${ApiPaths.CARDS}".
   * A name's value isn't known here, so what it makes is a loose end, never a verified fact.
   */
  named?: Record<string, AnnValue>;
  /**
   * Set when a framework model added this annotation for a house one (ADR 0054): which model,
   * and whether what it says was learned from code or bytecode (else facts it makes are inferred).
   */
  from?: { model: string; verified: boolean };
  line: number;
}

export type DeclKind =
  "class" | "interface" | "enum" | "record" | "annotation-type" | "method" | "field";

export interface Decl {
  kind: DeclKind;
  name: string;
  line: number;
  annotations: Annotation[];
  /** For types: the simple names after extends and implements. */
  supertypes: string[];
  /** The enclosing type declaration, if any. */
  parent?: Decl;
}

export interface Call {
  /** "rest.postForObject" or "send" */
  receiver?: string;
  method: string;
  /** Literal string arguments in order (non-literals are undefined). */
  args: (string | undefined)[];
  /**
   * Every argument as written, with what isn't a string literal shown as ${...}:
   * `base + PAY` → "${base}${PAY}". What a loose end can say about a call it can't resolve.
   */
  shown: string[];
  line: number;
  /** The method declaration the call sits in. */
  inMethod?: Decl;
  inType?: Decl;
}

export interface JavaFile {
  packageName?: string;
  /** Imported names, as written: "org.springframework.web.client.RestTemplate", "x.Y.*". */
  imports: string[];
  decls: Decl[];
  calls: Call[];
  /** String constants (static final String, const val), by the type that declares them. */
  constants: { owner: string; name: string; value: string; line: number }[];
  /** Fields, parameters and local variables with the simple name of their declared type. */
  variables: { name: string; type: string; line: number }[];
}

/**
 * Parse a Java or Kotlin source file into declarations (with their annotations and enclosing
 * type) and method calls, from its syntax tree (ADR 0060). The language follows the path's
 * extension (.kt, .kts are Kotlin), or is given.
 */
export async function parseJava(src: string, pathOrLang: string = "java"): Promise<JavaFile> {
  const lang = pathOrLang === "kotlin" || /.kts?$/i.test(pathOrLang) ? "kotlin" : "java";
  return parseJavaTree(src, lang);
}

/** A string attribute (the first item if it's a list). */
export function attr(a: Annotation | undefined, name = "value"): string | undefined {
  const v = a?.attrs[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * A list attribute as written, with each bare name shown as ${Name}: what a constant makes when
 * its value isn't known. `named` says whether there was one.
 */
export function attrsShown(
  a: Annotation | undefined,
  name = "value",
): { values: string[]; named: boolean } {
  const v = a?.named?.[name];
  if (v === undefined) return { values: attrs(a, name), named: false };
  return { values: Array.isArray(v) ? v : [v], named: true };
}

/** A list attribute (a single string becomes a one-item list). */
export function attrs(a: Annotation | undefined, name = "value"): string[] {
  const v = a?.attrs[name];
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

export function findAnnotation(d: Decl | undefined, ...names: string[]): Annotation | undefined {
  return d?.annotations.find((a) => names.includes(a.name));
}
