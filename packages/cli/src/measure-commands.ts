import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { loadOrgPack, orgPackDirOf } from "@maycombhq/core";
import {
  estateFacts,
  measureLinks,
  parseLinkReference,
  type LinkGot,
  type LinkWant,
  type MeasureLinksResult,
} from "@maycombhq/scanner";
import type { Output } from "./commands.js";

/**
 * atticus join measure <reference> [--json] (plan item R5): a person's own estate measured against
 * the entries and calls they listed by hand for two or three repos they know, each call with the
 * repo it should reach. It reads the org pack, every repo's verified facts and the answers to the
 * targets questions, runs the estate join as verify --write does, and prints reading recall and
 * join precision and recall. It reads files only and writes nothing but its report.
 */

export const MEASURE_WORDS = {
  usage: "Usage: atticus join measure <reference.yaml> [--json] (docs/guide/measure.md)",
  noFile: (file: string) =>
    `There is no reference file at ${file}. List a few known repos' entries and calls in it (docs/guide/measure.md), then run atticus join measure again.`,
  badFile: (file: string) => `${file} isn't a reference Atticus can read:`,
  nothing: (file: string) =>
    `${file} lists no calls or entries, so there is nothing to measure. List a few known repos' entries and calls (docs/guide/measure.md).`,
  head: (file: string, m: MeasureLinksResult, repos: number) =>
    `Measured against ${file}${m.estate ? ` (${m.estate})` : ""}: ${plural(repos, "repo")}, ${plural(m.reading.entries.want, "entry", "entries")} and ${plural(m.reading.calls.want, "call")} listed.`,
  reading: (m: MeasureLinksResult) =>
    `Reading: ${m.reading.entries.found} of ${plural(m.reading.entries.want, "entry", "entries")} and ${m.reading.calls.found} of ${plural(m.reading.calls.want, "call")} are in the facts${pct(m.reading.entries.found + m.reading.calls.found, m.reading.entries.want + m.reading.calls.want)}.`,
  precision: (m: MeasureLinksResult) =>
    m.links.precision === null
      ? "Join precision: no listed call is joined to a repo yet."
      : `Join precision ${m.links.precision}: ${m.links.right} of the ${plural(m.links.joined, "listed call")} joined to a repo reach the one you named.`,
  recall: (m: MeasureLinksResult) =>
    m.links.recall === null
      ? "Join recall: no listed call should reach a repo of the estate."
      : `Join recall ${m.links.recall}: ${m.links.right} of the ${plural(m.links.want, "call")} that should reach a repo of the estate do.`,
  rest: (m: MeasureLinksResult) =>
    [
      `${m.links.asked} asked`,
      `${m.links.inferred.joined} guessed (${m.links.inferred.right} right)`,
      `${m.links.outside.right} of ${m.links.outside.want} outside right`,
      ...(m.links.none.want ? [`${m.links.none.right} of ${m.links.none.want} "none" right`] : []),
      `${m.links.unlinked} unlinked`,
      ...(m.links.missed ? [`${m.links.missed} with no entry serving them`] : []),
      `${m.links.notRead} not read`,
    ].join(", ") + ".",
  calls: "Each listed call:",
  missed:
    "Listed but not in the facts (read the repo again, or check the line and path you wrote):",
  readOnly: "Nothing was written.",
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pct = (a: number, b: number) => (b ? ` (${Math.round((a / b) * 100)}%)` : "");

const wantText = (w: LinkWant) =>
  "repo" in w ? w.repo : "outside" in w ? `outside ${w.outside}` : "none";

function gotText(g: LinkGot): string {
  switch (g.kind) {
    case "joined":
      return `${g.repo} ${g.entry}${g.via?.length ? ` via ${g.via.join(", ")}` : ""}${g.inferred ? ` (a guess: ${g.inferred})` : ""}`;
    case "outside":
      return `outside ${g.system}`;
    case "asked":
      return `asked (${g.reason}): atticus questions`;
    case "missed":
      return `named ${g.target}, which serves nothing like it`;
    case "unlinked":
      return "nothing";
    case "not-read":
      return "not in the facts";
  }
}

export async function joinMeasure(
  root: string,
  file: string | undefined,
  o: { json?: boolean },
  io: Output,
): Promise<number> {
  if (!file) {
    io.err(MEASURE_WORDS.usage);
    return 2;
  }
  const path = isAbsolute(file) ? file : resolve(root, file);
  const text = await readFile(path, "utf8").catch(() => undefined);
  if (text === undefined) {
    io.err(MEASURE_WORDS.noFile(file));
    return 2;
  }
  const parsed = parseLinkReference(text);
  if (!parsed.ok) {
    io.err(MEASURE_WORDS.badFile(file));
    for (const i of parsed.issues) io.err(`  ${i}`);
    return 2;
  }
  const ref = parsed.reference;
  if (!ref.repos.some((r) => r.calls.length || r.entries.length)) {
    io.err(MEASURE_WORDS.nothing(file));
    return 2;
  }
  const op = await loadOrgPack(orgPackDirOf(root));
  const estate = await estateFacts(root, op, "");
  const m = measureLinks({ op, repos: estate.repos, targets: estate.targets, reference: ref });
  const notes = [...estate.notes, ...m.notes];
  if (o.json) {
    io.out(JSON.stringify({ reference: file, ...m, notes }, null, 2));
    return 0;
  }
  io.out(MEASURE_WORDS.head(file, m, ref.repos.length));
  io.out(MEASURE_WORDS.reading(m));
  io.out(MEASURE_WORDS.precision(m));
  io.out(MEASURE_WORDS.recall(m));
  io.out(MEASURE_WORDS.rest(m));
  if (m.calls.length) {
    io.out("");
    io.out(MEASURE_WORDS.calls);
    for (const c of m.calls)
      io.out(
        `  ${c.right ? "ok" : "--"}  ${c.repo} ${c.call}: wanted ${wantText(c.want)}, got ${gotText(c.got)}`,
      );
  }
  if (m.reading.missed.length) {
    io.out("");
    io.out(MEASURE_WORDS.missed);
    for (const x of m.reading.missed) io.out(`  ${x}`);
  }
  if (notes.length) {
    io.out("");
    for (const n of notes) io.out(n);
  }
  io.out("");
  io.out(MEASURE_WORDS.readOnly);
  return 0;
}
