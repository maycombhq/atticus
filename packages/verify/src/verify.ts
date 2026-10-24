import {
  claimOnLines,
  isSecretPath,
  NEVER_CHECKED_STEPS,
  quoteMatches,
  quoteNotRequired,
  redactSecrets,
  type Cite,
  type Claim,
  type Fact,
} from "@maycombhq/core";
import { globToRegExp } from "@maycombhq/sdk";
import { insideRepo, type FileSource } from "./source.js";

/**
 * The verifier (ADR 0124). It never reads code to find facts; it checks the facts it is given:
 * the file is inside the repo and not a secret, the fact is of the commit being verified, the
 * cited line exists, the claim (the route, topic, table, field, key or resource the fact states)
 * is on that line or one line either side, the quote matches after the model's small rewrites
 * are forgiven, and every fact a fact names exists and holds. What it proves: every fact rests on
 * a real line that names the thing claimed. What it cannot prove: that the reader understood it.
 */

export type RejectCode =
  | "outside-repo"
  | "secret-path"
  | "wrong-commit"
  | "no-file"
  | "no-line"
  | "claim-not-on-line"
  | "quote-mismatch"
  | "dangling-ref"
  | "ref-rejected";

export interface Rejected {
  fact: Fact;
  code: RejectCode;
  message: string;
}

export interface Coverage {
  /** Source files a kept fact cites, or the reader opened through Atticus's tools. */
  read: string[];
  /** Source files nobody can show were read. Never "excused" on the reader's word. */
  unknown: string[];
  /** Source files left out by an accepted exclusion rule (generated code, vendored copies). */
  excluded: string[];
  /** read / (read + unknown), three decimals; 1 when the repo has no source files. */
  ratio: number;
}

export interface VerifyReport {
  accepted: Fact[];
  rejected: Rejected[];
  coverage: Coverage;
  /** Quotes stored with a secret value redacted. */
  redacted: number;
}

export interface VerifyOptions {
  facts: readonly Fact[];
  source: FileSource;
  /** The commit being verified; a fact of another commit is refused. Prefixes match. */
  commit?: string;
  /** Files the reader opened through Atticus-routed tools (ADR 0118), repo-relative. */
  routed?: readonly string[];
  /** Accepted exclusion globs: generated code, vendored copies (ADR 0075 scan settings). */
  exclude?: readonly string[];
}

const SOURCE_EXT =
  /\.(java|kt|kts|scala|groovy|cs|vb|fs|ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|php|swift|m|mm|c|cc|cpp|h|hpp|sql|graphql|gql|proto|ya?ml|json|xml|properties|toml|ini|conf|tf|tfvars|hcl|bicep|sh|ps1|bat|cmd|gradle|html?|vue|svelte|cshtml|razor|aspx|jsp|ftl|hbs|cob|cbl|cpy|jcl|avsc|wsdl|xsd|csproj|sln|config)$/i;
const SOURCE_NAME = /(^|\/)(Dockerfile[^/]*|Makefile|Jenkinsfile|Procfile|Containerfile)$/;
const LOCKFILE =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Gemfile\.lock|Cargo\.lock|poetry\.lock|go\.sum|packages\.lock\.json)$/;

/** Whether a repo file counts as source for coverage. */
export function isSourceFile(path: string, firstLine = ""): boolean {
  if (isSecretPath(path) || LOCKFILE.test(path)) return false;
  if (quoteNotRequired(path, firstLine)) return false;
  return SOURCE_EXT.test(path) || SOURCE_NAME.test(path);
}

const lastPart = (s: string) => s.split(".").pop() ?? s;
const routeOrWord = (v: string): Claim =>
  v.includes("/") ? { kind: "route", value: v } : { kind: "word", value: v };

/** What a fact claims, as the line check looks for it; alternatives are tried in order. */
function claimsOf(f: Fact): Claim[] {
  switch (f.kind) {
    case "entry":
    case "call":
      return [routeOrWord(f.path)];
    case "store":
      return [
        { kind: "word", value: f.name },
        { kind: "word", value: lastPart(f.name) },
      ];
    case "field":
      return [{ kind: "field", value: f.name }];
    case "deploy":
      return [{ kind: "word", value: f.resourceName ?? f.cite.value }];
    case "config":
      return [
        { kind: "word", value: f.key },
        { kind: "word", value: lastPart(f.key) },
      ];
    case "flow":
      return [routeOrWord(f.cite.value)];
  }
}

const sameCommit = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);

function refsOf(f: Fact): { field: string; id: string }[] {
  const out: { field: string; id: string }[] = [];
  const add = (field: string, id: string | undefined) => {
    if (id !== undefined) out.push({ field, id });
  };
  if (f.kind === "call") add("from", f.from);
  if (f.kind === "store") add("under", f.under);
  if (f.kind === "field") {
    add("owner", f.owner);
    add("mappedTo", f.mappedTo);
  }
  if (f.kind === "flow") {
    add("entry", f.entry);
    f.steps.forEach((s, i) => add(`steps.${i + 1}.ref`, s.ref));
  }
  return out;
}

export async function verifyFacts(o: VerifyOptions): Promise<VerifyReport> {
  const facts = [...o.facts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const linesCache = new Map<string, string[] | undefined>();
  const linesOf = (path: string) => {
    if (!linesCache.has(path)) {
      const text = o.source.read(path);
      linesCache.set(
        path,
        text === undefined ? undefined : text.replace(/\r\n?/g, "\n").split("\n"),
      );
    }
    return linesCache.get(path);
  };

  /** One citation checked against its file: undefined when it holds, else why not. */
  const checkCite = (
    cite: Cite,
    claims: Claim[] | undefined,
    label: string,
  ): { code: RejectCode; message: string } | undefined => {
    const where = `${cite.file}:${cite.line}`;
    if (!insideRepo(cite.file))
      return {
        code: "outside-repo",
        message: `${label} cites ${cite.file}, which is outside the repo`,
      };
    if (isSecretPath(cite.file))
      return {
        code: "secret-path",
        message: `${label} cites ${cite.file}, a file whose lines are never quoted into a map; cite where the code reads the setting instead`,
      };
    const lines = linesOf(cite.file);
    if (lines === undefined)
      return {
        code: "no-file",
        message: `${label} cites ${cite.file}, which is not in the repo at this commit`,
      };
    if (cite.line > lines.length)
      return {
        code: "no-line",
        message: `${label} cites line ${cite.line} of ${cite.file}, which has ${lines.length} lines`,
      };
    if (claims && !claims.some((c) => claimOnLines(lines, cite.line, c)))
      return {
        code: "claim-not-on-line",
        message: `${label} claims ${claims.map((c) => `"${c.value}"`).join(" or ")}, which ${where} (or the line either side) does not name`,
      };
    const line = lines[cite.line - 1] ?? "";
    if (cite.quote && !quoteNotRequired(cite.file, line)) {
      const near = [cite.line - 1, cite.line, cite.line + 1].map((n) => lines[n - 1] ?? "");
      if (!near.some((l) => quoteMatches(l, cite.quote)))
        return {
          code: "quote-mismatch",
          message: `${label} quotes "${cite.quote}", but ${where} reads "${line.trim().slice(0, 200)}"`,
        };
    }
    return undefined;
  };

  const rejected = new Map<string, Rejected>();
  const reject = (fact: Fact, code: RejectCode, message: string) =>
    rejected.set(fact.id, { fact, code, message });

  for (const f of facts) {
    const label = `${f.kind} ${f.id}`;
    if (o.commit && !sameCommit(f.commit, o.commit)) {
      // a traversal or a secret is reported as such even on another commit
      const early = !insideRepo(f.cite.file)
        ? ("outside-repo" as const)
        : isSecretPath(f.cite.file)
          ? ("secret-path" as const)
          : undefined;
      if (early) {
        const c = checkCite(f.cite, undefined, label)!;
        reject(f, c.code, c.message);
      } else
        reject(
          f,
          "wrong-commit",
          `${label} was read at ${f.commit}, not at ${o.commit}; read it again`,
        );
      continue;
    }
    const bad = checkCite(f.cite, claimsOf(f), label);
    if (bad) {
      reject(f, bad.code, bad.message);
      continue;
    }
    if (f.kind === "flow") {
      let flowBad: { code: RejectCode; message: string } | undefined;
      f.steps.forEach((s, i) => {
        if (flowBad) return;
        const checked = !(NEVER_CHECKED_STEPS as readonly string[]).includes(s.kind);
        flowBad = checkCite(
          s.cite,
          checked ? [routeOrWord(s.cite.value)] : undefined,
          `${label} step ${i + 1}`,
        );
      });
      f.errors.forEach((e, i) => {
        if (flowBad) return;
        flowBad = checkCite(e.cite, [routeOrWord(e.cite.value)], `${label} error ${i + 1}`);
      });
      if (flowBad) {
        reject(f, flowBad.code, flowBad.message);
        continue;
      }
    }
  }

  // references: dangling first, then whatever names a rejected fact, until nothing changes
  const ids = new Set(facts.map((f) => f.id));
  for (const f of facts) {
    if (rejected.has(f.id)) continue;
    const d = refsOf(f).find((r) => !ids.has(r.id));
    if (d)
      reject(
        f,
        "dangling-ref",
        `${f.kind} ${f.id} names ${d.field} "${d.id}", which is no fact in this file`,
      );
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const f of facts) {
      if (rejected.has(f.id)) continue;
      const r = refsOf(f).find((x) => rejected.has(x.id));
      if (r) {
        reject(
          f,
          "ref-rejected",
          `${f.kind} ${f.id} names ${r.field} "${r.id}", which was rejected (${rejected.get(r.id)!.code})`,
        );
        changed = true;
      }
    }
  }

  // the kept facts: verified by the line check unless a person or a sample already did, quotes redacted
  let redacted = 0;
  const fixQuote = (c: Cite): Cite => {
    if (!c.quote) return c;
    const lines = linesOf(c.file) ?? [];
    const line = lines[c.line - 1] ?? "";
    if (quoteNotRequired(c.file, line) && !quoteMatches(line, c.quote)) {
      const { quote: _drop, ...rest } = c;
      return rest;
    }
    const q = redactSecrets(c.quote);
    if (q !== c.quote) redacted++;
    return { ...c, quote: q };
  };
  const accepted: Fact[] = facts
    .filter((f) => !rejected.has(f.id))
    .map((f) => {
      const verified = f.verified === "person" || f.verified === "sample" ? f.verified : "line";
      const base = { ...f, verified, cite: fixQuote(f.cite) } as Fact;
      if (base.kind === "flow")
        return {
          ...base,
          steps: base.steps.map((s) => ({ ...s, cite: fixQuote(s.cite) })),
          errors: base.errors.map((e) => ({ ...e, cite: fixQuote(e.cite) })),
        } as Fact;
      return base;
    });

  // coverage
  const excludeRes = (o.exclude ?? []).map(globToRegExp);
  const sources: string[] = [];
  const excluded: string[] = [];
  for (const p of o.source.list()) {
    const first = (linesOf(p) ?? [""])[0] ?? "";
    if (!isSourceFile(p, first)) continue;
    if (excludeRes.some((re) => re.test(p))) excluded.push(p);
    else sources.push(p);
  }
  const touched = new Set<string>(o.routed ?? []);
  for (const f of accepted) {
    touched.add(f.cite.file);
    if (f.kind === "flow") {
      for (const s of f.steps) touched.add(s.cite.file);
      for (const e of f.errors) touched.add(e.cite.file);
    }
  }
  const read = sources.filter((p) => touched.has(p)).sort();
  const unknown = sources.filter((p) => !touched.has(p)).sort();
  const total = read.length + unknown.length;
  const ratio = total === 0 ? 1 : Math.round((read.length / total) * 1000) / 1000;

  return {
    accepted,
    rejected: [...rejected.values()].sort((a, b) =>
      a.fact.id < b.fact.id ? -1 : a.fact.id > b.fact.id ? 1 : 0,
    ),
    coverage: { read, unknown, excluded: excluded.sort(), ratio },
    redacted,
  };
}
