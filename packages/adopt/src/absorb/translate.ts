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
