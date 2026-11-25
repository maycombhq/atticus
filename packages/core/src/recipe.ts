import { createHash } from "node:crypto";
import { globMatcher } from "./glob.js";
import { Fact } from "./schema/facts.js";
import {
  RECIPE_CHOICE_DEFAULTS,
  groupNames,
  recipeRegExp,
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
/** A line a recipe matched that wrote no fact, and why, so the caller can say so. */
export interface RecipeDropped {
  file: string;
  line: number;
  reason: string;
}

/** A YAML scalar as written after `key:`: unquoted, a comment outside quotes left off. */
function yamlScalar(raw: string): string | undefined {
  const d = /^"((?:\\.|[^"\\])*)"\s*(?:#.*)?$/.exec(raw);
  if (d) return d[1];
  const q = /^'((?:''|[^'])*)'\s*(?:#.*)?$/.exec(raw);
  if (q) return q[1]!.replace(/''/g, "'");
  if (/^["']/.test(raw)) return undefined;
  return raw.replace(/(^|\s)#.*$/, "").trim();
}

/** What a recipe's proof is of: its extract and its files (review of item 7). */
export const recipeDigest = (r: { extract?: unknown; files?: readonly string[] }): string =>
  createHash("sha256")
    .update(JSON.stringify([r.extract ?? null, r.files ?? []]))
    .digest("hex")
    .slice(0, 16);

export function runRecipe(
  rule: ReadingRule,
  files: readonly RecipeFile[],
  at: { repo: string; commit: string; component?: string },
): { facts: Fact[]; dropped: RecipeDropped[] } {
  const e = rule.extract;
  const facts: Fact[] = [];
  const dropped: RecipeDropped[] = [];
  if (!e) return { facts, dropped };
  const globs = (rule.files ?? []).map((g) => globMatcher(g));
  const fields = e.fields ?? { key: "{key}", value: "{value}" };
  const emit = (
    file: string,
    line: string,
    n: number,
    g: Record<string, string>,
    value: string,
    w: Part[],
  ) => {
    const fact: Record<string, unknown> = {
      kind: e.fact,
      ...RECIPE_CHOICE_DEFAULTS[e.fact],
      ...e.set,
    };
    for (const [f, t] of Object.entries(fields)) {
      // One pass: a capture is text, never a template or a replacement pattern.
      const v = t.replace(/\{(\w+)\}/g, (_m, x: string) => g[x] ?? "");
      if (v) fact[f] = f === "method" ? v.toUpperCase() : v;
    }
    const id = createHash("sha256").update(`${rule.key}\0${file}\0${n}`).digest("hex").slice(0, 12);
    const quote = line.trim().slice(0, 200);
    const cite = {
      file,
      line: n,
      value,
      ...(quote ? { quote } : {}),
      ...(w.length ? { with: w.map((p) => ({ file, ...p })) } : {}),
    };
    const r = Fact.safeParse({
      ...fact,
      id: `${e.fact}.${rule.key}.${id}`,
      ...at,
      cite,
      by: "reader",
      conf: "declared",
    });
    if (r.success) facts.push(r.data);
    else
      dropped.push({
        file,
        line: n,
        reason: `the facts file refuses it: ${r.error.issues[0]?.message ?? "invalid"}`,
      });
  };
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    if (globs.length && !globs.some((m) => m.test(file.path))) continue;
    const lines = file.text.split(/\r?\n/);
    if (!("pattern" in e)) {
      // `yaml: leaves`: a key with a scalar is a leaf; a key with none is a parent, cited in `with`.
      // A block scalar's body, and a list item with what is under it, are skipped.
      let parents: (Part & { indent: number })[] = [];
      let skipUnder: number | undefined;
      lines.forEach((line, i) => {
        if (line.length > LONG || !line.trim() || line.trim().startsWith("#")) return;
        const indent = line.length - line.trimStart().length;
        if (skipUnder !== undefined && indent > skipUnder) return;
        skipUnder = undefined;
        parents = parents.filter((p) => p.indent < indent);
        if (/^-(\s|$)/.test(line.trimStart())) {
          skipUnder = indent;
          return;
        }
        const m = /^\s*([A-Za-z0-9_.-]+):(?:\s+(.*))?$/.exec(line);
        if (!m) return;
        const raw = (m[2] ?? "").trim();
        if (/^[|>]/.test(raw)) {
          skipUnder = indent;
          return;
        }
        const val = yamlScalar(raw);
        if (!raw || (!val && /^#/.test(raw))) {
          parents.push({ indent, line: i + 1, value: m[1]! });
          return;
        }
        if (!val || /^[&*!{[]/.test(raw)) return;
        if (parents.length > 6) {
          dropped.push({
            file: file.path,
            line: i + 1,
            reason: "more than six parent keys",
          });
          return;
        }
        const key = [...parents.map((p) => p.value), m[1]!].join(".");
        emit(
          file.path,
          line,
          i + 1,
          { key, value: val },
          m[1]!,
          parents.map(({ line, value }) => ({ line, value })),
        );
      });
      continue;
    }
    const pattern = recipeRegExp(e.pattern);
    const scopes = (e.scopes ?? []).map((s) => ({
      ...s,
      re: recipeRegExp(s.pattern),
      stop: s.end ? recipeRegExp(s.end) : undefined,
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
        const sm = s.re.matcher(line);
        const v = sm.find() ? sm.group(s.name) : null;
        if (v !== null) held.set(s.name, { line: i + 1, value: v });
      }
      const m = pattern.matcher(line);
      if (m.find()) {
        const g: Record<string, string> = {};
        for (const n of own) {
          const v = m.group(n);
          if (v !== null) g[n] = v;
        }
        for (const [n, p] of held) g[n] = p.value;
        const missing = [...used].filter((n) => !(n in g) && !optional.has(n));
        // The value is the main capture as written on the line: a path's own part, a key, a name.
        const main = order.find((n) => own.includes(n) && g[n]);
        const value = main ? g[main]! : (m.group() ?? "");
        if (missing.length)
          dropped.push({
            file: file.path,
            line: i + 1,
            reason: `nothing matched ${missing.map((n) => `{${n}}`).join(", ")}`,
          });
        else if (value) {
          const w = scopes.flatMap((s) => {
            const p = held.get(s.name);
            return p && p.value && used.has(s.name) ? [p] : [];
          });
          emit(file.path, line, i + 1, g, value, w);
        }
      }
      for (const s of scopes) if (s.stop?.matcher(line).find()) held.delete(s.name);
    });
  }
  return { facts, dropped };
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
  proof?: { repos: string[]; reread: string[]; reproduced: string[]; digest: string };
} {
  const e = rule.extract;
  const globs = (rule.files ?? []).map((g) => globMatcher(g));
  const named = (p: string) => !globs.length || globs.some((m) => m.test(p));
  // Every field the recipe writes: its templates', its `set` and the choices it defaults.
  const filled = [
    ...new Set([
      ...Object.keys(e?.fields ?? { key: 1, value: 1 }),
      ...Object.keys(e?.set ?? {}),
      ...Object.keys((e && RECIPE_CHOICE_DEFAULTS[e.fact]) ?? {}),
    ]),
  ];
  const at = (f: { cite: { file: string; line: number } }) => `${f.cite.file}:${f.cite.line}`;
  const field = (f: Fact, k: string) =>
    (f as unknown as Record<string, unknown>)[k] as string | undefined;
  const repos = reads.map((r): RecipeRepoProof => {
    const got = runRecipe(rule, r.files, { repo: r.repo, commit: r.commit ?? "0000000" }).facts;
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
    proof: {
      repos: by.map((p) => p.repo),
      reread,
      reproduced: by.flatMap((p) => p.reproduced),
      digest: recipeDigest(rule),
    },
  };
}
