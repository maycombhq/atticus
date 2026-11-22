import { RuntimeKind } from "./schema/ai.js";
import { ASSISTANTS } from "./schema/orgpack.js";

/** Words that name an AI, whatever the tool. */
const GENERIC = ["assistant", "agent", "agents", "ai", "bot", "llm", "model"];

/** A Git host's bot account: `name[bot]`, or a handle ending in `-bot`. */
const BOT = /\[bot\]$|[-_.]bot$/;

/** A handle every critic lens and every persona's naysayer has: one hyphenated word, no address. */
const LENS_HANDLE = /^[a-z0-9]+(?:-[a-z0-9]+)*-(?:critic|naysayer)$/;

/**
 * The name a `by` matched when it names an AI agent or runtime rather than a person (ADR 0115
 * addendum, 2026-10-25; ADR 0203 A.4). Three rules:
 *
 * 1. One of the assistants Atticus writes files for, or its short name (the part before its first
 *    hyphen); a runtime kind; a generic word for an AI; a Git host's bot account. Such a word
 *    matches when it is the handle, or starts or ends it joined by a hyphen, dot, underscore or
 *    space ("copilot-agent", "ai-reviewer"); an email is read by its local part.
 * 2. One of `known`, which the caller fills (Atticus's own agents, the org pack's agents, its
 *    persona files, the models it allows): the whole `by`, exactly, case aside. Never a part of
 *    it, so a person "m.judge@…" or "judge.smith" is a person.
 * 3. A handle that ends `-critic` or `-naysayer` and is one hyphenated word of letters and digits
 *    (every critic lens and every persona's naysayer is named so): not an email, a dotted name,
 *    or words with spaces or underscores, which are people's.
 *
 * Undefined for a person. Facts about the words only: Atticus can't see who typed them, so this
 * is a record and a speed bump, and the pull request a person approves stays the gate.
 */
export function assistantActor(by: string, known: readonly string[] = []): string | undefined {
  const said = by.trim();
  const whole = said.toLowerCase();
  const local = whole.replace(/@.*$/, "");
  if (!local) return undefined;
  if (BOT.test(local)) return said;
  if (known.some((k) => k.trim() && k.trim().toLowerCase() === whole)) return said;
  if (LENS_HANDLE.test(whole)) return said;
  const names = new Set<string>([...GENERIC, ...RuntimeKind.options]);
  for (const a of ASSISTANTS) {
    names.add(a);
    names.add(a.split("-")[0]!);
  }
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
