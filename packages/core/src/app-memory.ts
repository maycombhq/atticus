import { readFileSync } from "node:fs";
import { freemem, totalmem } from "node:os";
import { getHeapStatistics } from "node:v8";

/**
 * ADR 0205 step 4 (the owner's answer of 2026-11-19): what the app's server keeps in memory
 * between Applies, so the next one doesn't read it back from disk: the last build's record texts
 * and the facts parses (core's memo and the build cache's parses not yet on disk). Up to about
 * 1 GB more at 100,000 records, let go:
 * - ten minutes after the last Apply (`appMemoryApplied`; a page's read or a preview is no Apply),
 *   or ten minutes after something was kept with no Apply since;
 * - at once when memory runs low: the heap three quarters full, or the machine's or the
 *   container's memory nearly used (`systemMemory`), checked on each use (the system's at most
 *   once a second) and every half minute on a timer, so an idle server lets go too;
 * - when the last server closes.
 * Off outside the server (`atticus ui` turns it on): a command builds once and ends.
 */
export const appMemory: {
  on: boolean;
  idleMs: number;
  /** The heap's share that is low (of V8's limit). */
  lowAt: number;
  /** The machine's (or container's) free share that is low, and the least free that is. */
  lowFree: number;
  lowFreeMinBytes: number;
  /** How often the timer checks, and how often a use reads the system's memory at most. */
  checkMs: number;
  systemEveryMs: number;
  /** The tests: the machine's memory in place of `systemMemory()`. */
  system?: () => { free: number; total: number };
} = {
  on: false,
  idleMs: 10 * 60 * 1000,
  lowAt: 0.75,
  lowFree: 0.1,
  lowFreeMinBytes: 256 * 1024 * 1024,
  checkMs: 30 * 1000,
  systemEveryMs: 1000,
};

/** A file's text, or undefined where it isn't (no cgroup, another system). */
const readText = (p: string): string | undefined => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
};

const num = (t: string | undefined): number | undefined => {
  const n = t === undefined ? NaN : Number(t.trim());
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

/**
 * The memory this process may still use and the most it may, in bytes: the machine's
 * (`os.freemem`, `os.totalmem`), or its container's where a cgroup limits it lower (Linux: the
 * process's own cgroup, from /proc/self/cgroup, and those above it, the one with the least room:
 * cgroup v2's memory.max and memory.current, less the file cache it can give back, or v1's
 * limit_in_bytes and usage_in_bytes). Windows and macOS have no cgroup files: the machine's.
 */
export function systemMemoryOf(
  read: (path: string) => string | undefined,
  os: { freemem: () => number; totalmem: () => number },
): { free: number; total: number } {
  const machine = { free: os.freemem(), total: os.totalmem() };
  const fileCache = (stat: string | undefined, key: string) =>
    num(new RegExp(`^${key} (\\d+)$`, "m").exec(stat ?? "")?.[1]) ?? 0;
  // The process's own cgroup (the review of cbab428f): /proc/self/cgroup names it, v2's line
  // `0::<path>`, v1's the memory controller's; inside its own namespace it is the root. Its
  // limit is the lowest of its own and every cgroup above it.
  const own = read("/proc/self/cgroup") ?? "";
  const v2Path = /^0::(\/.*)$/m.exec(own)?.[1]?.trim();
  const v1Path = /^\d+:(?:[^:]*,)?memory(?:,[^:]*)?:(\/.*)$/m.exec(own)?.[1]?.trim();
  /** The cgroup's folder and each above it, the process's own first. */
  const upFrom = (base: string, path: string | undefined) => {
    const parts = (path ?? "/").split("/").filter(Boolean);
    const out: string[] = [];
    for (let n = parts.length; n >= 0; n--) out.push([base, ...parts.slice(0, n)].join("/"));
    return out;
  };
  let best: { limit: number; used: number } | undefined;
  const consider = (limit: number | undefined, used: number | undefined) => {
    if (limit === undefined || used === undefined) return;
    if (!best || limit - Math.max(0, used) < best.limit - Math.max(0, best.used))
      best = { limit, used };
  };
  const v2Root = read("/sys/fs/cgroup/memory.max") !== undefined || v2Path !== undefined;
  if (v2Root && v1Path === undefined) {
    for (const d of upFrom("/sys/fs/cgroup", v2Path)) {
      const max = read(`${d}/memory.max`);
      if (max === undefined || max.trim() === "max") continue;
      const current = num(read(`${d}/memory.current`));
      consider(
        num(max),
        current === undefined
          ? undefined
          : current - fileCache(read(`${d}/memory.stat`), "inactive_file"),
      );
    }
  } else {
    for (const d of upFrom("/sys/fs/cgroup/memory", v1Path)) {
      const usage = num(read(`${d}/memory.usage_in_bytes`));
      consider(
        num(read(`${d}/memory.limit_in_bytes`)),
        usage === undefined
          ? undefined
          : usage - fileCache(read(`${d}/memory.stat`), "total_inactive_file"),
      );
    }
  }
  // No limit, or one above the machine's (v1 writes "no limit" as a huge number): the machine's.
  if (!best || best.limit >= machine.total) return machine;
  return {
    free: Math.max(0, Math.min(machine.free, best.limit - Math.max(0, best.used))),
    total: best.limit,
  };
}

/** This machine's (or container's) memory now. */
export const systemMemory = () => systemMemoryOf(readText, { freemem, totalmem });

/** What each keeper registered: how to let go, and what it holds now (bytes, by name). */
const keepers = new Set<{ release: () => void; held?: () => Record<string, number> }>();
let idle: ReturnType<typeof setTimeout> | undefined;
let checker: ReturnType<typeof setInterval> | undefined;
let systemAt = 0;
let systemLow = false;

/**
 * What to let go when the app's memory is let go (each keeper registers its own), and what it
 * holds, for the measurement (`appMemoryHeld`).
 */
export function onAppMemoryRelease(release: () => void, held?: () => Record<string, number>): void {
  keepers.add({ release, ...(held ? { held } : {}) });
}

/** What the keepers hold now, in bytes, by what it is. */
export function appMemoryHeld(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of keepers) Object.assign(out, k.held?.() ?? {});
  return out;
}

/** Let go of everything kept for the app now. */
export function releaseAppMemory(): void {
  if (idle) clearTimeout(idle);
  idle = undefined;
  for (const k of keepers) k.release();
}

function armIdle(): void {
  if (idle) clearTimeout(idle);
  idle = setTimeout(releaseAppMemory, appMemory.idleMs);
  idle.unref?.();
}

/** Whether the machine's or the container's memory is nearly used (read now). */
function systemIsLow(): boolean {
  const { free, total } = (appMemory.system ?? systemMemory)();
  // macOS counts its file cache as used, so its free memory is often a few hundred MB on a
  // machine with room to spare: only the floor is low there.
  const share = process.platform === "darwin" && !appMemory.system ? 0 : appMemory.lowFree;
  return free < Math.max(appMemory.lowFreeMinBytes, share * total);
}

/** Whether memory runs low: the heap three quarters full, or the system's nearly used. */
function memoryLow(now: number): boolean {
  const h = getHeapStatistics();
  if (h.used_heap_size > appMemory.lowAt * h.heap_size_limit) return true;
  if (now - systemAt >= appMemory.systemEveryMs) {
    systemAt = now;
    systemLow = systemIsLow();
  }
  return systemLow;
}

/**
 * Whether a keeper may keep (or use) what it holds for the app now: on, and memory not low
 * (else everything is let go first). A keeper that keeps with no Apply pending starts the ten
 * minutes; it doesn't start them again (only an Apply does, `appMemoryApplied`).
 */
export function appMemoryInUse(): boolean {
  if (!appMemory.on) return false;
  if (memoryLow(Date.now())) {
    releaseAppMemory();
    return false;
  }
  if (!idle) armIdle();
  return true;
}

/** An Apply ran in the app's server: what it keeps is kept ten more minutes from now. */
export function appMemoryApplied(): void {
  if (appMemory.on) armIdle();
}

let servers = 0;

/** A server starts keeping (`atticus ui`); the last to close stops, letting go. */
export function startAppMemory(): void {
  servers++;
  appMemory.on = true;
  systemAt = 0;
  if (!idle) armIdle();
  if (!checker) {
    checker = setInterval(() => {
      systemAt = 0;
      if (memoryLow(Date.now())) releaseAppMemory();
    }, appMemory.checkMs);
    checker.unref?.();
  }
}

export function stopAppMemory(): void {
  servers = Math.max(0, servers - 1);
  if (servers) return;
  appMemory.on = false;
  if (checker) clearInterval(checker);
  checker = undefined;
  releaseAppMemory();
}
