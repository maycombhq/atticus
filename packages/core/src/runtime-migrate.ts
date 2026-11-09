import { isMap, parseDocument } from "yaml";

/**
 * runtime.yaml version 1 → 2 (ADR 0121 addendum, per-step models). Version 2 adds a model per
 * kind of step (`models.read`, `draft`, `critic`, `knowledge`, `quick`); a file that names none
 * runs every step on the one model, as every step ran in version 1. So the migration only writes
 * the new version and keeps the file's comments and order: no step changes model until a person
 * names one. `models.recommended` stays as it is (the critic still reads `recommended.critic`).
 */
export function migrateRuntimeText(text: string): { text: string; changed: boolean } {
  const doc = parseDocument(text);
  if (!isMap(doc.contents) || doc.get("schemaVersion") !== 1) return { text, changed: false };
  // The number on its own line, so every other line stays exactly as the person wrote it (the
  // yaml library would space out flow lists); otherwise the document, written again.
  const line = /^schemaVersion:[ \t]*1[ \t]*(#.*)?$/m;
  if (line.test(text))
    return {
      text: text.replace(line, (_m, c?: string) => `schemaVersion: 2${c ? ` ${c}` : ""}`),
      changed: true,
    };
  doc.set("schemaVersion", 2);
  return { text: doc.toString({ lineWidth: 0 }), changed: true };
}

/** Whether a runtime.yaml names copilot-acp, as a mode or with its section (ADR 0171). */
function namesCopilotAcp(doc: ReturnType<typeof parseDocument>): boolean {
  const js = (doc.toJS() ?? {}) as {
    modes?: { allowed?: unknown; default?: unknown };
    copilotAcp?: unknown;
  };
  const allowed = Array.isArray(js.modes?.allowed) ? js.modes.allowed : [];
  return (
    js.copilotAcp !== undefined ||
    allowed.includes("copilot-acp") ||
    js.modes?.default === "copilot-acp"
  );
}

/**
 * runtime.yaml to version 3 (ADR 0171), for a file that names copilot-acp (a mode, or the
 * copilotAcp section): the number only, every other line as the person wrote it. A file that
 * doesn't name it means the same at version 1 or 2, so it is left as it is.
 */
export function migrateRuntimeV3Text(text: string): { text: string; changed: boolean } {
  const doc = parseDocument(text);
  if (doc.errors.length || !isMap(doc.contents)) return { text, changed: false };
  const v = doc.get("schemaVersion");
  if ((v !== 1 && v !== 2) || !namesCopilotAcp(doc)) return { text, changed: false };
  const line = /^schemaVersion:[ \t]*[12][ \t]*(#.*)?$/m;
  if (line.test(text))
    return {
      text: text.replace(line, (_m, c?: string) => `schemaVersion: 3${c ? ` ${c}` : ""}`),
      changed: true,
    };
  doc.set("schemaVersion", 3);
  return { text: doc.toString({ lineWidth: 0 }), changed: true };
}

/**
 * runtime.yaml to version 4 (ADR 0181), for a file that sets `decide` (whether the AI decides
 * pairings and option questions itself): the number only, every other line as the person wrote
 * it. A file without it means the same at version 1 to 3, so it is left as it is.
 */
export function migrateRuntimeV4Text(text: string): { text: string; changed: boolean } {
  const doc = parseDocument(text);
  if (doc.errors.length || !isMap(doc.contents)) return { text, changed: false };
  const v = doc.get("schemaVersion");
  if ((v !== 1 && v !== 2 && v !== 3) || !doc.has("decide")) return { text, changed: false };
  const line = /^schemaVersion:[ \t]*[123][ \t]*(#.*)?$/m;
  if (line.test(text))
    return {
      text: text.replace(line, (_m, c?: string) => `schemaVersion: 4${c ? ` ${c}` : ""}`),
      changed: true,
    };
  doc.set("schemaVersion", 4);
  return { text: doc.toString({ lineWidth: 0 }), changed: true };
}
