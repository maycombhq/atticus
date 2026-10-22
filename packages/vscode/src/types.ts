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
