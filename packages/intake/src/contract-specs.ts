import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { isMap, isScalar, isSeq, LineCounter, parseDocument, type YAMLMap } from "yaml";
import {
  normalizePath,
  type ContractSpecT,
  type Fact,
  type SpecFieldT,
  type SpecsFileT,
} from "@maycombhq/core";
import { denyListHits } from "./traffic.js";
import { readVendorSpec, type VendorSpec } from "./vendor-ops.js";

/**
 * The specs a contract is checked against (plan item F7, ADR 0164), read from files: an OpenAPI
 * document's operations (through `readVendorSpec`, so intake and the check agree), a `.proto`
 * file's messages (field names, types, labels and numbers), an Avro schema's records, a JSON
 * Schema, and an AsyncAPI document's messages with the channel each travels on. Every field cites
 * its file and line. Files only: no network, no model, no clock.
 */

const MAX_BYTES = 1024 * 1024;
const SKIP = new Set([
  ".git",
  "node_modules",
  "vendor",
  "target",
  "build",
  "dist",
  "out",
  "bin",
  "obj",
  ".gradle",
  ".idea",
  ".venv",
  "__pycache__",
]);

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ------------------------------------------------------------------ protobuf

/**
 * A `.proto` file's messages: each message (nested ones as `Outer.Inner`) with its fields, the
 * package in front of its name. A field is `[optional|required|repeated] <type> <name> = <n>;`,
 * a `map<k, v>` or a field of a `oneof`. proto2's `required` is required, `optional` isn't;
 * proto3 has no required field, so each is optional. Comments are skipped; options ignored.
 */
export function readProtoSpecs(path: string, text: string): ContractSpecT[] {
  const proto3 = /^\s*syntax\s*=\s*["']proto3["']/m.test(text);
  let pkg = "";
  const out: ContractSpecT[] = [];
  type Frame = { kind: "message" | "oneof" | "other"; name: string; spec?: ContractSpecT };
  const stack: Frame[] = [];
  let inComment = false;
  text.split(/\r?\n/).forEach((raw, i) => {
    let line = raw;
    if (inComment) {
      const end = line.indexOf("*/");
      if (end < 0) return;
      line = line.slice(end + 2);
      inComment = false;
    }
    line = line.replace(/\/\*.*?\*\//g, "").replace(/\/\/.*$/, "");
    const open = line.indexOf("/*");
    if (open >= 0) {
      inComment = true;
      line = line.slice(0, open);
    }
    const n = i + 1;
    const p = /^\s*package\s+([\w.]+)\s*;/.exec(line);
    if (p) pkg = p[1]!;
    const message = /^\s*message\s+(\w+)\s*\{/.exec(line);
    const oneof = /^\s*oneof\s+(\w+)\s*\{/.exec(line);
    const other = /^\s*(enum|service|extend|extensions)\b[^{]*\{/.exec(line);
    let rest = line;
    if (message) {
      const outer = stack.filter((f) => f.kind === "message").map((f) => f.name);
      const name = [...outer, message[1]!].join(".");
      const spec: ContractSpecT = {
        kind: "message",
        format: "protobuf",
        role: "schema",
        file: path,
        line: n,
        name: pkg ? `${pkg}.${name}` : name,
        fields: [],
      };
      out.push(spec);
      stack.push({ kind: "message", name: message[1]!, spec });
      rest = line.slice(line.indexOf("{") + 1);
    } else if (oneof || other) {
      stack.push({ kind: oneof ? "oneof" : "other", name: "" });
      rest = line.slice(line.indexOf("{") + 1);
    } else {
      const top = stack.at(-1);
      const owner =
        top?.kind === "message" ? top : top?.kind === "oneof" ? stack.at(-2) : undefined;
      const f =
        /^\s*(optional|required|repeated)?\s*(map\s*<[^>]+>|[\w.]+)\s+(\w+)\s*=\s*(\d+)\s*(\[[^\]]*\])?\s*;/.exec(
          line,
        );
      if (f && owner?.kind === "message" && owner.spec && !["reserved", "option"].includes(f[2]!)) {
        const label = f[1];
        owner.spec.fields.push({
          side: "message",
          name: f[3]!,
          type: label === "repeated" ? `repeated ${f[2]}` : f[2]!.replace(/\s+/g, ""),
          // proto2's `required` must be there; anything else may be left out (proto3 has no required).
          required: label === "required" && !proto3,
          number: Number(f[4]),
          at: `${path}:${n}`,
        });
      }
    }
    for (const _ of rest.matchAll(/\}/g)) stack.pop();
  });
  return out;
}

// ------------------------------------------------------------------ Avro

/** The line a JSON key's value is on, searched from a line onwards: `"name": "amount"`. */
function lineOfName(lines: readonly string[], from: number, name: string): number {
  const re = new RegExp(`"name"\\s*:\\s*"${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`);
  for (let i = Math.max(0, from); i < lines.length; i++) if (re.test(lines[i]!)) return i + 1;
  return from + 1;
}

/**
 * An Avro schema's records (`.avsc`): each record, its namespace in front, with its fields. A
 * field is required unless its type is a union with `null` or it has a default. Nested records
 * are records of their own; a field's type is the name Avro gives it.
 */
export function readAvroSpecs(path: string, text: string): ContractSpecT[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const lines = text.split(/\r?\n/);
  const out: ContractSpecT[] = [];
  let cursor = 0;
  const typeName = (t: unknown): string => {
    if (typeof t === "string") return t;
    if (Array.isArray(t)) return t.map(typeName).join("|");
    if (t && typeof t === "object") {
      const o = t as Record<string, unknown>;
      if (o.type === "array") return `repeated ${typeName(o.items)}`;
      if (o.type === "map") return `map<string,${typeName(o.values)}>`;
      if (typeof o.logicalType === "string") return String(o.type);
      if (typeof o.name === "string") return o.name;
      return typeName(o.type);
    }
    return "";
  };
  const record = (r: Record<string, unknown>, ns: string) => {
    if (r.type !== "record" || typeof r.name !== "string" || !Array.isArray(r.fields)) return;
    const space = typeof r.namespace === "string" ? r.namespace : ns;
    const line = lineOfName(lines, cursor, r.name);
    cursor = line;
    const spec: ContractSpecT = {
      kind: "message",
      format: "avro",
      role: "schema",
      file: path,
      line,
      name: space ? `${space}.${r.name}` : r.name,
      fields: [],
    };
    out.push(spec);
    r.fields.forEach((f, i) => {
      if (!f || typeof f !== "object") return;
      const x = f as Record<string, unknown>;
      if (typeof x.name !== "string") return;
      const at = lineOfName(lines, cursor, x.name);
      cursor = at;
      const nullable = Array.isArray(x.type) && x.type.includes("null");
      const type = typeName(Array.isArray(x.type) ? x.type.filter((t) => t !== "null") : x.type);
      spec.fields.push({
        side: "message",
        name: x.name,
        ...(type ? { type } : {}),
        required: !nullable && !("default" in x),
        number: i,
        at: `${path}:${at}`,
      });
      const inner = Array.isArray(x.type) ? x.type : [x.type];
      for (const t of inner)
        if (t && typeof t === "object") record(t as Record<string, unknown>, space);
    });
  };
  for (const r of Array.isArray(data) ? data : [data])
    if (r && typeof r === "object") record(r as Record<string, unknown>, "");
  return out;
}

// ------------------------------------------------------------------ JSON Schema and AsyncAPI

interface Doc {
  path: string;
  lc: LineCounter;
  root: YAMLMap;
}

const lineAt = (d: Doc, node: unknown): number => {
  const r = (node as { range?: [number, number, number] } | undefined)?.range;
  return r ? d.lc.linePos(r[0]).line : 1;
};

/** A local `$ref` (`#/components/schemas/X`, `#/definitions/X`) followed once per step, a few deep. */
function deref(d: Doc, node: unknown, depth = 0): unknown {
  if (!isMap(node) || depth > 8) return node;
  const ref = node.get("$ref");
  if (typeof ref !== "string" || !ref.startsWith("#/")) return node;
  let at: unknown = d.root;
  for (const p of ref.slice(2).split("/"))
    at = isMap(at) ? at.get(p.replace(/~1/g, "/").replace(/~0/g, "~"), true) : undefined;
  return deref(d, at, depth + 1);
}

function propsOf(d: Doc, schema: unknown, prefix: string, depth: number, out: SpecFieldT[]) {
  const s = deref(d, schema);
  if (!isMap(s) || depth > 6) return;
  const props = s.get("properties", true);
  const req = s.get("required", true);
  const required = new Set(
    isSeq(req) ? req.items.map((x) => (isScalar(x) ? String(x.value) : "")) : [],
  );
  if (!isMap(props)) return;
  for (const p of props.items) {
    if (!isScalar(p.key)) continue;
    const name = prefix ? `${prefix}.${String(p.key.value)}` : String(p.key.value);
    const v = deref(d, p.value);
    const type = isMap(v) ? v.get("type") : undefined;
    out.push({
      side: "message",
      name,
      ...(typeof type === "string" ? { type } : {}),
      required: required.has(String(p.key.value)),
      at: `${d.path}:${lineAt(d, p.key)}`,
    });
    if (isMap(v)) {
      if (type === "array") propsOf(d, v.get("items", true), `${name}[]`, depth + 1, out);
      else propsOf(d, v, name, depth + 1, out);
    }
  }
}

function docOf(path: string, text: string): Doc | undefined {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc });
  return isMap(doc.contents) ? { path, lc, root: doc.contents } : undefined;
}

/** A JSON Schema document (`$schema`, or an object schema with a title) as one message. */
export function readJsonSchemaSpecs(path: string, text: string): ContractSpecT[] {
  const d = docOf(path, text);
  if (!d) return [];
  const title = d.root.get("title");
  const id = d.root.get("$id");
  const fields: SpecFieldT[] = [];
  propsOf(d, d.root, "", 0, fields);
  if (!fields.length) return [];
  const name =
    typeof title === "string" && title
      ? title
      : typeof id === "string" && id
        ? (id.split("/").pop() ?? id).replace(/\.json$/, "")
        : (path.split("/").pop() ?? path).replace(/\.(schema\.)?json$|\.ya?ml$/i, "");
  return [
    { kind: "message", format: "json-schema", role: "schema", file: path, line: 1, name, fields },
  ];
}

/**
 * An AsyncAPI document's messages (2.x: a channel's `publish` and `subscribe` message, or its
 * `oneOf`; 3.x: a channel's `messages`), each with the channel as its topic and its payload's
 * properties as its fields.
 */
export function readAsyncApiSpecs(path: string, text: string): ContractSpecT[] {
  const d = docOf(path, text);
  if (!d || d.root.get("asyncapi") === undefined) return [];
  const out: ContractSpecT[] = [];
  const channels = d.root.get("channels", true);
  if (!isMap(channels)) return out;
  const add = (topic: string, message: unknown) => {
    const m = deref(d, message);
    if (!isMap(m)) return;
    const oneOf = m.get("oneOf", true);
    if (isSeq(oneOf)) {
      for (const x of oneOf.items) add(topic, x);
      return;
    }
    const payload = m.get("payload", true);
    const fields: SpecFieldT[] = [];
    propsOf(d, payload, "", 0, fields);
    const p = deref(d, payload);
    const title = isMap(p) ? p.get("title") : undefined;
    const name = m.get("name") ?? m.get("title") ?? title;
    out.push({
      kind: "message",
      format: "asyncapi",
      role: "schema",
      file: path,
      line: lineAt(d, m),
      topic,
      ...(typeof name === "string" && name ? { name } : {}),
      fields,
    });
  };
  for (const c of channels.items) {
    if (!isScalar(c.key)) continue;
    const ch = deref(d, c.value);
    if (!isMap(ch)) continue;
    const address = ch.get("address");
    const topic = typeof address === "string" && address ? address : String(c.key.value);
    for (const op of ["publish", "subscribe"]) {
      const o = ch.get(op, true);
      if (isMap(o)) add(topic, o.get("message", true));
    }
    const msgs = ch.get("messages", true);
    if (isMap(msgs)) for (const m of msgs.items) add(topic, m.value);
  }
  return out;
}

// ------------------------------------------------------------------ OpenAPI

/** An OpenAPI document's operations as the contract check reads them, from `readVendorSpec`. */
export function openApiContractSpecs(spec: VendorSpec): ContractSpecT[] {
  return spec.operations.map((o) => {
    const [file, line] = splitAt(o.cite, spec.path);
    const field = (side: "request" | "response") => (f: (typeof o.request)[number]) => ({
      side,
      name: f.name,
      ...(f.type ? { type: f.type } : {}),
      ...(f.required !== undefined ? { required: f.required } : {}),
      ...(f.in ? { in: f.in } : {}),
      at: f.cite,
    });
    return {
      kind: "operation" as const,
      format: "openapi" as const,
      role: "consumer" as const,
      file,
      line,
      method: o.method,
      path: o.fullPath,
      id: o.id,
      fields: [...o.request.map(field("request")), ...o.response.map(field("response"))],
      ...(o.errors?.length
        ? { errors: o.errors.map((e) => ({ status: e.status, at: e.cite })) }
        : {}),
    };
  });
}

function splitAt(cite: string, path: string): [string, number] {
  const m = /^(.*):(\d+)$/.exec(cite);
  return m ? [m[1]!, Number(m[2])] : [path, 1];
}

// ------------------------------------------------------------------ any file

/** What a file is, as a spec the contract check reads: by its name, else its first lines. */
export function specFormatOf(
  name: string,
  text: string,
): "openapi" | "protobuf" | "avro" | "json-schema" | "asyncapi" | undefined {
  const lower = name.toLowerCase();
  if (lower.endsWith(".proto")) return "protobuf";
  if (lower.endsWith(".avsc")) return "avro";
  if (!/\.(ya?ml|json)$/.test(lower)) return undefined;
  const head = text.slice(0, 4000);
  if (/^\s*["']?(openapi|swagger)["']?\s*:/m.test(head)) return "openapi";
  if (/^\s*["']?asyncapi["']?\s*:/m.test(head)) return "asyncapi";
  if (/"type"\s*:\s*"record"/.test(head) && /"fields"\s*:/.test(head)) return "avro";
  if (/["']?\$schema["']?\s*:/.test(head) && /json-schema\.org/.test(head)) return "json-schema";
  return undefined;
}

/** The contract specs of one file (any format), or none when it is no spec. */
export function readContractSpecs(path: string, text: string): ContractSpecT[] {
  switch (specFormatOf(path, text)) {
    case "protobuf":
      return readProtoSpecs(path, text);
    case "avro":
      return readAvroSpecs(path, text);
    case "json-schema":
      return readJsonSchemaSpecs(path, text);
    case "asyncapi":
      return readAsyncApiSpecs(path, text);
    case "openapi": {
      const spec = readVendorSpec(path, text, "spec");
      return spec ? openApiContractSpecs(spec) : [];
    }
    default:
      return [];
  }
}

const sameShape = (a: string, b: string) =>
  normalizePath(a).replace(/\{[^}]*\}/g, "{}") === normalizePath(b).replace(/\{[^}]*\}/g, "{}");

/**
 * Every spec in a checkout (ADR 0164), as the facts companion `<repo>.specs.yaml` holds them. An
 * OpenAPI operation one of the repo's own REST entries serves (same method, the same path with
 * the spec's server path in front or without it) is the repo's own published contract, tied to
 * that entry; any other is a consumer's copy of an API it calls. Message specs are any repo's to
 * share. A file the deny-list names a word of is left out whole, and `onRefused` is told which.
 */
export async function readRepoSpecs(
  dir: string,
  o: {
    repo: string;
    commit?: string;
    facts: readonly Fact[];
    denyHashes?: ReadonlySet<string>;
    onRefused?: (note: string) => void;
  },
): Promise<SpecsFileT> {
  const files: string[] = [];
  const walk = async (rel: string) => {
    const entries = await readdir(join(dir, ...rel.split("/").filter(Boolean)), {
      withFileTypes: true,
    }).catch(() => []);
    for (const e of [...entries].sort((a, b) => cmp(a.name, b.name))) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && !e.name.startsWith(".")) await walk(p);
      } else if (e.isFile() && /\.(proto|avsc|ya?ml|json)$/i.test(e.name)) files.push(p);
    }
  };
  await walk("");
  const own = o.facts.filter(
    (f): f is Extract<Fact, { kind: "entry" }> => f.kind === "entry" && f.entryType === "rest",
  );
  const specs: ContractSpecT[] = [];
  for (const p of files) {
    const full = join(dir, ...p.split("/"));
    const size = (await stat(full).catch(() => undefined))?.size ?? 0;
    if (size === 0 || size > MAX_BYTES) continue;
    const text = await readFile(full, "utf8");
    if (!specFormatOf(p, text)) continue;
    const got = readContractSpecs(p, text);
    if (!got.length) continue;
    if (o.denyHashes?.size && denyListHits(text, o.denyHashes).length) {
      o.onRefused?.(`${p}: the deny-list names a word in it, so its specs are left out.`);
      continue;
    }
    for (const s of got) {
      if (s.kind !== "operation") {
        specs.push(s);
        continue;
      }
      const vendorPath = readVendorSpec(p, text, "spec")?.operations.find((x) => x.id === s.id);
      const paths = [s.path ?? "", vendorPath?.path ?? ""].filter(Boolean);
      const entry = own
        .filter(
          (e) =>
            (!e.method || !s.method || e.method.toUpperCase() === s.method) &&
            paths.some((x) => sameShape(x, e.path)),
        )
        .sort((a, b) => cmp(a.id, b.id))[0];
      const { id: _id, ...rest } = s;
      specs.push(entry ? { ...rest, role: "own", entry: entry.id } : rest);
    }
  }
  return {
    schemaVersion: 1,
    repo: o.repo,
    ...(o.commit ? { commit: o.commit } : {}),
    specs,
  };
}
