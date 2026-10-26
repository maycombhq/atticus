import { RuntimeKind } from "./schema/ai.js";
import { ASSISTANTS } from "./schema/orgpack.js";

/** Words that name an AI, whatever the tool. */
const GENERIC = ["assistant", "agent", "agents", "ai", "bot", "llm", "model"];

/** A Git host's bot account: `name[bot]`, or a handle ending in `-bot`. */
const BOT = /\[bot\]$|[-_.]bot$/;

/**
 * The name a `by` matched when it names an AI agent or runtime rather than a person (ADR 0115
 * addendum, 2026-10-25): one of the assistants Atticus writes files for, or its short name (the
 * part before its first hyphen); a runtime kind; a generic word for an AI; a Git host's bot
 * account; or one of `known`, which the caller fills from the org pack (its agents' ids, the models
 * it allows). A handle matches a name when it is the name, or starts or ends with it joined by a
 * hyphen, dot, underscore or space ("copilot-agent", "ai-reviewer"); an email is read by its local
 * part. Undefined for a person. Facts about the words only: Atticus can't see who typed them, so
 * this is a record and a speed bump, and the pull request a person approves stays the gate.
 */
export function assistantActor(by: string, known: readonly string[] = []): string | undefined {
  const said = by.trim();
  const local = said.toLowerCase().replace(/@.*$/, "");
  if (!local) return undefined;
  if (BOT.test(local)) return said;
  const names = new Set<string>([...GENERIC, ...RuntimeKind.options]);
  for (const a of ASSISTANTS) {
    names.add(a);
    names.add(a.split("-")[0]!);
  }
  for (const k of known) if (k.trim()) names.add(k.trim().toLowerCase());
  for (const n of names) {
    if (local === n) return said;
    if (local.length > n.length && (local.startsWith(n) || local.endsWith(n))) {
      const next = local.startsWith(n) ? local[n.length] : local[local.length - n.length - 1];
      if (next !== undefined && /[-._\s]/.test(next)) return said;
    }
  }
  return undefined;
}

/** Whether a finding's resolution was recorded by an AI rather than a person. */
export const isAssistantResolution = (
  r: { by: string } | undefined,
  known: readonly string[] = [],
): boolean => !!r && assistantActor(r.by, known) !== undefined;
