import type { CatalogRecord } from "@maycombhq/core";
import { defineExtractor } from "@maycombhq/sdk";
import { findAnnotation, attr, parseJava, type Decl } from "../lang/java.js";
import { endpoint, lineAt, loose, own, read, sources, stripComments } from "./common.js";

/**
 * GraphQL (ADR 0040): served operations become `graphql` Endpoints and client operations
 * become `graphql-call` loose ends that merge resolves by operation and field name.
 *
 * Served: SDL files (`*.graphql`, `*.gql`, `*.graphqls`, which also covers the schema files a
 * gqlgen config points at) and code-first schemas where cheap: SDL inside Apollo-style
 * `gql`/`graphql` tagged templates or `typeDefs` template strings, Spring for GraphQL
 * `@QueryMapping`/`@MutationMapping`/`@SubscriptionMapping`/`@SchemaMapping`, and Python
 * Strawberry (`@strawberry.type` classes) and Graphene (`graphene.ObjectType` classes; snake
 * case fields are camel-cased as both libraries do by default). Every field of the root
 * operation types (renamed roots in `schema { ... }` are followed) is one Endpoint:
 * id `<component>.graphql.<type>.<field>`, method QUERY, MUTATION or SUBSCRIPTION and
 * pathOrTopic `Query.field`, owned by the repo's component.
 *
 * Called: operation documents (`query X { a b }`, anonymous `{ a }`) in `.graphql` files and
 * in tagged templates. Each top-level field of an operation is a loose end
 * `graphql-call "QUERY Query.a"`. A field this repo serves itself is not a loose end.
 */

const SDL = ["**/*.graphql", "**/*.gql", "**/*.graphqls"];
const JS = ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs"];
const JAVA = ["**/*.java", "**/*.kt"];
const PY = ["**/*.py"];

type Op = "QUERY" | "MUTATION" | "SUBSCRIPTION";
const ROOT: Record<Op, string> = {
  QUERY: "Query",
  MUTATION: "Mutation",
  SUBSCRIPTION: "Subscription",
};
const OP_OF: Record<string, Op> = {
  query: "QUERY",
  mutation: "MUTATION",
  subscription: "SUBSCRIPTION",
};

export interface GqlField {
  op: Op;
  name: string;
  /** Offset of the field name in the text given to parseGraphql. */
  at: number;
}

interface Tok {
  v: string;
  at: number;
}

/** GraphQL tokens: names and punctuators; comments, strings and descriptions are dropped. */
function tokens(text: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "#") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (text.startsWith('"""', i)) {
      const end = text.indexOf('"""', i + 3);
      i = end < 0 ? text.length : end + 3;
    } else if (c === '"') {
      i++;
      while (i < text.length && text[i] !== '"' && text[i] !== "\n") i += text[i] === "\\" ? 2 : 1;
      i++;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i, i + 200))!;
      out.push({ v: m[0], at: i });
      i += m[0].length;
    } else if (text.startsWith("...", i)) {
      out.push({ v: "...", at: i });
      i += 3;
    } else if ("{}()[]:@$!=|&".includes(c)) {
      out.push({ v: c, at: i });
      i++;
    } else i++;
  }
  return out;
}

/** Index just past the bracket that closes the one at `i`. */
function skipBalanced(t: Tok[], i: number): number {
  const open = t[i]!.v;
  const close = open === "{" ? "}" : open === "(" ? ")" : "]";
  let depth = 0;
  for (let j = i; j < t.length; j++) {
    if (t[j]!.v === open) depth++;
    else if (t[j]!.v === close && --depth === 0) return j + 1;
  }
  return t.length;
}

/** Field names of a type body `{ a(x: Int): T  b: [U!]! @d(r: "x") }` starting at `{`. */
function typeFields(t: Tok[], open: number): { fields: Tok[]; end: number } {
  const end = skipBalanced(t, open);
  const fields: Tok[] = [];
  for (let j = open + 1; j < end - 1; j++) {
    const v = t[j]!.v;
    if (v === "(" || v === "{" || v === "[") {
      j = skipBalanced(t, j) - 1;
      continue;
    }
    const next = t[j + 1]?.v;
    if (/^[A-Za-z_]/.test(v) && (next === ":" || next === "(") && t[j - 1]?.v !== "@")
      fields.push(t[j]!);
  }
  return { fields, end };
}

/** Top-level field names of a selection set starting at `{` (aliases, fragments and directives skipped). */
function selectionFields(t: Tok[], open: number): { fields: Tok[]; end: number } {
  const end = skipBalanced(t, open);
  const fields: Tok[] = [];
  for (let j = open + 1; j < end - 1; j++) {
    const tok = t[j]!;
    if (tok.v === "(" || tok.v === "{" || tok.v === "[") {
      j = skipBalanced(t, j) - 1;
      continue;
    }
    if (!/^[A-Za-z_]/.test(tok.v)) continue;
    const prev = t[j - 1]?.v;
    if (prev === "@" || prev === "..." || prev === "on" || prev === "$") continue;
    if (t[j + 1]?.v === ":") continue; // an alias: the field follows
    if (tok.v === "on" && prev === "...") continue;
    if (tok.v.startsWith("__")) continue;
    fields.push(tok);
  }
  return { fields, end };
}

/**
 * Read GraphQL text: the fields of the root operation types it defines (`served`) and the
 * top-level fields of the operations it contains (`called`).
 */
export function parseGraphql(text: string): { served: GqlField[]; called: GqlField[] } {
  const t = tokens(text);
  const roots: Record<string, Op> = {
    Query: "QUERY",
    Mutation: "MUTATION",
    Subscription: "SUBSCRIPTION",
  };
  // `schema { query: RootQuery }` renames a root type; read it first so order doesn't matter.
  for (let i = 0; i < t.length; i++) {
    if (t[i]!.v !== "schema" || t[i + 1]?.v !== "{") continue;
    const end = skipBalanced(t, i + 1);
    for (let j = i + 2; j < end - 2; j++)
      if (OP_OF[t[j]!.v] && t[j + 1]?.v === ":") roots[t[j + 2]!.v] = OP_OF[t[j]!.v]!;
  }
  const served: GqlField[] = [];
  const called: GqlField[] = [];
  let i = 0;
  while (i < t.length) {
    const v = t[i]!.v;
    if (v === "schema" && t[i + 1]?.v === "{") {
      i = skipBalanced(t, i + 1);
    } else if (v === "type" || (v === "extend" && t[i + 1]?.v === "type")) {
      const nameAt = v === "extend" ? i + 2 : i + 1;
      const name = t[nameAt]?.v ?? "";
      let j = nameAt + 1;
      while (
        j < t.length &&
        t[j]!.v !== "{" &&
        !/^(type|extend|schema|query|mutation|subscription|fragment|input|enum|interface|union|scalar|directive)$/.test(
          t[j]!.v,
        )
      )
        j++;
      if (t[j]?.v !== "{") {
        i = j;
        continue;
      }
      const { fields, end } = typeFields(t, j);
      const op = roots[name];
      if (op) for (const f of fields) served.push({ op, name: f.v, at: f.at });
      i = end;
    } else if (OP_OF[v] && t[i - 1]?.v !== ":") {
      const op = OP_OF[v]!;
      let j = i + 1;
      while (j < t.length && t[j]!.v !== "{") j = t[j]!.v === "(" ? skipBalanced(t, j) : j + 1;
      if (j >= t.length) break;
      const { fields, end } = selectionFields(t, j);
      for (const f of fields) called.push({ op, name: f.v, at: f.at });
      i = end;
    } else if (v === "{") {
      // An anonymous query, or the body of a definition we don't read (input, enum, fragment...).
      const anonymous = i === 0 || t[i - 1]?.v === "}";
      if (anonymous) {
        const { fields, end } = selectionFields(t, i);
        for (const f of fields) called.push({ op: "QUERY", name: f.v, at: f.at });
        i = end;
      } else i = skipBalanced(t, i);
    } else i++;
  }
  return { served, called };
}

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

export const graphqlExtractor = defineExtractor({
  id: "graphql",
  version: "0.1.0",
  claims: [...SDL, ...JS, ...JAVA, ...PY],
  async *scan(repo, ctx) {
    const comp = own(repo, ctx);
    const servedHere = new Set<string>();
    const out: CatalogRecord[] = [];
    const calls: { op: Op; field: string; path: string; line: number }[] = [];
    const serve = (op: Op, field: string, path: string, line: number, source: "spec" | "code") => {
      servedHere.add(`${op} ${field}`);
      out.push(
        endpoint({
          repo,
          component: comp,
          endpointType: "graphql",
          prefix: "graphql",
          name: `${ROOT[op]}.${field}`,
          method: op,
          pathOrTopic: `${ROOT[op]}.${field}`,
          source,
          path,
          line,
        }),
      );
    };
    const readGql = (
      text: string,
      base: number,
      path: string,
      source: "spec" | "code",
      full: string,
    ) => {
      const { served, called } = parseGraphql(text);
      for (const f of served) serve(f.op, f.name, path, lineAt(full, base + f.at), source);
      for (const f of called)
        calls.push({ op: f.op, field: f.name, path, line: lineAt(full, base + f.at) });
    };

    for (const path of await sources(repo, SDL)) {
      const text = await read(repo, ctx, path);
      if (text !== undefined) readGql(text, 0, path, "spec", text);
    }
    for (const path of await sources(repo, JS)) {
      const text = await read(repo, ctx, path);
      if (text === undefined || !/\b(gql|graphql|typeDefs)\b/.test(text)) continue;
      const clean = stripComments(text, "c");
      const re = /(?:\b(?:gql|graphql)\s*(?:\(\s*)?|\btypeDefs\s*[:=]\s*)`([^`]*)`/g;
      for (const m of clean.matchAll(re)) {
        const body = m[1]!;
        readGql(body, m.index + m[0].indexOf("`") + 1, path, "code", text);
      }
    }
    for (const path of await sources(repo, JAVA)) {
      const text = await read(repo, ctx, path);
      if (text === undefined || !/@(Query|Mutation|Subscription|Schema)Mapping/.test(text))
        continue;
      for (const d of parseJava(text).decls) {
        if (d.kind !== "method") continue;
        const found = javaField(d);
        if (found) serve(found.op, found.field, path, found.line, "code");
      }
    }
    for (const path of await sources(repo, PY)) {
      const text = await read(repo, ctx, path);
      if (text === undefined || !/\b(strawberry|graphene)\b/.test(text)) continue;
      for (const f of pythonFields(stripComments(text, "hash")))
        serve(f.op, f.name, path, f.line, "code");
    }

    yield* dedupe(out);
    const seen = new Set<string>();
    for (const c of calls) {
      const raw = `${c.op} ${ROOT[c.op]}.${c.field}`;
      if (servedHere.has(`${c.op} ${c.field}`) || seen.has(`${raw}|${c.path}|${c.line}`)) continue;
      seen.add(`${raw}|${c.path}|${c.line}`);
      yield loose(repo, comp, "graphql-call", raw, c.path, c.line);
    }
  },
});

/** One Endpoint per id: the same field in two schema files is one endpoint with both as evidence. */
function* dedupe(records: CatalogRecord[]): Generator<CatalogRecord> {
  const byId = new Map<string, CatalogRecord>();
  for (const r of records) {
    const cur = byId.get(r.id);
    if (cur) cur.evidence.push(...r.evidence);
    else byId.set(r.id, r);
  }
  yield* byId.values();
}

function javaField(d: Decl): { op: Op; field: string; line: number } | undefined {
  for (const [ann, op] of [
    ["QueryMapping", "QUERY"],
    ["MutationMapping", "MUTATION"],
    ["SubscriptionMapping", "SUBSCRIPTION"],
  ] as const) {
    const a = findAnnotation(d, ann);
    if (a) return { op, field: attr(a, "name") ?? attr(a) ?? d.name, line: a.line };
  }
  const a = findAnnotation(d, "SchemaMapping");
  const typeName = attr(a, "typeName");
  const op = (Object.keys(ROOT) as Op[]).find((o) => ROOT[o] === typeName);
  if (a && op) return { op, field: attr(a, "field") ?? attr(a) ?? d.name, line: a.line };
  return undefined;
}

/** Root-type fields of Strawberry and Graphene classes. */
function pythonFields(text: string): { op: Op; name: string; line: number }[] {
  const out: { op: Op; name: string; line: number }[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const cls = /^class\s+(Query|Mutation|Subscription)\b\s*(\(([^)]*)\))?\s*:/.exec(lines[i]!);
    if (!cls) continue;
    const decorated = /@strawberry\.type\b/.test(lines[i - 1] ?? "");
    const graphene = /graphene\.ObjectType/.test(cls[3] ?? "");
    if (!decorated && !graphene) continue;
    const op = cls[1]!.toUpperCase() as Op;
    let pendingField = false;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (l.trim() === "") continue;
      if (!/^\s/.test(l)) break; // dedent: the class ended
      if (!/^ {4}\S|^\t\S/.test(l)) continue; // only the class's own members
      const s = l.trim();
      if (/^@strawberry\.(field|mutation|subscription)\b/.test(s)) {
        pendingField = true;
        continue;
      }
      const def = /^(?:async\s+)?def\s+(\w+)\s*\(/.exec(s);
      if (def) {
        // Graphene's resolve_<field> methods resolve fields declared as attributes.
        if (decorated && pendingField) out.push({ op, name: camel(def[1]!), line: j + 1 });
        pendingField = false;
        continue;
      }
      pendingField = false;
      const annotated = /^(\w+)\s*:\s*[^=]+(?:=.*)?$/.exec(s);
      if (decorated && annotated && !annotated[1]!.startsWith("_")) {
        out.push({ op, name: camel(annotated[1]!), line: j + 1 });
        continue;
      }
      const assigned = /^(\w+)\s*=\s*(.+)$/.exec(s);
      if (graphene && assigned && !assigned[1]!.startsWith("_")) {
        if (/\bgraphene\.\w+\(|\.Field\(\)/.test(assigned[2]!))
          out.push({ op, name: camel(assigned[1]!), line: j + 1 });
      }
    }
  }
  return out;
}
