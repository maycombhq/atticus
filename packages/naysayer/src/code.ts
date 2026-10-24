import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { RecordId, stateDirOf, type CatalogRecord } from "@maycombhq/core";
import type { RuledHit } from "./findings.js";

/**
 * The critic looks in the code (ADR 0115 addendum, W1). A lens that says something doesn't
 * exist (a check, a class, a screen, an endpoint) must have looked: its prompt names the repos'
 * clones, and it lists the names its finding says are missing (`absent`). Atticus then checks
 * each name as a fact, against the catalog and the code: a name found makes the finding a note
 * citing where it was found, never a silent drop. The lens chose the names (its reading); the
 * search only confirms where a name is declared or a file is.
 */

/** A repo cloned in the workspace: its id, its folder from the metarepo and its full path. */
export interface CodeRepo {
  repo: string;
  rel: string;
  dir: string;
}

/** The repos cloned under workspace/ (or the state folder's workspace/), sorted by id. */
export function codeRepos(root: string): CodeRepo[] {
  const out = new Map<string, CodeRepo>();
  for (const base of [join(root, "workspace"), join(stateDirOf(root), "workspace")]) {
    if (!existsSync(base)) continue;
    let names: string[];
    try {
      names = readdirSync(base, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }
    for (const n of names)
      if (RecordId.safeParse(n).success && !out.has(n)) {
        const dir = join(base, n);
        out.set(n, { repo: n, dir, rel: relative(root, dir).split("\\").join("/") });
      }
  }
  return [...out.values()].sort((a, b) => a.repo.localeCompare(b.repo));
}

/**
 * Where the code has each name: `repo:path:line` of its declaration, or `repo:path` of a file it
 * names. The command line gives the context tools' search (namesInCode, ADR 0118 addendum);
 * names not found are left out.
 */
export type CodeSearch = (root: string, names: string[]) => Promise<Map<string, string>>;

let registered: CodeSearch | undefined;

/**
 * Register the code search the critic uses when a caller passes none (the command line does,
 * when it starts, so a stage's critic round gets it too). Undefined forgets it (tests).
 */
export function registerCodeSearch(search: CodeSearch | undefined): void {
  registered = search;
}

export const codeSearchFor = (given?: CodeSearch): CodeSearch | undefined => given ?? registered;

type Rec = CatalogRecord & Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** "post /a/{id}/" → "POST /a/{}"; undefined when it isn't METHOD /path. */
function endpointKey(s: string): string | undefined {
  const m = /^\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S*)\s*$/i.exec(s);
  if (!m) return undefined;
  const path = m[2]!
    .replace(/\?.*$/, "")
    .replace(/\{[^}]*\}/g, "{}")
    .replace(/(.)\/$/, "$1");
  return `${m[1]!.toUpperCase()} ${path.toLowerCase()}`;
}

/** The catalog record a name is: an endpoint by method and path, else a record by id or name. */
export function catalogHas(records: readonly CatalogRecord[], name: string): Rec | undefined {
  const n = name.trim();
  const ep = endpointKey(n);
  const rs = records as Rec[];
  if (ep)
    return rs.find(
      (r) =>
        r.kind === "Endpoint" &&
        endpointKey(`${str(r.method) ?? ""} ${str(r.pathOrTopic) ?? ""}`) === ep,
    );
  const low = n.toLowerCase();
  return rs.find(
    (r) =>
      r.kind !== "Unresolved" && (r.id.toLowerCase() === low || str(r.name)?.toLowerCase() === low),
  );
}

/** One place a name was found: the catalog record or the code's line. */
export interface FoundAt {
  name: string;
  /** `catalog:<Kind> <id>`, or the code's `repo:path[:line]`. */
  at: string;
  record?: string;
  kind?: string;
  repo?: string;
  path?: string;
  line?: number;
}

function codeAt(name: string, at: string): FoundAt {
  const [repo, path, line] = at.split(":");
  const n = Number(line);
  return {
    name,
    at,
    ...(repo ? { repo } : {}),
    ...(path ? { path } : {}),
    ...(Number.isInteger(n) && n > 0 ? { line: n } : {}),
  };
}

/**
 * Check the names a lens's findings say are missing (W1): each name is looked up in the catalog,
 * then searched in the code. A finding with a name found is marked (`found`); toFinding makes it
 * a note that cites where. Facts only: nothing is judged here, and nothing is dropped.
 */
export async function checkAbsences(
  root: string,
  records: readonly CatalogRecord[],
  hits: RuledHit[],
  search: CodeSearch | undefined,
): Promise<void> {
  const claimed = hits.filter((h) => h.hit.absent?.length);
  if (!claimed.length) return;
  const inCatalog = new Map<string, Rec>();
  const open = new Set<string>();
  for (const h of claimed)
    for (const n of h.hit.absent!) {
      const r = catalogHas(records, n);
      if (r) inCatalog.set(n, r);
      else open.add(n);
    }
  const inCode =
    search && open.size
      ? await search(root, [...open]).catch(() => new Map())
      : new Map<string, string>();
  for (const h of claimed) {
    const found: FoundAt[] = [];
    for (const n of h.hit.absent!) {
      const r = inCatalog.get(n);
      if (r)
        found.push({ name: n, at: `the catalog's ${r.kind} ${r.id}`, record: r.id, kind: r.kind });
      else if (inCode.has(n)) found.push(codeAt(n, inCode.get(n)!));
    }
    if (found.length) h.hit.found = found;
  }
}
