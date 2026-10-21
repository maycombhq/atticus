import type { CatalogRecord, ScanSettings } from "@maycombhq/core";
import { globToRegExp, type RepoHandle } from "@maycombhq/sdk";

/**
 * Scan settings per repo (ADR 0075): check every entry against the code, hide the excluded
 * folders from every reader, and put the prefixes in front of the HTTP entry points they
 * cover. An entry whose citation fails is reported and not applied.
 */

export interface CheckedSettings {
  exclude: RegExp[];
  prefixes: { paths: RegExp[]; prefix: string }[];
  problems: string[];
}

const HTTP_ENTRY = new Set(["rest", "webhook", "websocket", "sse"]);

/** The cited line's text, or undefined when the file or the line isn't there. */
async function citedLine(repo: RepoHandle, at: string): Promise<string | undefined> {
  const i = at.lastIndexOf(":");
  const path = at.slice(0, i);
  const n = Number(at.slice(i + 1));
  const text = await repo.readText(path).catch(() => undefined);
  if (text === undefined) return undefined;
  return text.replace(/\r\n?/g, "\n").split("\n")[n - 1];
}

export async function checkScanSettings(
  s: ScanSettings,
  repo: RepoHandle,
): Promise<CheckedSettings> {
  const out: CheckedSettings = { exclude: [], prefixes: [], problems: [] };
  for (const [i, e] of s.exclude.entries()) {
    if ((await citedLine(repo, e.at)) === undefined)
      out.problems.push(`exclude.${i}: ${e.at} isn't in the repo, so ${e.path} is still read`);
    else out.exclude.push(globToRegExp(e.path));
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
    else out.prefixes.push({ paths: p.paths.map(globToRegExp), prefix: p.prefix });
  }
  return out;
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
