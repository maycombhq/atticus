import * as vscode from "vscode";
import {
  ModelRefused,
  type Cancel,
  type ChatTurnMessage,
  type ModelTool,
  type ModelTurn,
  type StepModel,
} from "./types";
import { WORDS, modelChoice, modelPickRows } from "./words";

/**
 * vscode.lm in the runner's shape (ADR 0090). The model is any chat model VS Code offers (ADR
 * 0121 item 5): the one the setting atticus.model names (`vendor/family`, or a bare family for
 * Copilot's), else the model the person picked in the chat (when the step runs from the chat),
 * else the first Copilot model. The first request outside the chat makes VS Code ask the person;
 * a refusal becomes ModelRefused. `atticus` in the setting is runtime.yaml's model, which the
 * command line runs (usesConfiguredModel), so vscode.lm isn't asked.
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

const setting = () => vscode.workspace.getConfiguration("atticus").get<string>("model", "");

/** The setting asks for runtime.yaml's model: the step runs in model mode by the command line. */
export const usesConfiguredModel = () => modelChoice(setting()) === "configured";

export async function pickModel(
  chatModel?: vscode.LanguageModelChat,
): Promise<StepModel | undefined> {
  const choice = modelChoice(setting());
  if (choice === "configured") return undefined;
  if (choice) {
    const [m] = await vscode.lm.selectChatModels(choice);
    return m ? adapt(m) : undefined;
  }
  if (chatModel) return adapt(chatModel);
  const [m] = await vscode.lm.selectChatModels({ vendor: "copilot" });
  return m ? adapt(m) : undefined;
}

/**
 * Atticus: Pick the model (ADR 0121 item 5): every chat model VS Code offers, by vendor, plus
 * Copilot's default and Atticus's configured model; the choice is written to atticus.model.
 */
export async function chooseModel(): Promise<void> {
  const models = await vscode.lm.selectChatModels();
  const rows = modelPickRows(
    models.map((m) => ({ vendor: m.vendor, family: m.family, name: m.name })),
    setting(),
  );
  type Item = vscode.QuickPickItem & { setting?: string };
  const items: Item[] = rows.map((r) =>
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
  const pick = await vscode.window.showQuickPick(items, {
    title: WORDS.pickModel,
    placeHolder: WORDS.pickModelPlaceholder,
    matchOnDescription: true,
  });
  if (pick?.setting === undefined) return;
  await vscode.workspace
    .getConfiguration("atticus")
    .update("model", pick.setting, vscode.ConfigurationTarget.Global);
  void vscode.window.showInformationMessage(
    WORDS.modelPicked(pick.label.replace(/^\$\(check\) /, "")),
  );
}
