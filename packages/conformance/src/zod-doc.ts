import { z } from "zod";

/**
 * Read a zod schema as documentation: one row per field (nested objects, lists of objects and
 * maps flattened with dotted paths), with its type, whether it is required, its allowed values
 * and default, and the doc comment written above it in the schema source. zod keeps no
 * comments, so the comments come from the TypeScript source, matched by export name and field
 * path (see `docComments`).
 */

export interface FieldRow {
  path: string;
  type: string;
  required: boolean;
  values?: string;
  default?: string;
  description?: string;
}

export interface SchemaDocs {
  doc?: string;
  fields: Map<string, string>;
}

type Def = Record<string, unknown> & { type: string };
const defOf = (s: unknown): Def => (s as { _zod: { def: Def } })._zod.def;

/**
 * Doc comments in a schema source file, by export name: the comment above `export const X`
 * and the comment above each property, keyed by its path inside the export (nesting follows
 * indentation, so a property is a child of the nearest less-indented property above it).
 */
export function docComments(source: string): Map<string, SchemaDocs> {
  const out = new Map<string, SchemaDocs>();
  const lines = source.split(/\r?\n/);
  let pending: string | undefined;
  let current: SchemaDocs | undefined;
  let stack: { indent: number; key: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const t = line.trim();
    if (t.startsWith("/**")) {
      let text = t;
      while (!text.includes("*/") && i + 1 < lines.length) text += `\n${lines[++i]!.trim()}`;
      pending = text
        .replace(/^\/\*\*/, "")
        .replace(/\*\/$/, "")
        .split("\n")
        .map((l) => l.replace(/^\*\s?/, "").trim())
        .filter(Boolean)
        .join(" ")
        .trim();
      continue;
    }
    const exp = /^export const (\w+)\b/.exec(line);
    if (exp) {
      current = { ...(pending ? { doc: pending } : {}), fields: new Map() };
      out.set(exp[1]!, current);
      stack = [];
      pending = undefined;
      continue;
    }
    if (
      /^\S/.test(line) &&
      t !== "" &&
      !t.startsWith("}") &&
      !t.startsWith(")") &&
      !t.startsWith(".")
    ) {
      current = undefined; // another top-level statement
      pending = undefined;
      continue;
    }
    const prop = /^(\s*)(\w+)\??\s*:/.exec(line);
    if (current && prop && !t.startsWith("//")) {
      const indent = prop[1]!.length;
      while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
      const path = [...stack.map((s) => s.key), prop[2]!].join(".");
      if (pending && !current.fields.has(path)) current.fields.set(path, pending);
      stack.push({ indent, key: prop[2]! });
    }
    if (t !== "") pending = undefined;
  }
  return out;
}

export interface DocContext {
  /** zod schema object → its export name, to show named types and find their docs. */
  named: Map<unknown, string>;
  docs: Map<string, SchemaDocs>;
}

interface Unwrapped {
  inner: unknown;
  optional: boolean;
  default?: unknown;
}

function unwrap(s: unknown): Unwrapped {
  let cur = s;
  let optional = false;
  let dflt: unknown;
  for (let i = 0; i < 20; i++) {
    const d = defOf(cur);
    if (d.type === "optional" || d.type === "nullable") optional = true;
    else if (d.type === "default" || d.type === "prefault") {
      optional = true;
      const v = d.defaultValue;
      dflt = typeof v === "function" ? (v as () => unknown)() : v;
    } else if (d.type === "readonly" || d.type === "catch") {
      // pass through
    } else if (d.type === "pipe") {
      cur = d.in;
      continue;
    } else if (d.type === "lazy") {
      cur = (d.getter as () => unknown)();
      continue;
    } else break;
    cur = d.innerType;
  }
  return { inner: cur, optional, ...(dflt !== undefined ? { default: dflt } : {}) };
}

const isObject = (s: unknown) => defOf(unwrap(s).inner).type === "object";

/** A short type name for a schema. */
export function typeName(s: unknown, ctx?: DocContext): string {
  const { inner } = unwrap(s);
  const d = defOf(inner);
  const name = ctx?.named.get(inner) ?? ctx?.named.get(s);
  const base = (): string => {
    switch (d.type) {
      case "string":
        return typeof d.format === "string" && d.format !== "regex"
          ? `string (${d.format})`
          : "string";
      case "number": {
        const formats = [
          d.format,
          ...((d.checks as unknown[] | undefined) ?? []).map(
            (c) => (c as { _zod?: { def?: { format?: unknown } } })._zod?.def?.format,
          ),
        ];
        return formats.some((f) => f === "safeint" || f === "int32") ? "integer" : "number";
      }
      case "boolean":
        return "boolean";
      case "literal":
        return (d.values as unknown[]).map((v) => JSON.stringify(v)).join(" or ");
      case "enum":
        return "enum";
      case "array":
        return `${typeName(d.element, ctx)}[]`;
      case "object":
        return "object";
      case "record":
        return `map of ${typeName(d.valueType, ctx)}`;
      case "union": {
        const opts = d.options as unknown[];
        if (opts.every(isObject)) return `one of ${opts.length} shapes`;
        return [...new Set(opts.map((o) => typeName(o, ctx)))].join(" or ");
      }
      case "intersection":
        return "object";
      case "tuple":
        return "tuple";
      case "date":
        return "date";
      default:
        return "any";
    }
  };
  const b = base();
  return name && !["object"].includes(b) && !b.startsWith(name) ? `${b} (${name})` : b;
}

function enumValues(s: unknown): string[] | undefined {
  const { inner } = unwrap(s);
  const d = defOf(inner);
  if (d.type === "enum") return Object.values(d.entries as Record<string, string>).map(String);
  if (d.type === "literal") return undefined;
  if (d.type === "array") return enumValues(d.element);
  if (d.type === "union") {
    const opts = d.options as unknown[];
    const vals = opts.map((o) => {
      const od = defOf(unwrap(o).inner);
      return od.type === "literal" ? (od.values as unknown[]).map(String) : enumValues(o);
    });
    if (vals.every((v) => v !== undefined)) return vals.flat() as string[];
  }
  return undefined;
}

const fmt = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

/**
 * Rows for an object schema's fields. `docName` is the export whose comments describe this
 * object; descending into a field whose schema is another named export switches to its docs.
 */
export function fieldRows(
  schema: unknown,
  ctx: DocContext,
  docName: string,
  o: { prefix?: string; docPrefix?: string; skip?: Set<string>; fallbackDocs?: string[] } = {},
  depth = 0,
): FieldRow[] {
  const { inner } = unwrap(schema);
  const d = defOf(inner);
  if (depth > 5) return [];
  const shapes: Record<string, unknown>[] =
    d.type === "object"
      ? [d.shape as Record<string, unknown>]
      : d.type === "union" && (d.options as unknown[]).every(isObject)
        ? (d.options as unknown[]).map(
            (x) => defOf(unwrap(x).inner).shape as Record<string, unknown>,
          )
        : d.type === "intersection"
          ? ([defOf(unwrap(d.left).inner).shape, defOf(unwrap(d.right).inner).shape].filter(
              Boolean,
            ) as Record<string, unknown>[])
          : [];
  const rows: FieldRow[] = [];
  const seen = new Set<string>();
  for (const shape of shapes)
    for (const [key, field] of Object.entries(shape)) {
      if (o.skip?.has(key) || seen.has(key)) continue;
      seen.add(key);
      const path = o.prefix ? `${o.prefix}.${key}` : key;
      const docPath = o.docPrefix ? `${o.docPrefix}.${key}` : key;
      const u = unwrap(field);
      const fieldName = ctx.named.get(u.inner) ?? ctx.named.get(field);
      const description =
        ctx.docs.get(docName)?.fields.get(docPath) ??
        (o.fallbackDocs ?? []).map((n) => ctx.docs.get(n)?.fields.get(docPath)).find(Boolean) ??
        (fieldName ? ctx.docs.get(fieldName)?.doc : undefined) ??
        z.globalRegistry.get(field as z.ZodType)?.description;
      const values = enumValues(field);
      rows.push({
        path,
        type: typeName(field, ctx),
        required: !u.optional,
        ...(values ? { values: values.map((v) => `\`${v}\``).join(", ") } : {}),
        ...(u.default !== undefined &&
        !(Array.isArray(u.default) && u.default.length === 0) &&
        !(
          typeof u.default === "object" &&
          u.default !== null &&
          Object.keys(u.default).length === 0
        )
          ? { default: fmt(u.default) }
          : {}),
        ...(description ? { description } : {}),
      });
      // Nested objects, lists of objects and maps of objects.
      const id = defOf(u.inner);
      const nestedDoc =
        fieldName && fieldName !== docName
          ? { name: fieldName, prefix: "" }
          : { name: docName, prefix: docPath };
      if (
        id.type === "object" ||
        (id.type === "union" && (id.options as unknown[]).every(isObject))
      )
        rows.push(
          ...fieldRows(
            u.inner,
            ctx,
            nestedDoc.name,
            { prefix: path, docPrefix: nestedDoc.prefix || undefined },
            depth + 1,
          ),
        );
      else if (id.type === "array" && isObject(id.element)) {
        const el = unwrap(id.element).inner;
        const elName = ctx.named.get(el);
        rows.push(
          ...fieldRows(
            el,
            ctx,
            elName ?? nestedDoc.name,
            { prefix: `${path}[]`, docPrefix: elName ? undefined : nestedDoc.prefix || undefined },
            depth + 1,
          ),
        );
      } else if (id.type === "record" && isObject(id.valueType)) {
        const el = unwrap(id.valueType).inner;
        const elName = ctx.named.get(el);
        rows.push(
          ...fieldRows(
            el,
            ctx,
            elName ?? nestedDoc.name,
            {
              prefix: `${path}.<key>`,
              docPrefix: elName ? undefined : nestedDoc.prefix || undefined,
            },
            depth + 1,
          ),
        );
      }
    }
  return rows;
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** A Markdown table of field rows (prettier aligns it afterwards). */
export function fieldTable(rows: FieldRow[]): string {
  const head =
    "| Field | Type | Required | Values | Description |\n| --- | --- | --- | --- | --- |";
  const body = rows.map((r) => {
    const values = [r.values, r.default !== undefined ? `default \`${r.default}\`` : undefined]
      .filter(Boolean)
      .join("; ");
    return `| \`${r.path}\` | ${cell(r.type)} | ${r.required ? "yes" : "no"} | ${cell(values)} | ${cell(r.description ?? "")} |`;
  });
  return [head, ...body].join("\n");
}
