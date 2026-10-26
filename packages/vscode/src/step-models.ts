import { CONFIGURED_MODEL, modelChoice, modelSetting, WORDS, type ModelChoice } from "./words";
import { readYaml } from "./yaml-lite";

/**
 * Per-step models in VS Code (ADR 0121 addendum). Each AI request has a kind of step, which the
 * command line decides and says with each hand-off (`stepClass`), with runtime.yaml's model for
 * it (`orgModel`). The model a kind runs on here is the first of:
 *
 * 1. the person's setting for that kind, atticus.models.<kind>;
 * 2. runtime.yaml's models.<kind>, the organisation's;
 * 3. the setting atticus.model, the person's model for every step;
 * 4. the model picked in the Copilot chat, when the step runs from it;
 * 5. Copilot's first model.
 *
 * A choice VS Code doesn't offer (an admin turned it off, or its extension isn't there) is passed
 * over for the next, and the step says so once. Only the person's own choices, the organisation's
 * and Copilot's are tried: nothing else is ever picked. `atticus` in a choice is runtime.yaml's
 * model run by the command line, which only a whole step can do (the step's own kind decides).
 * No `vscode` here: the language model API is passed in, so the tests mock it.
 */

export const STEP_CLASSES = ["read", "draft", "critic", "knowledge", "quick"] as const;
export type StepClass = (typeof STEP_CLASSES)[number];

export const isStepClass = (c: unknown): c is StepClass =>
  typeof c === "string" && (STEP_CLASSES as readonly string[]).includes(c);

/** The person's settings: atticus.models.<kind> and atticus.model. */
export interface ModelSettings {
  perClass: Partial<Record<StepClass, string>>;
  model: string;
}

/** Where the choice that was taken came from. */
export type ChoiceSource = "class-setting" | "runtime.yaml" | "model-setting" | "chat" | "copilot";

/** VS Code's language model API in the one shape the choice needs (tests mock it). */
export type SelectModels<M> = (selector: { vendor: string; family?: string }) => Promise<M[]>;

export interface StepModelChoice<M> {
  model?: M;
  from?: ChoiceSource;
  /** What was passed over, in words: said once to the person. */
  notes: string[];
  /** The kind's choice is runtime.yaml's model, run by the command line (model mode). */
  configured?: boolean;
}

/** The choices in order, before VS Code is asked: each with the setting text it came from. */
export function choicesFor(
  c: StepClass | undefined,
  s: ModelSettings,
  orgModel?: string,
): { value: string; from: ChoiceSource }[] {
  const out: { value: string; from: ChoiceSource }[] = [];
  const own = c ? s.perClass[c]?.trim() : undefined;
  if (own) out.push({ value: own, from: "class-setting" });
  if (orgModel?.trim()) out.push({ value: orgModel.trim(), from: "runtime.yaml" });
  if (s.model.trim()) out.push({ value: s.model.trim(), from: "model-setting" });
  return out;
}

/** Whether a whole step runs on runtime.yaml's model: its kind's first choice says `atticus`. */
export function usesConfigured(
  c: StepClass | undefined,
  s: ModelSettings,
  orgModel?: string,
): boolean {
  return modelChoice(choicesFor(c, s, orgModel)[0]?.value ?? "") === "configured";
}

/**
 * The model one kind of step runs on: the first choice VS Code offers, else the chat's model,
 * else Copilot's first. `handOff` is true while the step hands its prompts to VS Code's model:
 * then an `atticus` choice can't be taken for one request, and is passed over with a note.
 */
export async function chooseStepModel<M>(
  c: StepClass | undefined,
  s: ModelSettings,
  o: {
    select: SelectModels<M>;
    orgModel?: string;
    chatModel?: M;
    handOff?: boolean;
  },
): Promise<StepModelChoice<M>> {
  const notes: string[] = [];
  for (const choice of choicesFor(c, s, o.orgModel)) {
    const m = modelChoice(choice.value);
    if (!m) continue;
    if (m === "configured") {
      if (!o.handOff) return { notes, configured: true, from: choice.from };
      notes.push(WORDS.modelConfiguredPassedOver(whereWords(choice.from, c)));
      continue;
    }
    const [found] = await o.select({ vendor: m.vendor, family: m.family });
    if (found) return { model: found, from: choice.from, notes: said(notes, c, choice.from) };
    notes.push(WORDS.modelNotOffered(modelSetting(m), whereWords(choice.from, c)));
  }
  if (o.chatModel) return { model: o.chatModel, from: "chat", notes: said(notes, c, "chat") };
  const [first] = await o.select({ vendor: "copilot" });
  return first
    ? { model: first, from: "copilot", notes: said(notes, c, "copilot") }
    : { notes: notes.length ? [...notes, WORDS.modelNoneLeft] : notes };
}

/** The notes, ending with the choice taken instead, when anything was passed over. */
function said(notes: string[], c: StepClass | undefined, from: ChoiceSource): string[] {
  return notes.length ? [...notes, WORDS.modelInstead(c, SOURCE[from])] : notes;
}

const SOURCE: Record<ChoiceSource, string> = {
  "class-setting": "your setting for this kind of step",
  "runtime.yaml": "runtime.yaml's model for this kind of step",
  "model-setting": "your setting atticus.model",
  chat: "the model picked in the chat",
  copilot: "Copilot's first model",
};

function whereWords(from: ChoiceSource, c: StepClass | undefined): string {
  if (from === "class-setting") return `atticus.models.${c}`;
  if (from === "runtime.yaml") return `runtime.yaml's models.${c}`;
  return from === "model-setting" ? "atticus.model" : SOURCE[from];
}

/**
 * The kind of step an AI step command runs its drafts as (the same as the command line's
 * stepClassOfCommand), for what the whole step does before it hands anything off: whether it
 * runs in model mode, and the model its prompt is sized for. Each hand-off then says its own.
 */
export function stepClassOfArgs(args: readonly string[]): StepClass | undefined {
  const [group, command] = args;
  if (group === "map") return "read";
  if (group === "critic") return "critic";
  if (group === "task" && command && command !== "context") return "draft";
  return COMMAND_CLASS[`${group ?? ""} ${command ?? ""}`];
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

/**
 * The model a kind of step will run on, in words, before VS Code is asked (the Next view's line):
 * its first choice, or the chat's model when nothing is set.
 */
export function plannedModel(
  c: StepClass | undefined,
  s: ModelSettings,
  orgModel?: string,
): string {
  const first = choicesFor(c, s, orgModel)[0];
  const m = first ? modelChoice(first.value) : undefined;
  if (!m) return WORDS.modelChatOrCopilot;
  return m === "configured" ? WORDS.modelConfigured : modelSetting(m as ModelChoice);
}

/**
 * runtime.yaml's model for each kind of step (its `models.<kind>`), from the file's text: what
 * the extension knows before a step hands anything off. Nothing when it can't be read.
 */
export function orgModelsFrom(runtimeYaml: string | undefined): Partial<Record<StepClass, string>> {
  const doc = runtimeYaml === undefined ? undefined : readYaml(runtimeYaml);
  const models =
    doc && typeof doc === "object" && !Array.isArray(doc)
      ? (doc as Record<string, unknown>).models
      : undefined;
  const out: Partial<Record<StepClass, string>> = {};
  if (!models || typeof models !== "object" || Array.isArray(models)) return out;
  for (const c of STEP_CLASSES) {
    const v = (models as Record<string, unknown>)[c];
    if (typeof v === "string" && v.trim()) out[c] = v.trim();
  }
  return out;
}

/** The environment the command line gets the person's per-kind settings by (doctor, model mode). */
export function modelEnv(s: ModelSettings): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of STEP_CLASSES) {
    const v = s.perClass[c]?.trim();
    if (v && v !== CONFIGURED_MODEL) out[`ATTICUS_MODEL_${c.toUpperCase()}`] = v;
  }
  return out;
}
