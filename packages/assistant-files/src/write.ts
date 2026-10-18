import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

async function read(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path, "utf8")).replace(/\r\n/g, "\n");
  } catch {
    return undefined;
  }
}

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.atticus-tmp`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, path);
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
    const p = plan(f, await read(full), !!o.force);
    const write = !o.check && p.text !== undefined;
    if (write) await put(full, p.text!);
    results.push({ path: f.path, action: p.action, written: write });
  }
  return { results, upToDate: results.every((r) => r.action === "unchanged") };
}
