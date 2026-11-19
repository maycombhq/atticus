import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AiOffError, runtimeForCli, type AiRuntime } from "@maycombhq/ai";
import {
  catalogDirOf,
  loadOrgPack,
  orgPackDirOf,
  writeFileAtomic,
  type CatalogRecord,
} from "@maycombhq/core";
import {
  changeFolder,
  changeFootprint,
  changeStore,
  checkRequirements,
  decodeRequirements,
  evidenceIds,
  loadChangeContext,
  parseRequirements,
  REQUIREMENTS_FILE,
} from "@maycombhq/changes";
import { personaLenses, personaReview } from "@maycombhq/naysayer";
import type { Output } from "./commands.js";
import { mapLookup } from "./change-commands.js";

/**
 * `atticus review <requirements.md | change> [--no-ai] [--mode m] [--write] [--json]` (ADR 0203
 * C.4): what the quick path's door would say, as findings, not a refusal; the map's standing of
 * every id the file cites; and, unless --no-ai, each naysayer of the org pack whose `owns`
 * heading the file has, as a lens over the file. It creates nothing and always exits 0 unless
 * the file can't be read. `--write` adds each finding not already there as a row of its role's
 * table, and nothing else. The checklist rules need a change's artifacts and type: they run at a
 * gate (`atticus critic`).
 */

export const REVIEW_WORDS = {
  unreadable: (file: string, why: string) => `Can't read ${file}: ${why}`,
  notRead: (id: string) => `${id} is in the manifest, not read: atticus map ${id}`,
  planned: (id: string) => `${id} is listed under Planned, so the map can't check it yet`,
  touched: (id: string, c: string) =>
    `${id} is touched by the open change ${c}: atticus change conflicts --touching ${id}`,
  dropped: (n: number) =>
    `${n} question${n === 1 ? "" : "s"} of the naysayers left out: ${n === 1 ? "its quote isn't" : "their quotes aren't"} on the line ${n === 1 ? "it cites" : "they cite"}.`,
  none: (file: string) => `${file}: nothing to ask.`,
  rules: (change: string) =>
    `The checklist rules run at a gate, with the change's artifacts: atticus critic ${change}.`,
  wrote: (n: number, file: string) =>
    n ? `Added ${n} row${n === 1 ? "" : "s"} to ${file}.` : `${file} has every row already.`,
} as const;

export interface ReviewFinding {
  line: number;
  /** Who asks: the persona's name, or atticus. */
  who: string;
  question: string;
  evidence: string;
  /** The `## <Role>` table the row belongs in, when it has one. */
  role?: string;
}

/** The ids the map can't check: manifest repos nobody read, and what open changes touch. */
async function standing(root: string, except?: string) {
  const { readCatalog } = await import("@maycombhq/scanner");
  const manifest = new Set<string>();
  for (const p of (await loadOrgPack(orgPackDirOf(root))).profiles)
    for (const r of p.repos?.repos ?? []) if (!r.archived) manifest.add(r.id);
  const read = new Set<string>();
  for (const dir of ["generated", "curated"])
    for (const r of (await readCatalog(join(catalogDirOf(root), dir), { keep: false }))
      .records as (CatalogRecord & { repo?: unknown })[])
      if (r.kind === "Component" && typeof r.repo === "string") read.add(r.repo);
  const touched = new Map<string, string[]>();
  const ctx = await loadChangeContext(root);
  for (const c of await changeStore(root).list()) {
    if (c.state === "archived" || c.id === except) continue;
    const f = await changeFootprint(ctx, c).catch(() => undefined);
    for (const id of new Set([
      ...(f?.systems ?? []),
      ...(f?.interfaces ?? []).map((x) => x.id),
      ...(f?.tables ?? []),
      ...(f?.records ?? []),
      ...(f?.repos ?? []),
    ]))
      touched.set(id, [...(touched.get(id) ?? []), c.id]);
  }
  return { unread: new Set([...manifest].filter((r) => !read.has(r))), touched };
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

/** The file with each finding not already there added as a row of its role's table. */
export function withRows(text: string, found: ReviewFinding[]): { text: string; added: number } {
  // Each line with its own ending, so a file of mixed endings keeps every one; a new line takes
  // the ending of the line before it (else the file's first, else LF).
  const parts = text.split(/(\r\n|\n|\r)/);
  const lines = parts
    .filter((_, i) => i % 2 === 0)
    .map((t, i) => ({ text: t, eol: parts[2 * i + 1] ?? "" }));
  const parsed = parseRequirements(text);
  const same = (q: string) => q.replace(/\s+/g, " ").trim();
  let added = 0;
  const byRole = new Map<string, ReviewFinding[]>();
  for (const f of found)
    if (f.role) {
      const have = parsed.roles.find((r) => r.role === f.role)?.rows ?? [];
      const mine = byRole.get(f.role) ?? [];
      // Like with like: a row's cell as the door check reads it (a \| is a bar) and the question.
      if (
        have.some((r) => r.cells[0] === same(f.question)) ||
        mine.some((m) => same(m.question) === same(f.question))
      )
        continue;
      byRole.set(f.role, [...mine, f]);
    }
  // From the bottom up, so earlier lines keep their numbers.
  const places = [...byRole].map(([role, list]) => {
    const rows = list.map(
      // Evidence is map ids: a door-check code or a naysayer's quote is none.
      (f) =>
        `| ${cell(f.question)} | ${f.who !== "atticus" || f.evidence.startsWith("requirements.") ? "-" : cell(f.evidence)} | ${f.who} | - | - | open |`,
    );
    added += rows.length;
    const table = parsed.roles.find((r) => r.role === role);
    if (table?.rows.length) return { at: Math.max(...table.rows.map((r) => r.line)), rows };
    const header = [
      "| Question | Evidence | Asked by | Answered by | Answer | State |",
      "| --- | --- | --- | --- | --- | --- |",
    ];
    const heading = lines.findIndex((l) => l.text.trim() === `## ${role}`);
    if (heading >= 0) return { at: heading + 1, rows: ["", ...header, ...rows] };
    const end = lines.length && lines.at(-1)!.text === "" ? lines.length - 1 : lines.length;
    return { at: end, rows: ["", `## ${role}`, "", ...header, ...rows] };
  });
  const first = lines.find((l) => l.eol)?.eol ?? "\n";
  for (const p of places.sort((a, b) => b.at - a.at)) {
    const before = lines[p.at - 1];
    const eol = before?.eol || first;
    // Appending after a last line with no ending: it gets one, and the new last line has none.
    const last = p.at === lines.length && before && !before.eol;
    if (last) before.eol = eol;
    lines.splice(
      p.at,
      0,
      ...p.rows.map((t, k) => ({ text: t, eol: last && k === p.rows.length - 1 ? "" : eol })),
    );
  }
  return { text: lines.map((l) => l.text + l.eol).join(""), added };
}

/** The file's encoding, from its byte-order mark, so a write gives back what was read. */
const encodingOf = (b: Uint8Array) =>
  b[0] === 0xff && b[1] === 0xfe
    ? "utf-16le"
    : b[0] === 0xfe && b[1] === 0xff
      ? "utf-16be"
      : b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf
        ? "utf-8-bom"
        : "utf-8";

function encode(text: string, encoding: ReturnType<typeof encodingOf>): Uint8Array {
  if (encoding === "utf-8") return Buffer.from(text, "utf8");
  if (encoding === "utf-8-bom")
    return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]);
  const le = Buffer.from(`\ufeff${text}`, "utf16le");
  return encoding === "utf-16le" ? le : le.swap16();
}

export async function reviewCommand(
  root: string,
  target: string | undefined,
  o: { noAi?: boolean; write?: boolean; json?: boolean; mode?: string },
  io: Output,
  deps: { runtime?: AiRuntime; now?: Date } = {},
): Promise<number> {
  if (!target) {
    io.err(
      "review needs a requirements file or a change, for example: atticus review requirements.md",
    );
    return 2;
  }
  const change =
    !existsSync(target) &&
    (await changeStore(root)
      .read(target)
      .catch(() => undefined));
  const file = change ? join(changeFolder(root, change.id), REQUIREMENTS_FILE) : target;
  const shown = change ? `${change.id}/${REQUIREMENTS_FILE}` : target;
  let text: string;
  let encoding: ReturnType<typeof encodingOf>;
  try {
    const bytes = await readFile(file);
    encoding = encodingOf(bytes);
    text = decodeRequirements(bytes);
  } catch (e) {
    io.err(REVIEW_WORDS.unreadable(shown, (e as Error).message.split("\n")[0]!));
    return 1;
  }
  const parsed = parseRequirements(text);
  const found: ReviewFinding[] = [];
  // The door check (ADR 0201 point 2), its reasons as findings.
  const prefix = `${shown}:`;
  const looked = await mapLookup(root);
  for (const r of checkRequirements(parsed, looked.has, shown, looked.map).reasons)
    found.push({
      line: r.line,
      who: "atticus",
      question: r.message.startsWith(prefix)
        ? r.message.slice(prefix.length).replace(/^\d+: /, "")
        : r.message,
      evidence: r.code,
      ...(r.role && r.code !== "requirements.open-question" ? { role: r.role } : {}),
    });
  // The map's standing of every id the file cites.
  const s = await standing(root, change ? change.id : undefined);
  const planned = new Set(parsed.planned);
  for (const { role, rows } of parsed.roles)
    for (const { line, cells } of rows)
      for (const id of cells.length > 1 ? evidenceIds(cells[1]!) : []) {
        const say = (question: string) =>
          found.push({ line, who: "atticus", question, evidence: id, role });
        if (s.unread.has(id)) say(REVIEW_WORDS.notRead(id));
        if (planned.has(id)) say(REVIEW_WORDS.planned(id));
        for (const c of s.touched.get(id) ?? []) say(REVIEW_WORDS.touched(id, c));
      }
  // The naysayers whose heading the file has, each a lens over it.
  const notes: string[] = [];
  let dropped = 0;
  if (!o.noAi) {
    const pack = await loadOrgPack(orgPackDirOf(root));
    const headings = new Set(
      text.split(/\r?\n/).flatMap((l) => (/^##\s+(.+?)\s*$/.exec(l)?.[1] ?? []) as string[]),
    );
    const mine = (await personaLenses(root, pack.runtime.budgets.defaultTokens)).filter(
      (p) => p.owns && headings.has(p.owns),
    );
    let runtime = deps.runtime;
    if (!runtime && mine.length)
      runtime = await runtimeForCli(root, { ...(o.mode ? { mode: o.mode } : {}), env: process.env })
        .then((r) => r.runtime)
        .catch((e: Error) => {
          notes.push(
            e instanceof AiOffError ? "AI is off here: the naysayers didn't run." : e.message,
          );
          return undefined;
        });
    if (runtime && mine.length) {
      const r = await personaReview(root, {
        path: REQUIREMENTS_FILE,
        text,
        personas: mine,
        runtime,
        change: change ? change.id : "atticus-review",
        now: deps.now ?? new Date(),
        levels: pack.pack?.classification ?? ["public", "internal", "confidential", "restricted"],
      });
      notes.push(...r.notes);
      dropped = r.dropped;
      for (const q of r.questions)
        found.push({
          line: q.line,
          who: q.persona,
          question: q.question,
          evidence: q.evidence,
          role: mine.find((p) => p.name === q.persona)!.owns!,
        });
    }
  }
  found.sort((a, b) => a.line - b.line);
  let wrote: number | undefined;
  if (o.write) {
    const w = withRows(text, found);
    wrote = w.added;
    if (w.added) await writeFileAtomic(file, encode(w.text, encoding));
  }
  if (o.json) {
    io.out(
      JSON.stringify(
        { file: shown, findings: found, dropped, notes, ...(o.write ? { wrote } : {}) },
        null,
        2,
      ),
    );
    return 0;
  }
  if (!found.length) io.out(REVIEW_WORDS.none(shown));
  for (const f of found) io.out(`${shown}:${f.line}: ${f.who}: ${f.question} [${f.evidence}]`);
  if (dropped) io.out(REVIEW_WORDS.dropped(dropped));
  for (const n of notes) io.out(n);
  if (change) io.out(REVIEW_WORDS.rules(change.id));
  if (o.write) io.out(REVIEW_WORDS.wrote(wrote ?? 0, shown));
  return 0;
}
