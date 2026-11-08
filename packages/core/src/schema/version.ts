/**
 * Current catalog schema version. Bumping it requires an ADR and a migration.
 * Version 2 (ADR 0031) added the Capability kind and changed no existing field.
 * Version 3 (ADR 0125) added `required` on a Schema field, optional, and changed no other field.
 * Version 4 (ADR 0164) added `protobuf` to a Schema's `format`, and changed no other field.
 * Version 5 (ADR 0181) added the evidence source `ai` and an evidence's `run` (a link the AI
 * decided, flagged `joined-by-ai`), and changed no other field.
 *
 * It lives in its own file, with no schema beside it, so the command line can print it in its
 * help without loading zod (`@maycombhq/core/light`); `./common.js` exports it with C1.
 */
export const SCHEMA_VERSION = 5 as const;
