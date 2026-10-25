import { DATAFILE_KINDS, fileKinds, readingRank } from "./batches.js";

/**
 * A big repo's first read (ADR 0124 addendum A-big): the folders `atticus map --estimate`
 * proposes to leave out, and the parts it proposes to read a repo bigger than one session holds
 * in. Both are proposals: Atticus never writes an exclusion (a person accepts it in the org pack,
 * in a pull request), and the parts only say how to split the read. Deterministic: the same
 * files give the same proposals and parts.
 */

/** A source file and its tokens as the estimate counts them. */
export interface FileTokens {
  path: string;
  tokens: number;
}

/** One proposed `exclude:` entry of `org-pack/scan/<repo>.yaml` (ADR 0075), with its size. */
export interface ExclusionProposal {
  /** A glob: the folder and everything under it. */
  path: string;
  why: string;
  /** The file the proposal rests on, `path:1`: its biggest data file, or its LICENSE. */
  at: string;
  files: number;
  tokens: number;
}

export interface ExclusionProposals {
  /** Biggest first, at most MAX_PROPOSALS. */
  proposals: ExclusionProposal[];
  /** Source tokens as the read stands, and with every proposal accepted. */
  before: number;
  after: number;
}

/**
 * A folder is proposed when it holds at least 10,000 tokens and 2% of the repo's (leaving out
 * less changes little), and at least 90% of its tokens are data or docs with no build, deploy or
 * config file among the rest.
 */
export const PROPOSE_MIN_TOKENS = 10_000;
export const PROPOSE_MIN_SHARE = 0.02;
export const PROPOSE_DATA_SHARE = 0.9;
export const MAX_PROPOSALS = 10;

/** A documentation site or reference at the top of the repo: none of it is the product. */
const DOCS_TOP = /^(docs?|documentation|site|website|javadoc|apidocs)\//i;
const DATA_EXT = /\.(json|xml|ya?ml)$/i;
const LICENSE = /^(LICEN[CS]E|COPYING)([._-][^/]*)?$/i;
const BUILD_FILE =
  /^(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|package\.json|go\.mod|Cargo\.toml|pyproject\.toml|setup\.py|setup\.cfg|composer\.json|Gemfile|[^/]+\.(csproj|vbproj|fsproj|sln))$/i;

const sum = (fs: readonly FileTokens[]) => fs.reduce((n, f) => n + f.tokens, 0);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const extOf = (path: string) => /\.[^./]+$/.exec(path)?.[0].toLowerCase() ?? path.split("/").pop()!;
const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** Docs at the top of the repo, or a structured file whose path says no kind (A-lean): data. */
function natureOf(path: string): "docs" | "data" | undefined {
  if (DOCS_TOP.test(path)) return "docs";
  if (!DATA_EXT.test(path)) return undefined;
  const kinds = fileKinds(path);
  return kinds.length === DATAFILE_KINDS.length && kinds.every((k) => DATAFILE_KINDS.includes(k))
    ? "data"
    : undefined;
}

interface Folder {
  files: FileTokens[];
  /** Its data or docs files. */
  odd: FileTokens[];
  /** Holds a build, deploy or config file that isn't data or docs. */
  keeps: boolean;
}

/**
 * The folders to propose leaving out: of data, of docs, or vendored (a folder holding its own
 * LICENSE and no build file of its own, as a library's source dropped in does; a workspace
 * package has its own build file). `all` is every file in the repo, source or not.
 */
export function proposeExclusions(
  files: readonly FileTokens[],
  all: readonly string[],
): ExclusionProposals {
  const before = sum(files);
  const min = Math.max(PROPOSE_MIN_TOKENS, PROPOSE_MIN_SHARE * before);
  const folders = new Map<string, Folder>();
  for (const f of files) {
    const nature = natureOf(f.path);
    const keeps = !nature && readingRank(f.path) <= 1;
    const parts = f.path.split("/");
    for (let d = 1; d < parts.length; d++) {
      const key = parts.slice(0, d).join("/");
      const x = folders.get(key) ?? { files: [], odd: [], keeps: false };
      x.files.push(f);
      if (nature) x.odd.push(f);
      x.keeps ||= keeps;
      folders.set(key, x);
    }
  }
  const biggest = (fs: readonly FileTokens[]) =>
    [...fs].sort((a, b) => b.tokens - a.tokens || byPath(a.path, b.path))[0]!;
  const counts = (fs: readonly FileTokens[]) => {
    const n = new Map<string, number>();
    for (const f of fs) n.set(extOf(f.path), (n.get(extOf(f.path)) ?? 0) + 1);
    return [...n.entries()]
      .sort((a, b) => b[1] - a[1] || byPath(a[0], b[0]))
      .map(([ext, c]) => plural(c, `${ext} file`))
      .join(", ");
  };

  const candidates = new Map<string, ExclusionProposal>();
  for (const [dir, x] of folders) {
    const tokens = sum(x.files);
    if (tokens < min || x.keeps || sum(x.odd) < PROPOSE_DATA_SHARE * tokens) continue;
    const others = x.files.length - x.odd.length;
    candidates.set(dir, {
      path: `${dir}/**`,
      why: `${DOCS_TOP.test(`${dir}/`) ? "documentation, not the product" : "data, not code"}: ${counts(x.odd)}${others ? `; also ${plural(others, "other file")}` : ""}`,
      at: `${biggest(x.odd).path}:1`,
      files: x.files.length,
      tokens,
    });
  }
  const builds = new Set(all.filter((p) => BUILD_FILE.test(p.split("/").pop()!)).map(dirOf));
  for (const p of [...all].sort(byPath)) {
    const dir = dirOf(p);
    if (!dir || candidates.has(dir) || builds.has(dir) || !LICENSE.test(p.split("/").pop()!))
      continue;
    const x = folders.get(dir);
    if (!x || sum(x.files) < min) continue;
    candidates.set(dir, {
      path: `${dir}/**`,
      why: "its own LICENSE and no build file: a vendored copy of third-party code? Check before accepting",
      at: `${p}:1`,
      files: x.files.length,
      tokens: sum(x.files),
    });
  }

  // The outermost folder that qualifies, not every folder under it too.
  const depth = (d: string) => d.split("/").length;
  const picked: string[] = [];
  for (const dir of [...candidates.keys()].sort((a, b) => depth(a) - depth(b) || byPath(a, b)))
    if (!picked.some((p) => dir.startsWith(`${p}/`))) picked.push(dir);
  const proposals = picked
    .map((d) => candidates.get(d)!)
    .sort((a, b) => b.tokens - a.tokens || byPath(a.path, b.path))
    .slice(0, MAX_PROPOSALS);
  return { proposals, before, after: before - proposals.reduce((n, p) => n + p.tokens, 0) };
}

/** The ready `exclude:` block for `org-pack/scan/<repo>.yaml`, one flow mapping per entry. */
export function exclusionYaml(proposals: readonly ExclusionProposal[]): string {
  if (!proposals.length) return "";
  const q = (s: string) => JSON.stringify(s);
  return [
    "exclude:",
    ...proposals.map((p) => `  - { path: ${q(p.path)}, why: ${q(p.why)}, at: ${q(p.at)} }`),
    "",
  ].join("\n");
}

/**
 * Tokens of source one assistant session reads with room left for the protocol, the facts it
 * writes and the verify loop: three quarters of a 200k-token context.
 */
export const SESSION_TOKENS = 150_000;

/** One part of a big repo's read: globs over its files, in path order. */
export interface ReadPart {
  paths: string[];
  files: number;
  tokens: number;
}

interface Unit {
  glob: string;
  files: number;
  tokens: number;
}

/** A folder whole when it fits the room (or has no subfolders); else its files, then each subfolder. */
function unitsOf(dir: string, fs: readonly FileTokens[], room: number): Unit[] {
  const prefix = dir ? `${dir}/` : "";
  const direct: FileTokens[] = [];
  const children = new Map<string, FileTokens[]>();
  for (const f of fs) {
    const rest = f.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash < 0) direct.push(f);
    else {
      const child = prefix + rest.slice(0, slash);
      children.set(child, [...(children.get(child) ?? []), f]);
    }
  }
  if (dir && (sum(fs) <= room || !children.size))
    return [{ glob: `${dir}/**`, files: fs.length, tokens: sum(fs) }];
  const out: Unit[] = direct.length
    ? [{ glob: `${prefix}*`, files: direct.length, tokens: sum(direct) }]
    : [];
  for (const child of [...children.keys()].sort(byPath))
    out.push(...unitsOf(child, children.get(child)!, room));
  return out;
}

/**
 * The parts to read a repo in when its source is more than `room` tokens (none when it fits):
 * folders whole where they fit, in path order, so a module's files stay together; each part
 * closes when the next folder would pass the room or the part has its even share. A single
 * folder of files bigger than the room is a part of its own.
 */
export function planParts(files: readonly FileTokens[], room = SESSION_TOKENS): ReadPart[] {
  const total = sum(files);
  if (total <= room) return [];
  const sorted = [...files].sort((a, b) => byPath(a.path, b.path));
  const target = total / Math.ceil(total / room);
  const parts: ReadPart[] = [];
  let current: ReadPart | undefined;
  for (const u of unitsOf("", sorted, room)) {
    if (current && (current.tokens + u.tokens > room || current.tokens >= target)) {
      parts.push(current);
      current = undefined;
    }
    current ??= { paths: [], files: 0, tokens: 0 };
    current.paths.push(u.glob);
    current.files += u.files;
    current.tokens += u.tokens;
  }
  if (current) parts.push(current);
  return parts;
}
