import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
export const fixture = (name: string) => join(FIXTURES, name);

const made: string[] = [];

/** A fresh temporary folder, removed by `cleanup`. */
export async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "atticus-adopt-"));
  made.push(d);
  return d;
}

/** Copy a fixture into a temporary folder under the given name (the folder name matters to adopt). */
export async function copyFixture(name: string, as: string = name): Promise<string> {
  const dir = join(await tempDir(), as);
  await cp(fixture(name), dir, { recursive: true });
  return dir;
}

export async function cleanup(): Promise<void> {
  while (made.length) await rm(made.pop()!, { recursive: true, force: true });
}

export const SCANNED_AT = "2026-10-18T12:00:00Z";
export const COMMIT = "a".repeat(40);
