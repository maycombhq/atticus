import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

/**
 * Write a file so a crash never leaves it half-written: write a temporary file beside it,
 * then rename it over the old one (a rename within a folder is atomic on every platform
 * Atticus supports). The temporary name is unique, so two writers never share it. On
 * Windows a rename can fail for a moment while a virus scanner or indexer holds the file:
 * it is retried a few times before giving up.
 */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, data, typeof data === "string" ? "utf8" : undefined);
    await renameRetrying(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

const BUSY = new Set(["EPERM", "EBUSY", "EACCES"]);

// Up to about 5 s in all (20 ms doubling): on Windows an editor indexing a folder it has just
// opened, or a virus scanner, can hold a file longer than half a second (seen running atticus
// upgrade with VS Code opening the metarepo). It only waits when the file is held.
export async function renameRetrying(from: string, to: string, tries = 9): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (!BUSY.has(code) || i >= tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 20 * 2 ** i));
    }
  }
}

// ------------------------------------------------------------------ locks

export interface LockInfo {
  pid: number;
  host: string;
  startedAt: string;
  what: string;
}

export class LockHeldError extends Error {
  constructor(readonly held: LockInfo) {
    super(
      `Another ${held.what} is running (process ${held.pid} on ${held.host}, since ${held.startedAt}). Wait for it to finish.`,
    );
    this.name = "LockHeldError";
  }
}

/** Where a metarepo's locks live: .atticus/locks/, on this machine only (git-ignored). */
export const lockFileOf = (root: string, name: string) =>
  join(root, ".atticus", "locks", `${name}.json`);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Read a lock: undefined when free; `stale` when its process is gone (it was cut short). */
export async function readLock(
  root: string,
  name: string,
): Promise<(LockInfo & { stale: boolean }) | undefined> {
  try {
    const info = JSON.parse(await readFile(lockFileOf(root, name), "utf8")) as LockInfo;
    const stale = info.host === hostname() ? !alive(info.pid) : false;
    return { ...info, stale };
  } catch {
    return undefined;
  }
}

/**
 * Take a lock for a long write (a scan): one at a time per metarepo. A lock whose process is
 * gone was cut short (a crash, a closed terminal); it is taken over and reported as
 * `interrupted`, so the caller can say the last run didn't finish.
 */
export async function acquireLock(
  root: string,
  name: string,
  what: string,
  now: () => Date = () => new Date(),
): Promise<{ release: () => Promise<void>; interrupted?: LockInfo }> {
  const file = lockFileOf(root, name);
  await ensureLocalIgnore(root);
  await mkdir(dirname(file), { recursive: true });
  const info: LockInfo = {
    pid: process.pid,
    host: hostname(),
    startedAt: now().toISOString(),
    what,
  };
  let interrupted: LockInfo | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(file, JSON.stringify(info), { encoding: "utf8", flag: "wx" });
      const release = async () => {
        const cur = await readLock(root, name);
        if (cur && cur.pid === info.pid && cur.startedAt === info.startedAt)
          await rm(file, { force: true });
      };
      return interrupted ? { release, interrupted } : { release };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const held = await readLock(root, name);
      if (held && !held.stale) throw new LockHeldError(held);
      if (held) {
        const { stale: _s, ...rest } = held;
        interrupted = rest;
      }
      await rm(file, { force: true });
    }
  }
  throw new Error(`Couldn't take the ${name} lock at ${file}.`);
}

/**
 * What stays on this machine inside .atticus/: the person's settings, the log, locks, upgrade
 * backups, the prompt and response history (ADR 0110) and what `atticus probe` measured of the
 * person's assistant (ADR 0124 addendum A-probe).
 */
export const LOCAL_ONLY = ["me.yaml", "logs/", "locks/", "backups/", "history/", "probe/"] as const;

/**
 * Make sure .atticus/.gitignore keeps this machine's files out of Git. It lives inside
 * .atticus/, so it works the same in a metarepo and in a repo adopted in place (where Atticus
 * writes nothing outside .atticus/).
 */
export async function ensureLocalIgnore(root: string): Promise<void> {
  const file = join(root, ".atticus", ".gitignore");
  const text = await readFile(file, "utf8").catch(() => "");
  const have = new Set(text.split(/\r?\n/).map((l) => l.trim()));
  const missing = LOCAL_ONLY.filter((l) => !have.has(l));
  if (!missing.length) return;
  await mkdir(dirname(file), { recursive: true });
  const prefix = text && !text.endsWith("\n") ? `${text}\n` : text;
  await writeFile(
    file,
    `${prefix}${prefix ? "" : "# This machine's own files: never committed.\n"}${missing.join("\n")}\n`,
    "utf8",
  );
}
