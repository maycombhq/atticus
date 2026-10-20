import { normalizePath } from "./identity.js";

/**
 * Field templates used by dialect rules (C2) and checklist owner questions (C3).
 *
 *   "${attr.path}"                       an attribute of the matched annotation or call
 *   "${annotation.ForgeService.name}"    an attribute of an annotation on the enclosing class
 *   "${config:gateway.url}"              a key from the repo's config files
 *   "${yaml:forge.yaml#service}"         a key from a named file in the repo
 *   "${member.name}" "${class.name}"     names of the matched member and its class
 *   "${file.path}" "${file.line}"        where the match is
 *   "${repo.name}"                       the repo id
 *   "${match.1}"                         a regex group from the rule's match
 *   "${node.key}" "${node.up.url}"        the structure around a jsonPath, xpath or hclBlock
 *                                        match: its key, a field of the object above (ADR 0058)
 *   "${lookup:servers(attr.name).host}"  a value from a dialect lookup table, by key (ADR 0058)
 *   "${capture.path}"                    a capture of a syntax match's query (ADR 0060)
 *   "${system}" "${field}" "${kind}"     subject of a checklist need (questions only)
 *
 * Filters follow a pipe: "${attr.method | upper}", "${attr.path | normalizePath}",
 * "${attr.name | default('unknown')}". Anything outside ${...} is literal text.
 */

export const TEMPLATE_FILTERS = [
  "lower",
  "upper",
  "slug",
  "normalizePath",
  "trimSlash",
  "default",
  "parent",
  "basename",
] as const;
export type TemplateFilter = (typeof TEMPLATE_FILTERS)[number];

export type TemplateSource =
  | { type: "attr"; name: string }
  | { type: "annotation"; annotation: string; name: string }
  | { type: "config"; key: string }
  | { type: "yaml"; file: string; key: string }
  | { type: "member" | "class" | "file" | "repo"; name: string }
  | { type: "match"; group: number }
  /** A capture of a `syntax` match's tree-sitter query (ADR 0060). */
  | { type: "capture"; name: string }
  /** The matched node's key (name "key"), or a field of an object `up` levels above it. */
  | { type: "node"; up: number; name: string }
  /** A row of a dialect lookup table, by the value of `key`. */
  | { type: "lookup"; table: string; key: TemplateExpr; field: string }
  | { type: "subject"; name: "system" | "field" | "kind" | "record" };

export interface TemplateExpr {
  source: TemplateSource;
  filters: { name: TemplateFilter; arg?: string }[];
}

export type TemplatePart = { text: string } | { expr: TemplateExpr };

export class TemplateError extends Error {
  constructor(
    message: string,
    readonly template: string,
  ) {
    super(message);
    this.name = "TemplateError";
  }
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const KEY = /^[A-Za-z0-9_.\-[\]*]+$/;
const BUILTIN: Record<string, readonly string[]> = {
  member: ["name"],
  class: ["name"],
  file: ["path", "line"],
  repo: ["name"],
};

function parseSource(raw: string, template: string): TemplateSource {
  const s = raw.trim();
  const fail = (why: string): never => {
    throw new TemplateError(`${why}: "\${${raw}}"`, template);
  };
  if (s.startsWith("config:")) {
    const key = s.slice(7);
    if (!KEY.test(key)) fail("config key must be a dotted name");
    return { type: "config", key };
  }
  if (s.startsWith("yaml:")) {
    const [file, key] = s.slice(5).split("#", 2);
    if (!file || !key || file.startsWith("/") || file.split("/").includes("..") || !KEY.test(key)) {
      fail("expected yaml:<repo-relative file>#<key>");
    }
    return { type: "yaml", file: file!, key: key! };
  }
  if (s.startsWith("lookup:")) {
    const m = /^lookup:([A-Za-z_][A-Za-z0-9_-]*)\(([\s\S]*)\)\.([A-Za-z_][A-Za-z0-9_-]*)$/.exec(s);
    if (!m || !m[2]!.trim()) fail("expected lookup:<table>(<key value>).<value>");
    return { type: "lookup", table: m![1]!, key: parseExpr(m![2]!, template), field: m![3]! };
  }
  if (s === "system" || s === "field" || s === "kind" || s === "record")
    return { type: "subject", name: s };
  const parts = s.split(".");
  const [head, ...rest] = parts;
  if (head === "attr" && rest.length === 1 && IDENT.test(rest[0]!))
    return { type: "attr", name: rest[0]! };
  if (head === "annotation" && rest.length === 2 && rest.every((p) => IDENT.test(p))) {
    return { type: "annotation", annotation: rest[0]!, name: rest[1]! };
  }
  if (head === "node") {
    let up = 0;
    while (rest[up] === "up") up++;
    const name = rest.slice(up);
    if (name.length !== 1 || !IDENT.test(name[0]!) || (up === 0 && name[0] !== "key"))
      fail("expected node.key, node.up.<field> or node.up.key");
    return { type: "node", up, name: name[0]! };
  }
  if (head === "capture" && rest.length === 1 && IDENT.test(rest[0]!))
    return { type: "capture", name: rest[0]! };
  if (head === "match" && rest.length === 1 && /^\d+$/.test(rest[0]!))
    return { type: "match", group: Number(rest[0]) };
  if (head && head in BUILTIN && rest.length === 1 && BUILTIN[head]!.includes(rest[0]!)) {
    return { type: head as "member" | "class" | "file" | "repo", name: rest[0]! };
  }
  return fail("unknown template value");
}

/** Split at | outside parentheses, so a lookup's key can have filters of its own. */
function splitPipes(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "|" && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  out.push(body.slice(start));
  return out;
}

function parseExpr(body: string, template: string): TemplateExpr {
  const [src = "", ...pipes] = splitPipes(body);
  const filters = pipes.map((p) => {
    const m = /^\s*([A-Za-z]+)\s*(?:\(\s*'([^']*)'\s*\))?\s*$/.exec(p);
    if (!m || !(TEMPLATE_FILTERS as readonly string[]).includes(m[1]!)) {
      throw new TemplateError(`unknown filter "${p.trim()}"`, template);
    }
    const name = m[1] as TemplateFilter;
    if (name === "default" && m[2] === undefined)
      throw new TemplateError("default needs a value: default('x')", template);
    if (name !== "default" && m[2] !== undefined)
      throw new TemplateError(`${name} takes no argument`, template);
    return m[2] === undefined ? { name } : { name, arg: m[2] };
  });
  return { source: parseSource(src, template), filters };
}

/** Parse a template into literal text and expressions. Throws TemplateError on bad syntax. */
export function parseTemplate(template: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let i = 0;
  while (i < template.length) {
    const start = template.indexOf("${", i);
    if (start === -1) {
      parts.push({ text: template.slice(i) });
      break;
    }
    if (start > i) parts.push({ text: template.slice(i, start) });
    const end = template.indexOf("}", start);
    if (end === -1) throw new TemplateError("unclosed ${", template);
    const body = template.slice(start + 2, end);
    if (body.includes("${")) throw new TemplateError("nested ${ is not allowed", template);
    parts.push({ expr: parseExpr(body, template) });
    i = end + 1;
  }
  return parts;
}

/** Sources a template uses (a lookup's key's too), for checking which ones a rule may refer to. */
export function templateSources(template: string): TemplateSource[] {
  const all = (x: TemplateSource): TemplateSource[] =>
    x.type === "lookup" ? [x, ...all(x.key.source)] : [x];
  return parseTemplate(template).flatMap((p) => ("expr" in p ? all(p.expr.source) : []));
}

const FILTERS: Record<TemplateFilter, (v: string, arg?: string) => string> = {
  lower: (v) => v.toLowerCase(),
  upper: (v) => v.toUpperCase(),
  slug: (v) =>
    v
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, ""),
  normalizePath: (v) => normalizePath(v),
  trimSlash: (v) => v.replace(/^\/+|\/+$/g, ""),
  default: (v, arg) => (v === "" ? (arg ?? "") : v),
  parent: (v) => (v.includes("/") ? v.slice(0, v.replace(/\/+$/, "").lastIndexOf("/")) : ""),
  basename: (v) => v.replace(/\/+$/, "").split("/").pop() ?? "",
};

/** One expression's value with its filters applied, or undefined when unknown with no default. */
export function renderExpr(
  expr: TemplateExpr,
  resolve: (source: TemplateSource) => string | undefined,
): string | undefined {
  const resolved = resolve(expr.source);
  let value = resolved ?? "";
  let known = resolved !== undefined;
  for (const f of expr.filters) {
    value = FILTERS[f.name](value, f.arg);
    if (f.name === "default") known = true;
  }
  return known ? value : undefined;
}

/**
 * Render a template. `resolve` returns a source's value or undefined when unknown.
 * Returns undefined when any value is unknown and has no default, so a rule never emits
 * a half-filled field.
 */
export function renderTemplate(
  template: string,
  resolve: (source: TemplateSource) => string | undefined,
): string | undefined {
  let out = "";
  for (const part of parseTemplate(template)) {
    if ("text" in part) {
      out += part.text;
      continue;
    }
    const value = renderExpr(part.expr, resolve);
    if (value === undefined) return undefined;
    out += value;
  }
  return out;
}
