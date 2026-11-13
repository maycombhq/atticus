import { CancelledError } from "@maycombhq/core";

/**
 * Beta.28.1 ("nothing slow runs silently", the owner's field report 1): a long piece of work
 * (Apply's write stage: the catalog loaded, built pass by pass, guarded, written, then the
 * contracts and specs) says each step as it starts, with the time so far, and every
 * `heartbeatMs` that a step still runs. The lines go where the command's lines go (a terminal's
 * standard error, the run log, the app job's Console entry). After each line the work gives way
 * once (`yieldNow`), so the line leaves the server before the step's work takes the thread.
 *
 * Stop: the job's signal is checked as each step starts, until `commit()` (the catalog is being
 * written): from there the write finishes, so the catalog, its contracts and its specs stay in
 * step, and a Stop asked meanwhile is said once. A heartbeat is a timer: during a step that keeps
 * the thread busy without a break (the estate join is one computation) it comes once the step
 * gives way.
 *
 * Work that ends within `quietMs` (2 s) says nothing at all, as before: a quick write stays a
 * few lines. Once it runs past that, the step it is on is said, and every step after it.
 */

export interface WriteProgress {
  /** Start a step: ends the one before, says this one, and stops here when Stop was asked. */
  step(what: string): Promise<void>;
  /** A plain line (a count a step found). */
  say(line: string): void;
  /** From here on Stop is no longer heard: what is written is written whole. */
  commit(): void;
  /** The heartbeat off, and the time it all took said (with `title`). */
  end(): void;
}

export interface WriteProgressOptions {
  /** How often a running step says it still runs (30 s). */
  heartbeatMs?: number;
  /** The job's signal (Stop). */
  signal?: AbortSignal;
  /** Let the line out before the step's work (a macrotask by default). */
  yieldNow?: () => Promise<void>;
  /** What the end's line says took the time ("The write took 2 min."); none, no end line. */
  title?: string;
  /** Nothing is said until the work has run this long (2 s); 0 says every step. */
  quietMs?: number;
}

/** A duration in words: 4 s, 1 min 35 s, 1 h 2 min. */
export function durationWords(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

const lowerFirst = (s: string) => (s ? s[0]!.toLowerCase() + s.slice(1) : s);
const macrotask = () => new Promise<void>((r) => setImmediate(r));

/** Tests' settings for every write's progress (the quiet time and the heartbeat). */
export const writeProgressHooks: { quietMs?: number; heartbeatMs?: number } = {};

export function writeProgress(
  print: (line: string) => void,
  o: WriteProgressOptions = {},
): WriteProgress {
  const every = o.heartbeatMs ?? writeProgressHooks.heartbeatMs ?? 30_000;
  const yieldNow = o.yieldNow ?? macrotask;
  const began = Date.now();
  let current: { what: string; at: number } | undefined;
  let beat: ReturnType<typeof setInterval> | undefined;
  let committed = false;
  let stopSaid = false;
  let ended = false;
  const quiet = o.quietMs ?? writeProgressHooks.quietMs ?? 2_000;
  let loud = quiet <= 0;
  const say = (l: string) => {
    if (!loud) return;
    try {
      print(l);
    } catch {
      // printing never fails the work
    }
  };
  const stepLine = (c: { what: string }, now: number) =>
    `${c.what}… (${durationWords(now - began)} in)`;
  // Past the quiet time: the step it is on is said, then every step after it.
  const getLoud = () => {
    if (loud || ended) return;
    loud = true;
    if (current) say(stepLine(current, Date.now()));
  };
  let quietTimer: ReturnType<typeof setTimeout> | undefined = loud
    ? undefined
    : setTimeout(getLoud, quiet);
  (quietTimer as { unref?: () => void } | undefined)?.unref?.();
  const stopBeat = () => {
    if (beat !== undefined) clearInterval(beat);
    beat = undefined;
  };
  return {
    async step(what) {
      if (o.signal?.aborted) {
        if (!committed) {
          stopBeat();
          throw new CancelledError();
        }
        if (!stopSaid) {
          stopSaid = true;
          say(
            "Stop heard, but the catalog is being written: the write finishes first, so the catalog, its contracts and its specs stay in step.",
          );
        }
      }
      stopBeat();
      const now = Date.now();
      current = { what, at: now };
      if (!loud && now - began >= quiet) {
        if (quietTimer !== undefined) clearTimeout(quietTimer);
        quietTimer = undefined;
        loud = true;
      }
      say(stepLine(current, now));
      if (every > 0) {
        const mine = current;
        beat = setInterval(() => {
          const t = Date.now();
          say(
            `Still ${lowerFirst(mine.what)}: ${durationWords(t - mine.at)} on this step (${durationWords(t - began)} in).`,
          );
        }, every);
        (beat as { unref?: () => void }).unref?.();
      }
      await yieldNow();
    },
    say,
    commit() {
      committed = true;
    },
    end() {
      if (ended) return;
      stopBeat();
      if (quietTimer !== undefined) clearTimeout(quietTimer);
      ended = true;
      if (o.title) say(`${o.title} took ${durationWords(Date.now() - began)}.`);
    },
  };
}
