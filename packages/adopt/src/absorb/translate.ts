import { parse, stringify } from "yaml";
import { SkillMeta } from "@maycombhq/core";
import { frontMatter, slug } from "../files.js";
import type { Confidence } from "./types.js";

/** Prompts, agents, skills, instructions and schemas, translated to Atticus files. */

function meta(text: string): { data: Record<string, unknown>; body: string } {
  const fm = frontMatter(text);
  let data: Record<string, unknown> = {};
  if (fm.data !== undefined)
    try {
      const v = parse(fm.data) as unknown;
      if (v && typeof v === "object") data = v as Record<string, unknown>;
    } catch {
      // unreadable front matter: treat as none
    }
  return { data, body: fm.body };
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** The first heading or sentence, as a one-line description. */
function firstLine(body: string): string | undefined {
  for (const l of body.split("\n")) {
    const t = l
      .replace(/^#+\s*/, "")
      .replace(/^\d+[.)]\s*/, "")
      .trim();
    if (t) return t.length > 160 ? `${t.slice(0, 157)}...` : t;
  }
  return undefined;
}

/** The body in a form both assistants read the same: one argument placeholder. */
const normaliseArgs = (body: string) =>
  body.replace(/\$\{input:[^}]+\}/g, "$ARGUMENTS").replace(/\{\{ARGS\}\}/g, "$ARGUMENTS");

/** Normalised text for duplicate detection (front matter and whitespace ignored). */
export function bodyKey(text: string): string {
  return normaliseArgs(meta(text).body)
    .replace(/\$ARGUMENTS/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export interface Translation {
  id: string;
  title: string;
  path: string;
  content: string;
  confidence: Confidence;
}

/** A prompt or command file as an org-pack command (`process/commands/<id>.md`). */
export function promptToCommand(file: string, text: string, prefix: string): Translation {
  const { data, body } = meta(text);
  const base = file
    .split("/")
    .pop()!
    .replace(/\.prompt\.md$|\.md$/i, "");
  const id = slug(`${prefix}-${base}`);
  const heading = firstLine(body);
  const description =
    str(data.description) ??
    heading?.replace(/\s*prompt$/i, "") ??
    `Prompt ${base} from ${prefix}.`;
  const hint = str(data["argument-hint"]) ?? str(data.argumentHint);
  const fm: Record<string, unknown> = { id, description };
  if (hint) fm.argumentHint = hint;
  return {
    id,
    title: description,
    path: `org-pack/process/commands/${id}.md`,
    content: `---\n${stringify(fm, { lineWidth: 0 }).trimEnd()}\n---\n\n${normaliseArgs(body).trim()}\n`,
    confidence: str(data.description) ? "high" : "medium",
  };
}

/** An agent, chat mode or skill as an org-pack skill (`process/skills/<id>/SKILL.md`, C6 SkillMeta). */
export function toSkill(
  file: string,
  text: string,
  o: { prefix: string; owner: string; source: string; kind: "agent" | "skill" | "instructions" },
): Translation & { problems: string[] } {
  const { data, body } = meta(text);
  const base = file
    .split("/")
    .filter((s) => s !== "SKILL.md")
    .pop()!
    .replace(/\.(agent|chatmode|instructions)\.md$|\.md$/i, "");
  const id = slug(`${o.prefix}-${o.kind === "instructions" ? `${base}-conventions` : base}`);
  const description =
    str(data.description) ??
    (o.kind === "instructions"
      ? `Conventions ${o.prefix} gives its assistants (${file}).`
      : (firstLine(body) ?? `Skill ${base} from ${o.prefix}.`));
  const name = str(data.name) ?? base.replace(/[-_.]+/g, " ");
  const m = {
    id,
    name,
    description,
    owner: o.owner,
    source: o.source,
    status: "draft" as const,
  };
  const r = SkillMeta.safeParse(m);
  return {
    id,
    title: description,
    path: `org-pack/process/skills/${id}/SKILL.md`,
    content: `---\n${stringify(m, { lineWidth: 0 }).trimEnd()}\n---\n\n${body.trim()}\n`,
    confidence: str(data.description) ? "high" : "medium",
    problems: r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
  };
}

export type SchemaKind = "openapi" | "asyncapi" | "json-schema";

/** Whether a file is an API description or a JSON Schema, from its content. */
export function schemaKind(file: string, text: string): SchemaKind | undefined {
  if (!/\.(ya?ml|json)$/i.test(file)) return undefined;
  let data: unknown;
  try {
    data = /\.json$/i.test(file) ? JSON.parse(text) : parse(text);
  } catch {
    return undefined;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const d = data as Record<string, unknown>;
  if (typeof d.openapi === "string" || typeof d.swagger === "string") return "openapi";
  if (typeof d.asyncapi === "string") return "asyncapi";
  if (typeof d.$schema === "string" || /\.schema\.json$/i.test(file)) return "json-schema";
  return undefined;
}

/** A reference record for a schema: what it is and what it holds, kept beside the link. */
export function schemaReference(
  file: string,
  text: string,
  kind: SchemaKind,
  prefix: string,
): Translation {
  const data = (/\.json$/i.test(file) ? JSON.parse(text) : parse(text)) as Record<string, unknown>;
  const info = (data.info ?? {}) as Record<string, unknown>;
  const title = str(info.title) ?? str(data.title) ?? file;
  const version = str(info.version) ?? str(data.version);
  const operations: string[] = [];
  const paths = (data.paths ?? data.channels ?? {}) as Record<string, Record<string, unknown>>;
  for (const [p, ops] of Object.entries(paths))
    for (const m of Object.keys(ops ?? {}))
      if (/^(get|put|post|delete|patch|head|options|publish|subscribe|send|receive)$/i.test(m))
        operations.push(`${m.toUpperCase()} ${p}`);
  const fields = Object.keys((data.properties ?? {}) as Record<string, unknown>);
  const id = slug(`${prefix}-${file.replace(/\.(ya?ml|json)$/i, "")}`);
  const ref = {
    kind,
    title,
    ...(version ? { version } : {}),
    source: `${prefix}:${file}`,
    ...(operations.length ? { operations } : {}),
    ...(fields.length ? { fields } : {}),
    use:
      kind === "json-schema"
        ? "Referenced from interfaces and mappings; intake reads it when copied into inputs/."
        : "A partner or team API: intake reads it into planned or vendor endpoints when copied into inputs/specs/.",
  };
  return {
    id,
    title,
    path: `references/schemas/${id}.yaml`,
    content: stringify(ref, { lineWidth: 0 }),
    confidence: "high",
  };
}

/** A plain reference record for an item that is followed, not copied. */
export function reference(kind: string, file: string, prefix: string, note: string): Translation {
  const id = slug(`${prefix}-${file.replace(/\.[a-z]+$/i, "")}`);
  return {
    id,
    title: file,
    path: `references/${kind}/${id}.yaml`,
    content: stringify({ kind, source: `${prefix}:${file}`, note }, { lineWidth: 0 }),
    confidence: "high",
  };
}

/** What a line-by-line read of a TypeSpec file finds: its namespace, operations and models. */
export interface TypeSpecOutline {
  namespace?: string;
  operations: string[];
  models: string[];
}

const VERBS = /@(get|put|post|patch|delete|head)\b/;
const ROUTE = /@route\(\s*"([^"]*)"\s*\)/;

/**
 * Read a .tsp file without compiling it: `namespace`, `model` names and each operation as
 * `VERB /path`, the path being the interface's @route, the operation's own @route and a
 * `/{name}` per @path parameter. The verb is the operation's decorator, else POST when it has a
 * @body and GET when it hasn't (TypeSpec's own default). An operation split over lines is read
 * from its first line; the compiled OpenAPI stays the full contract.
 */
export function typespecOutline(text: string): TypeSpecOutline {
  const lines = text.replace(/\/\/.*$/gm, "").split("\n");
  const out: TypeSpecOutline = { operations: [], models: [] };
  let pendingRoute: string | undefined;
  let prefix: string | undefined;
  let depth = 0;
  let interfaceDepth: number | undefined;
  for (const raw of lines) {
    const l = raw.trim();
    const ns = /^namespace\s+([\w.]+)/.exec(l);
    if (ns && !out.namespace) out.namespace = ns[1];
    const route = ROUTE.exec(l)?.[1];
    const model = /\bmodel\s+(\w+)/.exec(l);
    if (model) out.models.push(model[1]!);
    const iface = /\binterface\s+\w+/.test(l);
    if (iface) {
      prefix = pendingRoute ?? route ?? "";
      interfaceDepth = depth;
      pendingRoute = undefined;
    }
    const op = /^((?:@\w+(?:\([^)]*\))?\s+)*)(?:op\s+)?(\w+)\s*\((.*)$/.exec(l);
    const inInterface = interfaceDepth !== undefined && depth === interfaceDepth + 1;
    if (op && !model && !iface && (inInterface || /^(?:@\w+(?:\([^)]*\))?\s+)*op\s/.test(l))) {
      const decorators = op[1] ?? "";
      const own = ROUTE.exec(decorators)?.[1] ?? (inInterface ? undefined : pendingRoute);
      const verb = VERBS.exec(decorators)?.[1] ?? (/@body\b/.test(op[3] ?? "") ? "post" : "get");
      const params = [...(op[3] ?? "").matchAll(/@path\s+(\w+)/g)].map((m) => `/{${m[1]}}`);
      const path = `${inInterface ? (prefix ?? "") : ""}${own ?? ""}${params.join("")}` || "/";
      out.operations.push(`${verb.toUpperCase()} ${path.replace(/\/{2,}/g, "/")}`);
      pendingRoute = undefined;
    } else if (route && !iface) pendingRoute = route;
    for (const c of l) {
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (interfaceDepth !== undefined && depth === interfaceDepth) {
          interfaceDepth = undefined;
          prefix = undefined;
        }
      }
    }
  }
  out.operations.sort();
  return out;
}

/** The reference kept for a TypeSpec file, and the note saying where its compiled form is. */
export function typespecReference(
  file: string,
  text: string,
  prefix: string,
  compiled: string[],
): Translation {
  const o = typespecOutline(text);
  const id = slug(`${prefix}-${file.replace(/\.tsp$/i, "")}`);
  const note = compiled.length
    ? `TypeSpec source. Intake reads its compiled OpenAPI, absorbed as a schema: ${compiled.join(", ")}.`
    : "TypeSpec source. Intake reads OpenAPI, not TypeSpec: run tsp compile . in its repo (emitter @typespec/openapi3) and absorb again, or put the OpenAPI it writes in inputs/specs/.";
  return {
    id,
    title: o.namespace ? `${o.namespace} (${file})` : file,
    path: `references/typespec/${id}.yaml`,
    content: stringify(
      {
        kind: "typespec",
        source: `${prefix}:${file}`,
        ...(o.namespace ? { namespace: o.namespace } : {}),
        ...(o.operations.length ? { operations: o.operations } : {}),
        ...(o.models.length ? { models: o.models } : {}),
        note,
      },
      { lineWidth: 0 },
    ),
    confidence: "high",
  };
}
