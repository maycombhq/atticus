import type { DiagramEdge, Legend, LegendWords } from "@maycombhq/reconcile";

/*
 * Label parsing shared by every diagram reader. It mirrors the private helpers in
 * @maycombhq/reconcile's draw.io reader (edgeParts, legendOf) so a Lucid, Visio or Mermaid
 * edge reads exactly like a draw.io one. If reconcile exports those helpers, use them here.
 */

export const DEFAULT_LEGEND: LegendWords = { new: ["New"], modify: ["Modify"], retire: ["Retire"] };
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const PATTERN = /^[A-Z][A-Z0-9]*(\.[A-Z0-9]+)+$/;
const KINDS = ["new", "modify", "retire"] as const;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Split an edge label into pattern code, then METHOD /path, or a topic. */
export function edgeParts(
  text: string,
): Pick<DiagramEdge, "pattern" | "method" | "path" | "topic"> {
  const toks = text.split(" ").filter(Boolean);
  const out: Pick<DiagramEdge, "pattern" | "method" | "path" | "topic"> = {};
  if (toks[0] && PATTERN.test(toks[0])) out.pattern = toks.shift()!;
  if (toks[0] && METHODS.has(toks[0].toUpperCase()) && toks[1]) {
    out.method = toks[0].toUpperCase();
    out.path = toks[1];
  } else if (toks.length === 1 && /^[A-Za-z0-9][\w.-]*$/.test(toks[0]!)) out.topic = toks[0];
  return out;
}

/** A legend value from a word: the canonical name or one of the profile's legend words. */
export function legendWord(value: string | undefined, words: LegendWords): Legend | undefined {
  const v = value?.trim().toLowerCase();
  if (!v) return undefined;
  for (const k of KINDS) if (v === k || words[k].some((w) => w.toLowerCase() === v)) return k;
  return undefined;
}

/** A legend marker given by the format (shape data, class) or in brackets in the text. */
export function legendOf(
  given: Legend | undefined,
  text: string,
  words: LegendWords,
): { legend?: Legend; text: string } {
  let legend = given;
  let rest = text;
  for (const k of KINDS) {
    for (const w of words[k]) {
      const re = new RegExp(`\\s*[[(]\\s*${escape(w)}\\s*[\\])]\\s*`, "i");
      if (re.test(rest)) {
        legend ??= k;
        rest = rest.replace(re, " ").trim();
      }
    }
  }
  return { ...(legend ? { legend } : {}), text: rest };
}

/** Whitespace collapsed to single spaces and trimmed. */
export const squash = (s: string) => s.replace(/\s+/g, " ").trim();
