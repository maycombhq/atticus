import * as vscode from "vscode";
import {
  ModelRefused,
  type Cancel,
  type ChatTurnMessage,
  type ModelTool,
  type ModelTurn,
  type StepModel,
} from "./types";
import {
  chooseStepModel,
  isStepClass,
  STEP_CLASSES,
  stepClassOfArgs,
  usesConfigured,
  type ModelSettings,
  type StepClass,
} from "./step-models";
import { modelPickRows, modelSetting, scopeRows, STEP_CLASS_WORDS, WORDS } from "./words";

/**
 * vscode.lm in the runner's shape (ADR 0090). The model is any chat model VS Code offers (ADR
 * 0121 item 5), one per kind of step (its addendum): the setting atticus.models.<kind>, else
 * runtime.yaml's model for the kind, else atticus.model (`vendor/family`, or a bare family for
 * Copilot's), else the model the person picked in the chat (when the step runs from the chat),
 * else the first Copilot model (step-models.ts). The first request outside the chat makes VS
 * Code ask the person; a refusal becomes ModelRefused. `atticus` is runtime.yaml's model, which
 * the command line runs (usesConfiguredModel), so vscode.lm isn't asked.
 */

const JUSTIFICATION =
  "Atticus sends one step's prompt (built from your metarepo and repos) to the language model and writes the answer to the step's result file, where Atticus's command line checks it.";

function adapt(m: vscode.LanguageModelChat): StepModel {
  const refused = (e: unknown) =>
    e instanceof vscode.LanguageModelError &&
    e.code === vscode.LanguageModelError.NoPermissions.name
      ? new ModelRefused(e.message)
      : e;
  return {
    name: m.name,
    id: modelSetting({ vendor: m.vendor, family: m.family }),
    maxInputTokens: m.maxInputTokens,
    async countTokens(text: string, token: Cancel) {
      try {
        return await m.countTokens(text, token as vscode.CancellationToken);
      } catch (e) {
        throw refused(e);
      }
    },
    async send(messages: string[], token: Cancel) {
      try {
        const r = await m.sendRequest(
          messages.map((t) => vscode.LanguageModelChatMessage.User(t)),
          { justification: JUSTIFICATION },
          token as vscode.CancellationToken,
        );
        return r.text;
      } catch (e) {
        throw refused(e);
      }
    },
    // ADR 0107 addendum: the language model API's tool calls (LanguageModelChatRequestOptions
    // tools, LanguageModelToolCallPart in the answer, LanguageModelToolResultPart back).
    async chat(messages: ChatTurnMessage[], tools: ModelTool[], token: Cancel): Promise<ModelTurn> {
      const sent = messages.map((x) =>
        x.role === "user"
          ? vscode.LanguageModelChatMessage.User(x.text)
          : x.role === "assistant"
            ? vscode.LanguageModelChatMessage.Assistant([
                ...(x.text ? [new vscode.LanguageModelTextPart(x.text)] : []),
                ...x.calls.map((c) => new vscode.LanguageModelToolCallPart(c.id, c.name, c.input)),
              ])
            : vscode.LanguageModelChatMessage.User(
                x.results.map(
                  (r) =>
                    new vscode.LanguageModelToolResultPart(r.id, [
                      new vscode.LanguageModelTextPart(r.text),
                    ]),
                ),
              ),
      );
      try {
        const r = await m.sendRequest(
          sent,
          {
            justification: JUSTIFICATION,
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
            toolMode: vscode.LanguageModelChatToolMode.Auto,
          },
          token as vscode.CancellationToken,
        );
        let text = "";
        const calls: ModelTurn["calls"] = [];
        for await (const part of r.stream) {
          if (part instanceof vscode.LanguageModelTextPart) text += part.value;
          else if (part instanceof vscode.LanguageModelToolCallPart)
            calls.push({
              id: part.callId,
              name: part.name,
              input: (part.input ?? {}) as Record<string, unknown>,
            });
        }
        return { text, calls };
      } catch (e) {
        throw refused(e);
      }
    },
  };
}

const config = () => vscode.workspace.getConfiguration("atticus");
const setting = () => config().get<string>("model", "");

/** The person's settings: atticus.model and atticus.models.<kind> (ADR 0121 addendum). */
export function modelSettings(): ModelSettings {
  const perClass: ModelSettings["perClass"] = {};
  for (const c of STEP_CLASSES) {
    const v = config().get<string>(`models.${c}`, "");
    if (v.trim()) perClass[c] = v.trim();
  }
  return { perClass, model: setting() };
}

/**
 * The step runs on runtime.yaml's model, by the command line in model mode: its kind's first
 * choice (the person's setting for it, runtime.yaml's, else atticus.model) says `atticus`.
 */
export const usesConfiguredModel = (
  args: string[] = [],
  org: Partial<Record<StepClass, string>> = {},
) => {
  const c = stepClassOfArgs(args);
  return usesConfigured(c, modelSettings(), c ? org[c] : undefined);
};

/** What was said already, so each passed-over model is told once a window (ADR 0121 addendum). */
const told = new Set<string>();

/**
 * The model for one kind of step (ADR 0121 addendum): atticus.models.<kind>, runtime.yaml's
 * model for it, atticus.model, the chat's model, Copilot's first; what VS Code doesn't offer is
 * passed over, and said: in the step's progress, and once a window as a warning.
 */
export async function pickModel(
  chatModel?: vscode.LanguageModelChat,
  want: { stepClass?: StepClass; orgModel?: string } = {},
  say?: (line: string) => void,
): Promise<StepModel | undefined> {
  const r = await chooseStepModel(want.stepClass, modelSettings(), {
    select: async (s) => vscode.lm.selectChatModels(s),
    handOff: true,
    ...(want.orgModel ? { orgModel: want.orgModel } : {}),
    ...(chatModel ? { chatModel } : {}),
  });
  if (r.notes.length) {
    const text = r.notes.join(" ");
    say?.(text);
    if (!told.has(text)) {
      told.add(text);
      void vscode.window.showWarningMessage(`Atticus: ${text}`);
    }
  }
  return r.model ? adapt(r.model) : undefined;
}

type Row = vscode.QuickPickItem & { setting?: string };

/** VS Code's own note on a model (Copilot's premium-request multiplier), when it exposes one. */
const detailOf = (m: vscode.LanguageModelChat): string | undefined => {
  const d = (m as unknown as { detail?: unknown }).detail;
  return typeof d === "string" && d.trim() ? d.trim() : undefined;
};

/**
 * Atticus: Pick the model (ADR 0121 item 5 and addendum): for every step (atticus.model) or for
 * one kind (atticus.models.<kind>), then every chat model VS Code offers, by vendor, each with
 * VS Code's own note on it when there is one; plus Copilot's default (or, for a kind, the next
 * choice) and Atticus's configured model.
 */
export async function chooseModel(): Promise<void> {
  const s = modelSettings();
  const scopes = scopeRows(s.model, s.perClass);
  const scope = await vscode.window.showQuickPick(scopes, {
    title: WORDS.pickModel,
    placeHolder: WORDS.pickScope,
    matchOnDetail: true,
  });
  if (!scope) return;
  const c = isStepClass(scope.scope) ? scope.scope : undefined;
  const models = await vscode.lm.selectChatModels();
  const rows = modelPickRows(
    models.map((m) => ({
      vendor: m.vendor,
      family: m.family,
      name: m.name,
      ...(detailOf(m) ? { detail: detailOf(m)! } : {}),
    })),
    c ? (s.perClass[c] ?? "") : s.model,
    { forClass: !!c },
  );
  const items: Row[] = rows.map((r) =>
    "separator" in r
      ? { label: r.separator, kind: vscode.QuickPickItemKind.Separator }
      : {
          label: r.picked ? `$(check) ${r.label}` : r.label,
          ...(r.description ? { description: r.description } : {}),
          ...(r.detail ? { detail: r.detail } : {}),
          setting: r.setting,
        },
  );
  if (!models.length) void vscode.window.showWarningMessage(WORDS.modelNone);
  const label = c ? STEP_CLASS_WORDS[c].label : undefined;
  const pick = await vscode.window.showQuickPick(items, {
    title: WORDS.pickModel,
    placeHolder: label ? WORDS.pickClassModel(label) : WORDS.pickModelPlaceholder,
    matchOnDescription: true,
  });
  if (pick?.setting === undefined) return;
  await config().update(
    c ? `models.${c}` : "model",
    pick.setting,
    vscode.ConfigurationTarget.Global,
  );
  const what = pick.label.replace(/^\$\(check\) /, "");
  void vscode.window.showInformationMessage(
    label
      ? pick.setting
        ? WORDS.modelPickedFor(label, what)
        : WORDS.modelFallbackFor(label)
      : WORDS.modelPicked(what),
  );
}
