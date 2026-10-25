import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  Api,
  correctionLine,
  FACT_FIXED_FIELDS,
  FactCorrection,
  factsDirOf,
  factsRelOf,
  listQuestions,
  parseFactsLines,
  type Fact,
} from "@maycombhq/core";
import { applyCorrections, correctedFact, correctionFor } from "@maycombhq/verify";
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
    case "flow":
      return f.name;
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
  const p = parseFactsLines(text);
  return {
    file,
    present: true,
    facts: p.facts,
    bad: p.bad.map((b) => ({
      file,
      message: `line ${b.line} isn't a fact: ${b.issues.map((i) => i.message).join("; ")}`,
    })),
  };
}

export async function repoFactsView(root: string, repo: string): Promise<View> {
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
  const facts: CiteView[] = f.facts.map((x) => {
    const corr = correctionFor(x, c.corrections);
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
      verified: x.verified,
      by: x.by,
      ...(corr ? { correction: corr } : {}),
    };
  });
  const stale = applyCorrections(f.facts, c.corrections)
    .stale.filter((s) => s.why === "none")
    .map((s) => s.correction.fact);
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

export function uiFactsRoutes(
  r: Router,
  ctx: ServerContext,
  deps: { now?: () => Date } = {},
): Router {
  const now = deps.now ?? (() => new Date());
  return r
    .add("GET", "/api/facts/{repo}", async ({ params }) => ({
      status: 200,
      body: await repoFactsView(ctx.root, repoOf(params.repo!)),
    }))
    .add("POST", "/api/facts/{repo}/corrections", async ({ params, body }) => {
      const repo = repoOf(params.repo!);
      const b = Api.FactCorrectionRequest.safeParse(body ?? {});
      if (!b.success)
        throw badRequest("Say which fact and what is wrong: { fact, action, set, line, reason }.", {
          errors: b.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        });
      const f = await readFacts(ctx.root, repo);
      if (!f.present) throw notFound(`There are no facts for ${repo} at ${f.file}.`);
      const fact = f.facts.find((x) => x.id === b.data.fact);
      if (!fact) throw notFound(`${f.file} has no fact ${b.data.fact}.`);
      // A field that is unchanged is no correction: only what the person changed is kept.
      const was = claimOf(fact);
      const set = Object.fromEntries(
        Object.entries(b.data.set ?? {})
          .map(([k, v]) => [k, v.trim()] as const)
          .filter(([k, v]) => was[k] !== v),
      );
      const line =
        b.data.line !== undefined && b.data.line !== fact.cite.line ? b.data.line : undefined;
      const c = FactCorrection.safeParse({
        schemaVersion: 1,
        fact: fact.id,
        target: {
          kind: fact.kind,
          file: fact.cite.file,
          line: fact.cite.line,
          value: fact.cite.value,
        },
        action: b.data.action,
        ...(b.data.action === "edit" && Object.keys(set).length ? { set } : {}),
        ...(b.data.action === "edit" && line !== undefined ? { line } : {}),
        ...(b.data.reason ? { reason: b.data.reason } : {}),
        by: ctx.user,
        at: now().toISOString(),
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
      const rel = `${factsRelOf(ctx.root)}/${repo}.corrections.jsonl`;
      await mkdir(factsDirOf(ctx.root), { recursive: true });
      await appendFile(
        join(factsDirOf(ctx.root), `${repo}.corrections.jsonl`),
        `${correctionLine(c.data)}\n`,
        "utf8",
      );
      ctx.events.publish({ type: "file.changed", path: rel });
      const result: Api.FactCorrectionResultT = {
        correction: c.data,
        file: rel,
        commit: `git add ${rel} && git commit -m "${repo}: a person's correction of ${fact.id}"`,
        verify: `atticus verify ${repo}`,
      };
      return { status: 200, body: result };
    });
}
