import * as vscode from "vscode";
import {
  ModelRefused,
  type Cancel,
  type ChatTurnMessage,
  type ModelTool,
  type ModelTurn,
  type StepModel,
} from "./types";

/**
 * vscode.lm in the runner's shape (ADR 0090). The model is a Copilot chat model: the family in
 * the setting atticus.model, else the model the person picked in Copilot Chat (when the step runs
 * from the chat), else the first Copilot model. The first request outside the chat makes VS Code
 * ask the person; a refusal becomes ModelRefused.
 */

const JUSTIFICATION =
  "Atticus sends one step's prompt (built from your metarepo and repos) to the Copilot model and writes the answer to the step's result file, where Atticus's command line checks it.";

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

export async function pickModel(
  chatModel?: vscode.LanguageModelChat,
): Promise<StepModel | undefined> {
  const family = vscode.workspace.getConfiguration("atticus").get<string>("model", "").trim();
  if (family) {
    const [m] = await vscode.lm.selectChatModels({ vendor: "copilot", family });
    return m ? adapt(m) : undefined;
  }
  if (chatModel?.vendor === "copilot") return adapt(chatModel);
  const [m] = await vscode.lm.selectChatModels({ vendor: "copilot" });
  return m ? adapt(m) : undefined;
}
