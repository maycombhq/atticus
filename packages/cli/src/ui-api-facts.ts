import { appendLines } from "./file-lock.js";
import { mkdir, readFile, rm } from "node:fs/promises";
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

/** Hold every file's shared lock, in the order given, for the whole of `work`. */
const holdingAll = <T>(files: readonly string[], work: () => Promise<T>): Promise<T> =>
  files.length ? withSharedFileLock(files[0]!, () => holdingAll(files.slice(1), work)) : work();

export function uiFactsRoutes(
  r: Router,
  ctx: ServerContext,
  deps: {
    now?: () => Date;
    /** How a whole corrections file is written (a test makes one fail). */
    write?: (file: string, data: string) => Promise<void>;
  } = {},
): Router {
  const now = deps.now ?? (() => new Date());
  const write = deps.write ?? writeFileAtomic;
  return (
    r
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
        const repo = repoOf(params.repo!);
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
        await appendLines(cfile, [written]);
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
      // one order, so two batches can't wait on each other); an item whose newest correction on
      // file says the same already is skipped; each file is written whole and renamed into
      // place; a failure puts back every file written, or, when one can't be, says which were.
      .add("POST", "/api/links/corrections", async ({ body }) => {
        const b = Api.LinkCorrectionsRequest.safeParse(body ?? {});
        if (!b.success)
          throw badRequest(
            "Say which calls and what is wrong: { items: [{ repo, fact, action, set }], reason }.",
            {
              errors: b.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
            },
          );
        const at = now();
        const byRepo = new Map<string, FactCorrection[]>();
        const read = new Map<string, Awaited<ReturnType<typeof readFacts>>>();
        for (const item of b.data.items) {
          const repo = repoOf(item.repo);
          let f = read.get(repo);
          if (!f) {
            f = await readFacts(ctx.root, repo);
            read.set(repo, f);
          }
          if (!f.present) throw notFound(`There are no facts for ${repo} at ${f.file}.`);
          const reason = item.reason ?? b.data.reason;
          const { c } = correctionOfRequest(
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
          byRepo.set(repo, [...(byRepo.get(repo) ?? []), c]);
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
        await holdingAll(repos.map(fileOf), async () => {
          // Read under the locks: what each file holds now, and what its newest line says of
          // each fact (a line written meanwhile counts).
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
            const newest = new Map<string, string>();
            for (const c of parseCorrections(before ?? "").corrections)
              newest.set(c.fact, saysOf(c));
            const cs: FactCorrection[] = [];
            for (const c of byRepo.get(repo)!) {
              if (newest.get(c.fact) === saysOf(c)) {
                if (!skipped.some((x) => x.repo === repo && x.fact === c.fact))
                  skipped.push({ repo, fact: c.fact });
                continue;
              }
              newest.set(c.fact, saysOf(c));
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
              for (const w of written) ctx.events.publish({ type: "file.changed", path: w.file });
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
      })
  );
}
