import type { DriftItem, DriftKind, DriftReport } from "./drift.js";

/**
 * Machine and human output for the drift check: JSON (the report as it is), JUnit XML (one
 * test case per finding, so any CI's test view shows drift), and a Markdown summary for the
 * pipeline's summary page or a PR comment.
 */

export const driftJson = (r: DriftReport) => `${JSON.stringify(r, null, 2)}\n`;

const xml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const where = (i: DriftItem) =>
  i.evidence.map((e) => `${e.path ?? ""}${e.line ? `:${e.line}` : ""}`).filter(Boolean);

/**
 * JUnit XML: a test suite per repo, a test case per item (classname atticus.drift.<subject>).
 * Drift fails its test case in block mode and is skipped with the reason in warn mode; planned
 * items pass. A clean repo has one passing case, so the suite is never empty.
 */
export function driftJUnit(r: DriftReport): string {
  const cases = r.items.map((i) => {
    const name = `${i.kind} ${i.subject} ${i.id}`;
    const open = `    <testcase classname="atticus.drift.${i.subject}" name="${xml(name)}">`;
    const detail = [i.summary, ...where(i).map((w) => `at ${w}`)].join("\n");
    if (i.kind === "planned")
      return `${open}\n      <system-out>${xml(detail)}</system-out>\n    </testcase>`;
    if (r.mode === "warn")
      return `${open}\n      <skipped message="${xml(`warn-only: ${i.summary}`)}"/>\n    </testcase>`;
    return `${open}\n      <failure message="${xml(i.summary)}" type="${i.kind}">${xml(detail)}</failure>\n    </testcase>`;
  });
  if (!cases.length)
    cases.push(
      `    <testcase classname="atticus.drift" name="${xml(`${r.repo} matches the catalog`)}"/>`,
    );
  const failures = r.mode === "block" ? r.items.filter((i) => i.kind !== "planned").length : 0;
  const skipped = r.mode === "warn" ? r.items.filter((i) => i.kind !== "planned").length : 0;
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<testsuites name="atticus drift" tests="${cases.length}" failures="${failures}" skipped="${skipped}">`,
    `  <testsuite name="${xml(`atticus drift ${r.repo}`)}" tests="${cases.length}" failures="${failures}" errors="0" skipped="${skipped}">`,
    ...cases,
    `  </testsuite>`,
    `</testsuites>`,
    "",
  ].join("\n");
}

const KIND_WORD: Record<DriftKind, string> = {
  added: "Not in the catalog",
  changed: "Changed",
  removed: "Gone from the code",
  unknown: "Unknown loose end",
  planned: "Planned",
};

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** The Markdown summary: a headline, then one table row per item. */
export function driftMarkdown(r: DriftReport): string {
  const n = r.items.filter((i) => i.kind !== "planned").length;
  const planned = r.counts.planned;
  const head = !r.drift
    ? `No drift: ${r.repo} matches the catalog${planned ? ` (${planned} planned by approved changes)` : ""}.`
    : `${n} drift ${n === 1 ? "finding" : "findings"} in ${r.repo}${r.mode === "warn" ? " (warn-only: the pipeline passes)" : ""}.`;
  const lines = [`## Atticus drift check: ${r.repo}`, "", head];
  if (r.items.length) {
    lines.push("", "| What | Kind | Id | Details |", "| --- | --- | --- | --- |");
    for (const i of r.items)
      lines.push(
        `| ${KIND_WORD[i.kind]} | ${i.subject} | ${cell(i.id)} | ${cell(i.summary)}${where(i).length ? ` (${where(i).join(", ")})` : ""} |`,
      );
  }
  if (r.drift && r.mode === "block")
    lines.push(
      "",
      "Fix the code, or record the change in the catalog: plan it in an approved change's design, or rescan the estate once it is merged.",
    );
  if (r.problems.length) lines.push("", "Problems:", ...r.problems.map((p) => `- ${p}`));
  return `${lines.join("\n")}\n`;
}
