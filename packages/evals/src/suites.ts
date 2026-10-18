import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { buildContextPack, type AiRuntime } from "@maycombhq/ai";
import { cliMarkdown, gradeDialect, kindsMarkdown } from "@maycombhq/assistant-kit";
import { AgentDefinition, ServiceRequestTemplate, type CatalogRecord } from "@maycombhq/core";
import { detectFeatures, nameFeatures, type Capability } from "@maycombhq/features";
import { buildGlossary, proposeDefinitions, undefinedCodeTerms } from "@maycombhq/glossary";
import { BUILT_IN_CHECKS, runCritic } from "@maycombhq/naysayer";
import {
  draftTemplates,
  planStories,
  readStoryEval,
  snowDraft,
  storyBar,
} from "@maycombhq/planner";
import { generateTests } from "@maycombhq/testgen";
import {
  forgeChangeRoot,
  forgePages,
  forgeRecords,
  SEEDED_CHANGE,
  templatesRoot,
  testgenRoot,
} from "./fixtures.js";
import { citesWithin, count, covers, exact, fromItems, quotesExist, rubric } from "./graders.js";
import type { CaseOutcome, EvalCase, Grade } from "./types.js";

/**
 * One builder per agent family. Each turns a dataset case (params and expectations, from
 * `datasets/*.yaml`) into a runnable case: `run` calls the owning package's real entry point
 * with the eval's runtime, so the prompt is exactly what that agent sends in production (and
 * a replay recording keyed by that prompt still matches); `grade` scores what the package's
 * own evidence-bounded parser kept.
 */

export interface CaseDef {
  id: string;
  agent: string;
  description: string;
  modes: EvalCase["modes"];
  aiGraded: boolean;
  tags: string[];
  params: Record<string, unknown>;
  expect: Record<string, unknown>;
  /** The mock runtime's answers, by agent id. */
  reference?: Record<string, string>;
  /** Folder of replay recordings. */
  recordings?: string;
  source: string;
}

export type SuiteBuilder = (def: CaseDef, repoRoot: string) => EvalCase;

const nowIso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const fail = (e: unknown): CaseOutcome => ({
  state: "failed",
  kept: [],
  discarded: [],
  error: (e as Error).message,
});
const str = (v: unknown, d = "") => (typeof v === "string" ? v : d);
const strs = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);

function base(def: CaseDef): Omit<EvalCase, "run" | "grade"> {
  return {
    id: def.id,
    agent: def.agent,
    description: def.description,
    source: def.source,
    modes: def.modes,
    aiGraded: def.aiGraded,
    tags: def.tags,
    ...(def.reference ? { reference: def.reference } : {}),
    ...(def.recordings ? { recordings: def.recordings } : {}),
  };
}

const stateOf = (s: string | undefined): CaseOutcome["state"] =>
  s === "waiting" || s === "prepared"
    ? "waiting"
    : s === "failed" || s === "cancelled"
      ? "failed"
      : "ran";

/** Graders every case can ask for: how many outputs were kept and thrown away. */
function counts(def: CaseDef, o: CaseOutcome): Grade[] {
  const out: Grade[] = [];
  const e = def.expect;
  if (typeof e.minKept === "number" || typeof e.maxKept === "number")
    out.push(
      count("kept", o.kept.length, {
        ...(typeof e.minKept === "number" ? { min: e.minKept } : {}),
        ...(typeof e.maxKept === "number" ? { max: e.maxKept } : {}),
      }),
    );
  if (typeof e.minDiscarded === "number" || typeof e.maxDiscarded === "number")
    out.push(
      count("discarded", o.discarded.length, {
        ...(typeof e.minDiscarded === "number" ? { min: e.minDiscarded } : {}),
        ...(typeof e.maxDiscarded === "number" ? { max: e.maxDiscarded } : {}),
      }),
    );
  return out;
}

// ------------------------------------------------------------------ critic lenses

interface ExpectedFinding {
  id: string;
  kind: string;
  severity: string;
  layer: string;
  rule: string;
  artifact?: string;
  line?: number;
}

interface KeptFinding {
  rule: string;
  kind: string;
  severity: string;
  artifact: string;
  line?: number;
  lens: string;
  evidence: { path: string; line?: number; quote?: string }[];
}

const matches = (e: ExpectedFinding, f: KeptFinding) =>
  f.rule === e.rule &&
  f.severity === e.severity &&
  f.kind === e.kind &&
  (!e.artifact || f.artifact === e.artifact) &&
  (!e.line || f.line === e.line);

/**
 * A critic lens on the forge-change fixture at the plan gate. Ground truth: the AI-layer
 * entries of `fixtures/forge-change/expected/findings.yaml` whose rules the lens applies.
 * Params: lens, gate; `inject` adds text to an artifact (adversarial cases).
 */
export const criticLens: SuiteBuilder = (def, repoRoot) => ({
  ...base(def),
  async run(ctx) {
    try {
      const root = await forgeChangeRoot(repoRoot, { dir: await ctx.tmp() });
      const inject = def.params.inject as { artifact: string; text: string } | undefined;
      if (inject) {
        const p = join(root, "openspec/changes", SEEDED_CHANGE, inject.artifact);
        await writeFile(p, (await readFile(p, "utf8")).trimEnd() + "\n\n" + inject.text + "\n");
      }
      const seen: { dropped: { id: string; reason: string }[] }[] = [];
      const runtime = spy(ctx.runtime, (pack) => seen.push({ dropped: pack.manifest.dropped }));
      const lens = str(def.params.lens);
      // Layer 1's no-embedded-instructions check also finds an injected instruction (it shares
      // the pack defences' detector) and would keep the artifact out of the lens altogether.
      // These cases measure the lens's own defences, so that one check stands aside.
      const standAside = inject
        ? BUILT_IN_CHECKS.filter((c) => c.id === "no-embedded-instructions").map((c) => ({
            ...c,
            run: () => ({ hits: [], subjects: [] }),
          }))
        : [];
      const r = await runCritic(root, SEEDED_CHANGE, {
        now: nowIso(ctx.now),
        runtime,
        lenses: [lens as never],
        checks: standAside,
        ...(def.params.gate ? { gate: str(def.params.gate) } : {}),
      });
      const run = r.lenses.find((l) => l.lens === lens);
      const kept: KeptFinding[] = r.findings
        .filter((f) => f.layer === "ai")
        .map((f) => ({
          rule: f.finding.rule,
          kind: f.finding.kind,
          severity: f.finding.severity,
          artifact: f.finding.artifact,
          ...(f.finding.locator.line ? { line: f.finding.locator.line } : {}),
          lens: f.finding.lens,
          evidence: f.finding.evidence
            .filter((e) => e.path)
            .map((e) => ({
              path: e.path!,
              ...(e.line ? { line: e.line } : {}),
              ...(e.quote ? { quote: e.quote } : {}),
            })),
        }));
      const changeDir = join(root, "openspec/changes", SEEDED_CHANGE);
      const lines: Record<string, string[]> = {};
      for (const f of kept)
        for (const e of f.evidence)
          lines[e.path] ??= (await readFile(join(changeDir, e.path), "utf8").catch(() => "")).split(
            "\n",
          );
      return {
        state: run?.state === "failed" ? "failed" : "ran",
        ...(run?.promptSha256 ? { promptSha256: run.promptSha256 } : {}),
        kept,
        discarded: r.discarded.map((d) => ({
          reason: d.reason,
          ...(d.summary ? { summary: d.summary } : {}),
        })),
        extra: {
          rules: run?.rules ?? [],
          lines,
          quarantined: seen.flatMap((s) =>
            s.dropped.filter((d) => d.reason.startsWith("quarantined:")).map((d) => d.id),
          ),
        },
        ...(run?.state === "failed" && run.reason ? { error: run.reason } : {}),
      };
    } catch (e) {
      return fail(e);
    }
  },
  async grade(o) {
    const g: Grade[] = [...counts(def, o)];
    const kept = o.kept as KeptFinding[];
    const lines = (o.extra?.lines ?? {}) as Record<string, string[]>;
    g.push(
      quotesExist(
        "quotes are on their lines",
        kept.flatMap((f) => f.evidence),
        (p) => lines[p],
      ),
    );
    const file = str(def.expect.expectedFrom);
    if (file) {
      const doc = parse(readFileSync(join(repoRoot, file), "utf8")) as {
        seeded: ExpectedFinding[];
        alsoExpected?: ExpectedFinding[];
      };
      const rules = new Set((o.extra?.rules ?? []) as string[]);
      const all = [...doc.seeded, ...(doc.alsoExpected ?? [])].filter((e) => e.layer === "ai");
      const mine = all.filter((e) => rules.has(e.rule));
      g.push(
        fromItems(
          "every expected AI finding of this lens is raised",
          "structural",
          mine.map((e) => ({
            name: e.id,
            ok: kept.some((f) => matches(e, f)),
            note: "not raised",
          })),
        ),
      );
      g.push(
        fromItems(
          "nothing raised that the expected file doesn't list",
          "structural",
          kept.length
            ? kept.map((f) => ({
                name: `${f.rule} ${f.artifact}`,
                ok: all.some((e) => matches(e, f)),
                note: "unlisted",
              }))
            : [{ name: "none", ok: true }],
        ),
      );
    }
    const q = strs(def.expect.quarantined);
    if (q.length)
      g.push(
        fromItems(
          "injected sources are quarantined before the model sees them",
          "evidence",
          q.map((name) => ({
            name,
            ok: ((o.extra?.quarantined ?? []) as string[]).some((id) => id.includes(name)),
            note: "reached the model",
          })),
        ),
      );
    return g;
  },
});

/** Wrap a runtime to see each context pack it is given (for quarantine checks). */
function spy(
  rt: AiRuntime,
  onPack: (pack: Parameters<AiRuntime["prepare"]>[0]["pack"]) => void,
): AiRuntime {
  return {
    kind: rt.kind,
    prepare: (req) => {
      onPack(req.pack);
      return rt.prepare(req);
    },
    run: (id, signal) => rt.run(id, signal),
    result: (id) => rt.result(id),
  };
}

// ------------------------------------------------------------------ story writer

/**
 * The story writer: plan stories from the approved design of the forge-change fixture, draft
 * the service-desk requests, run the critic's rule layer, then measure the story bar against
 * `fixtures/forge-change/expected/stories.yaml` (ready stories, gaps covered, nothing invented).
 */
export const storyWriter: SuiteBuilder = (def, repoRoot) => ({
  ...base(def),
  async run(ctx) {
    try {
      const root = await forgeChangeRoot(repoRoot, { plan: false, dir: await ctx.tmp() });
      const r = await planStories(root, SEEDED_CHANGE, { runtime: ctx.runtime, now: ctx.now });
      if (r.state === "waiting") return { state: "waiting", kept: [], discarded: [] };
      await snowDraft(root, SEEDED_CHANGE);
      await runCritic(root, SEEDED_CHANGE, { now: nowIso(ctx.now) });
      const evalFile = str(def.expect.storyEval);
      const bar = await storyBar(
        root,
        SEEDED_CHANGE,
        evalFile ? { eval: await readStoryEval(join(repoRoot, evalFile)) } : {},
      );
      return {
        state: stateOf(r.run?.state),
        ...(r.promptSha256 ? { promptSha256: r.promptSha256 } : {}),
        kept: [...r.prose.keys()].filter((k) => !r.fallback.includes(k)),
        discarded: r.discarded.map((d) => ({ reason: d.reason, ...(d.id ? { id: d.id } : {}) })),
        extra: { bar, fallback: r.fallback, stories: r.skeleton.stories.map((s) => s.id) },
      };
    } catch (e) {
      return fail(e);
    }
  },
  async grade(o) {
    const g: Grade[] = [...counts(def, o)];
    const bar = o.extra?.bar as Awaited<ReturnType<typeof storyBar>> | undefined;
    if (!bar)
      return [
        ...g,
        {
          grader: "story bar",
          kind: "structural",
          pass: false,
          score: 0,
          notes: [o.error ?? "no story bar"],
        },
      ];
    g.push(
      covers("every story has AI prose", o.kept as string[], (o.extra?.stories ?? []) as string[]),
    );
    g.push(
      fromItems(
        "every story meets definition of ready",
        "rubric",
        bar.stories.map((s) => ({
          name: s.id,
          ok: s.ready,
          note: s.problems?.join("; ") ?? "not ready",
        })),
        bar.ready.min,
      ),
    );
    g.push(
      fromItems(
        "every seeded gap is covered",
        "structural",
        bar.gaps.map((x) => ({ name: x.id, ok: x.covered, note: x.what })),
      ),
    );
    g.push(
      fromItems(
        "no invented systems or interfaces",
        "evidence",
        bar.invented.length
          ? bar.invented.map((x) => ({ name: x, ok: false }))
          : [{ name: "none", ok: true }],
      ),
    );
    return g;
  },
});

// ------------------------------------------------------------------ feature namer

/**
 * The feature namer on the features detected in the Forge expected catalog. Expected names
 * and tags are in the dataset; every proposal must cite records of its own feature.
 */
export const featureNamer: SuiteBuilder = (def, repoRoot) => ({
  ...base(def),
  async run(ctx) {
    try {
      const records = forgeRecords(repoRoot);
      const extra = (def.params.extraRecords ?? []) as Record<string, unknown>[];
      const features = detectFeatures(records);
      const r = await nameFeatures(
        features,
        [...records, ...(extra as CatalogRecord[])],
        ctx.runtime,
        { now: ctx.now },
      );
      const allowed: Record<string, string[]> = {};
      for (const f of features as Capability[])
        allowed[f.id] = [...new Set([...f.entryPoints, ...f.records])];
      return {
        state: stateOf(r.runs[0]?.summary?.state ?? r.runs[0]?.state),
        ...(r.runs[0]?.promptSha256 ? { promptSha256: r.runs[0].promptSha256 } : {}),
        kept: r.proposals,
        discarded: r.discarded.map((d) => ({
          reason: d.reason,
          ...(d.feature ? { feature: d.feature } : {}),
        })),
        extra: { allowed, features: features.map((f) => f.id) },
        ...(r.runs[0]?.state === "failed" ? { error: r.runs[0].reason ?? "failed" } : {}),
      };
    } catch (e) {
      return fail(e);
    }
  },
  async grade(o) {
    const g: Grade[] = [...counts(def, o)];
    const kept = o.kept as {
      feature: string;
      name: string;
      tags: string[];
      description?: string;
      evidence: string[];
    }[];
    const want = (def.expect.names ?? {}) as Record<string, string>;
    if (Object.keys(want).length)
      g.push(
        exact(
          "names as expected",
          Object.fromEntries(kept.map((p) => [p.feature, p.name]).sort()),
          Object.fromEntries(Object.entries(want).sort()),
        ),
      );
    if (def.expect.everyFeature)
      g.push(
        covers(
          "every detected feature is named",
          kept.map((p) => p.feature),
          (o.extra?.features ?? []) as string[],
        ),
      );
    g.push(
      rubric("names read like a product owner's", kept, (p) => p.feature, [
        {
          name: "has two to five words",
          test: (p) =>
            (p.name.split(/\s+/).length >= 2 && p.name.split(/\s+/).length <= 5) || `"${p.name}"`,
        },
        {
          name: "is in sentence case",
          test: (p) =>
            /^[A-Z][^A-Z]*$/.test(p.name.replace(/\b[A-Z]{2,}\b/g, "x")) || `"${p.name}"`,
        },
        {
          name: "has at most five lower-case tags",
          test: (p) =>
            (p.tags.length <= 5 && p.tags.every((t) => t === t.toLowerCase())) || p.tags.join(", "),
        },
      ]),
    );
    const allowed = (o.extra?.allowed ?? {}) as Record<string, string[]>;
    g.push(
      citesWithin(
        "every proposal cites its own feature's records",
        kept.map((p) => ({ id: p.feature, evidence: p.evidence })),
        (id) => new Set(allowed[id] ?? []),
      ),
    );
    return g;
  },
});

// ------------------------------------------------------------------ glossary definer

/** The glossary definer on Forge's code-only terms (no page or person defines them). */
export const glossaryDefiner: SuiteBuilder = (def, repoRoot) => ({
  ...base(def),
  async run(ctx) {
    try {
      const entries = undefinedCodeTerms(
        buildGlossary({ pages: forgePages(repoRoot), records: forgeRecords(repoRoot) }).entries,
      );
      const r = await proposeDefinitions(entries, ctx.runtime, { now: ctx.now });
      const allowed: Record<string, string[]> = {};
      for (const e of entries) allowed[e.id] = (e.code?.uses ?? []).map((u) => u.record);
      if (r.waiting) return { state: "waiting", kept: [], discarded: [] };
      return {
        state: stateOf(r.run?.state),
        ...(r.promptSha256 ? { promptSha256: r.promptSha256 } : {}),
        kept: r.proposals,
        discarded: r.discarded.map((d) => ({
          reason: d.reason,
          ...(d.term ? { term: d.term } : {}),
        })),
        extra: { allowed },
      };
    } catch (e) {
      return fail(e);
    }
  },
  async grade(o) {
    const g: Grade[] = [...counts(def, o)];
    const kept = o.kept as { term: string; definition: string; evidence: string[] }[];
    const terms = strs(def.expect.terms);
    if (terms.length)
      g.push(
        exact(
          "defines exactly the expected terms",
          kept.map((p) => p.term).sort(),
          [...terms].sort(),
        ),
      );
    g.push(
      rubric("definitions are one plain sentence", kept, (p) => p.term, [
        {
          name: "is one sentence",
          test: (p) =>
            (p.definition.trim().split(/(?<=[.!?])\s+/).length === 1 &&
              /[.!?]$/.test(p.definition.trim())) ||
            p.definition,
        },
        {
          name: "doesn't define the word by itself",
          test: (p) =>
            !new RegExp(`^${p.term.replace(/^term\./, "").replace(/-/g, " ")}\\b`, "i").test(
              p.definition,
            ) || p.definition,
        },
        {
          name: "is at most 30 words",
          test: (p) =>
            p.definition.split(/\s+/).length <= 30 || `${p.definition.split(/\s+/).length} words`,
        },
      ]),
    );
    const allowed = (o.extra?.allowed ?? {}) as Record<string, string[]>;
    g.push(
      citesWithin(
        "every definition cites records that use the term",
        kept.map((p) => ({ id: p.term, evidence: p.evidence })),
        (id) => new Set(allowed[id] ?? []),
      ),
    );
    return g;
  },
});

// ------------------------------------------------------------------ test writer

/** The test writer naming the tests generated for a story of the testgen fixture. */
export const testWriter: SuiteBuilder = (def, repoRoot) => ({
  ...base(def),
  async run(ctx) {
    try {
      const root = await testgenRoot(repoRoot);
      const r = await generateTests(root, SEEDED_CHANGE, str(def.params.story), {
        now: ctx.now,
        runtime: ctx.runtime,
      });
      const cases = r.model.repos.flatMap((x) => x.cases);
      return {
        state: r.names.waiting ? "waiting" : "ran",
        ...(r.names.promptSha256 ? { promptSha256: r.names.promptSha256 } : {}),
        // Cases the test writer named; the rest keep their deterministic title.
        kept:
          r.names.by === "ai"
            ? cases
                .filter((c) => c.name && c.name !== c.title)
                .map((c) => ({
                  id: c.id,
                  name: c.name!,
                  data: (c as { data?: { name: string } }).data?.name,
                }))
            : [],
        discarded: r.names.discarded.map((d) => ({
          reason: d.reason,
          ...(d.id ? { id: d.id } : {}),
        })),
        extra: { by: r.names.by, ids: cases.map((c) => c.id) },
      };
    } catch (e) {
      return fail(e);
    }
  },
  async grade(o) {
    const g: Grade[] = [...counts(def, o)];
    g.push(exact("names come from the test writer", o.extra?.by, "ai"));
    const kept = o.kept as { id: string; name: string; data?: string }[];
    const want = (def.expect.names ?? {}) as Record<string, string>;
    if (Object.keys(want).length)
      g.push(
        fromItems(
          "names as expected",
          "exact",
          Object.entries(want).map(([id, name]) => ({
            name: id,
            ok: kept.find((k) => k.id === id)?.name === name,
            note: `got "${kept.find((k) => k.id === id)?.name ?? ""}"`,
          })),
        ),
      );
    g.push(
      rubric("scenario names are short sentences", kept, (k) => k.id, [
        { name: "starts with a capital", test: (k) => /^[A-Z]/.test(k.name) || k.name },
        {
          name: "is at most 80 characters",
          test: (k) => k.name.length <= 80 || `${k.name.length} characters`,
        },
        {
          name: "has a data name that is an identifier",
          test: (k) => !k.data || /^[a-z][A-Za-z0-9]*$/.test(k.data) || k.data,
        },
      ]),
    );
    return g;
  },
});

// ------------------------------------------------------------------ template writer

/**
 * The template writer drafting Forge's firewall-rule request template from the how-to page and
 * past tickets. Ground truth: the org pack's own `firewall-rule.yaml` (read in place).
 */
export const templateWriter: SuiteBuilder = (def, repoRoot) => ({
  ...base(def),
  async run(ctx) {
    try {
      const root = await templatesRoot(repoRoot);
      let promptSha256: string | undefined;
      const runtime = spy(ctx.runtime, (pack) => (promptSha256 = pack.manifest.promptSha256));
      const r = await draftTemplates(root, { runtime, now: ctx.now });
      return {
        state: stateOf(r.run?.state),
        ...(promptSha256 ? { promptSha256 } : {}),
        kept: r.templates,
        discarded: r.problems.map((p) => ({ reason: p })),
        extra: { root, files: r.files },
      };
    } catch (e) {
      return fail(e);
    }
  },
  async grade(o) {
    const g: Grade[] = [...counts(def, o)];
    const drafts = o.kept as {
      id: string;
      template?: unknown;
      summary?: string;
      notes: string[];
    }[];
    const id = str(def.expect.template, "firewall-rule");
    const d = drafts.find((x) => x.id === id);
    const want = ServiceRequestTemplate.parse(
      parse(readFileSync(join(repoRoot, str(def.expect.expectedFile)), "utf8")),
    );
    g.push(exact(`the ${id} template matches the org pack's`, d?.template ?? null, want));
    g.push(
      rubric("the AI summary is there and plain", d ? [d] : [], (x) => x.id, [
        { name: "has a summary", test: (x) => !!x.summary?.trim() || "no summary" },
        {
          name: "summary is at most 60 words",
          test: (x) => (x.summary ?? "").split(/\s+/).length <= 60 || "too long",
        },
      ]),
    );
    const root = str(o.extra?.root);
    if (root) {
      const text = await readFile(
        join(root, `proposals/templates/process/snow/${id}.yaml`),
        "utf8",
      ).catch(() => "");
      const cited = text
        .split("\n")
        .filter((l) => /^(name|requestType|approvers|leadTimeDays| {2}- )/.test(l));
      g.push(
        fromItems(
          "every value cites its source",
          "evidence",
          cited.map((l) => ({
            name: l.split("#")[0]!.trim(),
            ok: /#.*(inputs\/|SR-)/.test(l),
            note: "no citation",
          })),
        ),
      );
    }
    return g;
  },
});

// ------------------------------------------------------------------ dialect writer

export const DIALECT_WRITER = AgentDefinition.parse({
  schemaVersion: 1,
  id: "dialect-writer",
  role: "platform-lead",
  description:
    "Writes a C2 dialect for an in-house framework from the dialect build kit and sample repos.",
  inputs: ["repo-code", "documents"],
  outputArtifact: "code",
  tokenBudget: 200_000,
  allowedRuntimes: ["hand-off", "model", "headless-claude-code", "mock", "replay"],
});

/**
 * Dialect writing from the kit: the agent gets the task, the kit's command and record-kind
 * references (trusted) and the sample repos (data), and writes a dialect file; the M2 exit
 * grader checks it against `fixtures/forge-dialect-eval` (held-out repo included).
 */
export const dialectWriter: SuiteBuilder = (def, repoRoot) => ({
  ...base(def),
  async run(ctx) {
    try {
      const evalDir = join(repoRoot, str(def.params.evalDir, "fixtures/forge-dialect-eval"));
      const files: { id: string; text: string }[] = [];
      const walk = async (d: string, rel: string) => {
        const { readdir } = await import("node:fs/promises");
        for (const e of (await readdir(d, { withFileTypes: true })).sort((a, b) =>
          a.name < b.name ? -1 : 1,
        )) {
          if (e.isDirectory()) await walk(join(d, e.name), `${rel}/${e.name}`);
          else
            files.push({ id: `${rel}/${e.name}`, text: await readFile(join(d, e.name), "utf8") });
        }
      };
      await walk(join(evalDir, "repos"), "repos");
      const pack = buildContextPack({
        change: "dialect-eval",
        agent: DIALECT_WRITER.id,
        budget: DIALECT_WRITER.tokenBudget,
        levels: ["public", "internal", "confidential", "restricted"],
        maxClassification: "internal",
        now: ctx.now,
        sources: [
          {
            id: "0-task",
            kind: "instruction",
            origin: "fixtures/forge-dialect-eval/TASK.md",
            text: await readFile(join(evalDir, "TASK.md"), "utf8"),
            classification: "public",
            trusted: true,
          },
          {
            id: "1-cli",
            kind: "instruction",
            origin: "kit/cli.md",
            text: cliMarkdown(),
            classification: "public",
            trusted: true,
          },
          {
            id: "2-kinds",
            kind: "instruction",
            origin: "kit/kinds.md",
            text: kindsMarkdown(),
            classification: "public",
            trusted: true,
          },
          {
            id: "3-output",
            kind: "instruction",
            origin: "atticus/evals",
            text: "Write only the dialect file's YAML.",
            classification: "public",
            trusted: true,
          },
          ...files.map((f) => ({
            id: f.id,
            kind: "code" as const,
            origin: f.id,
            text: f.text,
            classification: "internal",
          })),
        ],
      });
      const prepared = await ctx.runtime.prepare({
        change: "dialect-eval",
        agent: DIALECT_WRITER,
        pack,
        outputPath: "org-pack/dialects/forge-messaging.yaml",
      });
      const run = await ctx.runtime.run(prepared.runId);
      if (run.state === "waiting" || run.state === "prepared")
        return {
          state: "waiting",
          kept: [],
          discarded: [],
          promptSha256: pack.manifest.promptSha256,
        };
      if (run.output === undefined || run.state === "failed")
        return {
          state: "failed",
          kept: [],
          discarded: [],
          error: run.errors.join("; ") || "no output",
        };
      const dir = await ctx.tmp();
      await mkdir(join(dir, "org-pack/dialects"), { recursive: true });
      const file = join(dir, "org-pack/dialects/forge-messaging.yaml");
      // Fixture paths in the dialect's own tests point at the sample repos wherever the author
      // had them; point them at this eval's copy so only the rules are judged.
      const text = run.output
        .replace(/^```(?:ya?ml)?\s*\n|\n```\s*$/g, "")
        .replace(
          /^(\s*fixture:\s*)["']?\S*?(repos\/[A-Za-z0-9._-]+)["']?\s*$/gm,
          (_m, k: string, tail: string) => `${k}${join(evalDir, tail).split("\\").join("/")}`,
        );
      await writeFile(file, text, "utf8");
      const grade = await gradeDialect(file, evalDir);
      return {
        state: "ran",
        promptSha256: pack.manifest.promptSha256,
        output: run.output,
        kept: [grade],
        discarded: [],
      };
    } catch (e) {
      return fail(e);
    }
  },
  async grade(o) {
    const grade = (o.kept as Awaited<ReturnType<typeof gradeDialect>>[])[0];
    if (!grade)
      return [
        {
          grader: "dialect grade",
          kind: "structural",
          pass: false,
          score: 0,
          notes: [o.error ?? "no dialect"],
        },
      ];
    const repos = grade.repos.map((r) => ({
      repo: r.path,
      pass:
        r.matched === r.expected &&
        !r.missing.length &&
        !r.wrong.length &&
        !r.extra.length &&
        !r.rejected.length,
    }));
    return [
      {
        grader: "the dialect passes the M2 exit grader",
        kind: "structural",
        pass: grade.pass,
        score: grade.pass ? 1 : 0,
        notes: grade.pass
          ? []
          : [
              ...grade.problems,
              ...grade.tests.filter((t) => !t.passed).map((t) => `test ${t.name} fails`),
            ],
      },
      fromItems(
        "every repo gives exactly the expected records",
        "exact",
        repos.map((r) => ({ name: r.repo, ok: r.pass })),
      ),
    ];
  },
});

// ------------------------------------------------------------------ generic (organisation datasets)

/**
 * A self-contained case for any agent, for an organisation's own datasets
 * (`org-pack/evals/*.yaml`): trusted instructions and data sources inline, the answer graded
 * by phrases it must and must not contain, a word limit, and quotes (lines starting `> `)
 * that must appear in the data.
 */
export const generic: SuiteBuilder = (def) => ({
  ...base(def),
  async run(ctx) {
    try {
      const sources = (def.params.sources ?? []) as {
        id: string;
        kind?: string;
        text: string;
        trusted?: boolean;
      }[];
      const agent = AgentDefinition.parse({
        schemaVersion: 1,
        id: def.agent,
        role: str(def.params.role, "developer"),
        description: str(def.params.description, def.description),
        inputs: ["documents"],
        outputArtifact: "proposal",
        tokenBudget: Number(def.params.tokenBudget ?? 50_000),
        allowedRuntimes: ["hand-off", "model", "headless-claude-code", "mock", "replay"],
      });
      const pack = buildContextPack({
        change: "eval",
        agent: agent.id,
        budget: agent.tokenBudget,
        levels: ["public", "internal", "confidential", "restricted"],
        maxClassification: "internal",
        now: ctx.now,
        sources: sources.map((s) => ({
          id: s.id,
          kind: (s.trusted ? "instruction" : (s.kind ?? "document")) as never,
          origin: `eval/${def.id}/${s.id}`,
          text: s.text,
          classification: s.trusted ? "public" : "internal",
          ...(s.trusted ? { trusted: true } : {}),
        })),
      });
      const prepared = await ctx.runtime.prepare({
        change: "eval",
        agent,
        pack,
        outputPath: "answer.md",
      });
      const run = await ctx.runtime.run(prepared.runId);
      if (run.state === "waiting" || run.state === "prepared")
        return {
          state: "waiting",
          kept: [],
          discarded: [],
          promptSha256: pack.manifest.promptSha256,
        };
      if (run.output === undefined || run.state === "failed")
        return { state: "failed", kept: [], discarded: [], error: run.errors.join("; ") };
      return {
        state: "ran",
        output: run.output,
        promptSha256: pack.manifest.promptSha256,
        kept: [run.output],
        discarded: [],
        extra: {
          data: sources
            .filter((s) => !s.trusted)
            .map((s) => s.text)
            .join("\n"),
        },
      };
    } catch (e) {
      return fail(e);
    }
  },
  async grade(o) {
    const out = String(o.kept[0] ?? "");
    const g: Grade[] = [];
    const must = strs(def.expect.contains);
    const mustNot = strs(def.expect.notContains);
    if (must.length)
      g.push(
        fromItems(
          "says what it must",
          "structural",
          must.map((m) => ({
            name: m,
            ok: out.toLowerCase().includes(m.toLowerCase()),
            note: "missing",
          })),
        ),
      );
    if (mustNot.length)
      g.push(
        fromItems(
          "says nothing it mustn't",
          "structural",
          mustNot.map((m) => ({
            name: m,
            ok: !out.toLowerCase().includes(m.toLowerCase()),
            note: "present",
          })),
        ),
      );
    if (typeof def.expect.maxWords === "number")
      g.push(
        count("word limit", out.split(/\s+/).filter(Boolean).length, { max: def.expect.maxWords }),
      );
    const data = String(o.extra?.data ?? "");
    const quotes = out
      .split("\n")
      .filter((l) => l.startsWith("> "))
      .map((l) => l.slice(2).trim());
    g.push(
      fromItems(
        "every quote is in the data",
        "evidence",
        quotes.length
          ? quotes.map((q) => ({ name: q, ok: data.includes(q), note: "not in the data" }))
          : [{ name: "no quotes", ok: true }],
      ),
    );
    if (o.state !== "ran")
      g.push({
        grader: "ran",
        kind: "structural",
        pass: false,
        score: 0,
        notes: [o.error ?? o.state],
      });
    return g;
  },
});

export const SUITES: Record<string, SuiteBuilder> = {
  "critic-lens": criticLens,
  "story-writer": storyWriter,
  "feature-namer": featureNamer,
  "glossary-definer": glossaryDefiner,
  "test-writer": testWriter,
  "template-writer": templateWriter,
  "dialect-writer": dialectWriter,
  generic,
};
