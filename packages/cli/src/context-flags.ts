import type { ContextOptions, ContextReport } from "@maycombhq/planner";

/**
 * The context engine's flags on the steps that use it (ADR 0107): `--context-tokens n` sets the
 * room for the selected context; `--whole-context` sends the whole lists as before.
 */
export function contextFlags(
  values: Record<string, unknown>,
): { context: ContextOptions } | { error: string } {
  const raw = values["context-tokens"];
  const out: ContextOptions = {};
  if (raw !== undefined) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 100)
      return {
        error: "--context-tokens is a whole number of 100 or more: the room for the context.",
      };
    out.tokens = n;
  }
  if (values["whole-context"] === true) out.engine = false;
  return { context: out };
}

/** What the step sent as context, in a line or two for the person. */
export function contextLines(c: ContextReport | undefined): string[] {
  if (!c) return [];
  if (!c.engine) return c.note ? [`Context: ${c.note}.`] : [];
  const full = c.picked.filter((p) => p.level === "full").length;
  const lines = [
    `Context: ${c.picked.length} record${c.picked.length === 1 ? "" : "s"} selected from the index (${full} in full), ${c.tokens ?? 0} of ${c.budget ?? 0} tokens${
      c.leftOut.length
        ? `; left out for room: ${c.leftOut
            .slice(0, 10)
            .map((l) => l.id)
            .join(", ")}${c.leftOut.length > 10 ? ` and ${c.leftOut.length - 10} more` : ""}`
        : ""
    }.`,
  ];
  const gaps = c.gaps ?? [];
  if (gaps.length) {
    // ADR 0107 point 5: what neither the wikis nor the repos say, listed; a gap the answer
    // relied on is a question to a person.
    lines.push(
      `Gaps: names the change uses that nothing Atticus has read says anything about: ${gaps
        .map((g) => `${g.name}${g.evidence ? ` (${g.evidence})` : ""}`)
        .join(", ")}.`,
    );
    for (const g of gaps.filter((x) => x.question))
      lines.push(
        g.state === "answered"
          ? `  ${g.name}: answered (question ${g.question}).`
          : `  ${g.name}: the answer relies on it, so it is a question to a person, not a guess: atticus questions answer ${g.question}`,
      );
  } else if (c.unknown.length)
    lines.push(`Names the change uses that nothing in the index has: ${c.unknown.join(", ")}.`);
  return lines;
}
