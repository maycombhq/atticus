import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parseDocument, visit, type Document } from "yaml";
import {
  changesDirOf,
  factsDirOf,
  listQuestions,
  questionFileOf,
  recordPath,
  specsDirOf,
  type CatalogRecord,
  type Question,
} from "@maycombhq/core";

/**
 * ADR 0124 addendum E-ids, its dated part of 2026-11-22 (the owner: one deterministic rule): the
 * ids of loose ends the build's inputs name, by the input files that name them, so a build that
 * would name a loose end of the old form again with its repo while an input still names the old
 * id refuses (`oldIdsNamedOf`), and `atticus upgrade` renames it and carries the input in one
 * write (`packages/cli/src/upgrade-unresolved-ids.ts`, which reads the same files).
 *
 * The inputs are every file the step carries ids in: the curated records (a decision's target, a
 * curated loose end's own id), a change's YAML files (not the archive), the specs' flows, the
 * cross-check dismissals (`facts/<repo>.crosscheck.yaml`, keyed `Unresolved|<id>`) and the
 * questions. Only files of the metarepo, never this machine's, so the same commit refuses the
 * same on every machine.
 */

const PREFIX = "unresolved.";
/** A cross-check item's key, `<Kind>|<id>`. */
export const UNRESOLVED_KEYED = "Unresolved|";

const posix = (p: string) => p.split(sep).join("/");
const yamlFile = (n: string) => /\.ya?ml$/.test(n);

async function walk(dir: string, keep: (name: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p, keep)));
    else if (keep(e.name)) out.push(p);
  }
  return out.sort();
}

/** The input files a loose end's id may be named in, with whether each is a question or curated. */
export async function looseEndInputFiles(
  root: string,
  curatedDir: string,
): Promise<{ path: string; question?: true; curated?: true }[]> {
  const out: { path: string; question?: true; curated?: true }[] = [];
  for (const p of await walk(curatedDir, yamlFile)) out.push({ path: p, curated: true });
  // A change's YAML files, not the archive: an archived change is history.
  const changes = changesDirOf(root);
  for (const p of await walk(changes, yamlFile))
    if (!posix(relative(changes, p)).startsWith("archive/")) out.push({ path: p });
  for (const p of await walk(specsDirOf(root), yamlFile)) out.push({ path: p });
  for (const p of await walk(factsDirOf(root), (n) => n.endsWith(".crosscheck.yaml")))
    out.push({ path: p });
  const qs = (await listQuestions(root).catch(() => ({ questions: [] as Question[] }))).questions;
  for (const q of qs) out.push({ path: questionFileOf(root, q.id), question: true });
  return out;
}

/** Each string scalar of a YAML document, in order (seq items included). */
export function stringScalars(doc: Document): string[] {
  const out: string[] = [];
  visit(doc, {
    Scalar(_, node) {
      if (typeof node.value === "string") out.push(node.value);
    },
  });
  return out;
}

/** The id a value names: a cross-check key's id after its kind, else the value. */
export const idOfValue = (v: string) =>
  v.startsWith(UNRESOLVED_KEYED) ? v.slice(UNRESOLVED_KEYED.length) : v;

/** Every string in a value, deep. */
function stringsIn(v: unknown, out: string[]): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringsIn(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) stringsIn(x, out);
  return out;
}

/**
 * The loose ends' ids (`unresolved.…`) the build's inputs name, each with the input files that
 * name it (relative to the root, sorted). The curated records and the questions are taken as the
 * build has them (a command's, as they will be); the other files as `pending` has them, else as
 * on disk.
 */
export async function looseEndIdsNamed(
  root: string,
  o: {
    curatedDir: string;
    curated: readonly CatalogRecord[];
    questions?: readonly Question[];
    pending?: ReadonlyMap<string, string | null>;
  },
): Promise<Map<string, string[]>> {
  const named = new Map<string, Set<string>>();
  const add = (id: string, path: string) => {
    if (!id.startsWith(PREFIX)) return;
    const rel = posix(relative(root, path));
    const s = named.get(id) ?? new Set<string>();
    s.add(rel);
    named.set(id, s);
  };
  for (const r of o.curated)
    for (const v of stringsIn(r, [])) add(v, join(o.curatedDir, ...recordPath(r).split("/")));
  const questions =
    o.questions ??
    (await listQuestions(root).catch(() => ({ questions: [] as Question[] }))).questions;
  for (const q of questions)
    for (const v of stringsIn(q, [])) add(idOfValue(v), questionFileOf(root, q.id));
  const files = new Set(
    (await looseEndInputFiles(root, o.curatedDir))
      .filter((f) => !f.curated && !f.question)
      .map((f) => f.path),
  );
  for (const [p, t] of o.pending ?? []) if (t !== null && yamlFile(p)) files.add(p);
  const changes = changesDirOf(root);
  const inScope = (p: string) => {
    const under = (d: string) => !posix(relative(d, p)).startsWith("..");
    return (
      (under(changes) && !posix(relative(changes, p)).startsWith("archive/")) ||
      under(specsDirOf(root)) ||
      (under(factsDirOf(root)) && p.endsWith(".crosscheck.yaml"))
    );
  };
  for (const p of [...files].sort()) {
    if (!inScope(p)) continue;
    const w = o.pending?.get(p);
    if (w === null) continue;
    const text = typeof w === "string" ? w : await readFile(p, "utf8").catch(() => undefined);
    if (text === undefined || !text.includes(PREFIX)) continue;
    let doc: Document;
    try {
      doc = parseDocument(text);
    } catch {
      continue;
    }
    for (const v of stringScalars(doc)) add(idOfValue(v), p);
  }
  return new Map([...named].map(([id, s]) => [id, [...s].sort()] as const));
}
