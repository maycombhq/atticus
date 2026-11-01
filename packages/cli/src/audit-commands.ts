import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parse } from "yaml";
import {
  AUDIT_ANSWERS,
  AUDIT_DEFAULT_SIZE,
  auditCandidates,
  auditItemHolds,
  auditPrecision,
  drawAudit,
  factsDirOf,
  factsRelOf,
  loadOrgPack,
  mergeDraw,
  orgPackDirOf,
  parseAuditFile,
  parseFacts,
  serializeAuditFile,
  sumAuditPrecision,
  type AuditAnswer,
  type AuditFileT,
  type AuditItemT,
  type AuditPrecision,
  type AuditTally,
  type Fact,
} from "@maycombhq/core";
import type { Output } from "./commands.js";
import { checkoutOf } from "./facts-files.js";
import { factsRepos } from "./verify-commands.js";

/**
 * atticus verify audit <repo> (plan item P3, ADR 0148): a person confirms a handful of the repo's
 * kept facts and of the links the estate join makes from it, drawn at random but reproducibly
 * (`--size n` of each, `--seed s`), each shown with its cited lines. The answers (right, wrong,
 * unsure) go to `<repo>.audit.yaml` beside the facts: a person's record, committed in a pull
 * request, never sent anywhere. `--report` gives precision per kind and for links, with the
 * sample size and a 95% interval; with no repo, every repo audited and the estate's.
 *
 * Interactive on a terminal; otherwise (an agent, a test) the answers come from `--answers
 * <file>` or `--right`, `--wrong` and `--unsure` lists of item ids, and a run with none prints the
 * sample and how to answer it. It reads files only and writes nothing but the audit file.
 */

export interface AuditOptions {
  size?: number;
  seed?: string;
  /** The repo's checkout, when not its base clone. */
  dir?: string;
  /** A YAML or JSON file mapping item ids to answers (`fact:x: right`, or `{answer, note}`). */
  answers?: string;
  right?: string[];
  wrong?: string[];
  unsure?: string[];
  report?: boolean;
  json?: boolean;
  by: string;
  /** Asks a person one question and gives back what they typed; none when not on a terminal. */
  ask?: (question: string) => Promise<string | undefined>;
  now?: () => Date;
}

export const AUDIT_WORDS = {
  usage:
    "Usage: atticus verify audit <repo> [--size n] [--seed s] [--answers file | --right ids --wrong ids --unsure ids] [--json], atticus verify audit <repo> --report, or atticus verify audit --report for the estate",
  noFacts: (repo: string, rel: string) =>
    `${repo} has no facts to audit (${rel}/${repo}.jsonl). Read it first: /atticus-map ${repo}, then atticus verify ${repo}.`,
  badFacts: (rel: string) => `${rel} doesn't read as facts; run atticus verify on it first.`,
  unverified: (repo: string, n: number) =>
    `${n} of ${repo}'s facts aren't verified yet, and an audit samples kept facts only. Run atticus verify ${repo} first.`,
  badFile: (rel: string) => `${rel} isn't an audit file Atticus can read:`,
  badAnswers: (file: string) => `${file} isn't a list of answers Atticus can read:`,
  unknownIds: (ids: string[]) =>
    `Not in this sample: ${ids.join(", ")}. Answer the ids the sample lists (atticus verify audit <repo> --json shows them).`,
  drew: (repo: string, facts: number, links: number, seed: string, size: number) =>
    `Sample audit of ${repo}: ${plural(facts, "fact")} and ${plural(links, "link")} drawn (seed ${seed}, size ${size}; the same seed draws the same sample).`,
  nothing: (repo: string) =>
    `${repo} has no kept facts a reader wrote and no links to sample, so there is nothing to audit.`,
  question: "Right, wrong or unsure? [r/w/u; Enter skips, q stops]",
  noteQuestion: "What is wrong with it? (one line; Enter for none)",
  wrongFact: (repo: string, rel: string) =>
    `  Correct it: the fact's Correct this on the Map (a line in ${rel}/${repo}.corrections.jsonl), then atticus verify ${repo} --write.`,
  wrongLink: (repo: string, rel: string, call: string) =>
    `  Say so: on the Map, the link's Why is this linked? › This link is wrong corrects call ${call} in ${rel}/${repo}.corrections.jsonl (ADR 0135); then atticus verify ${repo} --write.`,
  howToAnswer: (repo: string, file: string) =>
    `Not on a terminal, so nothing was asked. Answer each id above as right, wrong or unsure: in ${file} (answer: right), with atticus verify audit ${repo} --answers <file>, or with --right, --wrong and --unsure lists of ids.`,
  wrote: (file: string, answered: number, open: number) =>
    `Wrote ${file}: ${answered} answered, ${open} open. It is a person's record: commit it in a pull request (git add ${file}); nothing was sent anywhere.`,
  head: (repo: string, file: string, seeds: string[]) =>
    `Sample audit of ${repo} (${file}; ${plural(seeds.length, "draw")}, ${seeds.length === 1 ? "seed" : "seeds"} ${seeds.join(", ")}):`,
  estateHead: (n: number) => `Sample audits across the estate: ${plural(n, "repo")} audited.`,
  noAudit: (repo: string) =>
    `${repo} has no sample audit yet. Draw one: atticus verify audit ${repo}.`,
  noAudits: "No repo has a sample audit yet. Draw one: atticus verify audit <repo>.",
  small: (n: number) =>
    `${plural(n, "answer")} in all: a sample this small says little, so read the interval, not the number. Draw more with another --seed.`,
  gone: (n: number) =>
    `${plural(n, "item")} left out: the fact or link changed since it was drawn (read again), so its answer no longer stands.`,
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const num = (x: number | null) => (x === null ? "-" : String(x));

/** One tally in words: precision, how many answered, the interval, and what isn't counted. */
export function tallyWords(t: AuditTally): string {
  const n = t.right + t.wrong;
  const rest = [
    ...(t.unsure ? [`${t.unsure} unsure`] : []),
    ...(t.open ? [`${t.open} open`] : []),
    ...(t.gone ? [`${t.gone} gone`] : []),
  ].join(", ");
  if (!n) return `no answers yet (${plural(t.drawn, "drawn", "drawn")}${rest ? `; ${rest}` : ""})`;
  return `precision ${num(t.precision)}, ${t.right} of ${n} right (95% interval ${num(t.low)} to ${num(t.high)})${rest ? `; ${rest}` : ""}`;
}

function precisionLines(p: AuditPrecision): string[] {
  const out = [`Facts: ${tallyWords(p.facts)}.`];
  for (const [k, t] of Object.entries(p.byKind)) out.push(`  ${k}: ${tallyWords(t)}`);
  out.push(`Links: ${tallyWords(p.links)}.`);
  for (const [k, t] of Object.entries(p.byHow)) out.push(`  ${k}: ${tallyWords(t)}`);
  const answered = p.facts.right + p.facts.wrong + p.links.right + p.links.wrong;
  if (answered < 30) out.push(AUDIT_WORDS.small(answered));
  const gone = p.facts.gone + p.links.gone;
  if (gone) out.push(AUDIT_WORDS.gone(gone));
  return out;
}

const auditPath = (root: string, repo: string) => join(factsDirOf(root), `${repo}.audit.yaml`);

async function readAudit(
  root: string,
  repo: string,
): Promise<{ file?: AuditFileT; issues?: string[] }> {
  const text = await readFile(auditPath(root, repo), "utf8").catch(() => undefined);
  if (text === undefined) return {};
  const r = parseAuditFile(text);
  return r.ok ? { file: r.file } : { issues: r.issues };
}

async function readFactsOf(
  root: string,
  repo: string,
): Promise<{ facts?: Fact[]; missing?: true; bad?: true }> {
  const text = await readFile(join(factsDirOf(root), `${repo}.jsonl`), "utf8").catch(
    () => undefined,
  );
  if (text === undefined || !text.trim()) return { missing: true };
  const r = parseFacts(text);
  return r.ok ? { facts: r.facts } : { bad: true };
}

/** Every repo's verified facts and the estate join's links from `repo`, as `verify --write` joins. */
async function linksOf(root: string, repo: string): Promise<AuditItemT[]> {
  const { estateFacts, estateJoinOf, auditLinkCandidates } = await import("@maycombhq/scanner");
  const op = await loadOrgPack(orgPackDirOf(root));
  const estate = await estateFacts(root, op, "");
  const join = estateJoinOf(op, estate.repos, estate.targets);
  return auditLinkCandidates(join, estate.repos, repo);
}

/** The answers a file or the flags give, by item id. */
async function givenAnswers(
  root: string,
  o: AuditOptions,
): Promise<{ answers: Map<string, { answer: AuditAnswer; note?: string }>; issues: string[] }> {
  const answers = new Map<string, { answer: AuditAnswer; note?: string }>();
  const issues: string[] = [];
  const isAnswer = (x: unknown): x is AuditAnswer =>
    typeof x === "string" && (AUDIT_ANSWERS as readonly string[]).includes(x);
  if (o.answers) {
    const path = isAbsolute(o.answers) ? o.answers : resolve(root, o.answers);
    const text = await readFile(path, "utf8").catch(() => undefined);
    let doc: unknown;
    try {
      doc = text === undefined ? undefined : parse(text);
    } catch (e) {
      issues.push(`not YAML or JSON: ${(e as Error).message.split("\n")[0]}`);
    }
    if (text === undefined) issues.push("there is no such file");
    else if (doc && typeof doc === "object" && !Array.isArray(doc))
      for (const [id, v] of Object.entries(doc as Record<string, unknown>)) {
        const a = typeof v === "object" && v ? (v as Record<string, unknown>).answer : v;
        const note = typeof v === "object" && v ? (v as Record<string, unknown>).note : undefined;
        if (!isAnswer(a)) issues.push(`${id}: the answer is right, wrong or unsure`);
        else answers.set(id, { answer: a, ...(typeof note === "string" ? { note } : {}) });
      }
    else if (!issues.length) issues.push("it should map each item id to right, wrong or unsure");
  }
  for (const a of AUDIT_ANSWERS) for (const id of o[a] ?? []) answers.set(id, { answer: a });
  return { answers, issues };
}

/** The line a cite names, from the checkout it is in; undefined when there is none. */
function lineReader(root: string, o: AuditOptions, repo: string) {
  const dirs = new Map<string, Promise<string | undefined>>();
  const files = new Map<string, Promise<string[] | undefined>>();
  return async (cite: string): Promise<string | undefined> => {
    // A fact's cite is `file:line`; a link's is `<repo> file:line`.
    const space = cite.indexOf(" ");
    const r = space > 0 ? cite.slice(0, space) : repo;
    const at = space > 0 ? cite.slice(space + 1) : cite;
    const m = /^(.*):(\d+)$/.exec(at);
    if (!m) return undefined;
    if (!dirs.has(r)) dirs.set(r, checkoutOf(root, r, r === repo ? o.dir : undefined));
    const dir = await dirs.get(r);
    if (!dir) return undefined;
    const k = `${dir}\u0000${m[1]}`;
    if (!files.has(k))
      files.set(
        k,
        readFile(join(dir, m[1]!), "utf8").then(
          (t) => t.split(/\r?\n/),
          () => undefined,
        ),
      );
    return (await files.get(k))?.[Number(m[2]) - 1]?.trim();
  };
}

export async function auditCommand(
  root: string,
  repo: string | undefined,
  o: AuditOptions,
  io: Output,
): Promise<number> {
  if (o.report) return repo ? auditReport(root, repo, o, io) : estateAuditReport(root, o, io);
  if (!repo) {
    io.err(AUDIT_WORDS.usage);
    return 2;
  }
  const rel = factsRelOf(root);
  const read = await readFactsOf(root, repo);
  if (read.missing) {
    io.err(AUDIT_WORDS.noFacts(repo, rel));
    return 2;
  }
  if (read.bad || !read.facts) {
    io.err(AUDIT_WORDS.badFacts(`${rel}/${repo}.jsonl`));
    return 2;
  }
  const facts = read.facts;
  const unverified = facts.filter((f) => f.verified === "none").length;
  if (unverified) {
    io.err(AUDIT_WORDS.unverified(repo, unverified));
    return 2;
  }
  const fileRel = `${rel}/${repo}.audit.yaml`;
  const onFile = await readAudit(root, repo);
  if (onFile.issues) {
    io.err(AUDIT_WORDS.badFile(fileRel));
    for (const i of onFile.issues) io.err(`  ${i}`);
    return 2;
  }
  const given = await givenAnswers(root, o);
  if (given.issues.length) {
    io.err(AUDIT_WORDS.badAnswers(o.answers ?? "--right/--wrong/--unsure"));
    for (const i of given.issues) io.err(`  ${i}`);
    return 2;
  }

  const commit = [...new Set(facts.map((f) => f.commit))].sort()[0];
  const size = o.size && o.size > 0 ? Math.floor(o.size) : AUDIT_DEFAULT_SIZE;
  const seed = o.seed ?? `${repo}@${(commit ?? "").slice(0, 7)}`;
  const links = await linksOf(root, repo);
  const drawn = drawAudit({ facts: auditCandidates(facts), links, size, seed });
  if (!drawn.length && !onFile.file) {
    io.out(AUDIT_WORDS.nothing(repo));
    return 0;
  }
  const now = (o.now ?? (() => new Date()))().toISOString();
  const audit = mergeDraw(onFile.file, repo, drawn, {
    seed,
    size,
    ...(commit ? { commit } : {}),
    at: now,
  });

  // The answers given: by the item's id, or a fact's own id.
  const byId = new Map(audit.items.map((i) => [i.id, i] as const));
  const unknown: string[] = [];
  for (const [id, a] of given.answers) {
    const item = byId.get(id) ?? byId.get(`fact:${id}`) ?? byId.get(`link:${id}`);
    if (!item) {
      unknown.push(id);
      continue;
    }
    item.answer = a.answer;
    if (a.note) item.note = a.note;
    else delete item.note;
    item.by = o.by;
    item.at = now;
  }
  if (unknown.length) {
    io.err(AUDIT_WORDS.unknownIds(unknown));
    return 2;
  }

  const thisDraw = new Set(drawn.map((d) => d.id));
  const shown = audit.items.filter((i) => thisDraw.has(i.id));
  if (!o.json)
    io.out(
      AUDIT_WORDS.drew(
        repo,
        shown.filter((i) => i.kind === "fact").length,
        shown.filter((i) => i.kind === "link").length,
        seed,
        size,
      ),
    );
  const lineOf = lineReader(root, o, repo);
  const show = async (i: AuditItemT, k: number) => {
    io.out("");
    io.out(`[${k}/${shown.length}] ${i.kind === "link" ? `link (${i.of})` : "fact"} ${i.claim}`);
    io.out(`  id ${i.id}`);
    for (const c of i.cites) {
      const text = await lineOf(c);
      io.out(`  ${c}${text ? `  ${text.length > 160 ? `${text.slice(0, 157)}...` : text}` : ""}`);
    }
  };
  const pointTo = (i: AuditItemT) =>
    io.out(
      i.kind === "fact"
        ? AUDIT_WORDS.wrongFact(repo, rel)
        : AUDIT_WORDS.wrongLink(repo, rel, i.fact ?? i.id),
    );

  if (!o.json) {
    let k = 0;
    let stopped = false;
    for (const i of shown) {
      k++;
      if (i.answer || stopped || !o.ask) {
        await show(i, k);
        if (i.answer) io.out(`  ${i.answer}${i.note ? `: ${i.note}` : ""}`);
        if (i.answer === "wrong") pointTo(i);
        continue;
      }
      await show(i, k);
      const said = ((await o.ask(AUDIT_WORDS.question)) ?? "").trim().toLowerCase();
      if (said === "q") {
        stopped = true;
        continue;
      }
      const answer = AUDIT_ANSWERS.find((a) => a === said || a[0] === said);
      if (!answer) continue;
      i.answer = answer;
      i.by = o.by;
      i.at = now;
      if (answer === "wrong") {
        const note = ((await o.ask(AUDIT_WORDS.noteQuestion)) ?? "").trim();
        if (note) i.note = note;
        pointTo(i);
      }
    }
  }

  await writeFile(auditPath(root, repo), serializeAuditFile(audit), "utf8");
  const precision = await precisionOf(root, repo, audit, facts);
  if (o.json) {
    io.out(
      JSON.stringify(
        { repo, file: fileRel, seed, size, drawn: shown, precision, wrote: true },
        null,
        2,
      ),
    );
    return 0;
  }
  io.out("");
  if (!o.ask && shown.some((i) => !i.answer)) io.out(AUDIT_WORDS.howToAnswer(repo, fileRel));
  io.out(
    AUDIT_WORDS.wrote(
      fileRel,
      audit.items.filter((i) => i.answer).length,
      audit.items.filter((i) => !i.answer).length,
    ),
  );
  io.out("");
  for (const l of precisionLines(precision)) io.out(l);
  return 0;
}

/** Precision over the answers that still stand: the fact as drawn, the link still made. */
async function precisionOf(
  root: string,
  repo: string,
  audit: AuditFileT,
  facts: readonly Fact[],
): Promise<AuditPrecision> {
  const byId = new Map(facts.map((f) => [f.id, f] as const));
  const links = new Map((await linksOf(root, repo)).map((l) => [l.id, l] as const));
  return auditPrecision(audit.items, (i) =>
    i.kind === "fact" ? auditItemHolds(i, byId) : links.get(i.id)?.to === i.to,
  );
}

async function auditReport(
  root: string,
  repo: string,
  o: AuditOptions,
  io: Output,
): Promise<number> {
  const fileRel = `${factsRelOf(root)}/${repo}.audit.yaml`;
  const onFile = await readAudit(root, repo);
  if (onFile.issues) {
    io.err(AUDIT_WORDS.badFile(fileRel));
    for (const i of onFile.issues) io.err(`  ${i}`);
    return 2;
  }
  if (!onFile.file) {
    io.err(AUDIT_WORDS.noAudit(repo));
    return 2;
  }
  const precision = await precisionOf(
    root,
    repo,
    onFile.file,
    (await readFactsOf(root, repo)).facts ?? [],
  );
  const seeds = onFile.file.draws.map((d) => d.seed);
  if (o.json) {
    io.out(JSON.stringify({ repo, file: fileRel, seeds, precision }, null, 2));
    return 0;
  }
  io.out(AUDIT_WORDS.head(repo, fileRel, seeds));
  for (const l of precisionLines(precision)) io.out(l);
  return 0;
}

async function estateAuditReport(root: string, o: AuditOptions, io: Output): Promise<number> {
  const out: { repo: string; precision: AuditPrecision }[] = [];
  for (const repo of await factsRepos(root)) {
    const onFile = await readAudit(root, repo);
    if (onFile.issues) {
      io.err(AUDIT_WORDS.badFile(`${factsRelOf(root)}/${repo}.audit.yaml`));
      for (const i of onFile.issues) io.err(`  ${i}`);
      return 2;
    }
    if (!onFile.file) continue;
    const facts = (await readFactsOf(root, repo)).facts ?? [];
    out.push({ repo, precision: await precisionOf(root, repo, onFile.file, facts) });
  }
  if (!out.length) {
    io.err(AUDIT_WORDS.noAudits);
    return 2;
  }
  const estate = sumAuditPrecision(out.map((x) => x.precision));
  if (o.json) {
    io.out(JSON.stringify({ repos: out, estate }, null, 2));
    return 0;
  }
  io.out(AUDIT_WORDS.estateHead(out.length));
  for (const x of out) {
    io.out(`  ${x.repo}: facts ${tallyWords(x.precision.facts)}`);
    io.out(`  ${" ".repeat(x.repo.length)}  links ${tallyWords(x.precision.links)}`);
  }
  io.out("");
  io.out("The estate:");
  for (const l of precisionLines(estate)) io.out(l);
  return 0;
}
