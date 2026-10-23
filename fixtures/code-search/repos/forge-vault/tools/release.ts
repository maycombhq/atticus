export interface ReleaseNote {
  version: string;
}

export function noteFor(version: string): ReleaseNote {
  return { version };
}

export const latest = (): ReleaseNote => noteFor("1.0.0");
