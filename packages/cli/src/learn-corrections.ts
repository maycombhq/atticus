import { readFile, rm } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { isMap, isSeq, parseDocument } from "yaml";
import {
  factsDirOf,
  factsRelOf,
  linksFor,
  loadOrgPack,
  migrateReadingRulesText,
  orgPackDirOf,
  parseFacts,
  personEditOfTo,
  ReadingRulesFile,
  type Api,
  type Fact,
  type FactCorrection,
  type FactOf,
  type LearnedFrom,
  type ReadingRule,
} from "@maycombhq/core";
import type { Output } from "./commands.js";
import {
  answeredByPerson,
  bestApiOf,
  correctedRepos,
  correctionsOf,
  factsOf,
  inAcpSession,
} from "./ai-decide.js";
import type { AcpStepRunner } from "./copilot-acp-steps.js";
import { checkoutOf } from "./facts-files.js";
import { exampleOf, ruleMatches } from "./reading-rules.js";

/**
 * ADR 0208 (WP-03), Learn from my corrections: one run over every pairing a person made since
 * the last run (a corrected AI pairing or a canvas pairing, never a spread's line or the AI's).
 * For each repo type, the assistant is handed each correction with its cited lines and drafts
 * reading rules into the type's layer (as `atticus rules draft`, adding drafts only). Each draft
 * is tried by re-reading only the files it names (as `atticus rules try`, into facts/.try/).
 * A rule is written active, with its proof, when the re-read's call on every corrected line it
 * names gets the person's API as the shapes' first, and no call a person paired, declined or
 * answered changes, and no arrow a person deleted would be drawn again. Any other stays a draft
 * saying why. "Since the last run": a correction no learned rule names yet.
 */

export interface DeletedArrow {
  /** The caller's repo and the callee's repo of an arrow a person deleted on the canvas. */
  from: string;
  to: string;
  by: string;
  what: string;
}

export interface LearnDeps {
  by: string;
  now?: Date;
  runner?: AcpStepRunner;
  signal?: AbortSignal;
  /** The arrows deleted on the canvas, by repo (tests pass their own). */
  deleted?: () => Promise<DeletedArrow[]>;
}

interface Correction {
  id: string;
  repo: string;
  c: FactCorrection;
}

const idOf = (repo: string, c: FactCorrection) => `${repo} ${c.target.file}:${c.target.line}`;
const quiet: Output = { out: () => undefined, err: () => undefined };

/** The deleted arrows, by repo: each delete's two ends are components of the manifest. */
async function deletedByRepo(root: string): Promise<DeletedArrow[]> {
  const { deletedLinks } = await import("./catalog-build-commands.js");
  const { estateRepos } = await import("@maycombhq/scanner");
  const repos = estateRepos(await loadOrgPack(orgPackDirOf(root)));
  const repoOf = (c: string) => repos.find((r) => r.component === c || r.id === c)?.id;
  return (await deletedLinks(root)).links.flatMap((l) => {
    const from = repoOf(l.from);
    const to = repoOf(l.to);
    return from && to ? [{ from, to, by: l.by, what: `${l.from} → ${l.to}` }] : [];
  });
}

export async function learnFromCorrections(
  root: string,
  d: LearnDeps,
  io: Output = quiet,
): Promise<Api.LearnCorrectionsResultT> {
  if (inAcpSession()) throw new Error("Learn is a person's: a Copilot session acts as no one.");
  const op = await loadOrgPack(orgPackDirOf(root));
  if (op.runtime.ai === "off")
    throw new Error("runtime.yaml turns AI off here (ai: off): Learn needs the assistant.");
  const { estateRepos } = await import("@maycombhq/scanner");
  const { loadDoc, rulesDraftCommand, saveDoc, tryDiff } = await import("./rules-commands.js");
  const typeOf = new Map(estateRepos(op).map((r) => [r.id, r.type] as const));
  const out: Api.LearnCorrectionsResultT = { corrections: 0, active: [], draft: [], untaught: [] };
  const byType = new Map<string, Correction[]>();
  for (const repo of await correctedRepos(root)) {
    const all = await correctionsOf(root, repo);
    for (const c of all) {
      const own = !c.ai && !c.rule && c.action === "link" && c.link?.repo && c.link.entry;
      const cite = { file: c.target.file, line: c.target.line, value: c.target.value };
      if (!own || linksFor({ kind: "call", id: c.fact, cite }, all)[0] !== c) continue;
      const type = typeOf.get(repo);
      if (!type) out.untaught.push({ correction: idOf(repo, c), why: "its repo has no type" });
      else byType.set(type, [...(byType.get(type) ?? []), { id: idOf(repo, c), repo, c }]);
    }
  }
  const deleted = await (d.deleted ?? (() => deletedByRepo(root)))();
  const at = (d.now ?? new Date()).toISOString();
  for (const [type, found] of byType) {
    const rel = `types/${type}.yaml`;
    const fileRel = `${relative(root, orgPackDirOf(root)).replace(/\\/g, "/")}/reading-rules/${rel}`;
    const was = await loadDoc(root, rel);
    const before = ReadingRulesFile.safeParse(was.doc.toJS());
    const learned = new Set(
      (before.success ? before.data.rules : []).flatMap((r) => r.learned?.corrections ?? []),
    );
    const fresh = found.filter((x) => !learned.has(x.id));
    out.corrections += fresh.length;
    if (!fresh.length) continue;
    // 1. The assistant drafts, from each correction with its cited lines (data, never instructions).
    const missed: string[] = [];
    for (const x of fresh) {
      const l = x.c.link!;
      missed.push(
        `${x.id}: the read missed where this call goes; ${x.c.by} paired it with ${l.repo} ${[l.method, l.path].filter(Boolean).join(" ")} (${l.entry}).`,
      );
      const dir = await checkoutOf(root, x.repo).catch(() => undefined);
      const text = dir ? await readFile(join(dir, x.c.target.file), "utf8").catch(() => "") : "";
      const src = text.split(/\r?\n/);
      for (
        let n = Math.max(1, x.c.target.line - 2);
        n <= x.c.target.line + 2 && n <= src.length;
        n++
      )
        missed.push(`  ${n}| ${src[n - 1]}`);
    }
    let run: string | undefined;
    const runner: AcpStepRunner | undefined = d.runner
      ? async (s) => {
          const r = await d.runner!(s);
          run ??= r.runId;
          return r;
        }
      : undefined;
    const said: string[] = [];
    const code = await rulesDraftCommand(
      root,
      {
        type,
        repos: [...new Set(fresh.map((x) => x.repo))].join(","),
        about: `A person corrected these arrows on the map. Work out why each read was wrong and draft reading rules so that a re-read gets each right by itself. Name in \`files\` the files each rule is about: only those are re-read to test it.`,
        missed,
        mode: "copilot-acp",
        ...(runner ? { runner } : {}),
        ...(d.signal ? { signal: d.signal } : {}),
      },
      { out: (l) => (said.push(l), io.out(l)), err: (l) => (said.push(l), io.err(l)) },
    );
    if (code !== 0) throw new Error(said.join(" "));
    const now = await loadDoc(root, rel);
    const after = ReadingRulesFile.parse(now.doc.toJS());
    const had = new Set((before.success ? before.data.rules : []).map((r) => r.key));
    const drafts = after.rules.filter((r) => r.status === "draft" && !had.has(r.key));
    const named = new Set<string>();
    const verdicts = new Map<string, LearnedFrom>();
    // 2. Each draft is re-read on the files it names, then checked.
    for (const rule of drafts) {
      const mine = fresh.filter((x) => ruleMatches(rule, x.c.target.file));
      for (const x of mine) named.add(x.id);
      const base = { corrections: (mine.length ? mine : fresh).map((x) => x.id), by: d.by, at };
      const v = mine.length
        ? await proveRule(root, rule, mine, { runner, deleted, tryDiff, signal: d.signal })
        : { why: "it names none of the corrected files, so no re-read can reproduce them" };
      verdicts.set(rule.key, { ...base, ...(run ? { run } : {}), ...v });
      if ("proof" in v)
        out.active.push({ key: rule.key, file: fileRel, reproduced: v.proof!.reproduced });
      else out.draft.push({ key: rule.key, file: fileRel, why: v.why! });
    }
    for (const x of fresh)
      if (!drafts.length || !named.has(x.id))
        out.untaught.push({ correction: x.id, why: "no drafted rule names its file" });
    if (!verdicts.size) continue;
    // 3. Written in one change of the layer's file: each draft's verdict, a proven one active.
    // A version 1 file is moved on to 2 (ADR 0208's migration: the number only).
    const doc = parseDocument(migrateReadingRulesText((await loadDoc(root, rel)).text).text);
    const rules = doc.get("rules");
    for (const item of isSeq(rules) ? rules.items : []) {
      const v = isMap(item) ? verdicts.get(String(item.get("key"))) : undefined;
      if (!v || !isMap(item)) continue;
      item.set("status", v.proof ? "active" : "draft");
      item.set("learned", doc.createNode(v));
    }
    const bad = await saveDoc(now.path, doc, now.onDisk);
    if (bad) throw new Error(`${fileRel} wouldn't be valid: ${bad}`);
  }
  return out;
}

/** Re-read only the files a rule names, in each corrected repo, and check what it reproduces. */
async function proveRule(
  root: string,
  rule: ReadingRule,
  mine: readonly Correction[],
  o: {
    runner: AcpStepRunner | undefined;
    deleted: readonly DeletedArrow[];
    tryDiff: (
      a: readonly Fact[],
      b: readonly Fact[],
    ) => { added: Fact[]; changed: { now: Fact }[] };
    signal?: AbortSignal | undefined;
  },
): Promise<Pick<LearnedFrom, "proof" | "why">> {
  if (!o.runner) return { why: "no assistant session ran to re-read with it" };
  const { listFiles } = await import("./reading-rules-files.js");
  const { candidatesOf, settingsOf } = await import("./ui-api-links.js");
  const reread: string[] = [];
  const reproduced: string[] = [];
  const problems: string[] = [];
  for (const repo of [...new Set(mine.map((x) => x.repo))]) {
    const dir = await checkoutOf(root, repo).catch(() => undefined);
    if (!dir) return { why: `there is no checkout of ${repo} to re-read` };
    const files = (await listFiles(dir)).filter((p) => ruleMatches(rule, p)).slice(0, 200);
    const relDir = relative(root, dir);
    const checkout =
      relDir && !relDir.startsWith("..") && !isAbsolute(relDir) ? relDir.replace(/\\/g, "/") : dir;
    const tryRel = `${factsRelOf(root)}/.try/${repo}.${rule.key}.jsonl`;
    const tryPath = join(factsDirOf(root), ".try", `${repo}.${rule.key}.jsonl`);
    await o.runner({
      line: [
        `# Re-read ${repo} with the reading rule ${rule.key}`,
        "",
        `Read only these files of ${repo} (its checkout is \`${checkout}\`), by Atticus's reading rules (the /atticus-map rules) and this one:`,
        "",
        `- ${rule.key}: ${rule.rule.replace(/\s+/g, " ")}${exampleOf(rule.example)}`,
        "",
        ...files.map((f) => `- \`${f}\``),
        "",
        `Write the facts you read to \`${tryRel}\` only (one JSON object per line, as the facts file takes them), and nothing else. Don't run atticus verify: this is a test of the rule.`,
      ].join("\n"),
      change: `rules-learn-${repo}`,
      writeRoots: [join(factsDirOf(root), ".try")],
      ...(o.signal ? { signal: o.signal } : {}),
    });
    const parsed = parseFacts(await readFile(tryPath, "utf8").catch(() => ""));
    await rm(tryPath, { force: true });
    if (!parsed.ok) return { why: `the re-read of ${repo} didn't read as facts` };
    reread.push(...files.map((f) => `${repo} ${f}`));
    const onFile = await factsOf(root, repo);
    const readNow = new Set(files);
    const merged = [...onFile.filter((f) => !readNow.has(f.cite.file)), ...parsed.facts];
    const settings = settingsOf(merged);
    const at = (f: { cite: { file: string; line: number } }) => `${f.cite.file}:${f.cite.line}`;
    const tried = new Map(
      parsed.facts.filter((f): f is FactOf<"call"> => f.kind === "call").map((f) => [at(f), f]),
    );
    const apis = new Map<string, Awaited<ReturnType<typeof candidatesOf>>["view"]["apis"]>();
    const apisOf = async (to: string) => {
      if (!apis.has(to))
        apis.set(
          to,
          (
            (await candidatesOf(root, repo, { repo: to }).catch(() => undefined))?.view.apis ?? []
          ).filter((a) => a.kind !== "operation"),
        );
      return apis.get(to)!;
    };
    const best = async (call: FactOf<"call">, to: string) =>
      bestApiOf({ repo, call, target: to, apis: await apisOf(to), settings })?.id;
    // Each correction the rule names: the re-read's call on its line, joined as the person said.
    const own = new Set<string>();
    for (const x of mine.filter((m) => m.repo === repo)) {
      own.add(`${x.c.target.file}:${x.c.target.line}`);
      const t = tried.get(`${x.c.target.file}:${x.c.target.line}`);
      const got = t ? await best(t, x.c.link!.repo!) : undefined;
      if (got === x.c.link!.entry) reproduced.push(x.id);
      else
        problems.push(
          `it didn't reproduce ${x.id}: the re-read ${t ? `ranks ${got ?? "no API"} first` : "has no call on that line"}, not ${x.c.link!.entry}`,
        );
    }
    // No call a person touched changes, and no arrow a person deleted is drawn again.
    const corrections = await correctionsOf(root, repo);
    const byPerson = await answeredByPerson(root, repo, onFile);
    const diff = o.tryDiff(
      onFile.filter((f) => readNow.has(f.cite.file)),
      parsed.facts,
    );
    const moved = new Set([...diff.added, ...diff.changed.map((c) => c.now)].map(at));
    for (const f of onFile) {
      if (f.kind !== "call" || !readNow.has(f.cite.file) || own.has(at(f))) continue;
      const st = linksFor(f, corrections)[0];
      const who =
        st && !st.ai
          ? st.by
          : personEditOfTo(f, corrections)
            ? "a person"
            : byPerson.has(f.id)
              ? "a person's answer"
              : undefined;
      if (who && (moved.has(at(f)) || !tried.has(at(f))))
        problems.push(`it changes ${repo}'s call at ${at(f)}, which ${who} set`);
    }
    for (const del of o.deleted.filter((x) => x.from === repo))
      for (const k of moved) {
        const t = tried.get(k);
        if (t && !own.has(k) && (await best(t, del.to)))
          problems.push(
            `it would draw again the arrow ${del.what} that ${del.by} deleted (${repo} ${k})`,
          );
      }
  }
  if (problems.length || !reproduced.length)
    return { why: problems.join("; ") || "it reproduced no correction" };
  return { proof: { reread, reproduced } };
}

/** atticus rules learn: Learn from my corrections, in a terminal; `--json` prints the result. */
export async function rulesLearnCommand(
  root: string,
  o: { json?: boolean; runner?: AcpStepRunner; by?: string },
  io: Output,
): Promise<number> {
  const op = await loadOrgPack(orgPackDirOf(root));
  const { acpStepRunner, copilotAcpAllowed } = await import("./copilot-acp-steps.js");
  if (!o.runner && !copilotAcpAllowed(op)) {
    io.err(
      "Learn runs the assistant unattended: runtime.yaml must allow copilot-acp. Else draft by hand: atticus rules draft --type <t>.",
    );
    return 2;
  }
  const { gitUser } = await import("@maycombhq/workspace");
  let r: Api.LearnCorrectionsResultT;
  try {
    r = await learnFromCorrections(
      root,
      {
        by: o.by ?? (await gitUser(root)).handle,
        runner: o.runner ?? (await acpStepRunner(root, { op })),
      },
      io,
    );
  } catch (e) {
    io.err((e as Error).message);
    return 1;
  }
  if (o.json) {
    io.out(JSON.stringify(r, null, 2));
    return 0;
  }
  if (!r.corrections) {
    io.out("No correction since the last run: nothing was asked and nothing written.");
    return 0;
  }
  io.out(`${r.corrections} correction${r.corrections === 1 ? "" : "s"} since the last run.`);
  for (const a of r.active)
    io.out(`  active  ${a.key} (${a.file}): a re-read reproduced ${a.reproduced.join(", ")}`);
  for (const x of r.draft) io.out(`  draft   ${x.key} (${x.file}): ${x.why}`);
  for (const u of r.untaught) io.out(`  not learned  ${u.correction}: ${u.why}`);
  io.out(
    "Review the rules file in a pull request; atticus rules list shows what each repo is given.",
  );
  return 0;
}
