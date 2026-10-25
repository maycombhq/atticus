import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { estimateTokens, type SourceInput } from "@maycombhq/ai";
import { isSecretPath, redactSecrets } from "@maycombhq/core";
import { defaultCodeDir } from "@maycombhq/index";
import type { DeltaStory } from "./stories.js";

/**
 * The code a change's tasks touch, for the stories prompt (B-fixes, problem 3): an assistant
 * with no file tools (ADR 0124 §4, tiers 2 and 3) can't open the repo, so the auth, the
 * validation messages, the error handling, the tests and the migrations it is asked to write
 * about must be in front of it. Each line a task cites (today's step, and the files its fields
 * and columns are declared in) with a few lines either side, read from the repo's checkout under
 * workspace/, numbered as in the file, within a share of the prompt's budget: the tasks' own
 * lines first, then the declaring files, and what doesn't fit is counted, not cut silently.
 * Deterministic; no checkout, no source, so a prompt with nothing to show is as it was.
 */

/** Lines kept on each side of a cited line. */
export const STORY_CODE_AROUND = 3;
/** The share of the stories prompt's budget the code may take. */
export const STORY_CODE_SHARE = 0.2;
/** A file bigger than this is not read into a prompt. */
const MAX_FILE_BYTES = 512 * 1024;
/** A line longer than this is cut (a minified line says nothing to a reader). */
const MAX_LINE = 300;

const HEADING = [
  "The code the tasks change, read from the repos' checkouts: each line a task cites (today's step, and where its fields and columns are declared) with the lines around it, numbered as in the file.",
  "Use it for what the target flows don't say (who may call the entry, the validation messages, how errors are answered, the tests beside it, the migrations' folder and naming), and cite repo:path:line for what you take from it. Name only what is written here, in the target flows or in the estate.",
].join("\n");

/** A path inside a repo's checkout, or undefined: nothing absolute, no `..`, no link out. */
async function inside(base: string, path: string): Promise<string | undefined> {
  if (!path || path.includes("\0") || isAbsolute(path) || /^[a-zA-Z]:/.test(path)) return undefined;
  const full = resolve(base, ...path.split(/[\\/]+/));
  const rel = relative(base, full);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  try {
    const [real, realBase] = await Promise.all([realpath(full), realpath(base)]);
    const r = relative(realBase, real);
    if (!r || r.startsWith("..") || isAbsolute(r) || r.split(sep).includes("..")) return undefined;
    if ((await stat(real)).size > MAX_FILE_BYTES) return undefined;
    return real;
  } catch {
    return undefined;
  }
}

/**
 * A file of a repo's checkout under workspace/, as text: undefined with no checkout, a path out
 * of it, a secret path, or a file too big to read (B-places reads an added step's place).
 */
export async function readCheckoutFile(
  root: string,
  repo: string,
  path: string,
): Promise<string | undefined> {
  if (isSecretPath(path)) return undefined;
  const base = defaultCodeDir(root, repo);
  const file = base ? await inside(base, path) : undefined;
  return file ? await readFile(file, "utf8").catch(() => undefined) : undefined;
}

/**
 * What a path of a repo's checkout is (B-place): a file, a folder, or undefined with no
 * checkout, nothing there, or a path out of it. A `new:` file's folder must be one.
 */
export async function checkoutHas(
  root: string,
  repo: string,
  path: string,
): Promise<"file" | "dir" | undefined> {
  const base = defaultCodeDir(root, repo);
  if (!base) return undefined;
  if (!path) return "dir";
  const full = await inside(base, path);
  if (!full) return undefined;
  return (await stat(full)).isDirectory() ? "dir" : "file";
}

const andList = (xs: string[]) =>
  xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : (xs[0] ?? "");

/** "repo:path:line" or "repo:path" as its parts. */
function citeOf(c: string): { repo: string; path: string; line?: number } | undefined {
  const m = /^([^:]+):(.+?)(?::(\d+))?$/.exec(c);
  if (!m) return undefined;
  return { repo: m[1]!, path: m[2]!, ...(m[3] ? { line: Number(m[3]) } : {}) };
}

export async function storyCodeSource(
  root: string,
  stories: readonly DeltaStory[],
  /** The tokens the source may take. */
  budget: number,
  o: { around?: number } = {},
): Promise<SourceInput | undefined> {
  const around = o.around ?? STORY_CODE_AROUND;
  // Every cited line, the tasks' own first: file by file in the order first cited.
  const files = new Map<string, { repo: string; path: string; lines: number[] }>();
  const cite = (repo: string, path: string, line: number) => {
    const k = `${repo}:${path}`;
    const f = files.get(k) ?? { repo, path, lines: [] };
    if (!f.lines.includes(line)) f.lines.push(line);
    files.set(k, f);
  };
  const tasks = stories.flatMap((s) => s.tasks);
  for (const t of tasks)
    for (const c of t.evidence) {
      const x = citeOf(c);
      if (x?.line) cite(x.repo, x.path, x.line);
    }
  for (const t of tasks)
    for (const f of t.files ?? []) {
      const x = citeOf(f.file);
      if (x) for (const l of f.lines.length ? f.lines : [1]) cite(x.repo, x.path, l);
    }

  const excerpts: string[] = [];
  const missing: string[] = [];
  for (const [key, f] of files) {
    if (isSecretPath(f.path)) continue;
    const base = defaultCodeDir(root, f.repo);
    const file = base ? await inside(base, f.path) : undefined;
    const text = file ? await readFile(file, "utf8").catch(() => undefined) : undefined;
    if (text === undefined) {
      missing.push(key);
      continue;
    }
    const all = text.replace(/\r\n?/g, "\n").split("\n");
    if (all.length > 1 && all.at(-1) === "") all.pop();
    const lines = f.lines.filter((l) => l >= 1 && l <= all.length).sort((a, b) => a - b);
    const windows: { from: number; to: number; at: number[] }[] = [];
    for (const l of lines) {
      const from = Math.max(1, l - around);
      const to = Math.min(all.length, l + around);
      const cur = windows.at(-1);
      if (cur && from <= cur.to + 1) {
        cur.to = Math.max(cur.to, to);
        cur.at.push(l);
      } else windows.push({ from, to, at: [l] });
    }
    for (const w of windows)
      excerpts.push(
        [
          `${key} lines ${w.from}-${w.to} (cited at ${andList(w.at.map(String))}):`,
          ...all
            .slice(w.from - 1, w.to)
            .map((t, i) => `${w.from + i}: ${redactSecrets(t.slice(0, MAX_LINE))}`.trimEnd()),
        ].join("\n"),
      );
  }
  if (!excerpts.length) return undefined;

  const parts = [HEADING];
  let used = estimateTokens(HEADING);
  let left = 0;
  for (const x of excerpts) {
    const cost = estimateTokens(x) + 1;
    if (left || used + cost > budget) {
      left++;
      continue;
    }
    parts.push(x);
    used += cost;
  }
  if (parts.length === 1) return undefined;
  if (left)
    parts.push(
      `${left} more cited place${left === 1 ? " is" : "s are"} left out to keep to the prompt's budget.`,
    );
  if (missing.length) parts.push(`Not in the checkout: ${missing.join(", ")}.`);
  return {
    id: "code",
    kind: "code",
    origin: "the repos' checkouts under workspace/, at the lines the tasks cite (deterministic)",
    text: parts.join("\n\n"),
    classification: "internal",
    priority: 85,
  };
}
