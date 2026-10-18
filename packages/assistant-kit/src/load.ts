import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { parse } from "yaml";
import { Dialect, type DialectRule } from "@maycombhq/core";

export interface DialectProblem {
  /** Dotted path in the file, or "" for the whole file. */
  path: string;
  message: string;
}

export interface LoadedDialect {
  file: string;
  /** The folder test fixtures are relative to. */
  dir: string;
  /** The parsed dialect; undefined when the file isn't valid C2. */
  dialect?: Dialect;
  problems: DialectProblem[];
  /** True when the file has no tests yet (allowed only with allowNoTests). */
  noTests: boolean;
  /** Other dialects in the same folder, for `extends`. */
  parents: Map<string, Dialect>;
}

export interface LoadOptions {
  /**
   * Accept a dialect without tests, so `dialect run` works while the tests are being
   * written (it shows the ids, including derived Interface ids, the tests must expect).
   */
  allowNoTests?: boolean;
  /** Require `name` to match the file name, as the org pack's manifests refer to it by name. */
  checkFileName?: boolean;
}

const TESTS_REQUIRED = "every dialect ships at least one test";

/** The dialect file for a name in an org pack (.yaml, else .yml), or undefined. */
export async function dialectFilePath(orgPack: string, name: string): Promise<string | undefined> {
  for (const ext of [".yaml", ".yml"]) {
    const f = join(orgPack, "dialects", `${name}${ext}`);
    if (
      await stat(f)
        .then((s) => s.isFile())
        .catch(() => false)
    )
      return f;
  }
  return undefined;
}

/**
 * Read and check one dialect file against contract C2, collecting every problem rather
 * than stopping at the first, so an assistant can fix them in one pass. Tests are
 * validated separately from the rest: zod skips the cross-field checks when a base field
 * fails, which would hide rule problems behind a missing tests section.
 */
export async function loadDialectFile(file: string, o: LoadOptions = {}): Promise<LoadedDialect> {
  const out: LoadedDialect = {
    file,
    dir: dirname(file),
    problems: [],
    noTests: false,
    parents: new Map(),
  };
  let raw: unknown;
  try {
    raw = parse(await readFile(file, "utf8"));
  } catch (e) {
    out.problems.push({
      path: "",
      message: `not valid YAML: ${(e as Error).message.split("\n")[0]}`,
    });
    return out;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    out.problems.push({ path: "", message: "a dialect file is a YAML mapping (key: value)" });
    return out;
  }
  const doc = raw as Record<string, unknown>;
  out.noTests = doc.tests === undefined || (Array.isArray(doc.tests) && doc.tests.length === 0);
  const r = Dialect.safeParse(
    out.noTests ? { ...doc, tests: [{ name: "(placeholder)", files: {} }] } : doc,
  );
  if (!r.success)
    for (const i of r.error.issues)
      out.problems.push({ path: i.path.map(String).join("."), message: i.message });
  if (out.noTests && !o.allowNoTests) out.problems.push({ path: "tests", message: TESTS_REQUIRED });
  if (o.checkFileName && r.success) {
    const stem = basename(file, extname(file));
    if (r.data.name !== stem)
      out.problems.push({
        path: "name",
        message: `the file is ${basename(file)}, so name must be ${stem} (it says ${r.data.name})`,
      });
  }
  if (out.problems.length > 0) return out;
  out.dialect = out.noTests ? { ...r.data!, tests: [] } : r.data!;
  out.parents = await siblingDialects(out.dir, file);
  return out;
}

/** Valid dialects next to a file; invalid ones are skipped (they are reported when tested themselves). */
async function siblingDialects(dir: string, self: string): Promise<Map<string, Dialect>> {
  const out = new Map<string, Dialect>();
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => /\.ya?ml$/.test(n));
  for (const n of names.sort()) {
    const f = join(dir, n);
    if (f === self) continue;
    try {
      const r = Dialect.safeParse(parse(await readFile(f, "utf8")));
      if (r.success && !out.has(r.data.name)) out.set(r.data.name, r.data);
    } catch {
      // not ours to report
    }
  }
  return out;
}

/** The rules a dialect runs, parents first and the child's rule winning, as the engine merges them. */
export function mergedRules(dialect: Dialect, parents: Map<string, Dialect>): DialectRule[] {
  const rules = new Map<string, DialectRule>();
  const visit = (d: Dialect, seen: Set<string>) => {
    for (const p of d.extends) {
      const parent = parents.get(p);
      if (!parent || seen.has(p)) continue; // the engine reports these
      visit(parent, new Set([...seen, p]));
    }
    for (const r of d.rules) rules.set(r.id, r);
  };
  visit(dialect, new Set([dialect.name]));
  return [...rules.values()].sort((a, b) => a.id.localeCompare(b.id));
}
