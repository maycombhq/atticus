import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runtimeForCli, type AiRuntime, type Run } from "@maycombhq/ai";
import {
  archiveGate,
  driftExitCode,
  DriftError,
  driftJson,
  driftJUnit,
  driftMarkdown,
  pipelineSnippet,
  repoDrift,
  SNIPPET_KINDS,
} from "@maycombhq/ci";
import {
  aliasDecision,
  completeGlossaryDefinitions,
  defineDecision,
  GlossaryError,
  linkDecision,
  loadGlossary,
  resolveTermId,
  scanGlossary,
  writeDecisions,
  type ScanGlossaryResult,
} from "@maycombhq/glossary";
import {
  generateTests,
  matrixCsv,
  matrixMarkdown,
  traceMatrix,
  writeTraceFindings,
} from "@maycombhq/testgen";
import { createGit, type GitRunner } from "@maycombhq/workspace";
import type { Output } from "./commands.js";
import { table } from "./index-commands.js";

/**
 * atticus tests generate / trace / ci drift / ci snippet / ci archive-gate / glossary
 * list|scan|define|link|alias. Exit codes: 0 ok, 1 problems (or something for a person to do),
 * 2 usage or an error that stops the command.
 */

export interface QualityDeps {
  runtime?: AiRuntime;
  now?: () => Date;
  git?: GitRunner;
  /** Commit recorded for drift checks (tests); default read with git. */
  commit?: string;
}

const KNOWN = new Set([
  "TestgenError",
  "PlannerError",
  "ChangeError",
  "ChangeFileError",
  "GlossaryError",
  "RuntimeConfigError",
]);

function fail(io: Output, e: unknown): number {
  if (e instanceof Error && KNOWN.has(e.name)) {
    io.err(e.message);
    return (e as { code?: string }).code === "invalid" ? 2 : 1;
  }
  throw e;
}

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
/** Print a block of text one line at a time, like every other command. */
const lines = (io: Output, text: string) => {
  for (const l of text.trimEnd().split("\n")) io.out(l);
};
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

async function runtimeOf(root: string, mode: string | undefined, deps: QualityDeps) {
  if (deps.runtime) return deps.runtime;
  // The test writer only names things, so it runs only when asked for (--mode or ATTICUS_RUNTIME).
  if (!mode && !process.env.ATTICUS_RUNTIME) return undefined;
  return (await runtimeForCli(root, mode ? { mode } : {})).runtime;
}

// ------------------------------------------------------------------ tests generate

/** atticus tests generate <change> <story> [--framework <id>] [--force] [--check] [--mode <mode>] [--resume <run>] [--json] */
export async function testsGenerate(
  root: string,
  changeId: string | undefined,
  storyId: string | undefined,
  o: {
    framework?: string;
    force?: boolean;
    mode?: string;
    check?: boolean;
    resume?: string;
    json?: boolean;
  },
  io: Output,
  deps: QualityDeps = {},
): Promise<number> {
  if (!changeId || !storyId) {
    io.err(
      "Usage: atticus tests generate <change> <story> [--framework <id>] [--force] [--check] [--mode <mode>] [--json]",
    );
    return 2;
  }
  try {
    const runtime = await runtimeOf(root, o.mode, deps);
    const r = await generateTests(root, changeId, storyId, {
      ...(o.framework ? { framework: o.framework } : {}),
      ...(o.force ? { force: true } : {}),
      ...(o.check ? { check: true } : {}),
      ...(o.resume ? { resume: o.resume } : {}),
      ...(runtime ? { runtime } : {}),
      now: deps.now?.() ?? new Date(),
    });
    const kept = r.files.filter(
      (f) => f.action === "kept-edited" || f.action === "kept-not-generated",
    );
    if (o.json) {
      io.out(
        JSON.stringify(
          {
            change: r.change,
            story: r.story,
            strategy: r.model.strategy,
            kinds: r.model.kinds,
            names: r.names.by,
            ...(r.names.waiting ? { waiting: r.names.waiting } : {}),
            files: r.files,
            manifest: r.manifest,
            notes: r.notes,
            gaps: r.gaps,
          },
          null,
          2,
        ),
      );
      return kept.length ? 1 : 0;
    }
    const count = (a: string) => r.files.filter((f) => f.action === a).length;
    const cases = r.model.repos.reduce((n, x) => n + x.cases.length, 0);
    io.out(
      `${o.check ? "Would write" : "Generated"} ${plural(cases, "test case")} for ${r.story} in ${plural(r.files.length, "file")}: ${count("created")} new, ${count("updated")} updated, ${count("unchanged")} unchanged${kept.length ? `, ${kept.length} kept` : ""}.`,
    );
    for (const l of table(
      ["ACTION", "REPO", "FRAMEWORK", "FILE"],
      r.files.map((f) => [f.action, f.repo || "-", f.generator, f.path]),
    ))
      io.out(l);
    for (const k of r.model.kinds.filter((x) => !x.generated))
      io.out(`No ${k.type} tests: ${k.why}`);
    for (const n of r.notes) io.out(n);
    for (const g of r.gaps) io.out(`Gap: ${g}`);
    if (r.names.waiting)
      io.out(
        `The test writer is with your assistant (run ${r.names.waiting}); the files use plain names until you run: atticus tests generate ${changeId} ${storyId} --resume ${r.names.waiting}`,
      );
    if (!o.check) io.out(`Manifest: ${r.manifest}`);
    return kept.length ? 1 : 0;
  } catch (e) {
    return fail(io, e);
  }
}

// ------------------------------------------------------------------ trace

/** atticus trace <change> [--json | --csv] [--no-write] */
export async function traceCommand(
  root: string,
  changeId: string | undefined,
  o: { json?: boolean; csv?: boolean; write?: boolean },
  io: Output,
  deps: QualityDeps = {},
): Promise<number> {
  if (!changeId) {
    io.err("Usage: atticus trace <change> [--json | --csv] [--no-write]");
    return 2;
  }
  try {
    // git runs only in repo folders that are checkouts, for the task branches' diffs.
    const m = await traceMatrix(root, changeId, { git: deps.git ?? createGit() });
    for (const p of m.problems) io.err(p);
    const w =
      o.write === false
        ? undefined
        : await writeTraceFindings(root, m, iso(deps.now?.() ?? new Date()));
    if (o.json) io.out(JSON.stringify({ ...m, ...(w ? { round: w.round ?? null } : {}) }, null, 2));
    else if (o.csv) lines(io, matrixCsv(m));
    else {
      lines(io, matrixMarkdown(m));
      if (w)
        io.out(
          w.unchanged
            ? `Findings on the trace gate are unchanged (round ${w.round ?? "none"}).`
            : `Wrote ${plural(w.findings.length, "finding")} to review/trace/${w.round}/.`,
        );
    }
    return m.gaps.some((g) => g.kind !== "test-without-requirement") ? 1 : 0;
  } catch (e) {
    return fail(io, e);
  }
}

// ------------------------------------------------------------------ ci

/**
 * atticus ci drift [repo-dir] --catalog <metarepo or catalog folder> [--repo <id>] [--json [file]]
 * [--junit <file>] [--summary <file>] [--warn-only]
 */
export async function ciDrift(
  repoDir: string,
  o: {
    catalog?: string;
    json?: boolean | string;
    junit?: string;
    warnOnly?: boolean;
    repo?: string;
    summary?: string;
  },
  io: Output,
  deps: QualityDeps = {},
): Promise<number> {
  if (!o.catalog) {
    io.err(
      "Usage: atticus ci drift [repo-dir] --catalog <metarepo or catalog folder> [--repo <id>] [--json [file]] [--junit <file>] [--summary <file>] [--warn-only]",
    );
    return 2;
  }
  try {
    const r = await repoDrift({
      repoDir,
      catalog: o.catalog,
      ...(o.repo ? { repo: o.repo } : {}),
      ...(o.warnOnly ? { warnOnly: true } : {}),
      ...(deps.commit ? { commit: deps.commit } : {}),
      ...(deps.git ? { git: deps.git } : {}),
    });
    const put = async (file: string, text: string) => {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, text, "utf8");
    };
    if (typeof o.json === "string") await put(o.json, driftJson(r));
    if (o.junit) await put(o.junit, driftJUnit(r));
    if (o.summary) {
      await mkdir(dirname(o.summary), { recursive: true });
      await appendFile(o.summary, driftMarkdown(r), "utf8");
    }
    if (o.json === true) io.out(driftJson(r).trimEnd());
    else lines(io, driftMarkdown(r));
    return driftExitCode(r);
  } catch (e) {
    if (e instanceof DriftError) {
      io.err(e.message);
      return 2;
    }
    throw e;
  }
}

/** atticus ci snippet <github|azure|gitlab|jenkins> [--write <repo-dir>] */
export async function ciSnippet(
  kind: string | undefined,
  io: Output,
  o: { write?: string } = {},
): Promise<number> {
  const s = kind ? pipelineSnippet(kind) : undefined;
  if (!s) {
    io.err(`Usage: atticus ci snippet <${SNIPPET_KINDS.join("|")}> [--write <repo-dir>]`);
    return 2;
  }
  if (o.write) {
    const file = join(o.write, ...s.path.split("/"));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, s.content, "utf8");
    io.out(`Wrote ${s.path}. Set the variables its first lines name, then commit it.`);
    return 0;
  }
  lines(io, s.content);
  return 0;
}

/** atticus ci archive-gate <change> [--drift <report.json>...] [--json] */
export async function ciArchiveGate(
  root: string,
  changeId: string | undefined,
  o: { drift?: string[]; json?: boolean },
  io: Output,
  deps: QualityDeps = {},
): Promise<number> {
  if (!changeId) {
    io.err("Usage: atticus ci archive-gate <change> [--drift <report.json>...] [--json]");
    return 2;
  }
  let r;
  try {
    r = await archiveGate(root, changeId, {
      ...(o.drift?.length ? { driftReports: o.drift } : {}),
      ...(deps.commit ? { commit: deps.commit } : {}),
    });
  } catch (e) {
    if (e instanceof Error && e.name === "ChangeFileError") {
      io.err(e.message);
      return 2;
    }
    throw e;
  }
  if (o.json) io.out(JSON.stringify(r, null, 2));
  else {
    io.out(
      r.pass
        ? `${changeId} may be archived: no blockers, builds passed and the catalog matches its repos.`
        : `${changeId} can't be archived yet (${plural(r.blockers.length, "blocker")}):`,
    );
    for (const b of r.blockers) io.out(`- ${b.message}`);
    for (const n of r.notes) io.out(n);
  }
  return r.pass ? 0 : 1;
}

// ------------------------------------------------------------------ glossary

const short = (s: string, n = 70) => (s.length <= n ? s : `${s.slice(0, n - 3)}...`);
const sourceOf = (flags: readonly string[] | undefined, confidence: string) =>
  confidence === "asserted"
    ? "person"
    : flags?.includes("ai-proposed")
      ? "ai"
      : flags?.includes("undefined")
        ? "code"
        : "wiki";

/** atticus glossary list [--json] */
export async function glossaryList(
  root: string,
  o: { json?: boolean },
  io: Output,
): Promise<number> {
  const g = await loadGlossary(root);
  for (const p of g.problems) io.err(p);
  if (o.json) {
    io.out(
      JSON.stringify(
        {
          terms: g.terms,
          conflicts: g.build.conflicts,
          hints: g.build.hints,
          synonyms: Object.fromEntries(
            g.build.entries.filter((e) => e.aliases.length).map((e) => [e.id, e.aliases]),
          ),
        },
        null,
        2,
      ),
    );
    return 0;
  }
  if (!g.terms.length) {
    io.out(
      "The glossary is empty: no wiki page defines a term and the catalog has no domain words yet.",
    );
    return 0;
  }
  for (const l of table(
    ["TERM", "ID", "FROM", "FLAGS", "DEFINITION"],
    g.terms.map((t) => [
      t.term,
      t.id,
      sourceOf(t.flags, t.confidence),
      (t.flags ?? []).join(","),
      short(t.definition),
    ]),
  ))
    io.out(l);
  io.out(
    `${plural(g.terms.length, "term")}, ${plural(g.build.conflicts.filter((c) => !c.resolved).length, "conflict")}.`,
  );
  return 0;
}

/** atticus glossary scan [--mode <mode>] [--json] */
export async function glossaryScan(
  root: string,
  o: { mode?: string; json?: boolean },
  io: Output,
  deps: QualityDeps = {},
): Promise<number> {
  try {
    const runtime = await runtimeOf(root, o.mode, deps);
    const r = await scanGlossary(root, {
      ...(runtime ? { runtime } : {}),
      ...(deps.now ? { now: deps.now() } : {}),
    });
    if (o.json) {
      for (const p of r.problems) io.err(p);
      io.out(
        JSON.stringify(
          {
            terms: r.terms.length,
            written: r.written,
            removed: r.removed,
            conflicts: r.build.conflicts,
            hints: r.build.hints,
            ...(r.propose
              ? { proposals: r.propose.proposals.length, discarded: r.propose.discarded }
              : {}),
          },
          null,
          2,
        ),
      );
      return 0;
    }
    printGlossaryScan(r, io);
    return 0;
  } catch (e) {
    return fail(io, e);
  }
}

function printGlossaryScan(r: ScanGlossaryResult, io: Output): void {
  for (const p of r.problems) io.err(p);
  const open = r.build.conflicts.filter((c) => !c.resolved);
  io.out(
    `The glossary has ${plural(r.terms.length, "term")}; ${plural(r.written.length, "file")} written and ${plural(r.removed.length, "file")} removed in catalog/generated.`,
  );
  if (r.propose)
    io.out(
      r.propose.waiting
        ? `The glossary definer is with your assistant (run ${r.propose.waiting}). When it is done, run: atticus handoff done ${r.propose.waiting}`
        : `The glossary definer proposed ${plural(r.propose.proposals.length, "definition")} (kept inferred until a person defines the term).`,
    );
  for (const d of r.propose?.discarded ?? [])
    if (d.term && !r.propose?.waiting) io.err(`Discarded ${d.term}: ${d.reason}`);
  for (const c of open) io.out(`Conflict: ${c.message}`);
  for (const h of r.build.hints) io.out(`Naming: ${h.message}`);
}

/**
 * The end of `glossary scan` in hand-off mode: `atticus handoff done` validated the glossary
 * definer's answer, so its definitions are saved as proposals and the glossary rebuilt, as a
 * model run's answer would have been.
 */
export async function completeGlossaryScan(
  root: string,
  run: Run,
  io: Output,
  deps: { now?: Date } = {},
): Promise<number> {
  try {
    const r = await completeGlossaryDefinitions(root, run, deps.now ? { now: deps.now } : {});
    printGlossaryScan(r, io);
    return 0;
  } catch (e) {
    return fail(io, e);
  }
}

async function decide(
  root: string,
  io: Output,
  make: (g: Awaited<ReturnType<typeof loadGlossary>>) => Parameters<typeof writeDecisions>[1],
  said: string,
): Promise<number> {
  try {
    const g = await loadGlossary(root);
    const ds = make(g);
    const files = await writeDecisions(join(g.catalogDir, "curated"), ds);
    await scanGlossary(root);
    io.out(
      `Wrote ${files.map((f) => `catalog/curated/${f}`).join(" and ")}: ${said}. Commit it so every scan keeps it.`,
    );
    return 0;
  } catch (e) {
    if (e instanceof GlossaryError) {
      io.err(e.message);
      return e.code === "invalid" ? 2 : 1;
    }
    throw e;
  }
}

/** atticus glossary define <term> <definition> [--by <handle>] [--owner <team>] */
export async function glossaryDefine(
  root: string,
  term: string | undefined,
  definition: string | undefined,
  o: { by?: string; owner?: string },
  io: Output,
): Promise<number> {
  if (!term || !definition || !o.by) {
    io.err('Usage: atticus glossary define <term> "<definition>" [--by <handle>] [--owner <team>]');
    return 2;
  }
  return decide(
    root,
    io,
    (g) => {
      const existing = g.terms.find((t) => t.id === resolveTermId(term));
      return [
        defineDecision(term, definition, {
          by: o.by!,
          ...(o.owner ? { owner: o.owner } : {}),
          ...(existing ? { existing } : {}),
        }),
      ];
    },
    `${resolveTermId(term)} is defined and asserted`,
  );
}

/** atticus glossary link <term> <record-id | schema#field | feature> [--by <handle>] */
export async function glossaryLink(
  root: string,
  term: string | undefined,
  recordId: string | undefined,
  o: { by?: string },
  io: Output,
): Promise<number> {
  if (!term || !recordId || !o.by) {
    io.err("Usage: atticus glossary link <term> <record-id | schema#field> [--by <handle>]");
    return 2;
  }
  return decide(
    root,
    io,
    (g) => {
      const id = resolveTermId(term);
      const t = g.terms.find((x) => x.id === id);
      if (!t)
        throw new GlossaryError(
          "not-found",
          `There is no term ${id}. Define it first: atticus glossary define`,
        );
      return [linkDecision(t, recordId, g.base, { by: o.by! })];
    },
    `${recordId} is linked to ${resolveTermId(term)}`,
  );
}

/** atticus glossary alias <term> <other name>... [--by <handle>] */
export async function glossaryAlias(
  root: string,
  term: string | undefined,
  names: string[],
  o: { by?: string },
  io: Output,
): Promise<number> {
  if (!term || !names.length || !o.by) {
    io.err('Usage: atticus glossary alias <term> "<other name>"... [--by <handle>]');
    return 2;
  }
  return decide(
    root,
    io,
    (g) => {
      const id = resolveTermId(term);
      const before = g.build.entries.find((e) => e.id === id)?.aliases ?? [];
      return [aliasDecision(id, [...before, ...names], { by: o.by! })];
    },
    `${names.join(", ")} ${names.length === 1 ? "is another name" : "are other names"} for ${resolveTermId(term)}`,
  );
}
