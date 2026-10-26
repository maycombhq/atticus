/**
 * Current catalog schema version. Bumping it requires an ADR and a migration.
 * Version 2 (ADR 0031) added the Capability kind and changed no existing field.
 * Version 3 (ADR 0125) added `required` on a Schema field, optional, and changed no other field.
 *
 * It lives in its own file, with no schema beside it, so the command line can print it in its
 * help without loading zod (`@maycombhq/core/light`); `./common.js` exports it with C1.
 */
export const SCHEMA_VERSION = 3 as const;
