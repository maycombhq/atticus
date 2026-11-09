import { readdirSync, readFileSync, type Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { globMatcher, type GlobMatcher } from "./glob.js";

/**
 * A checkout's files as every reader of a repo sees them (review round 49): the verifier and its
 * coverage (`dirSource`), the scan (`fsRepo`) and the assistant's code tools all list the same
 * files with one walker, decode them with one decoder and count their tokens with one estimate.
 * Before, the verifier followed symbolic links and walked what a .gitignore ignores while the
 * others didn't, and only UTF-8 was ever read.
 */

// ---------------------------------------------------------------------------------------------
// Text

const LATIN1_HIGH =
  // windows-1252's 0x80-0x9F; the five it leaves undefined keep their C1 code point
  "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ";

const utf8 = new TextDecoder("utf-8", { fatal: true });

function windows1252(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    const chunk = bytes.subarray(i, i + 8192);
    const codes = new Array<number>(chunk.length);
    for (let j = 0; j < chunk.length; j++) {
      const b = chunk[j]!;
      codes[j] = b >= 0x80 && b <= 0x9f ? LATIN1_HIGH.charCodeAt(b - 0x80) : b;
    }
    out += String.fromCharCode(...codes);
  }
  return out;
}

function utf16(bytes: Uint8Array, bigEndian: boolean): string {
  const n = bytes.length - (bytes.length % 2);
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, n);
  if (!bigEndian) return b.toString("utf16le");
  const swapped = Buffer.from(b);
  swapped.swap16();
  return swapped.toString("utf16le");
}

/**
 * A file's bytes as text, the same way for every reader: UTF-16 (LE or BE) when it starts with
 * that byte-order mark (SQL Server Management Studio saves .sql files so), else UTF-8 with any
 * byte-order mark dropped, else, when the bytes aren't valid UTF-8, windows-1252 (a Latin-1 file
 * from an older editor). Line numbers and quotes then agree between the read, the scan and the
 * check.
 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe)
    return utf16(bytes.subarray(2), false);
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff)
    return utf16(bytes.subarray(2), true);
  const body =
    bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
      ? bytes.subarray(3)
      : bytes;
  try {
    return utf8.decode(body);
  } catch {
    return windows1252(body);
  }
}

/** Bytes looked at to tell a binary file: git's own rule, a NUL in the first 8,000. */
const SNIFF = 8000;

const utf16Mark = (b: Uint8Array) =>
  b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff));

/** Whether a file's bytes are binary: a NUL in the first 8,000, unless it is marked UTF-16. */
export function isBinaryBytes(bytes: Uint8Array): boolean {
  return !utf16Mark(bytes) && bytes.subarray(0, SNIFF).includes(0);
}

/** The same, for text `decodeText` made: a NUL is left only where the bytes were binary. */
export function isBinaryText(text: string): boolean {
  return text.slice(0, SNIFF).includes("\u0000");
}

/** A Git LFS pointer a checkout wasn't smudged with: three lines that stand for the real file. */
export function isLfsPointer(text: string): boolean {
  return text.startsWith("version https://git-lfs.github.com/spec/v1");
}

/**
 * Tokens a text costs, as every budget counts them (ADR 0112): four ASCII characters a token,
 * and each character outside ASCII a token of its own. Characters / 4 alone counted Japanese,
 * Chinese or Cyrillic at a quarter of what a tokenizer gives, so prompts over the model's limit
 * were planned as fitting. `tokenUnits` is the same count in quarters, to sum over parts.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(tokenUnits(text) / 4);
}

/** Quarter tokens: 1 for each ASCII character, 4 for each other (an astral one counted once). */
export function tokenUnits(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    // the low half of a surrogate pair was counted with its high half
    else if (c < 0xdc00 || c > 0xdfff) n += 4;
  }
  return n;
}

// ---------------------------------------------------------------------------------------------
// .gitignore

export interface IgnoreRule {
  /** The folder of the .gitignore, repo-relative ("" for the root). */
  base: string;
  /** Matched in linear time (glob.ts): a scanned repo's .gitignore can't stall the scan. */
  re: GlobMatcher;
  negate: boolean;
  dirOnly: boolean;
}

/** The rules of one .gitignore file (git's syntax: #, !, a trailing /, a leading or inner /). */
export function ignoreRules(text: string, base: string): IgnoreRule[] {
  const out: IgnoreRule[] = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.replace(/(?<!\\)\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1);
    } else if (line.startsWith("\\!") || line.startsWith("\\#")) line = line.slice(1);
    const dirOnly = line.endsWith("/");
    if (dirOnly) line = line.slice(0, -1);
    if (!line) continue;
    const anchored = line.includes("/");
    try {
      out.push({ base, re: globMatcher(line.replace(/^\//, ""), !anchored), negate, dirOnly });
    } catch {
      // A line git would read some other way is left out rather than guessed at.
    }
  }
  return out;
}

/** Whether git would ignore a path by these rules: the last rule that matches decides. */
export function ignoredBy(rules: readonly IgnoreRule[], path: string, isDir: boolean): boolean {
  let out = false;
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    if (r.base && !path.startsWith(`${r.base}/`)) continue;
    const rel = r.base ? path.slice(r.base.length + 1) : path;
    if (r.re.test(rel)) out = !r.negate;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The walker

export interface WalkOptions {
  /**
   * Whether a folder is left out: `above` are the folders it is in (repo-relative parts), `name`
   * its own, `siblings` every name beside it. Asked after .git, links and .gitignore.
   */
  skipFolder?: (above: readonly string[], name: string, siblings: readonly string[]) => boolean;
}

const byName = (a: Dirent, b: Dirent) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** What one folder holds, as the walker takes it: links and .git left out, .gitignore read. */
function folder(
  entries: Dirent[],
  rel: string,
  inherited: IgnoreRule[],
  gitignore: string | undefined,
) {
  const rules =
    gitignore === undefined ? inherited : [...inherited, ...ignoreRules(gitignore, rel)];
  const names = entries.map((e) => e.name);
  const kept = entries
    .filter((e) => !e.isSymbolicLink() && e.name !== ".git")
    .sort(byName)
    .map((e) => ({ e, path: rel ? `${rel}/${e.name}` : e.name }));
  return { rules, names, kept };
}

const hasGitignore = (entries: Dirent[]) =>
  entries.some((e) => e.name === ".gitignore" && e.isFile());

/**
 * A checkout's files, repo-relative with `/`, in the order a walk by name meets them: never a
 * symbolic link (so no loop, no file outside the repo and no secret under another name), never
 * `.git`, and nothing a .gitignore in the repo ignores (an ignored folder isn't walked). Only the
 * repo's own .gitignore files are read. Deterministic: the same tree gives the same list.
 */
export function listRepoFilesSync(root: string, o: WalkOptions = {}): string[] {
  const out: string[] = [];
  const go = (rel: string, above: string[], inherited: IgnoreRule[]) => {
    const dir = rel ? join(root, ...rel.split("/")) : root;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    let text: string | undefined;
    if (hasGitignore(entries)) {
      try {
        text = decodeText(readFileSync(join(dir, ".gitignore")));
      } catch {
        text = undefined;
      }
    }
    const { rules, names, kept } = folder(entries, rel, inherited, text);
    for (const { e, path } of kept) {
      if (e.isDirectory()) {
        if (ignoredBy(rules, path, true) || o.skipFolder?.(above, e.name, names)) continue;
        go(path, [...above, e.name], rules);
      } else if (e.isFile() && !ignoredBy(rules, path, false)) out.push(path);
    }
  };
  go("", [], []);
  return out;
}

/**
 * The same walk, a file at a time: `visit` returns false to stop. Stops after `max` files and
 * says it was cut.
 */
export async function walkRepo(
  root: string,
  visit: (path: string) => Promise<boolean | void>,
  o: WalkOptions & { max?: number } = {},
): Promise<{ files: number; cut: boolean }> {
  const max = o.max ?? Number.POSITIVE_INFINITY;
  let files = 0;
  let cut = false;
  const go = async (rel: string, above: string[], inherited: IgnoreRule[]): Promise<boolean> => {
    const dir = rel ? join(root, ...rel.split("/")) : root;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return true;
    }
    const text = hasGitignore(entries)
      ? await readFile(join(dir, ".gitignore")).then(decodeText, () => undefined)
      : undefined;
    const { rules, names, kept } = folder(entries, rel, inherited, text);
    for (const { e, path } of kept) {
      if (e.isDirectory()) {
        if (ignoredBy(rules, path, true) || o.skipFolder?.(above, e.name, names)) continue;
        if (!(await go(path, [...above, e.name], rules))) return false;
      } else if (e.isFile()) {
        if (ignoredBy(rules, path, false)) continue;
        if (files >= max) {
          cut = true;
          return false;
        }
        files++;
        if ((await visit(path)) === false) return false;
      }
    }
    return true;
  };
  await go("", [], []);
  return { files, cut };
}
