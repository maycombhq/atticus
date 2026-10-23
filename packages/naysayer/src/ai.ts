import { parse } from "yaml";
import { z } from "zod";
import {
  AgentDefinition,
  changesRelOf,
  Lens,
  toCanonicalYaml,
  type CatalogRecord,
  type RunSummary,
} from "@maycombhq/core";
import {
  buildContextPack,
  quarantineItems,
  toRunSummary,
  type AiRuntime,
  type ContextPack,
  type QuarantineItem,
  type SourceInput,
} from "@maycombhq/ai";
import { quarantineHits } from "./defences.js";
import { artifactOf, hopRoutes, type ArtifactName } from "./artifacts.js";
import type { CriticContext } from "./context.js";
import { headingAt, type Doc } from "./doc.js";
import { sentence, type Hit } from "./hits.js";
import type { RuledHit } from "./findings.js";
import type { EffectiveRule } from "./rules.js";

/**
 * Layer 2: AI lenses. One run per lens, in a fresh session, with a context pack (contract C5)
 * holding Atticus's instructions and the rules as trusted text and everything else (the
 * artifacts that passed layer 1, the catalog slice) wrapped as data. The output is parsed and
 * checked: a finding must name a rule it was asked to apply and an artifact it was given, and
 * every quote it cites must really be on that line of that file. Anything else is discarded.
 */

export type LensName = z.infer<typeof Lens>;

export interface LensRun {
  lens: LensName;
  agent: string;
  /**
   * "waiting": the run went to the person's assistant (hand-off) and its answer isn't in yet;
   * `atticus handoff done <runId>` reads it into the round (`completeLensRun`).
   */
  state: "ran" | "skipped" | "failed" | "waiting";
  /** The hand-off run a waiting lens is with. */
  runId?: string;
  reason?: string;
  rules: string[];
  artifacts: string[];
  runtime?: string;
  summary?: RunSummary;
  promptSha256?: string;
}

export interface Discarded {
  lens: LensName;
  reason: string;
  summary?: string;
}

const DEFAULT_ROLES: Record<LensName, string> = {
  business: "product-owner",
  architecture: "architect",
  story: "business-analyst",
  ux: "designer",
  delivery: "delivery-lead",
  "code-and-test": "developer",
  release: "delivery-lead",
};

/** The agent for a lens: `<lens>-critic` from the org pack, or a built-in default. */
export function lensAgent(ctx: CriticContext, lens: LensName): AgentDefinition {
  const own = ctx.lifecycle.orgPack.agents.find((a) => a.id === `${lens}-critic`);
  if (own) return own;
  return AgentDefinition.parse({
    schemaVersion: 1,
    id: `${lens}-critic`,
    role: DEFAULT_ROLES[lens],
    description: `The critic's ${lens} lens: looks for reasons the change's artifacts are wrong.`,
    inputs: [
      "brief",
      "proposal",
      "specs",
      "interfaces",
      "mappings",
      "data",
      "design",
      "ux",
      "stories",
      "tasks",
      "snow",
      "catalog-slice",
      "patterns",
      "checklist",
    ],
    outputArtifact: "findings",
    checklist: "constitution",
    tokenBudget: ctx.lifecycle.orgPack.runtime.budgets.defaultTokens,
    allowedRuntimes: ["hand-off", "model", "mock", "replay"],
  });
}

const OUTPUT_FORMAT = `Report each problem as a finding, in YAML, and write nothing else:

findings:
  - rule: <a rule id from the list above>
    kind: issue                # or knowledge-gap, when only a person can answer
    artifact: <the file, as named in the data block's id>
    locator: { line: <line number>, heading: <section heading> }
    summary: <one sentence>
    why: <why it matters>
    fix: <what to change>
    evidence:
      - { path: <file>, line: <line number>, quote: <the exact words on that line> }
    question: { text: <the question>, owner: <who should answer> }   # knowledge gaps only

Every finding quotes the exact text it relies on; a finding whose quote isn't on that line is discarded. Severity, layer and state come from the rule: don't set them. Write "findings: []" when nothing is wrong.`;

function instructions(ctx: CriticContext, lens: LensName): string {
  return [
    `# Critic: ${lens} lens`,
    "",
    `You are the ${lens} lens of the Atticus critic, reviewing change ${ctx.change.id} (${ctx.change.title}, a ${ctx.type.name.toLowerCase()}) in a fresh session. Look for reasons the artifacts are wrong. Apply only the rules listed below and report nothing else; the deterministic checks have already run, so don't repeat what a rule of theirs would catch.`,
    "",
    "Artifact lines are numbered as `<n>: <text>`; cite those numbers.",
    "",
    OUTPUT_FORMAT,
  ].join("\n");
}

function rulesText(rules: EffectiveRule[]): string {
  const body = rules.map((r) => ({
    id: r.id,
    title: r.title,
    severity: r.severity,
    artifacts: r.appliesTo.artifacts,
    look_for: r.check.type === "ai" ? r.check.prompt : "",
  }));
  return `## Rules\n\n${toCanonicalYaml(body, ["id", "title", "severity", "artifacts", "look_for"]).trimEnd()}`;
}

const numbered = (doc: Doc) => doc.rawLines.map((l, i) => `${i + 1}: ${l}`).join("\n");

/** The catalog records the change touches, without evidence, for the AI's context. */
function catalogSlice(ctx: CriticContext): string {
  const fp = ctx.footprint;
  const comps = new Set(fp.components);
  const routes = new Set(ctx.hops.flatMap((h) => hopRoutes(ctx.files, h)));
  const keep = (r: CatalogRecord): boolean => {
    switch (r.kind) {
      case "System":
        return fp.systems.includes(r.id);
      case "Component":
        return comps.has(r.id);
      case "Interface":
        return fp.interfaces.some((i) => i.id === r.id) || (comps.has(r.from) && comps.has(r.to));
      case "Endpoint":
      case "Setting":
      case "ObservabilityAsset":
      case "Deployment":
        return comps.has(r.component) || fp.systems.includes(r.component);
      case "DataStore":
        return fp.dataStores.includes(r.id);
      case "Table":
        return fp.tables.includes(r.id);
      case "GatewayRoute":
        return routes.has(r.id);
      case "Obligation":
        return fp.systems.includes(r.system);
      default:
        return false;
    }
  };
  const rows = ctx.records
    .filter(keep)
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))
    .map((r) => {
      const {
        evidence: _e,
        schemaVersion: _s,
        ...rest
      } = r as CatalogRecord & Record<string, unknown>;
      void _e;
      void _s;
      return rest;
    });
  return toCanonicalYaml(rows).trimEnd();
}

function patternsText(ctx: CriticContext): string {
  const rows = [...ctx.patterns.values()]
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((p) => ({
      code: p.code,
      name: p.name,
      route: p.route,
      targetType: p.targetType,
      controls: p.controls,
      status: p.status,
    }));
  return `## Integration patterns (org pack)\n\n${toCanonicalYaml(rows, ["code", "name"]).trimEnd()}`;
}

const AiEvidence = z.object({
  path: z.string().min(1),
  line: z.coerce.number().int().positive().optional(),
  quote: z.string().optional(),
});

const AiFinding = z.object({
  rule: z.string().min(1),
  kind: z.enum(["issue", "knowledge-gap"]).default("issue"),
  artifact: z.string().min(1),
  locator: z
    .object({ line: z.coerce.number().int().positive().optional(), heading: z.string().optional() })
    .optional(),
  summary: z.string().min(1),
  why: z.string().min(1),
  fix: z
    .union([z.string().min(1), z.object({ text: z.string().min(1) }).transform((f) => f.text)])
    .optional(),
  evidence: z.array(AiEvidence).default([]),
  question: z.object({ text: z.string().min(1), owner: z.string().min(1).optional() }).optional(),
});

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
/** The shortest quote an evidence entry may give (ADR 0111), as the knowledge scan asks. */
const MIN_QUOTE = 12;

/** Parse a lens's output into hits; returns what was discarded and why. */
export function parseLensOutput(
  ctx: CriticContext,
  lens: LensName,
  output: string,
  rules: EffectiveRule[],
  docs: Doc[],
): { hits: RuledHit[]; discarded: Discarded[] } {
  const discarded: Discarded[] = [];
  let data: unknown;
  try {
    data = parse(output.replace(/^```(?:ya?ml)?\s*\n|\n```\s*$/g, ""));
  } catch (e) {
    return {
      hits: [],
      discarded: [
        { lens, reason: `the output is not YAML: ${(e as Error).message.split("\n")[0]}` },
      ],
    };
  }
  const list = Array.isArray(data) ? data : (data as { findings?: unknown } | null)?.findings;
  if (!Array.isArray(list))
    return { hits: [], discarded: [{ lens, reason: "the output has no findings list" }] };
  const byRule = new Map(rules.map((r) => [r.id, r]));
  const byPath = new Map(docs.map((d) => [d.path, d]));
  const hits: RuledHit[] = [];
  for (const raw of list) {
    const p = AiFinding.safeParse(raw);
    const label =
      typeof (raw as { summary?: unknown })?.summary === "string"
        ? String((raw as { summary: string }).summary)
        : undefined;
    const drop = (reason: string) =>
      discarded.push({ lens, reason, ...(label ? { summary: sentence(label) } : {}) });
    if (!p.success) {
      drop(`not a finding: ${p.error.issues[0]?.path.join(".")} ${p.error.issues[0]?.message}`);
      continue;
    }
    // An unquoted question in a YAML flow mapping ({text: a, b, owner: x}) is cut at its first
    // comma, and the rest turns into stray keys. Refuse it rather than ask a half question.
    const q = (raw as { question?: unknown }).question;
    if (q && typeof q === "object" && Object.keys(q).some((k) => k !== "text" && k !== "owner")) {
      drop(
        "its question was cut at a comma (the text needs quotes, or block style: question: then text: on the next lines)",
      );
      continue;
    }
    const f = p.data;
    const rule = byRule.get(f.rule);
    if (!rule) {
      drop(`it names rule ${f.rule}, which this lens wasn't asked to apply`);
      continue;
    }
    const doc = byPath.get(f.artifact);
    if (!doc) {
      drop(`it is about ${f.artifact}, which this lens wasn't given`);
      continue;
    }
    const evidence: Hit["evidence"] = [];
    let unquoted = 0;
    for (const e of f.evidence) {
      const d = byPath.get(e.path);
      if (!d) continue;
      let line = e.line;
      // ADR 0111: an entry quotes the words it relies on, at least 12 characters, on the line it
      // cites; a quote on another line counts only when it is on exactly one line of the file.
      const q = norm(e.quote ?? "");
      if (q.length < MIN_QUOTE) {
        unquoted++;
        continue;
      }
      if (!(line && norm(d.rawLines[line - 1] ?? "").includes(q))) {
        const lines = d.rawLines.flatMap((l, k) => (norm(l).includes(q) ? [k + 1] : []));
        if (lines.length !== 1) continue;
        line = lines[0]!;
      }
      if (!line) continue;
      const text = d.rawLines[line - 1]!.trim();
      const quote =
        e.quote && e.quote.length <= 200
          ? e.quote.trim()
          : text.length <= 190
            ? text
            : `${text.slice(0, 187)}...`;
      evidence.push({ source: "artifact", path: d.path, line, quote });
    }
    if (evidence.length === 0) {
      drop(
        unquoted && unquoted === f.evidence.filter((e) => byPath.has(e.path)).length
          ? "its evidence quotes nothing: each entry needs the exact words (at least 12 characters) on the line it cites"
          : "none of its evidence is in the files it was given",
      );
      continue;
    }
    if (f.kind === "knowledge-gap" && !f.question) {
      drop("a knowledge gap without an owner question");
      continue;
    }
    const line =
      f.locator?.line && f.locator.line <= doc.rawLines.length
        ? f.locator.line
        : evidence.find((e) => e.path === doc.path)?.line;
    const heading = f.locator?.heading ?? (line ? headingAt(doc, line) : undefined);
    const locator = { ...(line ? { line } : {}), ...(heading ? { heading } : {}) };
    if (Object.keys(locator).length === 0) locator.heading = doc.sections[0]?.heading ?? doc.path;
    hits.push({
      rule,
      layer: "ai",
      also: [],
      hit: {
        kind: f.kind,
        artifact: doc.path,
        locator,
        summary: sentence(f.summary),
        why: f.why,
        fix: { text: f.fix ?? "See why." },
        evidence,
        ...(f.kind === "knowledge-gap"
          ? {
              question: { text: f.question!.text, owner: f.question!.owner ?? DEFAULT_ROLES[lens] },
            }
          : {}),
        key: `ai|${rule.id}|${doc.path}|${line ?? heading ?? ""}`,
      },
    });
  }
  return { hits, discarded };
}

export interface LensOptions {
  runtime?: AiRuntime;
  lenses: LensName[];
  /** Artifacts with a blocking layer-1 finding: they stay out of layer 2. */
  failed: Set<string>;
  maxClassification?: string;
  /** Collects the quarantine items of every lens run, for the round (ADR 0042). */
  quarantined: QuarantineItem[];
}

/**
 * What the context pack left out of a lens's artifacts: the ones the defences quarantined or
 * the budget dropped (a lens may not cite them), and the sentence the round records about it.
 */
export function leftOut(
  pack: Pick<ContextPack, "defences" | "manifest">,
  artifacts: Iterable<string>,
): { left: Set<string>; reason?: string } {
  const sent = new Set(artifacts);
  const quarantined = quarantineItems(pack.defences ?? []);
  const left = pack.manifest.dropped.filter((d) => sent.has(d.id));
  const overBudget = left.filter((d) => !quarantined.some((q) => q.source === d.id));
  const reason = [
    overBudget.length
      ? `left out to fit the budget: ${overBudget.map((d) => d.id).join(", ")}`
      : "",
    quarantined.length
      ? `quarantined by the defences, for a person to review: ${quarantined.map((q) => q.source).join(", ")}`
      : "",
  ]
    .filter(Boolean)
    .join("; ");
  return { left: new Set(left.map((d) => d.id)), ...(reason ? { reason } : {}) };
}

const ARTIFACT_INPUTS = new Set<string>([
  "brief",
  "proposal",
  "specs",
  "interfaces",
  "mappings",
  "data",
  "design",
  "ux",
  "stories",
  "tasks",
  "snow",
]);

export async function runLenses(
  ctx: CriticContext,
  rules: EffectiveRule[],
  o: LensOptions,
): Promise<{
  hits: RuledHit[];
  runs: LensRun[];
  discarded: Discarded[];
  skipped: { rule: string; reason: string }[];
}> {
  const hits: RuledHit[] = [];
  const runs: LensRun[] = [];
  const discarded: Discarded[] = [];
  const skipped: { rule: string; reason: string }[] = [];
  for (const lens of Lens.options) {
    if (!o.lenses.includes(lens)) continue;
    const lensRules = rules.filter((r) => r.lens === lens && r.check.type === "ai");
    if (lensRules.length === 0) continue;
    const agent = lensAgent(ctx, lens);
    const sent: EffectiveRule[] = [];
    const docs = new Map<string, Doc>();
    for (const r of lensRules) {
      const wanted = r.appliesTo.artifacts.filter((a) => ARTIFACT_INPUTS.has(a) && ctx.isDue(a));
      const readable = wanted.filter((a) => (agent.inputs as string[]).includes(a));
      const candidates = [...ctx.files.docs.values()].filter((d) =>
        readable.includes(artifactOf(d.path) as ArtifactName),
      );
      const passing = candidates.filter((d) => !o.failed.has(d.path));
      if (passing.length === 0) {
        const why = !wanted.length
          ? `its artifacts (${r.appliesTo.artifacts.join(", ")}) aren't due at the ${ctx.gate.id} gate`
          : !readable.length
            ? `agent ${agent.id} doesn't read ${wanted.join(", ")}`
            : !candidates.length
              ? `the change has no ${readable.join(", ")} yet`
              : `${candidates.map((d) => d.path).join(", ")} ${candidates.length > 1 ? "have" : "has"} blocking layer-1 findings; fix those first`;
        skipped.push({ rule: r.id, reason: `not sent to the ${lens} lens: ${why}` });
        continue;
      }
      sent.push(r);
      for (const d of passing) docs.set(d.path, d);
    }
    const base = {
      lens,
      agent: agent.id,
      rules: sent.map((r) => r.id),
      artifacts: [...docs.keys()].sort(),
    };
    if (sent.length === 0) {
      runs.push({
        ...base,
        state: "skipped",
        reason: "no AI rule of this lens has an artifact that passed layer 1",
      });
      continue;
    }
    if (!o.runtime) {
      const off = ctx.lifecycle.orgPack.runtime.ai === "off";
      runs.push({
        ...base,
        state: "skipped",
        reason: off
          ? "AI is off here (runtime.yaml ai: off); layer 1 ran alone and the gate doesn't wait for this lens"
          : "no AI runtime was given; layer 1 ran alone",
      });
      for (const r of sent)
        skipped.push({
          rule: r.id,
          reason: off ? "not run: AI is off here" : "not run: no AI runtime",
        });
      continue;
    }
    const sources: SourceInput[] = [
      {
        id: "0-instructions",
        kind: "instruction",
        origin: "atticus/critic",
        text: instructions(ctx, lens),
        classification: "public",
        trusted: true,
      },
      {
        id: "1-rules",
        kind: "checklist",
        origin: "checklists",
        text: rulesText(sent),
        classification: "public",
        trusted: true,
      },
    ];
    if ((agent.inputs as string[]).includes("patterns"))
      sources.push({
        id: "2-patterns",
        kind: "pattern",
        origin: "org-pack/patterns",
        text: patternsText(ctx),
        classification: "public",
        trusted: true,
      });
    for (const d of [...docs.values()].sort((a, b) => a.path.localeCompare(b.path)))
      sources.push({
        id: d.path,
        kind: "artifact",
        origin: `${changesRelOf(ctx.root)}/${ctx.change.id}/${d.path}`,
        text: numbered(d),
        classification: "internal",
        priority: 10,
      });
    if ((agent.inputs as string[]).includes("catalog-slice"))
      sources.push({
        id: "catalog-slice",
        kind: "catalog",
        origin: "catalog",
        text: catalogSlice(ctx),
        classification: "internal",
        priority: 5,
      });
    const levels = ctx.classifications;
    const budget = ctx.lifecycle.orgPack.runtime.budgets.perAgent[agent.id] ?? agent.tokenBudget;
    let pack;
    try {
      pack = buildContextPack({
        change: ctx.change.id,
        agent: agent.id,
        budget,
        sources,
        levels,
        maxClassification:
          o.maxClassification ??
          (levels.includes("confidential") ? "confidential" : levels.at(-1)!),
        now: new Date(ctx.now),
      });
    } catch (e) {
      runs.push({ ...base, state: "failed", reason: (e as Error).message });
      continue;
    }
    // Sources the defences rate high risk were left out of the pack (ADR 0042): a person gets
    // an item for each, and the lens that wanted it a gap finding.
    const quarantined = quarantineItems(pack.defences ?? []);
    if (quarantined.length) {
      const seen = new Set(o.quarantined.map((q) => `${q.source}|${q.sha256}`));
      for (const q of quarantined) if (!seen.has(`${q.source}|${q.sha256}`)) o.quarantined.push(q);
      hits.push(
        ...quarantineHits(lens, DEFAULT_ROLES[lens], quarantined, (source) => docs.has(source)),
      );
    }
    const out = leftOut(pack, docs.keys());
    try {
      const prepared = await o.runtime.prepare({
        change: ctx.change.id,
        agent,
        pack,
        // In hand-off mode the answer goes to a file in the run's own folder: a round at the same
        // gate never finds an earlier round's answer where it looks, and the change keeps only
        // the round (the findings), not the assistant's raw answers.
        outputPath: `findings-${lens}.yaml`,
        outputIn: "run",
      });
      const run = await o.runtime.run(prepared.runId);
      const summary = toRunSummary(run);
      const meta = { runtime: run.runtime, summary, promptSha256: pack.manifest.promptSha256 };
      if (run.state === "waiting") {
        // Hand-off: the prompt is written and the person's assistant has it. The round records
        // the lens as waiting; `atticus handoff done <run>` reads the answer in later.
        runs.push({
          ...base,
          ...meta,
          state: "waiting",
          runId: run.runId,
          reason: `handed to your assistant; finish with atticus handoff done ${run.runId}`,
        });
        continue;
      }
      if (run.state !== "validated" || run.output === undefined) {
        runs.push({
          ...base,
          ...meta,
          state: "failed",
          reason: run.errors.join("; ") || `the run ended ${run.state}`,
        });
        continue;
      }
      const parsed = parseLensOutput(
        ctx,
        lens,
        run.output,
        sent,
        [...docs.values()].filter((d) => !out.left.has(d.path)),
      );
      hits.push(...parsed.hits);
      discarded.push(...parsed.discarded);
      runs.push({
        ...base,
        ...meta,
        state: "ran",
        ...(out.reason ? { reason: out.reason } : {}),
      });
    } catch (e) {
      runs.push({ ...base, state: "failed", reason: (e as Error).message });
    }
  }
  return { hits, runs, discarded, skipped };
}
