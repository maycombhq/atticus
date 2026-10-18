import { z } from "zod";
import { RECORD_KINDS, RECORD_SCHEMAS, type RecordKind } from "./schema/kinds.js";

/**
 * JSON Schema for every record kind, generated from the zod source of truth, for editors,
 * other tools and org-pack validation outside TypeScript.
 */
export function catalogJsonSchemas(): Record<RecordKind, object> {
  const out = {} as Record<RecordKind, object>;
  for (const kind of RECORD_KINDS) {
    const schema = z.toJSONSchema(RECORD_SCHEMAS[kind], { io: "input", unrepresentable: "any" });
    out[kind] = {
      $id: `https://maycombhq.github.io/atticus/schema/catalog/v1/${kind}.json`,
      title: kind,
      ...schema,
    };
  }
  return out;
}
