import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { inputsDirOf, type OrgPack } from "@maycombhq/core";
import { documentFormat, readDocument, type DocumentRead } from "@maycombhq/ingestors";
import { scanInputs } from "@maycombhq/intake";
import type { RawPage, WikiSource } from "@maycombhq/knowledge";

/**
 * General knowledge dropped in the metarepo's inputs/ (ADR 0122): a knowledge source of its
 * own, id `inputs`, always on and never listed in sources.yaml. `atticus sources sync` snapshots
 * it like a wiki, and the knowledge scan reads it into items, each quote cited by the file.
 *
 * Intake decides which copy counts: a file dropped twice is read once (the copy outside the
 * inbox), and an older version is kept but not read. Each document is read into text by the
 * same readers intake and change attachments use; Markdown is kept as it is, so a quote's line
 * is the file's line. A picture goes to a person (the text-only rule), and a spec, diagram or
 * export is read by intake, not here. Files only: no network, no AI.
 */

export const INPUTS_SOURCE_ID = "inputs";

/** The built-in source, as a wiki entry: its snapshot is kept under knowledge/snapshots/inputs/. */
export const INPUTS_SOURCE: WikiSource = {
  id: INPUTS_SOURCE_ID,
  type: "markdown-folder",
  location: "inputs/",
  spaces: [],
};

/** What intake reads itself, or a person must: listed with the reason, never read here. */
const NOT_TEXT: Record<string, string> = {
  image: "a picture: a person reads it, since AI steps take text only",
  openapi: "an OpenAPI spec: intake reads it into the catalog (atticus intake)",
  swagger: "a Swagger spec: intake reads it into the catalog (atticus intake)",
  asyncapi: "an AsyncAPI spec: intake reads it into the catalog (atticus intake)",
  diagram: "a diagram: intake reads it (atticus intake)",
  payload: "a payload sample: intake reads its schema (atticus intake)",
};

/** A document read into Markdown: headings, the text under each, page numbers, tables. */
function markdownOf(read: DocumentRead): string {
  const out = [`# ${read.text.title}`, ""];
  for (const s of read.text.sections) {
    const page = s.page ? ` (page ${s.page})` : "";
    if (s.heading)
      out.push(`${"#".repeat(Math.min(6, Math.max(2, s.level + 1)))} ${s.heading}${page}`, "");
    else if (page) out.push(`(page ${s.page})`, "");
    if (s.text.trim()) out.push(s.text.trim(), "");
  }
  for (const t of read.text.tables ?? []) {
    t.forEach((row, i) => {
      out.push(`| ${row.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`);
      if (i === 0) out.push(`|${row.map(() => " --- |").join("")}`);
    });
    out.push("");
  }
  for (const n of read.notes) out.push(`> ${n}`, "");
  return out.join("\n");
}

export async function inputsPages(
  root: string,
  op: OrgPack,
): Promise<{ pages: RawPage[]; skipped: { source: string; path: string; reason: string }[] }> {
  const dir = inputsDirOf(root);
  // One fixed time: what intake records here isn't kept, and a snapshot carries its own date.
  const intake = await scanInputs({
    root,
    orgPack: op,
    inputsDir: dir,
    scannedAt: "1970-01-01T00:00:00Z",
  });
  const byId = new Map(intake.documents.filter((d) => d.id).map((d) => [d.id!, d]));
  const pages: RawPage[] = [];
  const skipped: { source: string; path: string; reason: string }[] = [];
  const skip = (path: string, reason: string) =>
    skipped.push({ source: INPUTS_SOURCE_ID, path, reason });
  for (const d of [...intake.documents].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    if (d.status === "duplicate") {
      skip(d.path, `the same file as ${d.duplicateOf ?? "another one in inputs/"}`);
      continue;
    }
    if (d.supersededBy) {
      const newer = byId.get(d.supersededBy)?.path ?? d.supersededBy;
      skip(d.path, `an older version: ${newer} is newer, and is the one read`);
      continue;
    }
    const why = NOT_TEXT[d.classification];
    if (why) {
      skip(d.path, why);
      continue;
    }
    const rel = d.path.replace(/^inputs\//, "");
    const bytes = new Uint8Array(await readFile(join(dir, ...rel.split("/"))));
    if (!documentFormat(rel, bytes.slice(0, 4096))) {
      skip(d.path, "not a document Atticus reads as text");
      continue;
    }
    const content = /\.(md|markdown)$/i.test(rel)
      ? new TextDecoder().decode(bytes)
      : markdownOf(readDocument(rel, bytes));
    pages.push({ pagePath: rel, path: d.path, content });
  }
  return { pages, skipped };
}
