import { appendLines } from "./file-lock.js";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { filesIn, memoByFiles } from "./file-memo.js";
import { join } from "node:path";
import {
  Api,
  correctionLine,
  FACT_FIXED_FIELDS,
  FactCorrection,
  factsDirOf,
  questionsDirOf,
  factsRelOf,
  listQuestions,
  parseAuditFile,
  parseCorrections,
  parseFactsLines,
  sampleConfirmed,
  withSharedFileLock,
  writeFileAtomic,
  type Fact,
  FactId,
  LockHeldError,
} from "@maycombhq/core";
import {
  applyCorrections,
  correctedFact,
  correctionFor,
  outsidePairingFor,
  repairFormSlips,
} from "@maycombhq/verify";
import {
  badRequest,
  HttpError,
  notFound,
  type Router,
  type ServerContext,
} from "@maycombhq/server";
import { loadRepos } from "@maycombhq/workspace";
import { readCorrections } from "./facts-files.js";

/**
 * The Map with its evidence (ADR 0124 addendum D-app, F3, C4 2.23.0). GET /api/facts/{repo}
 * gives a repo's facts as the Map cites them: each fact's line and quote, who made and checked
 * it, the fields a person may correct and a correction on file, and the open questions about the
 * repo. POST /api/facts/{repo}/corrections writes a person's correction to
 * `facts/<repo>.corrections.jsonl`, which `atticus verify` applies every time it runs; the app
 * runs no git and no verify, so the answer carries both commands.
 */

type View = Api.RepoFactsViewT;
type CiteView = Api.FactCiteViewT;

const REPO = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
const fixed = new Set<string>(FACT_FIXED_FIELDS);

/** The claim in a few words, as the Map shows it. */
export function factLabel(f: Fact): string {
  switch (f.kind) {
    case "entry":
      return `${f.method ? `${f.method} ` : ""}${f.path}`;
    case "call":
      return `${f.method ? `${f.method} ` : ""}${f.path}${f.to ? ` → ${f.to}` : ""}`;
    case "store":
      return `${f.name} (${f.op})`;
    case "field":
      return `${f.name}${f.type ? `: ${f.type}` : ""}`;
    case "deploy":
      return `${f.platform}${f.resourceName ? ` ${f.resourceName}` : ""}`;
    case "config":
      return `${f.key}${f.value !== undefined ? ` = ${f.value}` : ""}`;
    // ADR 0124 addendum A-framework: what the repo or the module is built on.
    case "framework":
      return `${f.name}${f.version ? ` ${f.version}` : ""}`;
    case "flow":
      return f.name;
    // ADR 0163: a term of the organisation's, with the role a note gave it.
    case "term":
      return `${f.term} ${f.value} (${f.role})`;
    // ADR 0180: what a component is.
    case "component":
      return `${f.component ?? f.repo} is a ${f.type}`;
    // ADR 0192: what a component's build publishes, and what it builds on.
    case "artifact":
      return `publishes ${f.group}:${f.name}${f.version ? `:${f.version}` : ""}`;
    case "dependency":
      return `builds on ${f.group}:${f.name}${f.version ? `:${f.version}` : ""}${f.scope && f.scope !== "compile" ? ` (${f.scope})` : ""}`;
  }
}

/** The fields a person may correct: the fact's own words, and the value its line is checked for. */
export function claimOf(f: Fact): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(f)) if (!fixed.has(k) && typeof v === "string") out[k] = v;
  out.value = f.cite.value;
  return out;
}

const spot = (c: Fact["cite"]) => ({
  file: c.file,
  line: c.line,
  value: c.value,
  ...(c.quote ? { quote: c.quote } : {}),
});

async function readFacts(root: string, repo: string) {
  const file = `${factsRelOf(root)}/${repo}.jsonl`;
  const text = await readFile(join(factsDirOf(root), `${repo}.jsonl`), "utf8").catch(
    () => undefined,
  );
  if (text === undefined) return { file, present: false, facts: [] as Fact[], bad: [] };
  // R6: the reader's slips of form are fixed as `atticus verify` fixes them, each said as a note
  // (the app writes no facts: the next verify writes the fix into the file).
  const read = parseFactsLines(text);
  const p = repairFormSlips(read.facts, read.bad);
  return {
    file,
    present: true,
    facts: p.facts,
    bad: [
      ...p.slips.map((x) => ({
        file,
        message: `slip of form fixed as read (a note; atticus verify ${repo} writes the fix into the facts file): ${x.message}`,
      })),
      ...p.bad.map((b) => ({
        file,
        message: `line ${b.line} isn't a fact: ${b.issues.map((i) => i.message).join("; ")}`,
      })),
    ],
  };
}

/** beta.21: a repo's facts view, worked out again only when one of the files it reads changes. */
export async function repoFactsView(root: string, repo: string): Promise<View> {
  const dir = factsDirOf(root);
  return memoByFiles(
    `facts-view\u0000${root}\u0000${repo}`,
    [
      ...[`${repo}.jsonl`, `${repo}.corrections.jsonl`, `${repo}.audit.yaml`].map((f) =>
        join(dir, f),
      ),
      // Its open questions are part of the view.
      ...(await filesIn(questionsDirOf(root))),
    ],
    () => repoFactsViewNow(root, repo),
  );
}

async function repoFactsViewNow(root: string, repo: string): Promise<View> {
  const f = await readFacts(root, repo);
  const cFile = `${factsRelOf(root)}/${repo}.corrections.jsonl`;
  const c = await readCorrections(root, repo);
  const problems = [
    ...f.bad,
    ...c.bad.map((b) => ({
      file: cFile,
      message: `line ${b.line} isn't a correction: ${b.message}`,
    })),
  ];
  // P3 (ADR 0148): a fact a person answered right in a sample audit, still citing the line they
  // saw, is shown as checked by the sample; the facts file keeps the verifier's `line`.
  const auditText = await readFile(join(factsDirOf(root), `${repo}.audit.yaml`), "utf8").catch(
    () => undefined,
  );
  const audit = auditText === undefined ? undefined : parseAuditFile(auditText);
  const sampled = sampleConfirmed(audit?.ok ? audit.file : undefined, f.facts);
  if (audit && !audit.ok)
    problems.push({
      file: `${factsRelOf(root)}/${repo}.audit.yaml`,
      message: `isn't an audit file: ${audit.issues[0] ?? "invalid"}`,
    });
  const facts: CiteView[] = f.facts.map((x) => {
    // A pairing with an outside system is the call's correction too (G1, ADR 0174).
    const corr = correctionFor(x, c.corrections) ?? outsidePairingFor(x, c.corrections);
    return {
      id: x.id,
      kind: x.kind,
      label: factLabel(x),
      claim: claimOf(x),
      cite: spot(x.cite),
      ...(x.kind === "flow"
        ? {
            steps: [
              ...x.steps.map((s) => ({ ...spot(s.cite), what: s.what })),
              ...x.errors.map((e) => ({ ...spot(e.cite), what: `${e.when} → ${e.then}` })),
            ],
          }
        : {}),
      verified: x.verified === "line" && sampled.has(x.id) ? "sample" : x.verified,
      by: x.by,
      ...(corr ? { correction: corr } : {}),
    };
  });
  const staleAll = applyCorrections(f.facts, c.corrections).stale;
  const stale = staleAll.filter((s) => s.why === "none").map((s) => s.correction.fact);
  // A correction or pairing verify can't apply says why here, or it would wait for good.
  for (const s of staleAll)
    if (s.why === "invalid") problems.push({ file: cFile, message: s.message });
  const questions = await listQuestions(root, { repo, state: "open" }).then(
    (l) => l.questions.map((q) => ({ id: q.id, question: q.question, evidence: q.evidence })),
    () => [],
  );
  return {
    repo,
    file: f.file,
    present: f.present,
    ...(f.facts[0] ? { commit: f.facts[0].commit } : {}),
    facts,
    corrections: { file: cFile, count: c.corrections.length, stale: [...new Set(stale)].sort() },
    questions,
    verify: `atticus verify ${repo}`,
    problems,
  };
}

/**
 * The most repos one GET /api/facts gives (3.12.0). Beta.27 re-review: 100 (was 500): 500 long
 * names passed the 16 KB a request's head may have, and the call failed whole (431).
 */
export const FACTS_BATCH_MAX = 100;

const repoOf = (v: string) => {
  if (!REPO.test(v)) throw badRequest(`${JSON.stringify(v)} isn't a repo name.`);
  return v;
};

/**
 * A person's correction of one fact, as its corrections line records it, checked: a fact the file
 * has, only the fields that change, a fact the edit still makes. Throws the HTTP problem otherwise.
 */
function correctionOfRequest(
  f: { file: string; facts: readonly Fact[] },
  req: Api.FactCorrectionRequestT,
  user: string,
  at: Date,
): { c: FactCorrection; fact: Fact } {
  const fact = f.facts.find((x) => x.id === req.fact);
  if (!fact) throw notFound(`${f.file} has no fact ${req.fact}.`);
  // A field that is unchanged is no correction: only what the person changed is kept.
  const was = claimOf(fact);
  const set = Object.fromEntries(
    Object.entries(req.set ?? {})
      .map(([k, v]) => [k, v.trim()] as const)
      .filter(([k, v]) => was[k] !== v),
  );
  const line = req.line !== undefined && req.line !== fact.cite.line ? req.line : undefined;
  const c = FactCorrection.safeParse({
    schemaVersion: 1,
    fact: fact.id,
    target: {
      kind: fact.kind,
      file: fact.cite.file,
      line: fact.cite.line,
      value: fact.cite.value,
    },
    action: req.action,
    ...(req.action === "edit" && Object.keys(set).length ? { set } : {}),
    ...(req.action === "edit" && line !== undefined ? { line } : {}),
    ...(req.reason ? { reason: req.reason } : {}),
    by: user,
    at: at.toISOString(),
  });
  if (!c.success)
    throw new HttpError(
      422,
      "Atticus can't record that",
      c.error.issues.map((i) => i.message).join("; "),
    );
  if (c.data.action === "edit") {
    const fixedFact = correctedFact(fact, c.data);
    if (typeof fixedFact === "string")
      throw new HttpError(
        422,
        "That isn't a fact",
        `The corrected ${fact.kind} isn't one: ${fixedFact}.`,
      );
  }
  return { c: c.data, fact };
}

/** What a correction says: its action, what it sets, its line and why (not who, nor when). */
const saysOf = (c: FactCorrection) =>
  JSON.stringify([
    c.action,
    Object.entries(c.set ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    c.line ?? null,
    c.reason ?? null,
  ]);

/** The largest body POST /api/links/corrections reads: 5000 items with their why and edits. */
const LINK_CORRECTIONS_MAX_BODY = 16 * 1024 * 1024;

/** Hold every file's shared lock, in the order given, for the whole of `work`. */
const holdingAll = <T>(
  files: readonly string[],
  work: () => Promise<T>,
  o: { waitMs?: number } = {},
): Promise<T> =>
  files.length
    ? withSharedFileLock(files[0]!, () => holdingAll(files.slice(1), work, o), o)
    : work();

/**
 * Review of beta.24: a repo as the estate spells it, from the repos' manifests and the facts
 * files: a name in another case (`Forge-Ledger`) is the one repo it names on a file system that
 * ignores case, so it is spelt the one way, and a batch makes one plan of it. A name nothing
 * spells is refused. Round 3: one table by the name in lower case; a facts folder's other files
 * (`.corrections`, `.rejected`, `.reviewed`, `.questions`) spell no repo; and a name two facts
 * files spell but for case (a file system that tells them apart) is refused, as it is no one repo
 * where case is ignored. Round 4: the facts file's spelling first, as the file that is there (a
 * manifest's `forge-ledger` with only `Forge-Ledger.jsonl` on a file system that minds case);
 * the manifests' when no facts file spells it.
 */
async function repoSpellings(root: string): Promise<(name: string) => string> {
  const byLower = new Map<string, Set<string>>();
  const add = (n: string) => {
    const k = n.toLowerCase();
    byLower.set(k, (byLower.get(k) ?? new Set()).add(n));
  };
  const manifests = new Map<string, string>();
  for (const r of await loadRepos(root).catch(() => [])) manifests.set(r.id.toLowerCase(), r.id);
  for (const n of await readdir(factsDirOf(root)).catch(() => [] as string[]))
    if (n.endsWith(".jsonl") && !/\.(corrections|rejected|reviewed|questions)\.jsonl$/.test(n))
      add(n.slice(0, -6));
  return (name) => {
    const k = name.toLowerCase();
    const same = [...(byLower.get(k) ?? [])].sort();
    const manifest = manifests.get(k);
    if (!same.length && manifest) return manifest;
    if (!same.length) throw notFound(`No repo of the estate is named ${name}.`);
    if (same.length > 1)
      throw new HttpError(
        422,
        "Atticus can't tell which repo that is",
        `The facts files spell ${same.join(", ")}, which differ only by case: one repo where case is ignored. Rename one (and its facts files) so each repo is spelt one way.`,
        { written: [] },
      );
    return same[0]!;
  };
}

export function uiFactsRoutes(
  r: Router,
  ctx: ServerContext,
  deps: {
    now?: () => Date;
    /** How a whole corrections file is written (a test makes one fail). */
    write?: (file: string, data: string) => Promise<void>;
    /** How long a batch waits for a corrections file another process holds (a test's is short). */
    lockWaitMs?: number;
  } = {},
): Router {
  const now = deps.now ?? (() => new Date());
  const write = deps.write ?? writeFileAtomic;
  return (
    r
      // 3.12.0 (beta.27 review): several repos' facts in one call; the Map asked once per repo
      // (65 calls on a large estate). Each repo as GET /api/facts/{repo} gives it, or its problem.
      .add("GET", "/api/facts", async ({ query }) => {
        const names = [
          ...new Set(
            query
              .getAll("repo")
              .flatMap((v) => v.split(","))
              .map((v) => v.trim())
              .filter(Boolean),
          ),
        ];
        if (!names.length) throw badRequest("Name the repos: /api/facts?repo=<id>&repo=<id>.");
        if (names.length > FACTS_BATCH_MAX)
          throw badRequest(`At most ${FACTS_BATCH_MAX} repos a call (${names.length} asked).`);
        // Null-prototype (beta.27 re-review): a repo named `__proto__` is a key like any other.
        const facts: Record<string, Awaited<ReturnType<typeof repoFactsView>>> = Object.create(
          null,
        );
        const problems: Record<string, { status: number; title: string; detail?: string }> =
          Object.create(null);
        for (const name of names) {
          try {
            facts[name] = await repoFactsView(ctx.root, repoOf(name));
          } catch (e) {
            if (!(e instanceof HttpError)) throw e;
            problems[name] = {
              status: e.status,
              title: e.title,
              ...(e.detail ? { detail: e.detail } : {}),
            };
          }
        }
        return { status: 200, body: { facts, problems } };
      })
      .add("GET", "/api/facts/{repo}", async ({ params }) => ({
        status: 200,
        body: await repoFactsView(ctx.root, repoOf(params.repo!)),
      }))
      // C4 (ADR 0149): the commands after a correction, and what the next verify --write changes,
      // worked out in-process by that command's own functions; nothing is written, no git runs.
      .add("GET", "/api/facts/{repo}/preview", async ({ params, query }) => {
        const repo = repoOf(params.repo!);
        const fact = query.get("fact") || undefined;
        if (fact && !FactId.safeParse(fact).success)
          throw badRequest(`${JSON.stringify(fact)} isn't a fact id.`);
        const { verifyWritePreview } = await import("./verify-preview.js");
        const v = await verifyWritePreview(ctx.root, repo, fact ? { fact } : {});
        if (!v)
          throw notFound(
            `There are no facts for ${repo} at ${factsRelOf(ctx.root)}/${repo}.jsonl.`,
          );
        return { status: 200, body: v };
      })
      .add("POST", "/api/facts/{repo}/corrections", async ({ params, body }) => {
        // Round 3: the repo as the estate spells it, as the batch takes it.
        const repo = (await repoSpellings(ctx.root))(repoOf(params.repo!));
        const b = Api.FactCorrectionRequest.safeParse(body ?? {});
        if (!b.success)
          throw badRequest(
            "Say which fact and what is wrong: { fact, action, set, line, reason }.",
            {
              errors: b.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
            },
          );
        const f = await readFacts(ctx.root, repo);
        if (!f.present) throw notFound(`There are no facts for ${repo} at ${f.file}.`);
        const { c, fact } = correctionOfRequest(f, b.data, ctx.user, now());
        const rel = `${factsRelOf(ctx.root)}/${repo}.corrections.jsonl`;
        const written = correctionLine(c);
        await mkdir(factsDirOf(ctx.root), { recursive: true });
        const cfile = join(factsDirOf(ctx.root), `${repo}.corrections.jsonl`);
        // Round 3: a file another process holds past the wait is a conflict that wrote nothing.
        await appendLines(cfile, [written], { waitMs: deps.lockWaitMs ?? 15_000 }).catch(
          (e: unknown) => {
            if (!(e instanceof LockHeldError)) throw e;
            throw new HttpError(
              409,
              "Another write holds a corrections file",
              `${e.message} Nothing was written; try again once it is done.`,
              { written: [] },
            );
          },
        );
        ctx.events.publish({ type: "file.changed", path: rel });
        const result: Api.FactCorrectionResultT = {
          correction: c,
          file: rel,
          commit: `git add ${rel}\ngit commit -m "${repo}: a person's correction of ${fact.id}"`,
          verify: `atticus verify ${repo}`,
          line: written,
        };
        return { status: 200, body: result };
      })
      // This whole arrow is wrong (beta.24): one correction of every call on a link. Every item is
      // checked first, so a call that can't be recorded writes none. Review of beta.24: all or
      // none, and never twice. Every involved file's shared lock is held for the whole batch (in
      // one order, so two batches can't wait on each other), and one held past the wait is a 409
      // that wrote nothing; an item whose correction the fact meets now (by its id and cite, as
      // verify meets it) says the same already is skipped; each file is written whole and
      // renamed into place; a failure puts back every file written, or, when one can't be, says
      // which were (`written`). Up to 5000 items (LINK_CORRECTIONS_MAX), in a body of 16 MB.
      .add(
        "POST",
        "/api/links/corrections",
        async ({ body }) => {
          const b = Api.LinkCorrectionsRequest.safeParse(body ?? {});
          if (!b.success)
            throw badRequest(
              "Say which calls and what is wrong: { items: [{ repo, fact, action, set }], reason }.",
              {
                errors: b.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
              },
            );
          const at = now();
          const byRepo = new Map<string, { c: FactCorrection; fact: Fact }[]>();
          const read = new Map<string, Awaited<ReturnType<typeof readFacts>>>();
          const spelt = await repoSpellings(ctx.root);
          for (const item of b.data.items) {
            const repo = spelt(repoOf(item.repo));
            let f = read.get(repo);
            if (!f) {
              f = await readFacts(ctx.root, repo);
              read.set(repo, f);
            }
            if (!f.present) throw notFound(`There are no facts for ${repo} at ${f.file}.`);
            const reason = item.reason ?? b.data.reason;
            const corrected = correctionOfRequest(
              f,
              {
                fact: item.fact,
                action: item.action,
                ...(item.set ? { set: item.set } : {}),
                ...(reason ? { reason } : {}),
              },
              ctx.user,
              at,
            );
            byRepo.set(repo, [...(byRepo.get(repo) ?? []), corrected]);
          }
          await mkdir(factsDirOf(ctx.root), { recursive: true });
          const repos = [...byRepo.keys()].sort((a, b2) => (a < b2 ? -1 : a > b2 ? 1 : 0));
          const fileOf = (repo: string) => join(factsDirOf(ctx.root), `${repo}.corrections.jsonl`);
          const relOf = (repo: string) => `${factsRelOf(ctx.root)}/${repo}.corrections.jsonl`;
          const files: Api.LinkCorrectionsResultT["files"] = [];
          const skipped: { repo: string; fact: string }[] = [];
          type Planned = {
            repo: string;
            before: string | undefined;
            after: string;
            cs: FactCorrection[];
          };
          const held = holdingAll(
            repos.map(fileOf),
            async () => {
              // Read under the locks: what each file holds now (a line written meanwhile counts).
              const plan: Planned[] = [];
              for (const repo of repos) {
                const before = await readFile(fileOf(repo), "utf8").catch((e: unknown) => {
                  if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
                  throw new HttpError(
                    500,
                    "Atticus wrote none of it",
                    `${relOf(repo)} couldn't be read (${e instanceof Error ? e.message : String(e)}): nothing was written to any repo.`,
                    { written: [] },
                  );
                });
                // Review of beta.24: an item is skipped only when the correction the fact meets now
                // (by its id and cite, as verify meets it) says the same. One on file for a line the
                // fact has left (the code moved) meets nothing: the new one is written, and wins.
                const onFile = parseCorrections(before ?? "").corrections;
                const cs: FactCorrection[] = [];
                for (const { c, fact } of byRepo.get(repo)!) {
                  const meets = correctionFor(fact, onFile);
                  if (meets && saysOf(meets) === saysOf(c)) {
                    if (!skipped.some((x) => x.repo === repo && x.fact === c.fact))
                      skipped.push({ repo, fact: c.fact });
                    continue;
                  }
                  onFile.push(c);
                  cs.push(c);
                }
                if (!cs.length) continue;
                // In the file's own line endings, on a line of its own (as appendLines writes).
                const was = before ?? "";
                const eol = /\r\n/.test(was) ? "\r\n" : "\n";
                const lead = was && !was.endsWith("\n") ? eol : "";
                const lines = cs.map(correctionLine);
                plan.push({
                  repo,
                  before,
                  after: was + lead + lines.map((l) => `${l}${eol}`).join(""),
                  cs,
                });
              }
              const done: Planned[] = [];
              for (const x of plan) {
                try {
                  await write(fileOf(x.repo), x.after);
                  done.push(x);
                } catch (e) {
                  const why = e instanceof Error ? e.message : String(e);
                  // Put back what was written: the file as it was, or none where there was none.
                  const kept: Planned[] = [];
                  for (const y of [...done].reverse())
                    await (
                      y.before === undefined
                        ? rm(fileOf(y.repo), { force: true })
                        : write(fileOf(y.repo), y.before)
                    ).catch(() => kept.push(y));
                  const written = kept
                    .sort((a, b2) => (a.repo < b2.repo ? -1 : 1))
                    .map((y) => ({ repo: y.repo, file: relOf(y.repo) }));
                  for (const w of written)
                    ctx.events.publish({ type: "file.changed", path: w.file });
                  throw new HttpError(
                    500,
                    written.length ? "Atticus wrote only part of it" : "Atticus wrote none of it",
                    written.length
                      ? `${relOf(x.repo)} couldn't be written (${why}), and ${written.map((w) => w.file).join(", ")} couldn't be put back as it was: the corrections for ${written.map((w) => w.repo).join(", ")} are on file, the others are not. Asked again, the ones on file are skipped.`
                      : `${relOf(x.repo)} couldn't be written (${why}): nothing was written to any repo.`,
                    { written },
                  );
                }
              }
              for (const x of done)
                files.push({
                  repo: x.repo,
                  file: relOf(x.repo),
                  lines: x.cs.map(correctionLine),
                  corrections: x.cs,
                });
            },
            { waitMs: deps.lockWaitMs ?? 15_000 },
          );
          // Review of beta.24: a file another process (the CLI, an assistant) holds past the wait
          // is a conflict, and nothing was written: every lock is taken before any write.
          await held.catch((e: unknown) => {
            if (!(e instanceof LockHeldError)) throw e;
            throw new HttpError(
              409,
              "Another write holds a corrections file",
              `${e.message} Nothing was written to any repo; try again once it is done.`,
              { written: [] },
            );
          });
          for (const f of files) ctx.events.publish({ type: "file.changed", path: f.file });
          const n = files.reduce((k, f) => k + f.corrections.length, 0);
          const result: Api.LinkCorrectionsResultT = {
            files,
            // Nothing new written (every one on file already): nothing to commit.
            commit: files.length
              ? `git add ${files.map((f) => f.file).join(" ")}\ngit commit -m "A person's correction of ${n} call${n === 1 ? "" : "s"} on one link"`
              : "",
            verify: files.map((f) => `atticus verify ${f.repo}`),
            ...(skipped.length ? { skipped } : {}),
          };
          return { status: 200, body: result };
        },
        // Review of beta.24: up to 5000 calls in one request (every call edge-calls gives), each
        // with its why: more than the server's usual 4 MB.
        { maxBody: LINK_CORRECTIONS_MAX_BODY },
      )
  );
}
