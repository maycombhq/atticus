import { createHash, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Review round 50 (ADR 0186 addendum): what Atticus keeps for this person outside the metarepo,
 * where the assistant can't write it: the resume of a step the app prepared, and the address the
 * person last confirmed for the model's key. Everything under the metarepo (`.runs/`, the org
 * pack, `.atticus/`, even what is committed) is the assistant's to write, so none of it can say
 * what the person decided.
 *
 * The folder: `$XDG_STATE_HOME/atticus` when that is set, else `%LOCALAPPDATA%\atticus\state`
 * on Windows and `~/.local/state/atticus` elsewhere; one folder in it per metarepo, named by a
 * hash of the metarepo's real path. Only this user reads it (0700 folders, 0600 files).
 */
export function userStateDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const xdg = env.XDG_STATE_HOME?.trim();
  if (xdg) return join(xdg, "atticus");
  if (platform === "win32")
    return join(
      env.LOCALAPPDATA?.trim() || join(homedir(), "AppData", "Local"),
      "atticus",
      "state",
    );
  return join(homedir(), ".local", "state", "atticus");
}

/** The metarepo's own folder in it: a hash of its real path, so a moved metarepo starts afresh. */
export function metarepoStateDir(root: string, env: NodeJS.ProcessEnv = process.env): string {
  let real = resolve(root);
  try {
    real = realpathSync.native(real);
  } catch {
    // Not there (yet): its path as given.
  }
  if (process.platform === "win32") real = real.toLowerCase();
  const id = createHash("sha256").update(real).digest("hex").slice(0, 24);
  return join(userStateDir(env), "metarepos", id);
}

/** A JSON file of this metarepo's state, or undefined when there is none (or it doesn't read). */
export async function readUserState<T>(
  root: string,
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T | undefined> {
  const text = await readFile(join(metarepoStateDir(root, env), name), "utf8").catch(
    () => undefined,
  );
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** Write one, whole (a temporary file renamed over it), readable by this user only. */
export async function writeUserState(
  root: string,
  name: string,
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const file = join(metarepoStateDir(root, env), name);
  const dir = join(file, "..");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify({ ...(value as object), root: resolve(root) }) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

export async function forgetUserState(
  root: string,
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await rm(join(metarepoStateDir(root, env), name), { force: true });
}
