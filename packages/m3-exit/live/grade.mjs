#!/usr/bin/env node
// Grade the runs prepare.mjs built, after fresh agent sessions have worked in them.
//
//   node packages/m3-exit/live/grade.mjs <outDir>
//
// Prints, for each AI-graded exit, a pass or fail with a reason for every run and the 4-of-5
// verdict, and writes <outDir>/grades.json and <outDir>/for-a-person.md. The answers come from
// the repository (fixtures/forge-change/expected), never from a run.
//
//   a  story writer          `plan bar --eval fixtures/forge-change/expected/stories.yaml`
//   b  critic AI lenses      round 1 at the plan gate as the agent's own `handoff done` runs left
//                            it, compared with expected/findings.yaml by the suite's match rule
//   c  task runner           task 1.2 built, `drift` says "No drift.", `trace` links code to s2
//   d  code-and-test lens    the lens ran at hand-up and raised no blocking finding
//   e  namers, glossary,     collected into for-a-person.md; no pass or fail
//      templates
//
// Why b reads the round as it is: `atticus handoff done <run>` on a critic lens parses the
// answer with the critic's own lens parser (findings whose quotes are not on the cited line are
// dropped, defences apply) and writes the findings into the round that was waiting, so the grader
// needs no critic run of its own.
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import {
  assertBuilt,
  atticus,
  CHANGE,
  changeDirOf,
  matches,
  metarepoOf,
  readYaml,
  runFolders,
} from "./common.mjs";
import { FORGE_CHANGE } from "./estate.mjs";

export const EXITS = {
  a: "Story writer meets the story bar",
  b: "Critic AI lenses catch the judgement-only seeded problems",
  c: "Run with AI (task runner)",
  d: "Code-and-test lens at hand-up",
  e: "Feature namer, test namer, glossary definer, template drafter (for a person)",
};

const exists = (p) =>
  stat(p).then(
    () => true,
    () => false,
  );
const pass = (reason, details = {}) => ({ pass: true, reason, details });
const fail = (reason, details = {}) => ({ pass: false, reason, details });

async function yamlFiles(dir) {
  const names = (await readdir(dir).catch(() => [])).filter((n) => n.endsWith(".yaml")).sort();
  return Promise.all(names.map(async (n) => [n, parse(await readFile(join(dir, n), "utf8"))]));
}

// ------------------------------------------------------------------ a: story writer

async function gradeStories(runDir) {
  const root = metarepoOf(runDir, "stories");
  if (!(await exists(root))) return fail("the sandbox is missing");
  if (!(await exists(join(changeDirOf(root), "tasks.md"))))
    return fail("no tasks.md: `plan stories --resume` did not complete");
  const r = await atticus(root, [
    ...["plan", "bar", CHANGE, "--eval", join(FORGE_CHANGE, "expected/stories.yaml"), "--json"],
  ]);
  let bar;
  try {
    bar = JSON.parse(r.stdout);
  } catch {
    return fail(`plan bar printed no result: ${r.text.trim().split("\n")[0] ?? ""}`);
  }
  const covered = bar.gaps.filter((g) => g.covered).length;
  const summary = `${bar.ready.passed} of ${bar.ready.total} stories ready (${Math.round(bar.ready.rate * 100)}%, bar ${Math.round(bar.ready.min * 100)}%); ${covered} of ${bar.gaps.length} gaps covered; ${bar.invented.length} invented name${bar.invented.length === 1 ? "" : "s"}`;
  const details = { ready: bar.ready, gaps: bar.gaps, invented: bar.invented };
  if (bar.met) return pass(summary, details);
  const why = [
    ...bar.stories.filter((s) => !s.ready).map((s) => `${s.id}: ${s.problems.join("; ")}`),
    ...bar.gaps.filter((g) => !g.covered).map((g) => `gap ${g.id} not covered`),
    ...bar.outline,
    ...bar.regressions,
  ];
  return fail(`${summary}${why.length ? `; ${why.slice(0, 3).join(" | ")}` : ""}`, details);
}

// ------------------------------------------------------------------ b: critic AI lenses

async function gradeCritic(runDir) {
  const root = metarepoOf(runDir, "critic");
  if (!(await exists(root))) return fail("the sandbox is missing");
  const roundDir = join(changeDirOf(root), "review/plan/1");
  const meta = await readYaml(join(roundDir, "meta/round.yaml")).catch(() => undefined);
  if (!meta)
    return fail("the critic was never run at the plan gate (no review/plan/1/meta/round.yaml)");
  const found = (await yamlFiles(roundDir)).map(([, f]) => f);
  const ex = await readYaml(join(FORGE_CHANGE, "expected/findings.yaml"));
  const caught = (list) => list.filter((s) => found.some((f) => matches(s, f)));
  const blocking = ex.seeded.filter((s) => s.severity === "blocking");
  const gaps = ex.seeded.filter((s) => s.kind === "knowledge-gap");
  const blockingHit = caught(blocking);
  const gapsHit = caught(gaps);
  const listed = [...ex.seeded, ...ex.alsoExpected];
  const unlisted = found.filter((f) => !listed.some((s) => matches(s, f))).map((f) => f.summary);
  const lenses = (meta.lenses ?? []).filter((l) => l.lens !== "release");
  if (lenses.length === 0) return fail("round 1 has no AI lens (the critic ran without --mode)");
  const ranLenses = lenses.filter((l) => l.state === "ran").length;
  const named = (state) =>
    lenses
      .filter((l) => l.state === state)
      .map((l) => l.lens)
      .join(", ");
  const missedBlocking = blocking.filter((s) => !blockingHit.includes(s)).map((s) => s.id);
  const gapRate = gapsHit.length / gaps.length;
  const discarded = meta.discarded ?? [];
  const parts = [
    `${blockingHit.length} of ${blocking.length} blocking${missedBlocking.length ? ` (missed ${missedBlocking.join(", ")})` : ""}`,
    `${gapsHit.length} of ${gaps.length} gaps (${Math.round(gapRate * 100)}%)`,
    `${ranLenses} of ${lenses.length} lenses ran${
      lenses.some((l) => l.state === "failed")
        ? ` (failed: ${named("failed")})`
        : lenses.some((l) => l.state === "waiting")
          ? ` (still waiting, handoff done not run: ${named("waiting")})`
          : ""
    }`,
    `${unlisted.length} unlisted (for a person to review)`,
  ];
  if (discarded.length)
    parts.push(
      `${discarded.length} AI finding(s) discarded (quote not on the line, unknown rule, …)`,
    );
  const details = {
    blockingMissed: missedBlocking,
    gapsMissed: gaps.filter((s) => !gapsHit.includes(s)).map((s) => s.id),
    unlisted,
    discarded,
    lenses,
  };
  // The exit is every seeded blocking issue and at least 90% of seeded gaps. Findings the
  // fixture doesn't list aren't wrong by definition (a lens may see a real extra problem), so
  // they are listed for a person to judge, not counted against the run.
  const ok = missedBlocking.length === 0 && gapRate >= 0.9;
  return (ok ? pass : fail)(parts.join("; "), details);
}

// ------------------------------------------------------------------ c: task runner

async function gradeTask(runDir) {
  const root = metarepoOf(runDir, "task");
  if (!(await exists(root))) return fail("the sandbox is missing");
  const dir = changeDirOf(root);
  const rec = await readYaml(join(dir, "tasks/1.2/task-run.yaml")).catch(() => undefined);
  if (!rec) return fail("task 1.2 was never run (no tasks/1.2/task-run.yaml)");
  if (rec.state !== "built")
    return fail(
      `task 1.2 ended ${rec.state}${rec.state === "waiting" ? " (handoff done not run, or the build still fails)" : ""}`,
      { state: rec.state },
    );
  const attempts = rec.attempts?.length ?? 0;
  const drift = await atticus(root, ["drift", CHANGE]);
  const noDrift = drift.out.includes("No drift.");
  const trace = await atticus(root, ["trace", CHANGE, "--json", "--no-write"]);
  let rows;
  try {
    rows = JSON.parse(trace.stdout).rows;
  } catch {
    return fail(
      `built in ${attempts} attempt(s); trace printed no result: ${trace.text.trim().split("\n")[0] ?? ""}`,
    );
  }
  const linked = rows.some((r) => r.story === "s2-remaining-limit" && r.code.length > 0);
  const reason = `built in ${attempts} attempt${attempts === 1 ? "" : "s"}; ${noDrift ? "No drift." : `drift: ${drift.out.slice(-1)[0] ?? drift.text.trim()}`}; trace ${linked ? "links code to s2" : "has no code for s2"}`;
  return (noDrift && linked ? pass : fail)(reason, { attempts, noDrift, linked });
}

// ------------------------------------------------------------------ d: code-and-test lens at hand-up

async function gradeHandup(runDir) {
  const root = metarepoOf(runDir, "handup");
  if (!(await exists(root))) return fail("the sandbox is missing");
  const dir = changeDirOf(root);
  const runs = (await yamlFiles(join(dir, "tasks/1.2/runs"))).map(([, r]) => r);
  const lens = runs.find((r) => r.agent === "code-and-test-critic");
  if (!lens)
    return fail(
      "the code-and-test lens never ran (spec hand-up not run, or its hand-off not finished)",
    );
  if (lens.state !== "validated")
    return fail(
      `the code-and-test lens run ended ${lens.state}: ${(lens.errors ?? []).join("; ")}`,
    );
  const findings = [];
  const base = join(dir, "review/hand-up");
  for (const round of await readdir(base).catch(() => []))
    for (const [, f] of await yamlFiles(join(base, round)))
      if (String(f.artifact).startsWith("tasks/1.2/")) findings.push(f);
  const blocking = findings.filter((f) => f.severity === "blocking" && f.state === "open");
  const reason = `the lens ran; ${findings.length} finding${findings.length === 1 ? "" : "s"} on task 1.2, ${blocking.length} blocking`;
  return (blocking.length === 0 ? pass : fail)(
    blocking.length ? `${reason}: ${blocking.map((f) => f.summary).join(" | ")}` : reason,
    { findings: findings.map((f) => ({ severity: f.severity, summary: f.summary })) },
  );
}

// ------------------------------------------------------------------ e: for a person

const cell = (v) =>
  String(v ?? "")
    .replace(/\s*\n\s*/g, " ")
    .replace(/\|/g, "\\|");

/** The feature name proposals of a run as a table: [file, yaml text] pairs in, Markdown out. */
function featureTable(files) {
  const rows = files.map(([, text]) => {
    const p = parse(text);
    return `| ${cell(p.feature)} | ${cell(p.name)} | ${cell((p.tags ?? []).join(", "))} | ${cell(p.description)} |`;
  });
  return [
    "| Feature | Proposed name | Tags | Description |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

const fence = (text) => `\`\`\`yaml\n${text.trimEnd()}\n\`\`\`\n`;

async function collectNames(runDir) {
  const root = metarepoOf(runDir, "names");
  if (!(await exists(root))) return { complete: false, reason: "the sandbox is missing", md: {} };
  const read = (p) => readFile(p, "utf8").catch(() => undefined);
  const features = [];
  const capDir = join(root, "catalog/proposals/capability");
  for (const n of (await readdir(capDir).catch(() => [])).filter((x) => x.endsWith(".yaml")).sort())
    features.push([n, await readFile(join(capDir, n), "utf8")]);
  const names = await read(join(changeDirOf(root), "tests/s2-remaining-limit/names.yaml"));
  const testDir = join(changeDirOf(root), "tests/s2-remaining-limit");
  const manifest = await read(join(testDir, "manifest.yaml"));
  const glossary = await read(
    join(root, "openspec/changes/glossary/catalog/proposals/glossary-definitions.yaml"),
  );
  const prose = await read(join(root, "openspec/changes/org-pack/proposals/templates/prose.yaml"));
  const summary = await read(join(root, "proposals/templates/SUMMARY.md"));
  const have = {
    features: features.length > 0,
    "test names": names !== undefined && manifest !== undefined,
    glossary: glossary !== undefined,
    templates: prose !== undefined && summary !== undefined,
  };
  const missing = Object.entries(have)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  return {
    complete: missing.length === 0,
    reason: missing.length
      ? `missing: ${missing.join(", ")}`
      : `collected ${features.length} feature name proposal${features.length === 1 ? "" : "s"}, test names, glossary definitions and template prose`,
    md: { features, names, glossary, prose, summary },
  };
}

function forAPerson(collected) {
  const out = [
    "# Outputs for a person to grade",
    "",
    "These are the answers the live runs wrote for the exits that need a person's judgement. Nothing here is pass or fail until a person says so. A run's exit passes when its outputs are accepted with wording-only edits and the deterministic parts are unchanged; the exit needs 4 of 5 runs.",
    "",
    "- **Feature namer**: are the names for feature.transfers, feature.payments, feature.account-balance and feature.daily-entries-report ones a Forge person would accept? Check each against the ADO stories (`fixtures/forge/inputs/tickets`) and the wiki pages (`fixtures/forge/inputs/wiki`): the description says only what the evidence shows, the tags fit, nothing is invented.",
    "- **Test namer**: do the scenario, case and data names read as a tester would write them, and do they match the cases of the story (`tests/s2-remaining-limit/manifest.yaml` lists them)?",
    "- **Glossary definer**: is each definition one sentence, true to how the code uses the term, nothing invented?",
    "- **Template drafter**: is the prose of each request template and procedure clear, and does it agree with the how-to pages and tickets it came from?",
    "",
  ];
  const sections = [
    [
      "Feature namer (catalog/proposals/capability/*.yaml)",
      (c) => (c.features.length ? featureTable(c.features) : undefined),
    ],
    [
      "Test namer (tests/s2-remaining-limit/names.yaml)",
      (c) => (c.names ? fence(c.names) : undefined),
    ],
    [
      "Glossary definer (the answer file; `handoff done` saves its definitions as proposals)",
      (c) => (c.glossary ? fence(c.glossary) : undefined),
    ],
    ["Template drafter (prose.yaml)", (c) => (c.prose ? fence(c.prose) : undefined)],
  ];
  for (const [title, render] of sections) {
    out.push(`## ${title}`, "");
    for (const [run, c] of collected) {
      out.push(`### ${run}`, "");
      const text = c.md.features ? render(c.md) : undefined;
      out.push(text && text.length ? text : "_Not written._", "");
    }
  }
  return out.join("\n");
}

// ------------------------------------------------------------------ the whole grade

const GRADERS = { a: gradeStories, b: gradeCritic, c: gradeTask, d: gradeHandup };

/** The runs needed: 4 of 5, or the same share of fewer runs. */
export const required = (total) => Math.ceil((total * 4) / 5);

export async function grade(outDir) {
  assertBuilt();
  const out = resolve(outDir);
  const runs = await runFolders(out);
  if (runs.length === 0) throw new Error(`${out} holds no run-N folders; run prepare.mjs first`);
  const result = { generatedAt: new Date().toISOString(), outDir: out, runs, exits: {} };
  for (const [id, fn] of Object.entries(GRADERS)) {
    const results = [];
    for (const run of runs) {
      let r;
      try {
        r = await fn(join(out, run));
      } catch (e) {
        r = fail(`the grader failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      results.push({ run, ...r });
    }
    const passed = results.filter((r) => r.pass).length;
    const need = required(runs.length);
    result.exits[id] = {
      name: EXITS[id],
      passed,
      total: runs.length,
      required: need,
      verdict: passed >= need ? "PASS" : "FAIL",
      provisional: runs.length !== 5,
      results,
    };
  }
  const collected = [];
  for (const run of runs) collected.push([run, await collectNames(join(out, run))]);
  result.exits.e = {
    name: EXITS.e,
    verdict: "FOR A PERSON",
    file: join(out, "for-a-person.md"),
    results: collected.map(([run, c]) => ({ run, complete: c.complete, reason: c.reason })),
  };
  await writeFile(join(out, "grades.json"), `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(join(out, "for-a-person.md"), forAPerson(collected));
  return result;
}

/** The report, as lines to print. */
export function report(result) {
  const lines = [];
  for (const [id, x] of Object.entries(result.exits)) {
    lines.push(`Exit ${id}: ${x.name}`);
    const w = Math.max(...x.results.map((r) => r.run.length));
    for (const r of x.results) {
      const mark = id === "e" ? (r.complete ? "READY" : "INCOMPLETE") : r.pass ? "PASS" : "FAIL";
      lines.push(`  ${r.run.padEnd(w)}  ${mark.padEnd(10)}  ${r.reason}`);
    }
    if (id === "e") lines.push(`  Verdict: ${x.verdict}: read ${x.file}`);
    else
      lines.push(
        `  Verdict: ${x.verdict}: ${x.passed} of ${x.total} runs passed; the exit needs ${x.required}${x.provisional ? ` (defined on 5 runs; ${x.total} run${x.total === 1 ? "" : "s"} is provisional)` : ""}`,
      );
    lines.push("");
  }
  return lines;
}

async function cli(argv) {
  if (argv.length !== 1 || argv[0].startsWith("-")) {
    console.error("Usage: node packages/m3-exit/live/grade.mjs <outDir>");
    return 2;
  }
  try {
    const result = await grade(argv[0]);
    for (const l of report(result)) console.log(l);
    console.log(
      `Wrote ${join(result.outDir, "grades.json")} and ${join(result.outDir, "for-a-person.md")}`,
    );
    return Object.values(result.exits).every(
      (x) => x.verdict === "PASS" || x.verdict === "FOR A PERSON",
    )
      ? 0
      : 1;
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await cli(process.argv.slice(2));
