import { execFile, spawn, type ChildProcess } from "node:child_process";

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

const onSignal = (sig: NodeJS.Signals) => {
  stopTrackedTrees();
  // Put first (prependListener), this runs before any other listener, a `once` one still in
  // place: what listens now is what hears it. Someone does (atticus ui stops itself): done here.
  if (process.listenerCount(sig) > 1) return;
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
  process.kill(process.pid, sig);
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
