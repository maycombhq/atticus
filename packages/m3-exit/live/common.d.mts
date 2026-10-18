export const CHANGE: string;
export const BIN: string;
export const SANDBOXES: {
  stories: string;
  critic: string;
  task: string;
  handup: string;
  names: string;
};
export const RECORDING_DIRS: string[];
export const GIT_IDENTITY: Record<string, string>;
export type SandboxKey = keyof typeof SANDBOXES;
export interface CommandResult {
  code: number;
  out: string[];
  err: string[];
  stdout: string;
  stderr: string;
  text: string;
}
export function assertBuilt(): void;
export function metarepoOf(runDir: string, key: SandboxKey): string;
export function changeDirOf(root: string): string;
export function atticus(
  cwd: string,
  args: string[],
  env?: Record<string, string>,
): Promise<CommandResult>;
export function readYaml(path: string): Promise<unknown>;
export function writeText(path: string, text: string): Promise<void>;
export function matches(
  e: {
    rule: string;
    severity: string;
    kind: string;
    artifact?: string;
    line?: number;
    record?: string;
  },
  f: {
    rule: string;
    severity: string;
    kind: string;
    artifact?: string;
    locator?: { line?: number; record?: string };
    evidence?: { record?: string }[];
  },
): boolean;
export function runFolders(outDir: string): Promise<string[]>;
export function recordingsOf(agent: string): Promise<{ promptSha256: string; output: string }[]>;
export function recordedAnswer(agent: string, promptSha256?: string): Promise<string>;
export function fileBlocks(output: string): [string, string][];
