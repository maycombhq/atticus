import { createHash } from "node:crypto";
import { globMatcher } from "./glob.js";
import { Fact } from "./schema/facts.js";
import {
  RECIPE_CHOICE_DEFAULTS,
  groupNames,
  templateNames,
  type ReadingRule,
} from "./schema/reading-rules.js";

/**
 * ADR 0210 part 2: the one engine that runs a reading rule's recipe (`extract`), with no model.
 * A pattern matched line by line, scopes the nearest match above, or a YAML file's scalar leaves;
 * every part of a value a cited capture. Its facts are `by: reader`, checked by the verifier as
 * any other.
 */
export interface RecipeFile {
  path: string;
  text: string;
}
const LONG = 2000;
const MAIN = ["path", "key", "name", "host", "term", "value"];
type Part = { line: number; value: string };

export function runRecipe(
  rule: ReadingRule,
  files: readonly RecipeFile[],
  at: { repo: string; commit: string; component?: string },
): Fact[] {
  const e = rule.extract;
  if (!e) return [];
  const globs = (rule.files ?? []).map((g) => globMatcher(g));
  const fields = e.fields ?? { key: "{key}", value: "{value}" };
  const out: Fact[] = [];
  const emit = (
    file: string,
    line: string,
    n: number,
    g: Record<string, string>,
    value: string,
    w: { file: string; line: number; value: string }[],
  ) => {
    const fact: Record<string, unknown> = {
      kind: e.fact,
      ...RECIPE_CHOICE_DEFAULTS[e.fact],
      ...e.set,
    };
    for (const [f, t] of Object.entries(fields)) {
      const v = templateNames(t).reduce((s, x) => s.replace(`{${x}}`, g[x] ?? ""), t);
      if (v) fact[f] = f === "method" ? v.toUpperCase() : v;
    }
    const id = createHash("sha256").update(`${rule.key}\0${file}\0${n}`).digest("hex").slice(0, 12);
    const quote = line.trim().slice(0, 200);
    const cite = {
      file,
      line: n,
      value,
      ...(quote ? { quote } : {}),
      ...(w.length ? { with: w } : {}),
    };
    const r = Fact.safeParse({
      ...fact,
      id: `${e.fact}.${rule.key}.${id}`,
      ...at,
      cite,
      by: "reader",
      conf: "declared",
    });
    // A fact the facts file refuses (a value shaped like a secret, a missing part) is not written.
    if (r.success) out.push(r.data);
  };
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    if (globs.length && !globs.some((m) => m.test(file.path))) continue;
    const lines = file.text.split(/\r?\n/);
    if (!("pattern" in e)) {
      // `yaml: leaves`: a key with a scalar is a leaf; a key with none is a parent, cited in `with`.
      let parents: (Part & { indent: number })[] = [];
      lines.forEach((line, i) => {
        const m = line.length > LONG ? null : /^(\s*)([A-Za-z0-9_.-]+):(?:\s+(.*))?$/.exec(line);
        if (!m) return;
        const indent = m[1]!.length;
        parents = parents.filter((p) => p.indent < indent);
        const raw = (m[3] ?? "").replace(/(^|\s+)#.*$/, "").trim();
        const val = /^(["'])(.*)\1$/.exec(raw)?.[2] ?? raw;
        if (!raw) {
          parents.push({ indent, line: i + 1, value: m[2]! });
          return;
        }
        if (/^[|>&*]/.test(raw) || parents.length > 6) return;
        const key = [...parents.map((p) => p.value), m[2]!].join(".");
        const w = parents.map((p) => ({ file: file.path, line: p.line, value: p.value }));
        if (val) emit(file.path, line, i + 1, { key, value: val }, m[2]!, w);
      });
      continue;
    }
    const pattern = new RegExp(e.pattern);
    const scopes = (e.scopes ?? []).map((s) => ({
      ...s,
      re: new RegExp(s.pattern),
      end: s.end ? new RegExp(s.end) : undefined,
    }));
    const used = new Set(Object.values(fields).flatMap(templateNames));
    const optional = new Set(e.optional ?? []);
    const own = groupNames(e.pattern).filter((n) => used.has(n));
    const order = [...MAIN.filter((f) => f in fields), ...Object.keys(fields)].flatMap((f) =>
      templateNames(fields[f]!),
    );
    const held = new Map<string, Part>();
    lines.forEach((line, i) => {
      if (line.length > LONG) return;
      for (const s of scopes) {
        const v = s.re.exec(line)?.groups?.[s.name];
        if (v !== undefined) held.set(s.name, { line: i + 1, value: v });
      }
      const m = pattern.exec(line);
      if (m) {
        const g: Record<string, string> = {};
        for (const n of own) if (m.groups?.[n] !== undefined) g[n] = m.groups[n];
        for (const [n, p] of held) g[n] = p.value;
        if ([...used].every((n) => n in g || optional.has(n))) {
          // The value is the main capture as written on the line: a path's own part, a key, a name.
          const main = order.find((n) => own.includes(n) && g[n]);
          const value = main ? g[main]! : m[0];
          const w = scopes.flatMap((s) => {
            const p = held.get(s.name);
            return p && p.value && used.has(s.name)
              ? [{ file: file.path, line: p.line, value: p.value }]
              : [];
          });
          if (value) emit(file.path, line, i + 1, g, value, w);
        }
      }
      for (const s of scopes) if (s.end?.test(line)) held.delete(s.name);
    });
  }
  return out;
}

/** One repo's comparison: the recipe's facts against the facts a read verified there. */
export interface RecipeRepoProof {
  repo: string;
  /** True when every fact matches and there is at least one. */
  same: boolean;
  /** A fact on the same line with a field the template fills set otherwise. */
  differ: {
    file: string;
    line: number;
    field: string;
    want: string | undefined;
    got: string | undefined;
  }[];
  /** The read's facts the recipe didn't find. */
  missing: { file: string; line: number }[];
  /** The recipe's facts the read doesn't have. */
  extra: { file: string; line: number }[];
  /** `<repo> <file>:<line>` of each fact it reproduced. */
  reproduced: string[];
}

/**
 * ADR 0210 part 2 with ADR 0208's proof: runs the recipe on each repo's files and compares its
 * facts with that repo's verified facts of the same kind, in the files the rule names, by file,
 * line and each field the template fills. `proof` is given only when two repos it wasn't written
 * from match; the caller then marks the rule active with it.
 */
export function proveRecipe(
  rule: ReadingRule,
  reads: readonly {
    repo: string;
    files: readonly RecipeFile[];
    facts: readonly Fact[];
    commit?: string;
  }[],
  opts: { writtenFrom?: readonly string[] } = {},
): {
  repos: RecipeRepoProof[];
  proof?: { repos: string[]; reread: string[]; reproduced: string[] };
} {
  const e = rule.extract;
  const globs = (rule.files ?? []).map((g) => globMatcher(g));
  const named = (p: string) => !globs.length || globs.some((m) => m.test(p));
  const filled = Object.keys(e?.fields ?? { key: 1, value: 1 });
  const at = (f: { cite: { file: string; line: number } }) => `${f.cite.file}:${f.cite.line}`;
  const field = (f: Fact, k: string) =>
    (f as unknown as Record<string, unknown>)[k] as string | undefined;
  const repos = reads.map((r): RecipeRepoProof => {
    const got = runRecipe(rule, r.files, { repo: r.repo, commit: r.commit ?? "0000000" });
    const want = r.facts.filter((f) => f.kind === e?.fact && named(f.cite.file));
    const mine = new Map(got.map((f) => [at(f), f]));
    const theirs = new Map(want.map((f) => [at(f), f]));
    const p: RecipeRepoProof = {
      repo: r.repo,
      same: false,
      differ: [],
      missing: [],
      extra: [],
      reproduced: [],
    };
    for (const w of want) {
      const g = mine.get(at(w));
      if (!g) {
        p.missing.push({ file: w.cite.file, line: w.cite.line });
        continue;
      }
      const d = filled
        .filter((k) => field(w, k) !== field(g, k))
        .map((k) => ({
          file: w.cite.file,
          line: w.cite.line,
          field: k,
          want: field(w, k),
          got: field(g, k),
        }));
      p.differ.push(...d);
      if (!d.length) p.reproduced.push(`${r.repo} ${at(w)}`);
    }
    for (const g of got)
      if (!theirs.has(at(g))) p.extra.push({ file: g.cite.file, line: g.cite.line });
    p.same = !p.differ.length && !p.missing.length && !p.extra.length && p.reproduced.length > 0;
    return p;
  });
  const by = repos.filter((p) => p.same && !opts.writtenFrom?.includes(p.repo));
  if (by.length < 2) return { repos };
  const reread = by.flatMap((p) => {
    const r = reads.find((x) => x.repo === p.repo)!;
    return r.files
      .filter((f) => named(f.path))
      .map((f) => `${p.repo} ${f.path}`)
      .sort();
  });
  return {
    repos,
    proof: { repos: by.map((p) => p.repo), reread, reproduced: by.flatMap((p) => p.reproduced) },
  };
}
