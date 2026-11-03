import { DATAFILE_KINDS, fileKinds, readingRank } from "./batches.js";
import { vendoredProjects, type VendoredProject } from "./vendored.js";

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
  /** Its lines, when known: a file bigger than a session is then read in line ranges. */
  lines?: number;
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
  /** Biggest first: every folder that qualifies (the estimate shows the first ten). */
  proposals: ExclusionProposal[];
  /** Source tokens as the read stands, and with every proposal accepted. */
  before: number;
  after: number;
}

/**
 * A folder is proposed when it holds at least 10,000 tokens and 2% of the repo's (leaving out
 * less changes little), and at least 90% of its tokens are data, docs or vendored code with no
 * build, deploy or config file among the rest; a folder of documents (pages outside a docs
 * folder) only when it holds no code at all.
 */
export const PROPOSE_MIN_TOKENS = 10_000;
export const PROPOSE_MIN_SHARE = 0.02;
export const PROPOSE_DATA_SHARE = 0.9;
/** The proposals the estimate prints; the exclude: block and --json hold them all. */
export const SHOWN_PROPOSALS = 10;

/** A documentation site or reference at the top of the repo: none of it is the product. */
const DOCS_TOP = /^(docs?|documentation|site|website|javadoc|apidocs)\//i;
const DATA_EXT = /\.(json|xml|ya?ml)$/i;
/** A page of text (A-big2): a document when it's in no folder a product's pages live in. */
const TEXT_PAGE = /\.(html?|xhtml)$/i;
const PRODUCT_PAGES =
  /(^|\/)(src|app|apps|web|www|wwwroot|webapp|public|static|assets|resources|templates?|views?|pages|layouts?|partials|components|emails?|mail|ui|client|frontend|site)\//i;
const SPA_PAGE = /\.(component|directive|pipe)\.html$/i;

const sum = (fs: readonly FileTokens[]) => fs.reduce((n, f) => n + f.tokens, 0);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const extOf = (path: string) => /\.[^./]+$/.exec(path)?.[0].toLowerCase() ?? path.split("/").pop()!;
const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const under = (path: string, dir: string) => path.startsWith(`${dir}/`);
/** What a vendored project is, without the question a proposal of its own ends with. */
const whatOf = (v: VendoredProject) =>
  v.why.replace(/: (a )?vendored [^:]*\? Check before accepting$/, "");

type Nature = "docs" | "data" | "page" | "vendored";

/**
 * Docs at the top of the repo; a structured file whose path says no kind (A-lean): data; a page
 * of text outside the product's page folders (A-big2): a document.
 */
function natureOf(path: string): Exclude<Nature, "vendored"> | undefined {
  if (DOCS_TOP.test(path)) return "docs";
  if (TEXT_PAGE.test(path))
    return PRODUCT_PAGES.test(path) || SPA_PAGE.test(path) ? undefined : "page";
  if (!DATA_EXT.test(path)) return undefined;
  const kinds = fileKinds(path);
  return kinds.length === DATAFILE_KINDS.length && kinds.every((k) => DATAFILE_KINDS.includes(k))
    ? "data"
    : undefined;
}

interface Folder {
  files: FileTokens[];
  /** Its data, docs, pages and vendored files. */
  odd: { f: FileTokens; nature: Nature }[];
  /** Holds a build, deploy or config file that isn't data, docs or vendored. */
  keeps: boolean;
}

/**
 * The folders to propose leaving out: of data, of docs, of documents (pages of text and no code),
 * or vendored (`vendoredProjects`: a project of its own no build includes, or a source tree copied
 * in with its LICENSE). A folder that holds vendored projects and documents beside them is
 * proposed whole. `all` is every file in the repo, source or not; `read` gives a file's text, for
 * the module lists and packages (without it, no project with its own build file is proposed).
 */
export function proposeExclusions(
  files: readonly FileTokens[],
  all: readonly string[],
  read?: (path: string) => string | undefined,
  o: { saysNotProduct?: boolean } = {},
): ExclusionProposals {
  const before = sum(files);
  // ADR 0128: a person who says the repo is a documentation site, a text corpus or vendored code
  // has told us something the file shapes can only guess at, so a smaller folder is worth
  // proposing. It lowers the bar for a proposal a person still accepts; nothing else changes, and
  // a folder holding a build, deploy or config file is still never proposed.
  const floor = o.saysNotProduct ? PROPOSE_MIN_TOKENS / 4 : PROPOSE_MIN_TOKENS;
  const share = o.saysNotProduct ? PROPOSE_MIN_SHARE / 4 : PROPOSE_MIN_SHARE;
  const min = Math.max(floor, share * before);
  const vendored = vendoredProjects(all, read);
  const vendoredOf = (path: string) => vendored.find((v) => under(path, v.dir));
  const folders = new Map<string, Folder>();
  for (const f of files) {
    const nature: Nature | undefined = vendoredOf(f.path) ? "vendored" : natureOf(f.path);
    const keeps = !nature && readingRank(f.path) <= 1;
    const parts = f.path.split("/");
    for (let d = 1; d < parts.length; d++) {
      const key = parts.slice(0, d).join("/");
      const x = folders.get(key) ?? { files: [], odd: [], keeps: false };
      x.files.push(f);
      if (nature) x.odd.push({ f, nature });
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
    if (tokens < min || x.keeps) continue;
    const self = vendored.find((v) => v.dir === dir);
    if (self) {
      candidates.set(dir, {
        path: `${dir}/**`,
        why: self.why,
        at: self.at,
        files: x.files.length,
        tokens,
      });
      continue;
    }
    if (sum(x.odd.map((o) => o.f)) < PROPOSE_DATA_SHARE * tokens) continue;
    const docsTop = DOCS_TOP.test(`${dir}/`);
    const pages = x.odd.some((o) => o.nature === "page");
    const others = x.files.length - x.odd.length;
    // Pages are documents only where nothing beside them is code.
    if (!docsTop && pages && others) continue;
    const odd = x.odd.filter((o) => o.nature !== "vendored").map((o) => o.f);
    // The vendored projects in it, the outermost; a folder holding only one is that project's.
    const inside = vendored.filter(
      (v) => under(v.dir, dir) && !vendored.some((w) => w !== v && under(v.dir, w.dir)),
    );
    if (!odd.length && inside.length < 2) continue;
    const tokensOf = (v: VendoredProject) => sum(x.files.filter((f) => under(f.path, v.dir)));
    const [main] = [...inside].sort((a, b) => tokensOf(b) - tokensOf(a) || byPath(a.dir, b.dir));
    const kind = docsTop
      ? "documentation, not the product"
      : pages
        ? "documents, not code"
        : "data, not code";
    const projects = `${plural(inside.length, "vendored project")}: ${
      inside.length === 1
        ? `${inside[0]!.dir}, ${whatOf(inside[0]!)}`
        : inside.map((v) => v.dir).join(", ")
    }`;
    candidates.set(dir, {
      path: `${dir}/**`,
      why: odd.length
        ? `${kind}: ${counts(odd)}${others ? `; also ${plural(others, "other file")}` : ""}${inside.length ? `; with ${projects}` : ""}`
        : `vendored code, not the product: ${projects}`,
      // Its biggest vendored project's LICENSE when vendored code is most of it.
      at:
        main &&
        2 * sum(inside.flatMap((v) => x.files.filter((f) => under(f.path, v.dir)))) >= tokens
          ? main.at
          : `${biggest(odd).path}:1`,
      files: x.files.length,
      tokens,
    });
  }

  // The outermost folder that qualifies, not every folder under it too.
  const depth = (d: string) => d.split("/").length;
  const picked: string[] = [];
  for (const dir of [...candidates.keys()].sort((a, b) => depth(a) - depth(b) || byPath(a, b)))
    if (!picked.some((p) => dir.startsWith(`${p}/`))) picked.push(dir);
  const proposals = picked
    .map((d) => candidates.get(d)!)
    .sort((a, b) => b.tokens - a.tokens || byPath(a.path, b.path));
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
 * Tokens of source one assistant session reads when the model's limit isn't known, with room left
 * for the protocol, the facts it writes and the verify loop: three quarters of a 200k-token context.
 */
export const SESSION_TOKENS = 150_000;

/**
 * The share of a model's context a session's source takes when the model's limit is known: the
 * rest holds the reading rules, the facts the reader writes and the verify loop. Below half, so a
 * 136K-token model reads parts of about 61K (F1: they were planned at 150K, past the model's whole
 * context, and cut short or summarised mid-read), and a 1M-token model parts of 450K.
 */
export const SESSION_SHARE = 0.45;

/** The source one session reads: a share of the model's limit when known, else SESSION_TOKENS. */
export function sessionTokensFor(limit: number | undefined): number {
  return limit && limit > 0 ? Math.floor(limit * SESSION_SHARE) : SESSION_TOKENS;
}

/**
 * R4: the lines two neighbouring ranges of a big file share, so nothing is cut at a boundary:
 * 20, or 2% of the range when that is more, but never more than a fifth of it (a range of few,
 * long lines would otherwise pass the room). A range is done when a kept fact cites one of its own
 * lines (from its `start`, never the lines it shares with the range before: those count for that
 * one), or the reviewed file names it.
 */
export const RANGE_OVERLAP_LINES = 20;
export const RANGE_OVERLAP_SHARE = 0.02;

/** The lines a range of `each` lines shares with the one before it. */
export function rangeOverlap(each: number): number {
  return Math.min(
    Math.floor(each / 5),
    Math.max(RANGE_OVERLAP_LINES, Math.ceil(RANGE_OVERLAP_SHARE * each)),
  );
}

/** One range of a file too big for a session: its lines, and its share of the file's tokens. */
export interface LineRange {
  from: number;
  to: number;
  /** The first line that is its own, not shared with the range before (R4). */
  start: number;
  tokens: number;
}

/**
 * The line ranges a file bigger than `room` is read in (A-ranges): `ceil(tokens / (0.8 × room))`
 * ranges of equal lines, each fitting with room to spare (lines aren't all the same length), in
 * order. R4: each range after the first starts `rangeOverlap` lines before the last one ended, so
 * a block cut at the boundary is whole in one of them; its tokens count those lines once more,
 * and nothing else.
 */
export function lineRanges(f: { tokens: number; lines: number }, room: number): LineRange[] {
  const n = Math.max(1, Math.min(f.lines, Math.ceil(f.tokens / (0.8 * room))));
  const each = Math.ceil(f.lines / n);
  const overlap = rangeOverlap(each);
  const out: LineRange[] = [];
  for (let start = 1; start <= f.lines; start += each) {
    const from = start === 1 ? 1 : start - overlap;
    const to = Math.min(f.lines, start + each - 1);
    out.push({ from, to, start, tokens: Math.ceil((f.tokens * (to - from + 1)) / f.lines) });
  }
  return out;
}

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
 * ADR 0169: what reads first. `head` (build and config files, the entry points and clients) is
 * planned first, as folders where a folder holds nothing else; `models` (the model files they
 * reach) next, one by one in that order; then the rest, as folders where they can be. No folder
 * glob covers a file of `leftOut` (the model files nothing reaches), which no part reads.
 */
export interface PartOrder {
  head: readonly string[];
  models: readonly string[];
  leftOut: readonly string[];
}

/**
 * Units over a group of files: a folder whole when every file under it (of `all`) is in the
 * group and it fits the room; its own files as `dir/*` when they all are; else each file.
 */
function groupUnits(
  dir: string,
  fs: readonly FileTokens[],
  room: number,
  holds: (dir: string, deep: boolean, n: number) => boolean,
): Unit[] {
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
  if (dir && holds(dir, true, fs.length) && (sum(fs) <= room || !children.size))
    return [{ glob: `${dir}/**`, files: fs.length, tokens: sum(fs) }];
  const out: Unit[] = [];
  if (direct.length) {
    if (holds(dir, false, direct.length))
      out.push({ glob: `${prefix}*`, files: direct.length, tokens: sum(direct) });
    else
      for (const f of [...direct].sort((a, b) => byPath(a.path, b.path)))
        out.push({ glob: f.path, files: 1, tokens: f.tokens });
  }
  for (const child of [...children.keys()].sort(byPath))
    out.push(...groupUnits(child, children.get(child)!, room, holds));
  return out;
}

/** A file bigger than the room in line ranges, each a unit; its first range counts the file. */
function rangeUnits(f: FileTokens, room: number): Unit[] {
  return lineRanges({ ...f, lines: f.lines! }, room).map((r, i) => ({
    glob: `${f.path}#L${r.from}-L${r.to}`,
    files: i === 0 ? 1 : 0,
    tokens: r.tokens,
  }));
}

/** ADR 0169: the units in reading order: the head, the reached models, the rest. */
function orderedUnits(files: readonly FileTokens[], room: number, o: PartOrder): Unit[] {
  const isBig = (f: FileTokens) => f.tokens > room && (f.lines ?? 0) > 1;
  const byFile = new Map(files.map((f) => [f.path, f]));
  const head = new Set(o.head.filter((p) => byFile.has(p)));
  const models = [...new Set(o.models)].filter((p) => byFile.has(p) && !head.has(p));
  const inModels = new Set(models);
  const rest = files.filter((f) => !head.has(f.path) && !inModels.has(f.path));
  // Every file a glob could stand for, by folder: what is planned and what is left out.
  const all = [...files.map((f) => f.path), ...o.leftOut];
  const counts = () => {
    const deep = new Map<string, number>();
    const own = new Map<string, number>();
    const count = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
    for (const p of all) {
      const parts = p.split("/");
      count(own, parts.slice(0, -1).join("/"));
      for (let d = 1; d < parts.length; d++) count(deep, parts.slice(0, d).join("/"));
    }
    // A folder (or its own files) whole only when it holds as many files as the group has there.
    return (dir: string, isDeep: boolean, n: number) =>
      (isDeep ? deep.get(dir) : own.get(dir)) === n;
  };
  const holds = counts();
  const unitsOfGroup = (group: FileTokens[]) => {
    const small = group.filter((f) => !isBig(f)).sort((a, b) => byPath(a.path, b.path));
    // A big file's ranges are in no folder glob: its folder isn't whole.
    const out = groupUnits("", small, room, holds);
    for (const f of group.filter(isBig)) out.push(...rangeUnits(f, room));
    return out;
  };
  return [
    ...unitsOfGroup(files.filter((f) => head.has(f.path))),
    ...models.flatMap((p) => {
      const f = byFile.get(p)!;
      return isBig(f) ? rangeUnits(f, room) : [{ glob: p, files: 1, tokens: f.tokens }];
    }),
    ...unitsOfGroup(rest),
  ];
}

/**
 * The parts to read a repo in when its source is more than `room` tokens (none when it fits):
 * folders whole where they fit, in path order, so a module's files stay together; each part
 * closes when the next folder would pass the room or the part has its even share. A single
 * folder of files bigger than the room is a part of its own. With `order` (ADR 0169), the head
 * first, the reached models next, then the rest, and no glob over a file left out.
 */
export function planParts(
  files: readonly FileTokens[],
  room = SESSION_TOKENS,
  order?: PartOrder,
): ReadPart[] {
  const total = sum(files);
  if (total <= room) return [];
  let units: Unit[];
  if (order) units = orderedUnits(files, room, order);
  else {
    // A file bigger than the room, whatever its size, is read in line ranges, each a unit that
    // fits with room to spare (lines aren't all the same length); its first range counts the file.
    const big = files.filter((f) => f.tokens > room && (f.lines ?? 0) > 1);
    const rest = files.filter((f) => !big.includes(f));
    const ranges: (Unit & { key: string })[] = [];
    for (const f of big)
      for (const [i, r] of lineRanges({ ...f, lines: f.lines! }, room).entries())
        ranges.push({
          glob: `${f.path}#L${r.from}-L${r.to}`,
          files: i === 0 ? 1 : 0,
          tokens: r.tokens,
          key: `${f.path}\u0000${String(r.start).padStart(12, "0")}`,
        });
    const sorted = [...rest].sort((a, b) => byPath(a.path, b.path));
    const keyOf = (g: string) => g.replace(/\/?\*\*?$/, "");
    units = [...unitsOf("", sorted, room).map((u) => ({ ...u, key: keyOf(u.glob) })), ...ranges]
      .sort((a, b) => byPath(a.key, b.key))
      .map(({ key: _k, ...u }) => u);
  }
  const target = total / Math.ceil(total / room);
  const parts: ReadPart[] = [];
  let current: ReadPart | undefined;
  for (const u of units) {
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
