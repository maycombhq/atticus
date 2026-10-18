import { z } from "zod";
import { RECORD_KINDS, RECORD_SCHEMAS } from "@maycombhq/core";

/**
 * kit/c1-kinds.md, generated from contract C1 so the kit can never disagree with the
 * schema: for each record kind a dialect can emit, the fields a rule may set.
 */

const ENGINE_FIELDS = new Set(["kind", "schemaVersion", "id", "status", "confidence", "evidence"]);
const SLUG = "^[a-z0-9][a-z0-9._-]*$";

type Js = {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  pattern?: string;
  items?: Js;
  properties?: Record<string, Js>;
  required?: string[];
  additionalProperties?: Js | boolean;
  anyOf?: Js[];
  default?: unknown;
  format?: string;
};

function describe(s: Js): string {
  if (s.anyOf) return s.anyOf.map(describe).join(" or ");
  if (s.enum) return `one of ${s.enum.map((v) => `\`${String(v)}\``).join(", ")}`;
  if (s.const !== undefined) return `\`${String(s.const)}\``;
  const t = Array.isArray(s.type) ? s.type[0] : s.type;
  switch (t) {
    case "string":
      if (s.pattern === SLUG) return "a record id";
      if (s.format === "date") return "a date (YYYY-MM-DD)";
      if (s.format === "date-time") return "a timestamp";
      return "text";
    case "integer":
      return "a whole number";
    case "number":
      return "a number";
    case "boolean":
      return "`true` or `false`";
    case "array": {
      const item = s.items ? describe(s.items) : "any value";
      if (item === "text") return "a list of text";
      if (item === "a record id") return "a list of record ids";
      if (item.startsWith("an object")) return `a list of objects${item.slice("an object".length)}`;
      return `a list, each ${item}`;
    }
    case "object":
      if (s.properties)
        return `an object with ${Object.keys(s.properties)
          .map((k) => `\`${k}\``)
          .join(", ")}`;
      return "an object (key: value)";
    default:
      return "any value";
  }
}

export function kindsMarkdown(): string {
  const L = [
    "# Record kinds (contract C1)",
    "",
    "Generated from the schema. A rule's `emit.kind` is one of these, and its `emit.fields` may set only the fields listed for that kind. The engine sets `kind`, `id`, `schemaVersion`, `status` (always `current`), `confidence` (from the rule) and `evidence` itself; a rule can't set them.",
    "",
    "A field marked **yes** must end up with a value, or the record is rejected and reported as invalid. Fields with a default may be left out. Templates always render text, so a rule can fill text fields, record ids and enum values from templates; numbers and `true`/`false` can only be written as literal values; a list field takes a list of templates (items that render empty are dropped). Fields whose value is an object, or a list of objects, cannot be set by a rule. A record id is a lowercase slug (`a-z`, `0-9`, `.`, `_`, `-`).",
    "",
  ];
  for (const kind of RECORD_KINDS) {
    if (kind === "CuratedDecision") continue; // written by people, never by rules
    const js = z.toJSONSchema(RECORD_SCHEMAS[kind], { io: "input", unrepresentable: "any" }) as Js;
    const required = new Set(js.required ?? []);
    L.push(`## ${kind}`, "", "| field | required | value |", "| --- | --- | --- |");
    for (const [field, schema] of Object.entries(js.properties ?? {})) {
      if (ENGINE_FIELDS.has(field)) continue;
      L.push(`| \`${field}\` | ${required.has(field) ? "yes" : "no"} | ${describe(schema)} |`);
    }
    L.push("");
  }
  return L.join("\n");
}
