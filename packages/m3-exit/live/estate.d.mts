export const PACKAGE: string;
export const REPO: string;
export const FIXTURES: string;
export const FORGE: string;
export const FORGE_CHANGE: string;
export const SPECKIT: string;
export const OWN: string;
export const CHANGE: string;
export function sh(cwd: string, ...args: string[]): string;
export interface ForgeEstate {
  top: string;
  root: string;
  replayDir: string | undefined;
  buildLog: string;
  fakeBuild: string;
}
export function forgeEstate(o?: { top?: string; answers?: boolean }): Promise<ForgeEstate>;
