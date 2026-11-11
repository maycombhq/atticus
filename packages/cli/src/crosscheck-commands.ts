import { mkdir } from "node:fs/promises";
import { dirname, relative, sep } from "node:path";
import { writeFileAtomic } from "@maycombhq/core";
import {
  dismissalsAfter,
  dismissalsPath,
  readCrossCheck,
  readDismissals,
  serializeDismissals,
  type CrossCheckItem,
  type RepoCrossCheck,
} from "@maycombhq/scanner";
import type { Output } from "./commands.js";

/**
 * `atticus catalog crosscheck [<repo>] [--json] [--dismiss <key> | --undismiss <key>]` (ADR 0195
 * point 3, ticket CS3): the readers' cross-check of each repo with facts, from the slots, and a
 * person's dismissal of an item. A dismissal is kept in `facts/<repo>.crosscheck.yaml` at the
 * readers' value the item has now, so it is listed again when that value changes; taking it back
 * lists it again at once. Nothing here changes a slot or a catalog record: the facts are the
 * source, and the readers slot is kept whole. The app's Readers found page runs this command, so
 * its lines are in the Console.
 */

const posix = (p: string) => p.split(sep).join("/");
const short = (c?: string) => (c && /^[0-9a-f]{8,}$/.test(c) ? c.slice(0, 7) : (c ?? ""));

const STATE_WORDS: Record<RepoCrossCheck["state"], string> = {
  compared: "compared",
  "no-facts": "no facts slot: its records come from the readers, so there is nothing to check",
  "no-readers": "no readers slot yet: scan it to compare (atticus scan --repos <repo>)",
  legacy:
    "its readers slot is the upgrade's copy of the old catalog, not compared until a scan reads it",
  unusable: "a slot doesn't read",
};

const valueWords = (v: unknown): string =>
  v === undefined || v === null
    ? "nothing"
    : typeof v === "string"
      ? v
      : typeof v === "object"
        ? Object.entries(v as Record<string, unknown>)
            .map(([k, x]) => `${k} ${typeof x === "string" ? x : JSON.stringify(x)}`)
            .join(", ")
        : JSON.stringify(v);

const cite = (i: CrossCheckItem, side: "readers" | "facts") => {
  const c = i[side]?.cites[0];
  return c ? ` (${c.file}${c.line ? `:${c.line}` : ""})` : "";
};

/** One item in words, as the Console and a terminal show it. */
export function itemLine(i: CrossCheckItem): string {
  const mark = i.dismissed ? " [dismissed]" : "";
  if (i.state === "readers-only")
    return `readers found: ${i.key}: ${valueWords(i.readers?.value)}${cite(i, "readers")}${mark}`;
  if (i.state === "facts-only")
    return `facts only: ${i.key}: ${valueWords(i.facts?.value)}${cite(i, "facts")}`;
  const f = (i.fields ?? [])
    .map((x) => `${x.field}: readers ${valueWords(x.readers)}, facts ${valueWords(x.facts)}`)
    .join("; ");
  return `disagree: ${i.key}: ${f}${cite(i, "readers")}${mark}`;
}

export async function catalogCrossCheck(
  root: string,
  o: { repo?: string; json?: boolean; dismiss?: string; undismiss?: string },
  io: Output,
): Promise<number> {
  if ((o.dismiss !== undefined || o.undismiss !== undefined) && !o.repo) {
    io.err("Say which repo: atticus catalog crosscheck <repo> --dismiss <key>.");
    return 2;
  }
  if (o.dismiss !== undefined && o.undismiss !== undefined) {
    io.err("--dismiss and --undismiss take one key each, one at a time.");
    return 2;
  }
  const view = await readCrossCheck(root, o.repo ? { repo: o.repo } : {});
  if (o.repo && !view.repos.length) {
    io.err(`${o.repo} isn't a repo the manifests list (a prototype isn't compared).`);
    return 1;
  }
  const key = o.dismiss ?? o.undismiss;
  if (key !== undefined) {
    const r = view.repos[0]!;
    if (r.state !== "compared") {
      io.err(
        `${r.repo}: ${STATE_WORDS[r.state]}${r.problem ? ` (${r.problem})` : ""}. Nothing written.`,
      );
      return 1;
    }
    const d = await readDismissals(root, r.repo);
    if (d.problem) {
      io.err(`${r.dismissals} ${d.problem}: put it right by hand, or remove it. Nothing written.`);
      return 1;
    }
    const item = r.items.find((i) => i.key === key && i.state !== "facts-only");
    const path = dismissalsPath(root, r.repo);
    const rel = posix(relative(root, path));
    if (o.undismiss !== undefined) {
      if (!d.dismissals?.dismissed.some((x) => x.key === key)) {
        io.err(`${key} isn't dismissed in ${rel}. Nothing written.`);
        return 1;
      }
      const next = dismissalsAfter(d.dismissals, key, { undo: true });
      await mkdir(dirname(path), { recursive: true });
      await writeFileAtomic(path, serializeDismissals(next));
      io.out(`${r.repo}: ${key} is listed again (taken out of ${rel}).`);
      return 0;
    }
    if (!item) {
      io.err(
        `${r.repo}: ${key} isn't an item the readers found or disagree on now (atticus catalog crosscheck ${r.repo} lists them). Nothing written.`,
      );
      return 1;
    }
    const next = dismissalsAfter(d.dismissals, key, { readers: item.readers?.value ?? null });
    await mkdir(dirname(path), { recursive: true });
    await writeFileAtomic(path, serializeDismissals(next));
    io.out(
      `${r.repo}: dismissed ${key} at the readers' value ${valueWords(item.readers?.value)} in ${rel}; it is listed again if the readers' value changes. Propose the file for review so the team keeps it.`,
    );
    return 0;
  }
  if (o.json) {
    io.out(JSON.stringify(view, null, 2));
    return 0;
  }
  for (const r of view.repos) {
    if (r.state !== "compared") {
      io.out(`${r.repo}: ${STATE_WORDS[r.state]}${r.problem ? ` (${r.problem})` : ""}`);
      continue;
    }
    const c = r.counts;
    io.out(
      `${r.repo}: readers at ${short(r.readersCommit)}, facts at ${short(r.factsCommit)}: ${c.readersOnly} found by the readers only, ${c.disagree} disagree, ${c.factsOnly} in the facts only, ${c.agree} agree${c.dismissed ? `, ${c.dismissed} dismissed` : ""}`,
    );
    if (o.repo) for (const i of r.items) io.out(`  ${itemLine(i)}`);
  }
  for (const p of view.problems) io.err(`${p.file}: ${p.message}`);
  if (!o.repo && view.repos.some((r) => r.state === "compared"))
    io.out("atticus catalog crosscheck <repo> lists a repo's items.");
  return 0;
}
