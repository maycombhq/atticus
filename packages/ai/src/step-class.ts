import {
  STEP_CLASSES,
  stepModelsOf,
  type AgentDefinition,
  type Runtime,
  type StepClass,
} from "@maycombhq/core";

/**
 * Per-step models (ADR 0121 addendum). Every AI request has a class, decided here in code from
 * the agent that runs it (or a tag its call site sets), never from its prompt; the class picks
 * the model. Read, draft and critic, knowledge and quick are the five (core `STEP_CLASSES`).
 */

/**
 * The class of each built-in agent. An org pack's agent of the same id takes its class; an
 * agent of the org's own is a critic when it writes findings, else a draft (the model a draft
 * runs on is the strongest an organisation names, so an unknown step never runs on less).
 */
export const STEP_CLASS_BY_AGENT: Readonly<Record<string, StepClass>> = {
  // read: the repo read into facts (atticus map, and its fix round for the facts rejected).
  "repo-reader": "read",
  // draft: what a change is, drawn and written; the spec, the scan settings and the dialects.
  "feature-placer": "draft",
  "flow-architect": "draft",
  "story-writer-flows": "draft",
  "story-writer": "draft",
  "small-change-planner": "draft",
  "change-drafter": "draft",
  "spec-drafter": "draft",
  "dialect-drafter": "draft",
  "framework-drafter": "draft",
  "task-runner": "draft",
  "test-writer": "draft",
  // knowledge: the wikis read into items, a search of them, which apply to a change, and ask.
  "knowledge-reader": "knowledge",
  "knowledge-asker": "knowledge",
  "needs-finder": "knowledge",
  // quick: closed judgments, the context engine's expansion and order, names and short texts.
  judge: "quick",
  "context-expander": "quick",
  "context-reranker": "quick",
  "feature-namer": "quick",
  "glossary-definer": "quick",
  "template-writer": "quick",
  explainer: "quick",
};

/** What decides a request's class: its agent, and the tag its call site may set. */
export interface ClassedRequest {
  agent: Pick<AgentDefinition, "id" | "outputArtifact">;
  stepClass?: StepClass;
}

/** The request's class: its call site's tag, else its agent's, else findings → critic, else draft. */
export function stepClassOf(request: ClassedRequest): StepClass {
  if (request.stepClass) return request.stepClass;
  const known = STEP_CLASS_BY_AGENT[request.agent.id];
  if (known) return known;
  if (request.agent.outputArtifact === "findings" || request.agent.id.endsWith("-critic"))
    return "critic";
  return "draft";
}

/**
 * The class an AI step command's own requests run as (`atticus <group> <command>`), for what
 * says which model a step will use before it runs (atticus next, the editors). A stage's critic
 * lenses run as critic whatever the step; each run says its own class when it is handed off.
 */
export function stepClassOfCommand(args: readonly string[]): StepClass | undefined {
  const [group, command] = args;
  if (group === "map") return "read";
  if (group === "critic") return "critic";
  // atticus task <change> <task> is task run's short form.
  if (group === "task" && command && command !== "context") return "draft";
  const key = `${group ?? ""} ${command ?? ""}`;
  return COMMAND_CLASS[key];
}

const COMMAND_CLASS: Record<string, StepClass> = {
  "scan verify": "read",
  "scan survey": "draft",
  "spec draft": "draft",
  "change feature": "draft",
  "change architecture": "draft",
  "change small": "draft",
  "change draft": "draft",
  "plan stories": "draft",
  "knowledge scan": "knowledge",
  "knowledge find": "knowledge",
  "knowledge ask": "knowledge",
  "change needs": "knowledge",
};

/** The class of a step `atticus next` names (its `step`), when it is an AI step. */
export function stepClassOfNextStep(step: string): StepClass | undefined {
  return NEXT_CLASS[step];
}

const NEXT_CLASS: Record<string, StepClass> = {
  survey: "draft",
  verify: "read",
  map: "read",
  spec: "draft",
  knowledge: "knowledge",
  feature: "draft",
  architecture: "draft",
  stories: "draft",
  small: "draft",
  needs: "knowledge",
  task: "draft",
};

// ------------------------------------------------------------------ which model

/** Where a step's model came from: a person's setting, runtime.yaml, or the one model. */
export type ModelSource = "setting" | "runtime.yaml" | "fallback";

export interface ClassModel {
  stepClass: StepClass;
  /** The model; undefined when there is none (no provider model, and none named). */
  model?: string;
  from: ModelSource;
  /** Why a model named for this class wasn't used, in words, when one wasn't. */
  notes: string[];
}

/** The environment variable a person's setting for a class reaches the command line by. */
export const modelEnvOf = (c: StepClass) => `ATTICUS_MODEL_${c.toUpperCase()}`;

/** The model runtime.yaml's provider runs when a step names none (adapters.model's settings). */
export function providerModelOf(rt: Pick<Runtime, "adapters">): string | undefined {
  const s = rt.adapters.model?.settings ?? {};
  const pick = (k: string) => (typeof s[k] === "string" && s[k] ? (s[k] as string) : undefined);
  return pick("model") ?? pick("deployment");
}

/**
 * The model each class runs on in model mode (or headless Claude Code), and where it came from:
 * the person's setting (ATTICUS_MODEL_<CLASS>, which the editors pass), else runtime.yaml's
 * `models.<class>`, else the provider's one model. A model the provider can't run is passed
 * over, with a note: one models.allowed doesn't list (when it lists any), or an editor's
 * `vendor/family` that models.allowed doesn't list. `atticus` in a setting means runtime.yaml's.
 */
export function modelsByClass(
  rt: Pick<Runtime, "adapters" | "models">,
  env: Record<string, string | undefined> = {},
): Record<StepClass, ClassModel> {
  const named = stepModelsOf(rt);
  const allowed = rt.models.allowed;
  const fallback = providerModelOf(rt);
  const out = {} as Record<StepClass, ClassModel>;
  for (const c of STEP_CLASSES) {
    const notes: string[] = [];
    const tries: { model: string; from: ModelSource; where: string }[] = [];
    const set = env[modelEnvOf(c)]?.trim();
    if (set && set !== "atticus")
      tries.push({ model: set, from: "setting", where: `Your setting for ${c} steps` });
    if (named[c]) tries.push({ model: named[c]!, from: "runtime.yaml", where: `models.${c}` });
    let chosen: ClassModel | undefined;
    for (const t of tries) {
      const why = unusable(t.model, allowed);
      if (!why) {
        chosen = { stepClass: c, model: t.model, from: t.from, notes };
        break;
      }
      notes.push(`${t.where} names ${t.model}, ${why}.`);
    }
    chosen ??= { stepClass: c, ...(fallback ? { model: fallback } : {}), from: "fallback", notes };
    if (notes.length)
      notes.push(
        chosen.model
          ? `${cap(c)} steps run on ${chosen.model} (${SOURCE_WORDS[chosen.from]}).`
          : `${cap(c)} steps run on the provider's own model.`,
      );
    out[c] = chosen;
  }
  return out;
}

const SOURCE_WORDS: Record<ModelSource, string> = {
  setting: "your setting",
  "runtime.yaml": "runtime.yaml",
  fallback: "adapters.model in runtime.yaml",
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function unusable(model: string, allowed: readonly string[]): string | undefined {
  if (allowed.length && !allowed.includes(model))
    return "which models.allowed in runtime.yaml doesn't list";
  if (model.includes("/") && !allowed.includes(model))
    return "an editor's model (vendor/family), which runtime.yaml's provider doesn't run";
  return undefined;
}

/** The words for where a model came from, as doctor and the run lines say them. */
export const modelSourceWords = (from: ModelSource) => SOURCE_WORDS[from];
