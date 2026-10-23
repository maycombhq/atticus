/**
 * The small interfaces the extension's core uses in place of VS Code's API (ADR 0090), so the
 * runner, the command line and the words run under vitest without VS Code. `vscode.CancellationToken`
 * fits `Cancel` as it is; `vscode-model.ts` adapts `vscode.LanguageModelChat` to `StepModel`.
 */

/** A cancellation token: VS Code's, or a test's. */
export interface Cancel {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => unknown): { dispose(): unknown };
}

/** A chat model the runner sends a step's prompt to. */
export interface StepModel {
  /** The model's name as a person reads it. */
  readonly name: string;
  /** The most tokens the model takes in one request. */
  readonly maxInputTokens: number;
  countTokens(text: string, token: Cancel): Promise<number>;
  /** Send the messages (each a user message, in order); the answer comes back in parts. */
  send(messages: string[], token: Cancel): Promise<AsyncIterable<string>>;
  /**
   * One request of a conversation with tools (ADR 0107 addendum): the model answers with text,
   * or with tool calls for the runner to run. Absent: the model gets the one-shot prompt.
   */
  chat?(messages: ChatTurnMessage[], tools: ModelTool[], token: Cancel): Promise<ModelTurn>;
}

/** A read-only tool the model may call, as `atticus ... --handoff --json` offers it. */
export interface ModelTool {
  name: string;
  description: string;
  inputSchema: object;
}

export interface ModelToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ChatTurnMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; calls: ModelToolCall[] }
  | { role: "tool"; results: { id: string; name: string; text: string }[] };

export interface ModelTurn {
  text: string;
  calls: ModelToolCall[];
}

/** The person didn't allow the extension to use the model (VS Code asked them). */
export class ModelRefused extends Error {}

/** What one run of the command line gave. */
export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  /** The run was stopped because the person cancelled. */
  cancelled: boolean;
}

/** Run `atticus <args>` in the metarepo. */
export type Cli = (args: string[], token?: Cancel) => Promise<CliResult>;

/** An open question, as `atticus questions list --json` and `--handoff --json` give it. */
export interface OpenQuestion {
  id: string;
  repo: string;
  question: string;
  options: { label: string; means?: string; changes?: string }[];
  evidence: string[];
}

/** One step of `atticus next --json`. */
export interface NextStep {
  step: string;
  command: string;
  slash?: string;
  where?: string;
  why: string;
  person?: boolean;
  repo?: string;
  change?: string;
  source?: string;
}
