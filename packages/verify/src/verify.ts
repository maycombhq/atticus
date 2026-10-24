import {
  claimOnLines,
  lineNamesClaim,
  partsNamePath,
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
import { pageRouteMatches } from "./pages.js";
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
  | "claim-in-comment"
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

/**
 * Files that hold no facts of what a repo serves, calls, stores or deploys, so coverage doesn't
 * count them (feedback from the A4 run): tests, build-tool wrappers, Java package docs, and
 * i18n message bundles.
 */
const NOT_PRODUCT = [
  /(^|\/)(src\/test|src\/it|test|tests|__tests__|__mocks__|spec|specs|e2e|testdata|test-data|fixtures)\//i,
  /(\.|_|-)(test|spec|tests|specs)\.[a-z0-9]+$/i,
  /(Test|Tests|IT|Spec)\.(java|kt|scala|groovy|cs|vb)$/,
  /(^|\/)test_[^/]+\.py$/,
  /(^|\/)(mvnw|mvnw\.cmd|gradlew|gradlew\.bat)$/,
  /(^|\/)package-info\.java$/,
  /(^|\/)messages(_[A-Za-z_]+)?\.properties$/,
  /\.(resx|po|pot)$/i,
];

/** Whether a repo file counts as source for coverage. */
export function isSourceFile(path: string, firstLine = ""): boolean {
  if (isSecretPath(path) || LOCKFILE.test(path)) return false;
  if (NOT_PRODUCT.some((re) => re.test(path))) return false;
  if (quoteNotRequired(path, firstLine)) return false;
  return SOURCE_EXT.test(path) || SOURCE_NAME.test(path);
}

const lastPart = (s: string) => s.split(".").pop() ?? s;
/** A line that is all comment: `//`, `/*`, `*`, `#` (not a C# directive), `<!--` or SQL's `-- `. */
const isCommentLine = (l: string) =>
  /^\s*(\/\/|\/\*|\*|<!--|-- |#(?!\s*(region|endregion|if|elif|else|endif|define|undef|pragma|nullable|include|import)\b)(?!!))/.test(
    l,
  );

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
    case "config": {
      // A key as written on the line, or the last part of a dotted path or a flag (a YAML path
      // `livenessProbe.httpGet.path` names `path:` on its line; `kubectl wait --timeout`, `timeout`).
      const tail = f.key.trim().split(/\s+/).pop()!.replace(/^-+/, "");
      const lastOf = (k: string) => k.split(/[.:]|__/).pop() ?? k;
      return [
        { kind: "word", value: f.key },
        { kind: "word", value: lastPart(f.key) },
        { kind: "word", value: tail },
        { kind: "word", value: lastOf(tail) },
      ];
    }
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
    // A claim put together from several lines (ADR 0124 addendum A4): each part line must exist
    // and name its own part; then the claim is checked over all the lines together.
    const parts = cite.with ?? [];
    const near = (ls: string[], n: number) => ls.slice(Math.max(0, n - 2), n + 1);
    const partLines: string[] = [];
    for (const [i, p] of parts.entries()) {
      const pl = `${label} part ${i + 1}`;
      if (!insideRepo(p.file))
        return {
          code: "outside-repo",
          message: `${pl} cites ${p.file}, which is outside the repo`,
        };
      if (isSecretPath(p.file))
        return {
          code: "secret-path",
          message: `${pl} cites ${p.file}, a file never quoted into a map`,
        };
      const ls = linesOf(p.file);
      if (ls === undefined)
        return {
          code: "no-file",
          message: `${pl} cites ${p.file}, which is not in the repo at this commit`,
        };
      if (p.line > ls.length)
        return {
          code: "no-line",
          message: `${pl} cites line ${p.line} of ${p.file}, which has ${ls.length} lines`,
        };
      if (
        !claimOnLines(ls, p.line, routeOrWord(p.value)) &&
        !claimOnLines(ls, p.line, { kind: "word", value: p.value.replace(/^\/+|\/+$/g, "") }) &&
        // a part named at a camelCase start (`Catalog` in `CatalogController`), as the path check does
        !partsNamePath(near(ls, p.line), p.value)
      )
        return {
          code: "claim-not-on-line",
          message: `${pl} says "${p.value}" is written at ${p.file}:${p.line} (or the line either side), and it isn't`,
        };
      partLines.push(...near(ls, p.line));
    }
    const holds = (c: Claim) =>
      claimOnLines(lines, cite.line, c) ||
      // a framework that routes by file place (Razor Pages, WebForms, Next.js)
      (c.kind === "route" &&
        pageRouteMatches(cite.file, lines, (p) => linesOf(p) !== undefined, c.value)) ||
      (parts.length > 0 &&
        (c.kind === "route"
          ? partsNamePath([...near(lines, cite.line), ...partLines], c.value)
          : partLines.some((l) => lineNamesClaim(l, c))));
    if (claims && !claims.some(holds))
      return {
        code: "claim-not-on-line",
        message: `${label} claims ${claims.map((c) => `"${c.value}"`).join(" or ")}, which ${where} (or the line either side)${parts.length ? " and its parts" : ""} does not name${parts.length ? "" : "; if it is put together from other lines (a base URL, a prefix, a context path), cite them in cite.with"}`,
      };
    // A claim written only in a comment (a commented-out example, a scaffold note) isn't code.
    if (claims && !parts.length) {
      const naming = [cite.line - 1, cite.line, cite.line + 1]
        .map((n) => lines[n - 1])
        .filter((l): l is string => l !== undefined && claims.some((c) => lineNamesClaim(l, c)));
      // Netlify's `_redirects` starts its rules with `/*`, which is no comment there
      if (naming.length && !/(^|\/)_redirects$/.test(cite.file) && naming.every(isCommentLine))
        return {
          code: "claim-in-comment",
          message: `${label} claims ${claims.map((c) => `"${c.value}"`).join(" or ")}, which ${where} writes only in a comment; cite the code that does it`,
        };
    }
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
      // A reader can't vouch for itself: only a fact a person made keeps a person's mark, and a
      // sample session's mark stands only on a fact a person made too (the sample check writes
      // its own results, not this file). Everything else is verified by the line check.
      const verified = f.by === "person" && f.verified !== "none" ? f.verified : "line";
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
  // A file is read when a kept fact cites it, or the reader opened it through Atticus's tools. A
  // flow step's cite doesn't count: a step names its own value, so it is weaker evidence.
  const touched = new Set<string>(o.routed ?? []);
  for (const f of accepted)
    if (f.kind !== "flow") {
      touched.add(f.cite.file);
      for (const p of f.cite.with ?? []) touched.add(p.file);
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
