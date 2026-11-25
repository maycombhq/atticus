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
 * runtime.yaml to version `to` for a file that `needs` it: the number only, every other line as
 * the person wrote it. A file that doesn't need it means the same at its own number.
 */
function liftRuntimeText(
  text: string,
  to: number,
  needs: (d: ReturnType<typeof parseDocument>) => boolean,
) {
  const doc = parseDocument(text);
  if (doc.errors.length || !isMap(doc.contents)) return { text, changed: false };
  const v = doc.get("schemaVersion");
  if (typeof v !== "number" || v < 1 || v >= to || !needs(doc)) return { text, changed: false };
  const line = new RegExp(`^schemaVersion:[ \\t]*${v}[ \\t]*(#.*)?$`, "m");
  if (line.test(text))
    return {
      text: text.replace(line, (_m, c?: string) => `schemaVersion: ${to}${c ? ` ${c}` : ""}`),
      changed: true,
    };
  doc.set("schemaVersion", to);
  return { text: doc.toString({ lineWidth: 0 }), changed: true };
}

/** To version 3 (ADR 0171), for a file that names copilot-acp (a mode, or its section). */
export const migrateRuntimeV3Text = (text: string) => liftRuntimeText(text, 3, namesCopilotAcp);
/** To version 4 (ADR 0181), for a file that sets `decide`. */
export const migrateRuntimeV4Text = (text: string) =>
  liftRuntimeText(text, 4, (d) => d.has("decide"));
/** To version 5 (ADR 0210 part 5), for a file that sets `budgets.limits`. */
export const migrateRuntimeV5Text = (text: string) =>
  liftRuntimeText(text, 5, (d) => d.hasIn(["budgets", "limits"]));
/** conventions.yaml to version 3 (ADR 0210 part 6), for a file that sets `readers`. */
export const migrateConventionsV3Text = (text: string) =>
  liftRuntimeText(text, 3, (d) => d.has("readers"));
