import { execFile, spawn, type ChildProcess } from "node:child_process";
import { constants as osConstants } from "node:os";

/**
 * Beta.27 review: the processes Atticus starts in a process group of their own (a build, a git
 * the app may stop), kept so none outlives Atticus. A process in its own group no longer gets the
 * terminal's signals (Ctrl+C, the terminal closed), so while any runs, or a task run holds on to a
 * stop (holdStop), one handler per signal (SIGINT, SIGTERM, SIGHUP) stops them all, tells each
 * listener (onStopping: taskrun aborts its model call), and lets the signal end Atticus once nothing
 * holds on (or after TREE_SIGNAL_GRACE_MS). When Atticus exits, every tree still running is killed
 * outright. Shared by taskrun's builds and workspace's git (it was taskrun's own).
 */

/** How a tracked tree is stopped: its own way (git's tree, a build's group), by the signal. */
export type StopTree = (signal: NodeJS.Signals) => void;

const live = new Map<ChildProcess, StopTree>();
const listeners = new Set<() => void>();
const SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
/** However long the runs take to record themselves, Atticus ends by the signal within this. */
export const TREE_SIGNAL_GRACE_MS = 10_000;

/** The runs between their start and their record saved. */
let holds = 0;
/** The signal that ends Atticus once nothing holds on (nobody else listened for it). */
let pending: NodeJS.Signals | undefined;

/**
 * Stop every tracked tree (SIGTERM, each its own way) and tell each listener: Atticus is
 * stopping (atticus ui on its way out, or a signal).
 */
export function stopTrackedTrees(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // a listener's failure stops nothing else
    }
  }
  for (const [, stop] of live) {
    try {
      stop("SIGTERM");
    } catch {
      // gone already
    }
  }
}

/** Hear Atticus stopping (stopTrackedTrees, a signal). Gives back the way to stop hearing. */
export function onStopping(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Beta.27 re-review: Atticus's own handlers of a signal, the ones that end (or stop) Atticus
 * themselves: atticus ui's, map --all's Ctrl+C. Counting the process's listeners took any
 * library's for one (signal-exit, which @inquirer/core loads through OpenSpec, listens to every
 * signal and ends the process only when it alone listens), so neither ended it and Ctrl+C did
 * nothing. A `once` handler that has heard the signal still counts until that signal's listeners
 * have all run. A `fallback` one (a terminal run's record) ends Atticus only when nobody else
 * does, nor these trees (stopPending): it never counts here.
 */
type SignalFn = (sig: NodeJS.Signals) => void;
const own = new Map<NodeJS.Signals, Map<SignalFn, { fallback: boolean }>>();

/**
 * Hear a signal as Atticus's own handler: one that ends or stops Atticus (process-trees and the
 * run log then leave the ending to it), or with `fallback`, one that ends it only when nothing
 * else does. Gives back the way to stop hearing it.
 */
export function onAtticusSignal(
  sig: NodeJS.Signals,
  fn: SignalFn,
  o: { once?: boolean; fallback?: boolean } = {},
): () => void {
  const set = own.get(sig) ?? new Map<SignalFn, { fallback: boolean }>();
  own.set(sig, set);
  let gone = false;
  const off = (later = false) => {
    if (gone) return;
    gone = true;
    process.off(sig, h);
    // Heard: it still counts for the other listeners of this signal, which run after it.
    if (later) setImmediate(() => set.delete(fn));
    else set.delete(fn);
  };
  const h = () => {
    if (o.once) off(true);
    fn(sig);
  };
  set.set(fn, { fallback: o.fallback === true });
  process.on(sig, h);
  return () => off();
}

/**
 * Whether Atticus has a handler of its own for `sig` (other than `except`, never a fallback one)
 * that ends it.
 */
export function atticusHandles(sig: NodeJS.Signals, except?: SignalFn): boolean {
  for (const [fn, h] of own.get(sig) ?? []) if (fn !== except && !h.fallback) return true;
  return false;
}

/**
 * Whether these trees hold a signal that ends Atticus once they have ended and the runs recorded
 * the stop (it is raised again then): a fallback handler leaves the end to it until then.
 */
export const stopPending = (): boolean => pending !== undefined;

const onSignal = (sig: NodeJS.Signals) => {
  stopTrackedTrees();
  // Atticus has a handler of its own (atticus ui stops itself, map --all stops after its step):
  // done here. Another library's listener (signal-exit) doesn't end the process while this one
  // listens, so it never counts; nor a terminal run's record, which waits for this one.
  if (atticusHandles(sig)) return;
  // Nobody else (atticus task run, a terminal closed under atticus ui): the signal ends Atticus as
  // it would have, once the trees have ended and the runs recorded the stop, or after the grace.
  if (!pending) {
    pending = sig;
    setTimeout(raise, TREE_SIGNAL_GRACE_MS).unref?.();
  }
  settle();
};
function raise() {
  const sig = pending;
  if (!sig) return;
  pending = undefined;
  unhook();
  try {
    process.kill(process.pid, sig);
  } catch {
    // Windows can't send itself SIGHUP (ENOSYS): end as the signal would have, 128 + its number.
    process.exit(128 + (osConstants.signals[sig] ?? 1));
  }
}
function settle() {
  if (holds > 0 || live.size > 0) return;
  if (pending) raise();
  else unhook();
}
/** Atticus exits: what still runs is killed outright (synchronous: nothing waits on exit). */
const onExit = () => {
  for (const [child, stop] of live) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try {
      stop("SIGKILL");
    } catch {
      // gone already
    }
  }
};
let hooked = false;
function hook() {
  if (hooked) return;
  hooked = true;
  for (const s of SIGNALS) process.prependListener(s, onSignal);
  process.on("exit", onExit);
}
function unhook() {
  if (!hooked) return;
  hooked = false;
  for (const s of SIGNALS) process.off(s, onSignal);
  process.off("exit", onExit);
}

/**
 * Keep a child in its own process group until it ends: stopped with Atticus (a signal,
 * stopTrackedTrees) by `stop`, killed by it with SIGKILL when Atticus exits. Gives back the way
 * to let go of it (when it has ended).
 */
export function trackTree(child: ChildProcess, stop: StopTree = (s) => stopProcessGroup(child, s)) {
  live.set(child, stop);
  hook();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    live.delete(child);
    settle();
  };
}

/**
 * Hold a stop for a task run, from its start until its record is saved: a signal meanwhile
 * stops its trees, and Atticus ends only once it is released.
 */
export function holdStop(): () => void {
  holds++;
  hook();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds--;
    settle();
  };
}

/** How many trees are tracked now (tests). */
export const trackedTrees = () => live.size;

/**
 * The child and everything it started: on Windows its whole tree (taskkill /T /F), elsewhere its
 * process group (it was started detached), else the child alone.
 */
export function stopProcessGroup(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      }).on("error", () => child.kill());
    } catch {
      child.kill();
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

/**
 * Every process below `pid` (POSIX `ps`, read without blocking), each with when it started (as
 * ps says), deepest last; none when ps can't be run. When it started tells a process from another
 * given the same pid later.
 */
export function processDescendants(pid: number): Promise<Map<number, string>> {
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-A", "-o", "pid=,ppid=,lstart="],
      { encoding: "utf8", timeout: 2000, windowsHide: true },
      (err, text) => {
        if (err) {
          resolve(new Map());
          return;
        }
        const kids = new Map<number, { pid: number; start: string }[]>();
        for (const line of text.split("\n")) {
          const m = /^\s*(\d+)\s+(\d+)\s*(.*)$/.exec(line);
          if (!m) continue;
          const p = Number(m[1]);
          const pp = Number(m[2]);
          kids.set(pp, [...(kids.get(pp) ?? []), { pid: p, start: m[3]!.trim() }]);
        }
        const out = new Map<number, string>();
        const walk = (p: number) => {
          for (const k of kids.get(p) ?? []) {
            if (out.has(k.pid)) continue;
            out.set(k.pid, k.start);
            walk(k.pid);
          }
        };
        walk(pid);
        resolve(out);
      },
    );
  });
}

/** Every process there now, with when it started (`ps`, read without blocking). */
function processesNow(): Promise<Map<number, string>> {
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-A", "-o", "pid=,lstart="],
      { encoding: "utf8", timeout: 2000, windowsHide: true },
      (err, text) => {
        const out = new Map<number, string>();
        if (!err)
          for (const line of text.split("\n")) {
            const m = /^\s*(\d+)\s*(.*)$/.exec(line);
            if (m) out.set(Number(m[1]), m[2]!.trim());
          }
        resolve(out);
      },
    );
  });
}

/** How long a stopped tree gets to end before it is killed outright. */
export const TREE_KILL_AFTER_MS = 5000;

/**
 * Kill a process and everything it started (git clone runs git-remote-https and index-pack). On
 * Windows, taskkill /T takes the tree; elsewhere the process ran in its own group, which is
 * signalled whole, with each process found below it (where a new group can't be made, a sandbox,
 * the group alone would miss them); what hasn't ended a moment later is killed outright. The
 * second pass reads the processes again and kills only those still there with the same start, so
 * a pid given to another process meanwhile is never signalled. `ps` is read without blocking.
 */
export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32" || signal === "SIGKILL") {
    // Atticus exits (nothing may wait), or Windows: the group, or the whole tree.
    stopProcessGroup(child, signal === "SIGKILL" ? "SIGKILL" : "SIGTERM");
    return;
  }
  const ended = () => child.exitCode !== null || child.signalCode !== null;
  const send = (pids: Iterable<number>, s: NodeJS.Signals) => {
    try {
      process.kill(-pid, s);
    } catch {
      // no group of its own (or gone): each process below is signalled
    }
    for (const p of pids)
      try {
        process.kill(p, s);
      } catch {
        // gone already
      }
  };
  // Its descendants, found before any is killed (a killed parent's children are no longer its).
  void processDescendants(pid).then((first) => {
    send([...first.keys(), ...(ended() ? [] : [pid])], "SIGTERM");
    let hardDone = false;
    const hard = async () => {
      if (hardDone) return;
      hardDone = true;
      const now = await processesNow();
      const still = [...first].filter(([p, start]) => now.get(p) === start).map(([p]) => p);
      send([...still, ...(ended() ? [] : [pid])], "SIGKILL");
    };
    const timer = setTimeout(() => void hard(), TREE_KILL_AFTER_MS);
    timer.unref?.();
    // The group may outlive its leader a moment (a child still writing): it goes too.
    if (ended()) {
      clearTimeout(timer);
      void hard();
    } else
      child.once("exit", () => {
        clearTimeout(timer);
        void hard();
      });
  });
}
