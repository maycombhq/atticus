import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parse } from "yaml";
import {
  catalogDirOf,
  factsDirOf,
  factsFileOf,
  factsRelOf,
  headFromFiles,
  isAdopted,
  keptParse,
  auditItemHolds,
  auditPrecision,
  listQuestions,
  parseAuditFile,
  parseFacts,
  Api,
  FileChangedError,
  ProfileEditError,
  QuestionError,
  type Fact,
  type CatalogRecord,
} from "@maycombhq/core";
import { readCatalog } from "@maycombhq/scanner";
import { frameworkFacts, frameworkGaps, keyIsSecret } from "@maycombhq/verify";
import {
  badRequest,
  conflict,
  HttpError,
  notFound,
  type Router,
  type ServerContext,
} from "@maycombhq/server";
import { baseClonePath, loadRepos } from "@maycombhq/workspace";
import { contractCheckOf } from "./contract-check-files.js";
import { keptAnswer, stampOfFiles } from "./watched-memo.js";

/**
 * GET /api/trust (ADR 0124 addendum, C4 2.22.0): how far to trust each repo's map, for the Map's
 * Trust tab. It reads files only: the manifests, `facts/<repo>.jsonl`, the verifier's
 * `<repo>.verify.yaml`, the checkout's HEAD from its `.git` files (no git runs), and
 * catalog/generated. It runs nothing and calls nothing.
 */

type View = Api.TrustViewT;
type Repo = View["repos"][number];
type Report = NonNullable<Repo["verify"]["report"]>;
type Lists = NonNullable<Repo["lists"]>;

/**
 * The lines of `<repo>.rejected.jsonl` (`writeVerifyFiles`), each with what it is about: a
 * rejected fact's id, kind, file and line, or a refused question, reviewed entry or line.
 */
export function rejectedLines(text: string | undefined): Lists["rejected"] {
  const out: Lists["rejected"] = [];
  for (const raw of (text ?? "").split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let l: { code?: unknown; message?: unknown; fact?: Record<string, unknown> };
    try {
      l = JSON.parse(raw) as typeof l;
    } catch {
      out.push({ code: "unreadable", message: raw.slice(0, 200) });
      continue;
    }
    const f = l.fact && typeof l.fact === "object" ? l.fact : undefined;
    const cite = f?.cite as { file?: unknown; line?: unknown } | undefined;
    out.push({
      ...(typeof f?.id === "string" ? { fact: f.id } : {}),
      ...(typeof f?.kind === "string" ? { kind: f.kind } : {}),
      ...(typeof cite?.file === "string" ? { file: cite.file } : {}),
      ...(typeof cite?.line === "number" && Number.isInteger(cite.line) ? { line: cite.line } : {}),
      code: typeof l.code === "string" ? l.code : "rejected",
      message: typeof l.message === "string" ? l.message : "",
    });
  }
  return out;
}

const SHA = /^[0-9a-f]{7,64}$/;
/**
 * A projected fact's evidence says whose fact it was (ADR 0124: an assistant's, a reader's or a
 * person's) and names no extractor; a built-in reader's evidence is the rest.
 */
const FACT_BY = new Set(["assistant", "reader", "person"]);
const UNKNOWN_SHOWN = 50;

const firstLine = (e: unknown) => String((e as Error).message ?? e).split("\n")[0]!;
const text = (p: string) => readFile(p, "utf8").catch(() => undefined);

/** The commit a checkout is at, from its `.git` files (core, ADR 0140). */
export { headFromFiles };

/**
 * Beta.24: the report's live-looking secrets, each a file, a line and a key (never a value).
 * Review of beta.24: a key that is a secret itself is none (`""`), even from an older report.
 */
function secretsOf(raw: unknown): Pick<Report, "secrets"> {
  if (!Array.isArray(raw)) return {};
  const secrets = raw.flatMap((x) => {
    const s = x as { file?: unknown; line?: unknown; key?: unknown } | null;
    return s && typeof s.file === "string" && typeof s.key === "string" && Number.isInteger(s.line)
      ? [{ file: s.file, line: s.line as number, key: keyIsSecret(s.key) ? "" : s.key }]
      : [];
  });
  return secrets.length ? { secrets } : {};
}

/** The verifier's report (`<repo>.verify.yaml`, `writeVerifyFiles`), or why it can't be read. */
function reportOf(raw: unknown): Report | string {
  const r = raw as {
    accepted?: unknown;
    rejected?: unknown;
    redacted?: unknown;
    secrets?: unknown;
    commit?: unknown;
    coverage?: { ratio?: unknown; read?: unknown; unknown?: unknown; excluded?: unknown };
  } | null;
  if (!r || typeof r.accepted !== "number" || typeof r.rejected !== "number")
    return "not a verifier's report: accepted and rejected are missing";
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  const unknown = list(r.coverage?.unknown);
  return {
    accepted: r.accepted,
    rejected: r.rejected,
    redacted: typeof r.redacted === "number" ? r.redacted : 0,
    coverage: {
      ratio: typeof r.coverage?.ratio === "number" ? r.coverage.ratio : 0,
      read: typeof r.coverage?.read === "number" ? r.coverage.read : 0,
      unknown: unknown.length,
      excluded: list(r.coverage?.excluded).length,
    },
    unknownFiles: unknown.slice(0, UNKNOWN_SHOWN),
    ...secretsOf(r.secrets),
    ...(typeof r.commit === "string" && SHA.test(r.commit) ? { commit: r.commit } : {}),
  };
}

/** Same commit when either names the other's prefix (facts may keep a short one). */
const sameCommit = (a: string | undefined, b: string | undefined): boolean | null =>
  a && b ? a.startsWith(b) || b.startsWith(a) : null;

/**
 * Per repo, how many records of the catalog cite it from its facts (an assistant's, a reader's or
 * a person's fact, no extractor) and how many only from the built-in readers. A person's own
 * statement (manual evidence) is neither.
 */
export function catalogSources(
  records: readonly CatalogRecord[],
): Map<string, { facts: number; readers: number }> {
  const counts = new Map<string, { facts: number; readers: number }>();
  for (const r of records) {
    const seen = new Map<string, { facts: boolean; readers: boolean }>();
    for (const e of r.evidence) {
      if (!e.repo) continue;
      const s = seen.get(e.repo) ?? { facts: false, readers: false };
      if (!e.extractor && e.by && FACT_BY.has(e.by)) s.facts = true;
      else if (e.source !== "manual") s.readers = true;
      seen.set(e.repo, s);
    }
    for (const [repo, s] of seen) {
      const c = counts.get(repo) ?? { facts: 0, readers: 0 };
      if (s.facts) c.facts += 1;
      else if (s.readers) c.readers += 1;
      counts.set(repo, c);
    }
  }
  return counts;
}

/** What to do next for a repo, and the state that says why (the app says it in words). */
function nextOf(
  repo: string,
  r: Pick<Repo, "facts" | "verify" | "sameCommit" | "catalog">,
): { state: Repo["state"]; next?: Repo["next"] } {
  const read = { command: `atticus map ${repo}`, slash: `/atticus-map ${repo}` };
  if (!r.facts.present) return { state: "not-read", next: read };
  const report = r.verify.report;
  if (!report) return { state: "unverified", next: { command: `atticus verify ${repo}` } };
  if (report.rejected > 0)
    return {
      state: "rejected",
      next: { command: `atticus verify ${repo}`, slash: `/atticus-map ${repo}` },
    };
  if (r.sameCommit === false) return { state: "stale", next: read };
  if (r.facts.unverified > 0)
    return { state: "unverified", next: { command: `atticus verify ${repo}` } };
  if (r.catalog.fromFacts === 0)
    return { state: "unwritten", next: { command: `atticus verify ${repo} --write` } };
  if (report.coverage.unknown > 0) return { state: "unknown-files", next: read };
  return { state: "trusted" };
}

export async function trustView(root: string): Promise<View> {
  const rel = (p: string) => relative(root, p).split(sep).join("/") || ".";
  const problems: View["problems"] = [];
  const dir = factsDirOf(root);
  const factsRel = factsRelOf(root);

  // The repos: the manifests' in their order, then any the facts name that no manifest lists.
  const ids: string[] = [];
  try {
    for (const r of await loadRepos(root)) ids.push(r.id);
  } catch (e) {
    problems.push({ file: "org-pack/profiles", message: firstLine(e) });
  }
  // A repo is named by its facts file or the verifier's report; the questions, rejected, reviewed
  // and corrections files beside them are companions, never a repo of their own.
  const files = await readdir(dir).catch(() => [] as string[]);
  const named = new Set<string>();
  for (const f of files) {
    const of = factsFileOf(f);
    if (of && (of.facts || f.endsWith(".verify.yaml"))) named.add(of.repo);
  }
  for (const id of [...named].sort()) if (!ids.includes(id)) ids.push(id);

  // What the catalog holds of each repo: records from its facts, records from the readers.
  const catalog = await readCatalog(join(catalogDirOf(root), "generated"), { cacheRoot: root });
  for (const p of catalog.problems)
    problems.push({ file: rel(join(catalogDirOf(root), "generated", p.file)), message: p.message });
  const counts = catalogSources(catalog.records);

  // ADR 0135: the open questions, by repo, so the asked count opens them.
  const open = await listQuestions(root, { state: "open" }).then(
    (l) => l.questions,
    () => [],
  );

  const adopted = isAdopted(root);
  const repos: Repo[] = [];
  for (const repo of ids) {
    const factsPath = join(dir, `${repo}.jsonl`);
    // beta.23: each repo's facts parsed once and kept until the file changes (read-only here).
    const read = await keptParse(factsPath, "facts", (t) =>
      t.trim() ? parseFacts(t) : null,
    ).catch(() => undefined);
    const factsPresent = read !== undefined;
    const facts: Repo["facts"] = {
      path: rel(factsPath),
      present: factsPresent,
      count: 0,
      unverified: 0,
    };
    let frameworks: Repo["frameworks"];
    let terms: Repo["terms"];
    let kept: Fact[] = [];
    const lists: Lists = { rejected: [], excluded: [], asked: [], unverified: [] };
    if (read) {
      const parsed = read;
      if (parsed.ok) {
        kept = parsed.facts;
        facts.count = parsed.facts.length;
        const unchecked = parsed.facts.filter((f) => f.verified === "none");
        facts.unverified = unchecked.length;
        lists.unverified = unchecked.slice(0, UNKNOWN_SHOWN).map((f) => ({
          fact: f.id,
          kind: f.kind,
          file: f.cite.file,
          line: f.cite.line,
        }));
        const commit = parsed.facts[0]?.commit;
        if (commit) facts.commit = commit;
        // A-framework: what the repo is built on, and the frameworks whose patterns the facts
        // show none of. From the facts: no catalog record holds a framework.
        const gaps = new Map(frameworkGaps(parsed.facts).map((g) => [g.id, g.question] as const));
        const built = frameworkFacts(parsed.facts).map((f) => ({
          name: f.name,
          ...(f.version ? { version: f.version } : {}),
          ...(f.component ? { component: f.component } : {}),
          cite: `${f.cite.file}:${f.cite.line}`,
          ...(gaps.has(f.id) ? { gap: gaps.get(f.id)! } : {}),
        }));
        if (built.length) frameworks = built;
        // ADR 0163: the organisation's terms it writes, each with its role and lines.
        const t = parsed.facts.flatMap((f) =>
          f.kind === "term"
            ? [
                {
                  term: f.term,
                  value: f.value,
                  role: f.role,
                  cite: `${f.cite.file}:${f.cite.line}`,
                  ...(f.meaning ? { meaning: `${f.meaning.file}:${f.meaning.line}` } : {}),
                  ...(f.note !== undefined ? { note: f.note } : {}),
                },
              ]
            : [],
        );
        if (t.length) terms = t;
      } else
        problems.push({
          file: rel(factsPath),
          message: `doesn't read as facts: ${parsed.issues[0]?.message ?? "invalid"}`,
        });
    }

    const reportPath = join(dir, `${repo}.verify.yaml`);
    let report: Report | null = null;
    let excluded: string[] = [];
    const reportText = await text(reportPath);
    if (reportText !== undefined) {
      try {
        const doc = parse(reportText) as { coverage?: { excluded?: unknown } } | null;
        const r = reportOf(doc);
        if (typeof r === "string") problems.push({ file: rel(reportPath), message: r });
        else {
          report = r;
          const ex = doc?.coverage?.excluded;
          if (Array.isArray(ex)) excluded = ex.map(String).slice(0, UNKNOWN_SHOWN);
        }
      } catch (e) {
        problems.push({ file: rel(reportPath), message: `can't read YAML: ${firstLine(e)}` });
      }
    }
    if (!facts.commit && report?.commit) facts.commit = report.commit;
    lists.rejected = rejectedLines(await text(join(dir, `${repo}.rejected.jsonl`)));
    lists.excluded = excluded;
    lists.asked = open
      .filter((q) => q.repo === repo)
      .map((q) => ({ id: q.id, question: q.question, lines: q.evidence }));

    // ADR 0148 (P3): the sample audit's precision. A fact answer stands while the fact cites the
    // line the person saw; a link answer is counted as given (the join isn't run here).
    let audit: Repo["audit"];
    const auditPath = join(dir, `${repo}.audit.yaml`);
    const auditText = await text(auditPath);
    if (auditText !== undefined) {
      const a = parseAuditFile(auditText);
      if (!a.ok)
        problems.push({ file: rel(auditPath), message: `isn't an audit file: ${a.issues[0]}` });
      else {
        const byId = new Map(kept.map((f) => [f.id, f] as const));
        const p = auditPrecision(a.file.items, (i) => auditItemHolds(i, byId));
        audit = {
          path: rel(auditPath),
          facts: p.facts,
          byKind: p.byKind,
          links: p.links,
          // ADR 0181: the AI's decisions audited apart, when any were drawn.
          ...(p.ai.drawn ? { ai: p.ai } : {}),
        };
      }
    }

    let checkoutDir: string | undefined;
    try {
      checkoutDir = adopted ? root : baseClonePath(root, repo);
    } catch {
      checkoutDir = undefined;
    }
    const head = checkoutDir ? await headFromFiles(checkoutDir) : undefined;
    const present = checkoutDir
      ? await stat(join(checkoutDir, ".git")).then(
          () => true,
          () => false,
        )
      : false;
    const checkout: Repo["checkout"] = {
      path: checkoutDir ? rel(checkoutDir) : `workspace/${repo}`,
      present,
      ...(head ? { commit: head } : {}),
    };

    const c = counts.get(repo) ?? { facts: 0, readers: 0 };
    const from: Repo["catalog"]["from"] =
      c.facts && c.readers ? "both" : c.facts ? "facts" : c.readers ? "readers" : "none";
    const base = {
      repo,
      facts,
      verify: { path: rel(reportPath), report },
      checkout,
      sameCommit: sameCommit(report?.commit ?? facts.commit, head),
      catalog: { from, fromFacts: c.facts, fromReaders: c.readers },
    };
    const { state, next } = nextOf(repo, base);
    repos.push({
      ...base,
      state,
      ...(next ? { next } : {}),
      ...(frameworks ? { frameworks } : {}),
      ...(terms ? { terms } : {}),
      lists,
      ...(audit ? { audit } : {}),
    });
  }
  // ADR 0164: the contract check's counts, when some link had a payload on both sides.
  const contracts = await contractCheckOf(root).then(
    (c) => (c.result.counts.compared ? c.result.counts : undefined),
    () => undefined,
  );
  // Beta.24 review: the boxes an answer's words made, so a person can put each right.
  const { answerBoxesOf } = await import("./answer-boxes.js");
  const answerBoxes = await answerBoxesOf(root).catch(() => []);
  return {
    factsDir: factsRel,
    repos,
    problems,
    ...(contracts ? { contracts } : {}),
    ...(answerBoxes.length ? { answerBoxes } : {}),
  };
}

/**
 * The state of the checkouts trustView reads, which the server's watcher doesn't follow: a pull,
 * a commit or a checkout there changes it. Files only, never a folder's time: git makes and
 * removes files in .git as it reads (index.lock), so a folder's time moved on every load and
 * Home worked Map › Trust and each cockpit out again each time (beta.23, Windows: 1.3 s for a
 * reload with nothing changed). What is checked out is HEAD, the branch HEAD names, its reflog
 * (written on every commit, pull and checkout) and packed-refs; and the branches the cockpit reads,
 * committed to in worktrees of the clone: every `task/...` and `change/...` branch's ref, here and
 * as last fetched from each remote, and each worktree's HEAD and reflog (files listed, each one
 * stamped by name, size and time).
 */
export async function checkoutsStamp(root: string): Promise<string> {
  const dirs = isAdopted(root)
    ? [root]
    : (await loadRepos(root).catch(() => [])).flatMap((r) => {
        try {
          return [baseClonePath(root, r.id)];
        } catch {
          return [];
        }
      });
  const files = await Promise.all(
    dirs.map(async (d) => {
      const git = join(d, ".git");
      const head = await readFile(join(git, "HEAD"), "utf8").catch(() => "");
      const branch = /^ref: (refs\/\S+)/.exec(head)?.[1];
      const remotes = await readdir(join(git, "refs", "remotes")).catch(() => [] as string[]);
      const worktrees = await readdir(join(git, "worktrees")).catch(() => [] as string[]);
      const branches = await Promise.all(
        [
          join(git, "refs", "heads", "task"),
          join(git, "refs", "heads", "change"),
          ...remotes.flatMap((r) => [
            join(git, "refs", "remotes", r, "task"),
            join(git, "refs", "remotes", r, "change"),
          ]),
        ].map(refFiles),
      );
      return [
        join(git, "HEAD"),
        join(git, "packed-refs"),
        join(git, "logs", "HEAD"),
        ...(branch ? [join(git, ...branch.split("/"))] : []),
        ...branches.flat(),
        ...worktrees
          .sort()
          .flatMap((w) => [
            join(git, "worktrees", w, "HEAD"),
            join(git, "worktrees", w, "logs", "HEAD"),
          ]),
      ];
    }),
  );
  // HEAD's text too: a checkout of another branch can leave its size and time as they were.
  const heads = await Promise.all(
    dirs.map((d) => readFile(join(d, ".git", "HEAD"), "utf8").catch(() => "-")),
  );
  // The files' names too: a branch made or deleted changes the list, not only a file's time.
  const all = files.flat();
  const names = all.map((f) => relative(root, f)).join(",");
  return `${heads.join("|")}#${names}#${await stampOfFiles(all)}`;
}

/** Every ref file under a refs folder, sorted (ref names have slashes; lock files are left out). */
async function refFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, depth: number) => {
    if (depth > 8) return;
    const es = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of es) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.isFile() && !e.name.endsWith(".lock")) out.push(p);
    }
  };
  await walk(dir, 0);
  return out.sort();
}

export function uiTrustRoutes(r: Router, ctx: ServerContext): Router {
  return (
    r
      // beta.23: kept until a change is heard or a base clone's commit moves (watched-memo.ts).
      .add("GET", "/api/trust", async () => ({
        status: 200,
        body: await keptAnswer(
          ctx.root,
          "trust",
          () => trustView(ctx.root),
          () => checkoutsStamp(ctx.root),
        ),
      }))
      // Beta.24 review: put right a box an answer's words made: Ignore, or a real system's name.
      // Local writes in the metarepo, previewed first, for Propose for review.
      .add("POST", "/api/trust/answer-boxes/ignore", ({ body }) => answerBoxRoute(ctx, body, false))
      .add("POST", "/api/trust/answer-boxes/rename", ({ body }) => answerBoxRoute(ctx, body, true))
      // ADR 0196 (Z2): canaries and the silent error rate, from the files only.
      .add("GET", "/api/trust/canaries", async () => {
        const { canaryView } = await import("./canary-commands.js");
        const body: Api.CanaryViewT = await canaryView(ctx.root);
        return { status: 200, body };
      })
      // ADR 0141 (P5): the estate's freshness. It runs read-only local git in the clones
      // (`git diff --name-status` between two commits they have); nothing fetched or written.
      .add("GET", "/api/trust/fresh", async () => {
        const { estateFreshness } = await import("./estate-fresh.js");
        const v = await estateFreshness(ctx.root);
        // ADR 0167: the local API's states are the commit's (2.34.0); a repo read before the
        // reading rules there are now is fresh by its commit. `atticus estate fresh` says more.
        const body: Api.FreshViewT = {
          ...v,
          repos: v.repos.map(({ rulesLacking: _r, ...r }) => {
            if (r.state !== "rules-changed")
              return { ...r, state: r.state as Api.FreshViewT["repos"][number]["state"] };
            const { command: _c, slash: _s, ...x } = r;
            return { ...x, state: "fresh" as const };
          }),
        };
        return { status: 200, body };
      })
  );
}

/** POST /api/trust/answer-boxes/ignore and /rename (beta.24 review). */
async function answerBoxRoute(ctx: ServerContext, body: unknown, rename: boolean) {
  const b = Api.AnswerBoxRequest.safeParse(body ?? {});
  if (!b.success || (rename && !b.data.name))
    throw badRequest(
      rename
        ? "Say which box and its real name: { id, name, preview }."
        : "Say which box: { id, preview }.",
    );
  const { AnswerBoxError, ignoreAnswerBox, renameAnswerBox } = await import("./answer-boxes.js");
  const o = {
    by: ctx.user,
    at: new Date().toISOString(),
    ...(b.data.preview ? { preview: true } : {}),
    ...(b.data.stamp ? { stamp: b.data.stamp } : {}),
  };
  try {
    const r = rename
      ? await renameAnswerBox(ctx.root, b.data.id, b.data.name!, o)
      : await ignoreAnswerBox(ctx.root, b.data.id, o);
    if (r.written) {
      for (const a of r.answers)
        ctx.events.publish({ type: "file.changed", path: `questions/${a.id}.yaml` });
      if (r.profile) ctx.events.publish({ type: "file.changed", path: r.profile.path });
    }
    return { status: 200, body: r };
  } catch (e) {
    if (e instanceof AnswerBoxError) {
      if (e.code === "not-found") throw notFound(e.message);
      // Beta.25: changed since it was read or previewed: nothing written.
      if (e.code === "changed") throw conflict(e.message);
      if (e.code === "partial") {
        for (const f of e.written) ctx.events.publish({ type: "file.changed", path: f });
        throw new HttpError(500, "Atticus wrote only part of it", e.message, {
          written: e.written.map((file) => ({ file })),
        });
      }
      throw badRequest(e.message);
    }
    if (e instanceof FileChangedError) throw conflict(e.message);
    if (e instanceof QuestionError) throw new HttpError(422, "Atticus can't do that", e.message);
    // Beta.25: a profile edit Atticus doesn't make (a system holding an anchor others use).
    if (e instanceof ProfileEditError) throw new HttpError(422, "Atticus can't do that", e.message);
    if (e instanceof Error && / would not be valid: /.test(e.message))
      throw new HttpError(422, "Atticus can't do that", e.message.split("\n")[0]!);
    throw e;
  }
}
