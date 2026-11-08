import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { renameRetrying } from "@maycombhq/core";
import { dirname, join } from "node:path";
import { findSection, parseHeader, renderSection, sha256, withHeader } from "./header.js";
import type { RenderedFile } from "./render.js";

export type WriteAction =
  | "created"
  | "updated"
  | "unchanged"
  /** A person edited the generated file (its hash no longer matches): kept, unless --force. */
  | "kept-edited"
  /** A file with no Atticus header is in the way: it was never Atticus's, so it is kept. */
  | "kept-not-generated";

export interface WriteResult {
  path: string;
  action: WriteAction;
  /** In check mode nothing is written; `action` says what would happen. */
  written: boolean;
}

export interface WriteReport {
  results: WriteResult[];
  /** True when every file is already what Atticus would write. */
  upToDate: boolean;
}

/** The full text Atticus writes for a whole file. */
export const fileText = (f: RenderedFile) => withHeader(f.content, f.style, f.source);

/** A file's text with LF line endings, and whether it had CRLF (a Windows checkout). */
async function read(path: string): Promise<{ text: string; crlf: boolean } | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    return { text: raw.replace(/\r\n/g, "\n"), crlf: raw.includes("\r\n") };
  } catch {
    return undefined;
  }
}

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.atticus-tmp`;
  // Windows review: Copilot and VS Code hold these files open; a held file is waited for, and a
  // failed write leaves no .atticus-tmp behind.
  try {
    await writeFile(tmp, text, "utf8");
    await renameRetrying(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

function plan(
  f: RenderedFile,
  current: string | undefined,
  force: boolean,
): { action: WriteAction; text?: string } {
  if (f.mode === "section") {
    const section = renderSection(f.content, f.source);
    if (current === undefined) return { action: "created", text: `${section}\n` };
    const s = findSection(current);
    if (!s) {
      const sep =
        current === ""
          ? ""
          : current.endsWith("\n\n")
            ? ""
            : current.endsWith("\n")
              ? "\n"
              : "\n\n";
      return { action: "updated", text: `${current}${sep}${section}\n` };
    }
    if (sha256(s.inner) !== s.hash && !force) return { action: "kept-edited" };
    // Only the lines between the markers change; the person's lines around them stay as they are.
    const lines = current.split("\n");
    const lines2 = [...lines.slice(0, s.start), ...section.split("\n"), ...lines.slice(s.end + 1)];
    const text = lines2.join("\n");
    return text === current ? { action: "unchanged" } : { action: "updated", text };
  }
  const text = fileText(f);
  if (current === undefined) return { action: "created", text };
  if (current === text) return { action: "unchanged" };
  const h = parseHeader(current);
  if (!h && !force) return { action: "kept-not-generated" };
  if (h && sha256(h.body) !== h.hash && !force) return { action: "kept-edited" };
  return { action: "updated", text };
}

/**
 * Write rendered files under `dir`. Idempotent: unchanged files are not touched. Files a
 * person edited, and files Atticus never wrote, are kept unless `force`. With `check`,
 * nothing is written and the report says what would change.
 */
export async function writeAssistantFiles(
  dir: string,
  files: RenderedFile[],
  o: { force?: boolean; check?: boolean } = {},
): Promise<WriteReport> {
  const results: WriteResult[] = [];
  for (const f of files) {
    if (f.path.startsWith("/") || f.path.split("/").includes("..") || /^[A-Za-z]:/.test(f.path))
      throw new Error(`refusing to write outside the target folder: ${f.path}`);
    const full = join(dir, f.path);
    const was = await read(full);
    const p = plan(f, was?.text, !!o.force);
    const write = !o.check && p.text !== undefined;
    // A file that was CRLF stays CRLF: only Atticus's lines change, never the person's endings.
    if (write) await put(full, was?.crlf ? p.text!.replace(/\n/g, "\r\n") : p.text!);
    results.push({ path: f.path, action: p.action, written: write });
  }
  return { results, upToDate: results.every((r) => r.action === "unchanged") };
}
