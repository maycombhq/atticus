import { spawn } from "node:child_process";

/**
 * Runs a repo's build or test command (repos.manifest.yaml `build`). Injectable: tests pass a
 * fake, so no build tool runs in CI. Output is kept for the run's log.
 */
export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Atticus was stopping (Ctrl+C, a stop signal, stopAllBuilds) when the command ended. */
  stopped?: true;
}

export type CommandRunner = (
  command: string,
  cwd: string,
  o?: { timeoutMs?: number; env?: Record<string, string> },
) => Promise<CommandResult>;

/** The most of each stream kept for the log: the end of it, where a build says what failed. */
export const KEEP_OUTPUT = 4 * 1024 * 1024;

/** Keeps the last `max` characters of what is added, saying how much was left out. */
export function tail(max = KEEP_OUTPUT) {
  let text = "";
  let dropped = 0;
  return {
    add(d: string) {
      text += d;
      if (text.length > max) {
        dropped += text.length - max;
        text = text.slice(text.length - max);
      }
    },
    get text() {
      return dropped ? `[${dropped} characters of output left out]\n${text}` : text;
    },
  };
}

type Child = ReturnType<typeof spawn>;

/** The command and everything it started: on Windows the shell's whole tree, elsewhere its group. */
function stopTree(child: Child, signal: NodeJS.Signals = "SIGTERM") {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    const k = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    k.on("error", () => child.kill());
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

/**
 * The builds running now, and the runs holding on to a stop. A build runs in its own process
 * group (so a timeout stops the whole tree), so the terminal's Ctrl+C no longer reaches it: while
 * any build runs or a task run holds (holdSignals), one handler per signal stops them all, aborts
 * the model call, and lets the signal end Atticus once the runs have recorded themselves.
 */
const live = new Set<Child>();
const SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
/** Atticus is stopping: no build that ends now counts, and a task run does nothing more. */
let stopping = false;
export const stopRequested = () => stopping;
const stopper = new AbortController();
/** Aborted when Atticus stops: a model call, headless Claude Code or a Copilot session ends with it. */
export const stopSignal: AbortSignal = stopper.signal;

/** Stop every build running now and every one asked for later (atticus ui on its way out). */
export function stopAllBuilds(): void {
  stopping = true;
  for (const c of live) stopTree(c);
  if (!stopper.signal.aborted) stopper.abort();
}

/** The runs between their start and their record saved. */
let holds = 0;
/** The signal that ends Atticus once nothing holds on (nobody else listened for it). */
let pending: NodeJS.Signals | undefined;
/** However long the runs take to record themselves, Atticus ends by the signal within this. */
export const SIGNAL_GRACE_MS = 10_000;

const onSignal = (sig: NodeJS.Signals) => {
  stopAllBuilds();
  // Put first (prependListener), this runs before any other listener, a `once` one still in
  // place: what listens now is what hears it. Someone does (atticus ui stops itself): done here.
  if (process.listenerCount(sig) > 1) return;
  // Nobody else (atticus task run): the signal ends Atticus as it would have, once the runs
  // have recorded the stop, or after the grace.
  if (!pending) {
    pending = sig;
    setTimeout(raise, SIGNAL_GRACE_MS);
  }
  settle();
};
function raise() {
  const sig = pending;
  if (!sig) return;
  unhook();
  process.kill(process.pid, sig);
}
function settle() {
  if (holds > 0 || live.size > 0) return;
  if (pending) raise();
  else unhook();
}
const onExit = () => {
  for (const c of live) stopTree(c, "SIGKILL");
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
 * Hold a stop for a task run, from its start until its record is saved: a signal meanwhile
 * stops its builds and its model call, and Atticus ends only once it is released.
 */
export function holdSignals(): () => void {
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

const track = (c: Child) => {
  live.add(c);
  hook();
};
const untrack = (c: Child) => {
  live.delete(c);
  settle();
};

/** How long a timed-out tree gets to stop on SIGTERM before SIGKILL. */
export const STOP_GRACE_MS = 5_000;

/** The real runner: the command through the platform shell (build commands are shell lines). */
export function shellCommandRunner(): CommandRunner {
  return (command, cwd, o = {}) =>
    new Promise((resolve) => {
      // Atticus is stopping: a build asked for now doesn't start.
      if (stopping) {
        resolve({ exitCode: null, stdout: "", stderr: "Atticus is stopping.", stopped: true });
        return;
      }
      const child = spawn(command, {
        cwd,
        shell: true,
        env: { ...process.env, ...o.env },
        windowsHide: true,
        // Its own process group off Windows, so a timeout stops the build, not only the shell.
        detached: process.platform !== "win32",
      });
      track(child);
      const out = tail();
      const err = tail();
      let done = false;
      let kill: NodeJS.Timeout | undefined;
      let drain: NodeJS.Timeout | undefined;
      const finish = (r: CommandResult) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearTimeout(kill);
        clearTimeout(drain);
        untrack(child);
        resolve(stopping ? { ...r, stopped: true } : r);
      };
      const timer = setTimeout(
        () => {
          stopTree(child);
          // A tree that ignores SIGTERM is killed; the run ends either way.
          kill = setTimeout(() => stopTree(child, "SIGKILL"), STOP_GRACE_MS);
        },
        o.timeoutMs ?? 30 * 60_000,
      );
      child.stdout!.setEncoding("utf8").on("data", (d: string) => out.add(d));
      child.stderr!.setEncoding("utf8").on("data", (d: string) => err.add(d));
      child.on("error", (e) =>
        finish({ exitCode: null, stdout: out.text, stderr: err.text + e.message }),
      );
      // The shell exited: its output is read to the end, or for a moment when a grandchild
      // keeps the pipes open.
      child.on("exit", (code) => {
        drain = setTimeout(
          () => finish({ exitCode: code, stdout: out.text, stderr: err.text }),
          2_000,
        );
      });
      child.on("close", (code) => finish({ exitCode: code, stdout: out.text, stderr: err.text }));
    });
}
