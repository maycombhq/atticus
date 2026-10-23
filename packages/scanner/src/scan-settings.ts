import type { CatalogRecord, ScanSettings } from "@maycombhq/core";
import { globToRegExp, type RepoHandle } from "@maycombhq/sdk";

/**
 * Scan settings per repo (ADR 0075): check every entry against the code, hide the excluded
 * folders from every reader, put the prefixes in front of the HTTP entry points they cover,
 * and the client bases in front of the HTTP calls (ADR 0076). An entry whose citation fails
 * is reported and not applied.
 */

export interface CheckedClient {
  paths: RegExp[];
  base: string;
  names: string[];
  /** Where the base is written: path and line, cited on every call it resolves. */
  at: { path: string; line: number };
}

export interface CheckedSettings {
  exclude: RegExp[];
  prefixes: { paths: RegExp[]; prefix: string }[];
  clients: CheckedClient[];
  problems: string[];
}

export const NO_SETTINGS: CheckedSettings = {
  exclude: [],
  prefixes: [],
  clients: [],
  problems: [],
};

const HTTP_ENTRY = new Set(["rest", "webhook", "websocket", "sse"]);

/** The cited line's text (at is path:line), or undefined when the file or the line isn't there. */
export async function citedLine(repo: RepoHandle, at: string): Promise<string | undefined> {
  const i = at.lastIndexOf(":");
  const path = at.slice(0, i);
  const n = Number(at.slice(i + 1));
  const text = await repo.readText(path).catch(() => undefined);
  if (text === undefined) return undefined;
  return text.replace(/\r\n?/g, "\n").split("\n")[n - 1];
}

/** Code, by extension: the files an exclude must not drop wholesale (ADR 0111). */
const CODE_EXT = new Set(
  (
    "java kt scala groovy ts tsx js jsx mjs cjs py go rb cs fs vb php rs swift m mm c cc cpp h hpp " +
    "dart ex exs erl clj lua pl"
  ).split(" "),
);
/** Build output and dependencies: never the repo's own code. */
const NOT_OWN = /(^|\/)(node_modules|\.git|target|bin|obj|dist|build|\.atticus|vendor)\//;
/** Build and config files, by name or extension: the files that may leave a folder out. */
const CONFIG_EXT = new Set(
  "xml json jsonc yaml yml toml properties gradle cfg ini conf csproj sln props targets".split(" "),
);
const CONFIG_NAME =
  /^(makefile|dockerfile|build\.gradle\.kts|settings\.gradle\.kts|\.[a-z]*ignore|\.editorconfig)$/i;

const ext = (f: string) => /\.([^./]+)$/.exec(f)?.[1]?.toLowerCase() ?? "";
const base = (f: string) => f.slice(f.lastIndexOf("/") + 1);
export const isCodeFile = (f: string) => !NOT_OWN.test(f) && CODE_EXT.has(ext(f));
export const isConfigFile = (f: string) => CONFIG_EXT.has(ext(f)) || CONFIG_NAME.test(base(f));

/** The folder name a glob is about: its longest segment with the wildcards taken out. */
export function globName(glob: string): string {
  return glob
    .split("/")
    .map((s) => s.replace(/[*?[\]{}!]/g, ""))
    .reduce((a, b) => (b.length > a.length ? b : a), "");
}

/**
 * The prefix a cited value gives (ADR 0111): the value with one slash in front and none at the
 * end, the path of a URL, or the default of a placeholder (${NAME:/default}); quotes around it
 * are left out. Undefined when the value gives no path.
 */
export function prefixOf(value: string): string | undefined {
  let v = value.trim().replace(/^["'`]|["'`]$/g, "");
  const dflt = /^\$\{[^:}]+:([^}]*)\}$/.exec(v);
  if (dflt) v = dflt[1]!;
  const url = /^https?:\/\/[^/?#\s]+(\/[^?#\s]*)?/.exec(v);
  if (url) v = url[1] ?? "";
  if (/[${}\s?#]/.test(v)) return undefined;
  const p = `/${v.replace(/^\/+/, "").replace(/\/+$/, "")}`;
  return p === "/" ? undefined : p;
}

const trimSlash = (p: string) => p.replace(/\/+$/, "") || "/";

export async function checkScanSettings(
  s: ScanSettings,
  repo: RepoHandle,
): Promise<CheckedSettings> {
  const out: CheckedSettings = { exclude: [], prefixes: [], clients: [], problems: [] };
  // ADR 0111: what an exclude would leave out of the repo's own code.
  const code: string[] = [];
  if (s.exclude.length)
    for await (const f of repo.listFiles(["**/*"])) if (isCodeFile(f)) code.push(f);
  const perTop = new Map<string, number>();
  for (const f of code)
    if (f.includes("/")) perTop.set(f.split("/")[0]!, (perTop.get(f.split("/")[0]!) ?? 0) + 1);
  const most = Math.max(0, ...perTop.values());
  // The one top-level folder holding more code than any other; none on a tie.
  const tops = [...perTop].filter(([, n]) => n === most && n > 0).map(([d]) => d);
  const mainRoots = tops.length === 1 ? tops : [];
  for (const [i, e] of s.exclude.entries()) {
    const line = await citedLine(repo, e.at);
    if (line === undefined) {
      out.problems.push(`exclude.${i}: ${e.at} isn't in the repo, so ${e.path} is still read`);
      continue;
    }
    const re = globToRegExp(e.path);
    const file = e.at.slice(0, e.at.lastIndexOf(":"));
    const name = globName(e.path);
    const names = name !== "" && line.includes(name);
    if (!re.test(file) && !names) {
      out.problems.push(
        `exclude.${i}: ${e.at} isn't in ${e.path} and doesn't name it, so ${e.path} is still read`,
      );
      continue;
    }
    // A build or config file that leaves the folder out itself speaks for it, however big.
    if (!(isConfigFile(file) && names)) {
      const dropped = code.filter((f) => re.test(f));
      const root = mainRoots.find((d) => {
        const under = code.filter((f) => f.startsWith(`${d}/`));
        return under.length && under.every((f) => re.test(f));
      });
      const why =
        " so it is still read; only a build or config file that leaves it out itself can say so";
      if (dropped.length * 2 > code.length) {
        out.problems.push(
          `exclude.${i}: ${e.path} leaves out ${dropped.length} of the repo's ${code.length} code files,${why}`,
        );
        continue;
      }
      if (root) {
        out.problems.push(
          `exclude.${i}: ${e.path} leaves out ${root}/, where most of the repo's code is (${most} of ${code.length} code files),${why}`,
        );
        continue;
      }
    }
    out.exclude.push(re);
  }
  for (const [i, p] of s.prefixes.entries()) {
    const line = await citedLine(repo, p.at);
    if (line === undefined)
      out.problems.push(
        `prefixes.${i}: ${p.at} isn't in the repo, so the prefix ${p.prefix} isn't applied`,
      );
    else if (!line.includes(p.value))
      out.problems.push(
        `prefixes.${i}: ${p.at} doesn't say ${p.value}, so the prefix ${p.prefix} isn't applied`,
      );
    else if (prefixOf(p.value) !== trimSlash(p.prefix))
      // ADR 0111: the prefix is the value on its line, not any path near it.
      out.problems.push(
        `prefixes.${i}: the prefix ${p.prefix} isn't the value ${p.value} written at ${p.at}, so it isn't applied`,
      );
    else out.prefixes.push({ paths: p.paths.map(globToRegExp), prefix: p.prefix });
  }
  for (const [i, c] of s.clients.entries()) {
    const line = await citedLine(repo, c.at);
    const trim = (x: string) => x.replace(/\/+$/, "");
    const paths = c.paths.map(globToRegExp);
    const missing = line === undefined ? [] : await namesNotIn(repo, paths, c.names);
    if (line === undefined)
      out.problems.push(`clients.${i}: ${c.at} isn't in the repo, so the base isn't applied`);
    else if (!line.includes(c.value))
      out.problems.push(`clients.${i}: ${c.at} doesn't say ${c.value}, so the base isn't applied`);
    else if (!trim(c.base).endsWith(trim(c.value)))
      out.problems.push(
        `clients.${i}: the base ${c.base} isn't the value ${c.value} written at ${c.at}, so it isn't applied`,
      );
    else if (missing.length)
      out.problems.push(
        `clients.${i}: ${missing.join(", ")} isn't in any file under ${c.paths.join(", ")}, so the base isn't applied`,
      );
    else {
      const k = c.at.lastIndexOf(":");
      out.clients.push({
        paths,
        base: c.base,
        names: c.names,
        at: { path: c.at.slice(0, k), line: Number(c.at.slice(k + 1)) },
      });
    }
  }
  return out;
}

/** The names no file the globs cover mentions (a client entry's names must be in its code). */
async function namesNotIn(repo: RepoHandle, paths: RegExp[], names: string[]): Promise<string[]> {
  const left = new Set(names);
  if (left.size === 0) return [];
  for await (const f of repo.listFiles(["**/*"])) {
    if (!paths.some((x) => x.test(f))) continue;
    const text = await repo.readText(f).catch(() => "");
    for (const n of [...left]) if (text.includes(n)) left.delete(n);
    if (left.size === 0) break;
  }
  return [...left];
}

/** A base and the rest of a URL, with one slash between: `https://x/api/` + `owners`. */
export function joinBase(base: string, rest: string): string {
  if (rest === "") return base;
  if (/^[?#]/.test(rest)) return `${base.replace(/\/+$/, "")}${rest}`;
  return `${base.replace(/\/+$/, "")}/${rest.replace(/^\/+/, "")}`;
}

/**
 * HTTP calls with their client's base in front (ADR 0076): in a file an entry covers, a URL
 * that starts with one of its names (`${environment.API}owners`) or a path with no host
 * (`/owners`, put in front by an interceptor) gets the base; the first entry that applies
 * wins. The call keeps its id and cites the line the base is written on.
 */
export function applyClients(
  records: CatalogRecord[],
  clients: CheckedSettings["clients"],
): CatalogRecord[] {
  if (clients.length === 0) return records;
  return records.map((r) => {
    const x = r as unknown as { unresolvedKind?: string; raw?: string };
    if (r.kind !== "Unresolved" || x.unresolvedKind !== "http-call" || !x.raw) return r;
    const site = r.evidence[0];
    const file = site?.path;
    if (!file) return r;
    const sp = x.raw.indexOf(" ");
    const method = x.raw.slice(0, sp);
    const url = x.raw.slice(sp + 1);
    for (const c of clients) {
      if (!c.paths.some((p) => p.test(file))) continue;
      const name = c.names.find((n) => url.startsWith(`\${${n}}`));
      const resolved =
        name !== undefined
          ? joinBase(c.base, url.slice(name.length + 3))
          : url.startsWith("/") && !url.startsWith("//")
            ? joinBase(c.base, url)
            : undefined;
      if (resolved === undefined) continue;
      return {
        ...r,
        raw: `${method} ${resolved}`,
        evidence: [
          ...r.evidence,
          {
            source: "config",
            ...(site.repo ? { repo: site.repo } : {}),
            path: c.at.path,
            line: c.at.line,
            ...(site.commit ? { commit: site.commit } : {}),
            ...(site.scannedAt ? { scannedAt: site.scannedAt } : {}),
            side: "caller",
          },
        ],
      } as unknown as CatalogRecord;
    }
    return r;
  });
}

/** The repo as the readers see it: files under an excluded folder aren't listed. */
export function withExcludes<R extends RepoHandle>(repo: R, exclude: RegExp[]): R {
  if (exclude.length === 0) return repo;
  const wrapped = Object.create(repo) as R;
  Object.defineProperty(wrapped, "listFiles", {
    value: async function* (globs: readonly string[]) {
      for await (const f of repo.listFiles(globs)) if (!exclude.some((x) => x.test(f))) yield f;
    },
  });
  return wrapped;
}

const join = (prefix: string, path: string) =>
  `${prefix.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`.replace(/\/+$/, "") ||
  "/";

/** Endpoints with every prefix whose paths cover their source file, in the order listed. */
export function applyPrefixes(
  records: CatalogRecord[],
  prefixes: CheckedSettings["prefixes"],
): CatalogRecord[] {
  if (prefixes.length === 0) return records;
  return records.map((r) => {
    if (r.kind !== "Endpoint") return r;
    const e = r as unknown as {
      endpointType: string;
      pathOrTopic: string;
      normalizedPath?: string;
    };
    if (!HTTP_ENTRY.has(e.endpointType)) return r;
    const file = r.evidence[0]?.path;
    if (!file) return r;
    // Applied innermost first, so a list of [context path, global prefix] reads outside-in.
    const apply = prefixes.filter((p) => p.paths.some((x) => x.test(file))).reverse();
    if (apply.length === 0) return r;
    let path = e.pathOrTopic;
    let normalized = e.normalizedPath;
    for (const p of apply) {
      path = join(p.prefix, path);
      if (normalized !== undefined) normalized = join(p.prefix, normalized);
    }
    return {
      ...r,
      pathOrTopic: path,
      ...(normalized !== undefined ? { normalizedPath: normalized } : {}),
    } as CatalogRecord;
  });
}
