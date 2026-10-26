import { parse } from "yaml";
import { z } from "zod";
import {
  AgentDefinition,
  changesRelOf,
  LEGACY_LENSES,
  Lens,
  lensCovers,
  questionOfLens,
  toCanonicalYaml,
  type CatalogRecord,
  type CriticQuestion,
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
import { answersText, checkedAnswerLink } from "./answers.js";
import { checkAbsences, codeRepos, codeSearchFor, type CodeRepo, type CodeSearch } from "./code.js";
import { recordedText } from "./recorded.js";
import { quarantineHits } from "./defences.js";
import { artifactOf, hopRoutes, type ArtifactName } from "./artifacts.js";
import type { CriticContext } from "./context.js";
import { headingAt, type Doc } from "./doc.js";
import { sentence, type Hit } from "./hits.js";
import type { RuledHit } from "./findings.js";
import type { EffectiveRule } from "./rules.js";
import { QUESTION_ROLES, QUESTION_TEXT, QUESTIONS, questionOfRule } from "./questions.js";

/**
 * Layer 2: AI lenses. One run per question the critic asks (ADR 0124 addendum, Part 4: is it
 * true to the code, complete, safe to build, can it ship), in a fresh session, with a context pack (contract C5)
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

/** Every input a critic lens can read: the change's artifacts, the catalog slice and the pack. */
const ALL_INPUTS = [
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
] as const;

const LENS_DESCRIPTION: Record<CriticQuestion, string> = {
  true: "The critic's true lens: is the change true to the code? Looks for a draft that contradicts how the code and the estate behave.",
  complete:
    "The critic's complete lens: is the change complete? Looks for what the brief implies and the draft leaves out, and the error paths nobody wrote.",
  safe: "The critic's safe lens: is the change safe to build? Security, privacy and integrity reasoning no rule can check.",
  ship: "The critic's ship lens: can the change ship? Operability, rollout and rollback, and the lead times delivery waits on.",
};

/**
 * The agent for a question's lens. The org pack's own `<question>-critic` when it has one. Else,
 * when the org pack still defines agents for the old role lenses that reviewed this question
 * (`architecture-critic` for true and safe, say), one agent made of them, as strict as they
 * were: what any of them read, only the runtimes all of them allow, the largest budget. Else the
 * built-in default. Throws when the old agents allow no runtime in common: the org pack decides.
 *
 * Asked by an old lens's name, it is the agent of the question that lens maps to. There is no
 * built-in agent of an old lens any more: the spec hand-up's review of a task, the last to ask
 * for one (code-and-test), asks the complete question (the product owner's decision of
 * 2026-10-24), and an org pack's code-and-test-critic is one of the old agents its lens is made of.
 */
export function lensAgent(ctx: CriticContext, lens: LensName): AgentDefinition {
  const agents = ctx.lifecycle.orgPack.agents;
  const q = questionOfLens(lens);
  const own = agents.find((a) => a.id === `${q}-critic`);
  if (own) return own;
  const legacy = LEGACY_LENSES.filter((l) => lensCovers(l).includes(q))
    .map((l) => agents.find((a) => a.id === `${l}-critic`))
    .filter((a): a is AgentDefinition => a !== undefined);
  if (legacy.length) {
    const runtimes = legacy[0]!.allowedRuntimes.filter((r) =>
      legacy.every((a) => a.allowedRuntimes.includes(r)),
    );
    if (runtimes.length === 0)
      throw new Error(
        `The org pack's old lens agents ${legacy.map((a) => a.id).join(", ")} allow no runtime in common, so the ${q} lens can't run; define ${q}-critic in org-pack/agents/.`,
      );
    return AgentDefinition.parse({
      schemaVersion: 1,
      id: `${q}-critic`,
      role: QUESTION_ROLES[q],
      description: `${LENS_DESCRIPTION[q]} Made from the org pack's ${
        legacy.length > 1
          ? `${legacy
              .slice(0, -1)
              .map((a) => a.id)
              .join(", ")} and ${legacy.at(-1)!.id}`
          : legacy[0]!.id
      }.`,
      inputs: [
        ...ALL_INPUTS.filter((i) => legacy.some((a) => (a.inputs as string[]).includes(i))),
        ...new Set(
          legacy
            .flatMap((a) => a.inputs)
            .filter((i) => !(ALL_INPUTS as readonly string[]).includes(i)),
        ),
      ],
      outputArtifact: "findings",
      checklist: legacy[0]!.checklist ?? "constitution",
      tokenBudget: Math.max(...legacy.map((a) => a.tokenBudget)),
      allowedRuntimes: runtimes,
    });
  }
  return AgentDefinition.parse({
    schemaVersion: 1,
    id: `${q}-critic`,
    role: QUESTION_ROLES[q],
    description: LENS_DESCRIPTION[q],
    inputs: [...ALL_INPUTS],
    outputArtifact: "findings",
    checklist: "constitution",
    tokenBudget: ctx.lifecycle.orgPack.runtime.budgets.defaultTokens,
    allowedRuntimes: ["hand-off", "model", "headless-claude-code", "mock", "replay"],
  });
}

/**
 * What each lens looks for (ADR 0124 addendum, Part 4). The seven role lenses' concerns fold into
 * the four questions: the architecture and code reviews into true and safe, business, story, UX
 * and tests into complete, delivery and release into ship.
 */
const LOOK_FOR: Record<CriticQuestion, string> = {
  true: "Look for a draft or an artifact that contradicts how the code and the estate actually behave: a flow marked only read whose steps the change must alter, a capability the draft takes for granted that nothing in the estate does, a value a step returns or shows that no step gives, a design that relies on a call, a field or a check the code doesn't have.",
  complete:
    "Look for what the draft leaves out: an outcome or requirement the brief implies that nothing delivers, an open question no artifact answers, an error path nobody wrote (a partner that doesn't answer, a refusal, a timeout), a screen state the specs imply (loading, empty, error), a story with no requirement behind it, a criterion a tester couldn't turn into a test, a scenario no test covers.",
  safe: "Reason about security, privacy and integrity where the deterministic rules can't: who may call a new or changed entry and what it may see or change, personal data that crosses a boundary, lands in a log or is kept longer than it needs, a hop whose pattern's controls don't fit what it carries, two requests racing over the same record, a partner's failure that leaves data half written.",
  ship: "Think about operability and delivery: what breaks at 3 a.m. and how anyone would know (the alert, the dashboard, the log line to watch), the order things deploy in and how each step is rolled back, data written between a deployment and its rollback, the requests, approvals and lead times the work waits on, a migration that must run before the code that needs it.",
};

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
ANSWERED_LINE
Every finding quotes the exact text it relies on; a finding whose quote isn't on that line is discarded. Severity, layer and state come from the rule: don't set them. Write "findings: []" when nothing is wrong.`;

/** The output format line for a link to a person's answer, when the lens was given answers. */
const ANSWERED_LINE = `    answered: { id: <the answered question's id>, quote: "<the words of its answer, copied exactly>" }   # only when a person's answer decided what the finding is about
`;

/** What a lens is told about the answers people gave (ADR 0115 addendum, 2026-10-24). */
const ANSWERS_RULE = `People answered questions about this change; the "answers-on-file" data block lists each question with its id and the answer. Those answers are part of the brief, as binding as its own words, and a person made each decision deliberately. A scope, a limit or a choice a person set by answering is not a finding: an artifact or a draft that follows it (that narrows the brief as an answer says, say) is right, so don't report it. If a finding of yours is still about what an answer decided, give answered with that question's id and the words of its answer, so the person sees which decision it is about.`;

/** The output format line for the names a finding says are missing, when the lens can search (W1). */
const ABSENT_LINE = `    absent: ["<a name the finding says doesn't exist: a class, a method, a file, METHOD /path>"]   # only when the finding says something is missing
`;

/**
 * What a lens is told about the code (ADR 0115 addendum, W1): the estate is what Atticus has
 * recorded, the code may hold more, so a lens looks before it says something doesn't exist.
 */
function codeRule(repos: readonly CodeRepo[]): string {
  return [
    `The repos' code is cloned in the metarepo, read-only: ${repos.map((r) => `${r.repo} at ${r.rel}/`).join(", ")}. The estate is only what Atticus has recorded of it; the code may hold more (a check inside a method, a screen in a web app, an entry the scan didn't read).`,
    `Before you report that something doesn't exist (a check, a class, a component, a screen, an endpoint, a flow), look for it: call the grep, files and outline tools where they are offered, or search and read those folders. If you find it, don't report it as missing; cite where it is if it still matters. A finding that says something is missing lists the names it looked for under absent; Atticus searches the catalog and the code for each, and a name it finds makes the finding a note.`,
  ].join(" ");
}

/** What a lens is told about the facts people recorded (ADR 0115 addendum, W2). */
const RECORDED_RULE = `People recorded facts and decisions on this change's findings at its reviews; the "recorded-by-people" data block lists each with the gate, who and when. A fact a person recorded is not raised again: don't report it as a finding or a gap, at this gate or any other. You may challenge one only with new evidence you cite (a line of the draft, the estate or the code that contradicts it), naming the recorded finding in why.`;

function instructions(
  ctx: CriticContext,
  lens: LensName,
  review?: StageReview,
  repos: readonly CodeRepo[] = [],
): string {
  const q = questionOfLens(lens);
  return [
    `# Critic: the ${q} lens (${QUESTION_TEXT[q]})`,
    "",
    `You are the ${q} lens of the Atticus critic, reviewing change ${ctx.change.id} (${ctx.change.title}, a ${ctx.type.name.toLowerCase()}) in a fresh session. You ask one question of it: ${QUESTION_TEXT[q]} Look for reasons the artifacts are wrong. Apply only the rules listed below and report nothing else; each asks part of your question. The deterministic checks have already run, so don't repeat what a rule of theirs would catch.`,
    "",
    LOOK_FOR[q],
    "",
    ...(review
      ? [
          `This review is of the ${review.stage} draft an assistant just wrote: ${review.docs.map((d) => d.path).join(", ")}. Review the draft against the estate and the brief, including what the draft left out: something the brief asks for, or the estate shows the change needs, that the draft doesn't say or says wrongly. What the drafter read of the estate is in the data blocks; cite the draft's lines like any artifact's.`,
          "",
          ...(review.sources.some((s) => s.id === MERGED_FLOWS)
            ? [
                `The "${MERGED_FLOWS}" data block gives each target flow as it will be, its steps numbered in their final order, and the keys the change declares. Atticus works it out from the target flows; read the order of a flow's steps from it, never from a step's after, and take a key it lists as declared.`,
                "",
              ]
            : []),
        ]
      : []),
    ...(ctx.answers?.length ? [ANSWERS_RULE, ""] : []),
    ...(ctx.recorded?.length ? [RECORDED_RULE, ""] : []),
    ...(repos.length ? [codeRule(repos), ""] : []),
    "Artifact lines are numbered as `<n>: <text>`; cite those numbers.",
    "",
    OUTPUT_FORMAT.replace(
      "ANSWERED_LINE",
      (ctx.answers?.length ? ANSWERED_LINE : "") + (repos.length ? ABSENT_LINE : ""),
    ),
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

/**
 * The catalog records the change touches, without evidence, for the AI's context. On the stage
 * path (ADR 0124 addendum B-change) the footprint names the entries, calls and columns the target
 * flows touch, so the slice keeps those rather than every entry and setting of a component.
 */
export function catalogSlice(ctx: CriticContext): string {
  const fp = ctx.footprint;
  const comps = new Set(fp.components);
  const staged = fp.from.some((f) => f.startsWith("target-flows/") || f === "feature.yaml");
  const routes = new Set(ctx.hops.flatMap((h) => hopRoutes(ctx.files, h)));
  const keep = (r: CatalogRecord): boolean => {
    switch (r.kind) {
      case "System":
        return fp.systems.includes(r.id) || fp.outside.some((o) => o.id === r.id);
      case "Component":
        return comps.has(r.id);
      case "Interface":
        return (
          fp.interfaces.some((i) => i.id === r.id) ||
          fp.calls.includes(r.id) ||
          (!staged && comps.has(r.from) && comps.has(r.to))
        );
      case "Endpoint":
        return staged
          ? fp.entries.includes(r.id)
          : comps.has(r.component) || fp.systems.includes(r.component);
      case "Setting":
      case "ObservabilityAsset":
        return !staged && (comps.has(r.component) || fp.systems.includes(r.component));
      case "Deployment":
        return comps.has(r.component) || fp.systems.includes(r.component);
      case "DataStore":
        return fp.dataStores.includes(r.id);
      case "Table":
        return fp.tables.includes(r.id);
      case "Column":
        return fp.columns.includes(r.id);
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
  answered: z.object({ id: z.string().min(1), quote: z.string().min(1) }).optional(),
  absent: z
    .union([z.string(), z.array(z.coerce.string())])
    .transform((a) =>
      (Array.isArray(a) ? a : [a]).map((x) => x.trim()).filter((x) => x.length >= 2),
    )
    .optional(),
});

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
/** The shortest quote an evidence entry may give (ADR 0111), as the knowledge scan asks. */
const MIN_QUOTE = 12;

/**
 * Whether a short quote is word for word on a line: the same characters (whitespace runs aside),
 * case and all, not inside a longer word or number ("429" in "status 429", never in "14290").
 */
function wordFor(line: string, quote: string): boolean {
  if (!quote) return false;
  const esc = quote.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${esc}($|[^\\p{L}\\p{N}_])`, "u").test(
    line.replace(/\s+/g, " "),
  );
}

/** A lens's answer as data: the findings list, or why the answer isn't a review at all. */
function lensFindings(output: string): { list: unknown[] } | { problem: string } {
  let data: unknown;
  try {
    data = parse(output.replace(/^```(?:ya?ml)?\s*\n|\n```\s*$/g, ""));
  } catch (e) {
    return { problem: `the output is not YAML: ${(e as Error).message.split("\n")[0]}` };
  }
  const list = Array.isArray(data) ? data : (data as { findings?: unknown } | null)?.findings;
  return Array.isArray(list)
    ? { list }
    : {
        problem: "the output has no findings list (a lens that finds nothing answers findings: [])",
      };
}

/**
 * Why a lens's answer isn't a review at all, or undefined when it is one: YAML with a findings
 * list (empty when the lens found nothing). An empty answer, a refusal or prose is not a clean
 * review, and must never count as one: the gate would open on a review that never happened.
 */
export function lensAnswerProblem(output: string): string | undefined {
  const r = lensFindings(output);
  return "problem" in r ? r.problem : undefined;
}

/**
 * Parse a lens's output into hits; returns what was discarded and why. `malformed` says why an
 * answer that isn't a review at all was refused (lensAnswerProblem): the lens then failed.
 */
export function parseLensOutput(
  ctx: CriticContext,
  lens: LensName,
  output: string,
  rules: EffectiveRule[],
  docs: Doc[],
): { hits: RuledHit[]; discarded: Discarded[]; malformed?: string } {
  const discarded: Discarded[] = [];
  const read = lensFindings(output);
  if ("problem" in read)
    return { hits: [], discarded: [{ lens, reason: read.problem }], malformed: read.problem };
  const list = read.list;
  const byRule = new Map(rules.map((r) => [r.id, r]));
  // A file is named by its data block's id, or by the metarepo path its block's origin gives (B2:
  // an assistant cites the path it read the file at, and the finding was dropped).
  const changeRel = `${changesRelOf(ctx.root)}/${ctx.change.id}/`;
  const byPath = new Map(
    docs.flatMap((d) => [
      [d.path, d],
      [`${changeRel}${d.path}`, d],
    ]),
  );
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
    let short = 0;
    for (const e of f.evidence) {
      const d = byPath.get(e.path);
      if (!d) continue;
      let line = e.line;
      // ADR 0111: an entry quotes the words it relies on, at least 12 characters, on the line it
      // cites; a quote on another line counts only when it is on exactly one line of the file.
      const q = norm(e.quote ?? "");
      if (!q) {
        unquoted++;
        continue;
      }
      // ADR 0111 addendum (2026-10-25): a shorter quote (a status, a column, a value) counts when
      // it is word for word on the line it cites; one with no line, or not there, is left out
      // and says so (a finding quoting "429" was dropped without a word).
      if (q.length < MIN_QUOTE) {
        const said = (e.quote ?? "").replace(/\s+/g, " ").trim();
        if (line && wordFor(d.rawLines[line - 1] ?? "", said)) {
          evidence.push({ source: "artifact", path: d.path, line, quote: said });
          continue;
        }
        short++;
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
      const given = f.evidence.filter((e) => byPath.has(e.path)).length;
      drop(
        unquoted && unquoted === given
          ? "its evidence quotes nothing: each entry needs the exact words (at least 12 characters) on the line it cites"
          : short && unquoted + short === given
            ? "its quote is under 12 characters and isn't word for word on the line it cites: a short quote counts only on its own line, so give the line, or quote more of it"
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
    // A link to a person's answer holds only when it names an answer the lens was given and
    // quotes that answer's words; otherwise the finding stands without it.
    const answered = checkedAnswerLink(ctx.answers ?? [], f.answered);
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
              question: {
                text: f.question!.text,
                owner: f.question!.owner ?? QUESTION_ROLES[questionOfLens(lens)],
              },
            }
          : {}),
        ...(answered ? { answered } : {}),
        ...(f.absent?.length ? { absent: [...new Set(f.absent)].slice(0, 20) } : {}),
        key: `ai|${rule.id}|${doc.path}|${line ?? heading ?? ""}`,
      },
    });
  }
  return { hits, discarded };
}

/**
 * A stage's draft for the lenses to review (ADR 0115): the files the stage wrote, which the
 * lenses read and may cite as they do the artifacts, and the estate the drafter read, as data.
 */
/**
 * The data block a stage gives its lenses with its target flows merged with today's, numbered in
 * their final order (ADR 0111 addendum, S3): the order is read from it as a fact.
 */
export const MERGED_FLOWS = "target-flows-merged";

export interface StageReview {
  /** The stage, in words: feature, architecture, stories, small. */
  stage: string;
  docs: Doc[];
  sources: SourceInput[];
}

export interface LensOptions {
  runtime?: AiRuntime;
  /** A stage's draft to review with the artifacts, when nothing failed layer 1. */
  review?: StageReview;
  /** The questions whose lenses run (ADR 0124 addendum, Part 4). */
  lenses: CriticQuestion[];
  /** Artifacts with a blocking layer-1 finding: they stay out of layer 2. */
  failed: Set<string>;
  maxClassification?: string;
  /** Collects the quarantine items of every lens run, for the round (ADR 0042). */
  quarantined: QuarantineItem[];
  /** Where the code has a name a finding says is missing (W1). Default: the registered one. */
  codeSearch?: CodeSearch;
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
  // The repos' clones a lens may search before it says something is missing (W1).
  const repos = codeRepos(ctx.root);
  // One lens per question, whatever lens its rules were written with (ADR 0124 addendum, Part 4).
  for (const lens of QUESTIONS) {
    if (!o.lenses.includes(lens)) continue;
    const lensRules = rules.filter((r) => questionOfRule(r) === lens && r.check.type === "ai");
    if (lensRules.length === 0) continue;
    let agent: AgentDefinition;
    try {
      agent = lensAgent(ctx, lens);
    } catch (e) {
      runs.push({
        lens,
        agent: `${lens}-critic`,
        rules: lensRules.map((r) => r.id),
        artifacts: [],
        state: "failed",
        reason: (e as Error).message,
      });
      continue;
    }
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
    // A stage's draft goes with the artifacts it was drafted from, once they pass layer 1.
    const review = sent.length && o.review && o.failed.size === 0 ? o.review : undefined;
    for (const d of review?.docs ?? []) if (!docs.has(d.path)) docs.set(d.path, d);
    // The lens reviews the draft against the brief (ADR 0120), so the brief rides with it even
    // when this lens's rules read other artifacts (a story lens's rules read the stories).
    const brief = review && ctx.isDue("brief") ? ctx.files.docs.get("brief.md") : undefined;
    if (brief && !docs.has(brief.path) && (agent.inputs as string[]).includes("brief"))
      docs.set(brief.path, brief);
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
        text: instructions(ctx, lens, review, repos),
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
    // What people answered for the change: part of the brief, as data (ADR 0115 addendum).
    if (ctx.answers?.length)
      sources.push({
        id: "answers-on-file",
        kind: "document",
        origin: "questions/ (answered for this change)",
        text: answersText(ctx.answers),
        classification: "internal",
        priority: 9,
      });
    // What people recorded on the change's findings, at any gate (W2), as data with who and when.
    if (ctx.recorded?.length)
      sources.push({
        id: "recorded-by-people",
        kind: "document",
        origin: "review/ (what people recorded on this change's findings)",
        text: recordedText(ctx.recorded),
        classification: "internal",
        priority: 9,
      });
    // What the drafter read of the estate, as data, below the artifacts (ADR 0115).
    for (const x of review?.sources ?? [])
      if (x.kind !== "instruction" && !docs.has(x.id) && !sources.some((y) => y.id === x.id))
        sources.push({
          ...x,
          // The merged target flows are the draft itself, read in order: kept above the estate.
          priority: x.id === MERGED_FLOWS ? 8 : Math.min(x.priority ?? 4, 4),
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
        // ADR 0112: a lens whose prompt can't fit the model fails here, saying so, unsent.
        step: `critic ${ctx.change.id} (the ${agent.id} lens)`,
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
        ...quarantineHits(lens, QUESTION_ROLES[lens], quarantined, (source) => docs.has(source)),
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
        stepClass: "critic",
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
      const seen = [...docs.values()].filter((d) => !out.left.has(d.path));
      let parsed = parseLensOutput(ctx, lens, run.output, sent, seen);
      let final = meta;
      // An answer that doesn't read (a value with ": " left unquoted, say) goes back to the lens
      // once in the same round, with why, so a format slip doesn't throw a good review away.
      // The earlier answer rides as data; nothing is repaired by Atticus.
      if (parsed.malformed) {
        const again = await o.runtime.prepare({
          change: ctx.change.id,
          agent,
          pack: buildContextPack({
            change: ctx.change.id,
            agent: agent.id,
            budget,
            sources: [
              ...sources,
              {
                id: "0-read-again",
                kind: "instruction",
                origin: "atticus/critic",
                text: `Your last answer to this review could not be read: ${parsed.malformed}. Write the same review again as the YAML asked for. Put any value that contains ": " or starts with a quote in double quotes.`,
                classification: "public",
                trusted: true,
              },
              {
                id: "last-answer",
                kind: "artifact",
                origin: `the ${lens} lens's last answer`,
                text: run.output,
                classification: "internal",
                priority: 9,
              },
            ],
            levels,
            maxClassification:
              o.maxClassification ??
              (levels.includes("confidential") ? "confidential" : levels.at(-1)!),
            now: new Date(ctx.now),
            step: `critic ${ctx.change.id} (the ${agent.id} lens, read again)`,
          }),
          outputPath: `findings-${lens}.yaml`,
          outputIn: "run",
          stepClass: "critic",
        });
        const second = await o.runtime.run(again.runId);
        if (second.state === "validated" && second.output !== undefined) {
          parsed = parseLensOutput(ctx, lens, second.output, sent, seen);
          final = {
            runtime: second.runtime,
            summary: toRunSummary(second),
            promptSha256: again.request.pack.manifest.promptSha256,
          };
        }
      }
      // A name a finding says is missing, looked up as a fact (W1): found, the finding is a note.
      await checkAbsences(ctx.root, ctx.records, parsed.hits, codeSearchFor(o.codeSearch));
      hits.push(...parsed.hits);
      discarded.push(...parsed.discarded);
      // An answer that isn't a review (empty, a refusal, prose) is a lens that failed, never a
      // clean review: the gate stays closed until a lens really reviews.
      runs.push(
        parsed.malformed
          ? { ...base, ...final, state: "failed", reason: parsed.malformed }
          : { ...base, ...final, state: "ran", ...(out.reason ? { reason: out.reason } : {}) },
      );
    } catch (e) {
      runs.push({ ...base, state: "failed", reason: (e as Error).message });
    }
  }
  return { hits, runs, discarded, skipped };
}
