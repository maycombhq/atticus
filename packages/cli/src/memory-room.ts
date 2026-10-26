import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { freemem } from "node:os";
import { getHeapStatistics } from "node:v8";
import { parseFactLine, type BadFactLine, type Fact } from "@maycombhq/core";

/**
 * A memory ceiling for the commands that read a whole repo's facts (ADR 0124 addendum A-room).
 *
 * On a trial of a 4,900-file repo with 2,279 facts, `atticus verify --write` was killed with exit
 * 137 and not one byte of stdout or stderr whenever the machine had less than about 2.6 GB free.
 * 137 is the kernel's own SIGKILL, not V8's heap limit: nothing in the process gets to run, so
 * nothing can be printed, and three runs were wasted before the tester saw it wasn't Atticus's
 * bug. The fix is to stop the command first, with words.
 *
 * So `room()` is called while a read is running and throws `NoRoomError` once the process is past
 * its ceiling. What it watches is **resident memory**, not the heap, because that is what the
 * kernel kills on, and it is always the larger of the two — on the estate measured here, 149 MB
 * resident to 56 MB of heap. The ceiling is the lower of what V8 will give the heap and what this
 * machine can actually hand over (what is free, plus what this process already holds), because a
 * heap limit raised above free memory only moves the kill later.
 * `ATTICUS_MAX_OLD_SPACE` (in MB) raises it, and `bin.ts` starts Node again with
 * `--max-old-space-size` set to it, which is the only way to raise a heap that already exists
 * (`reExecForMemory`); it is what the message tells a person to set, so it has to be honoured.
 */

/** The ceiling has been reached: the message is what to tell the person, and it says what to do. */
export class NoRoomError extends Error {
  readonly usedMB: number;
  readonly ceilingMB: number;
  constructor(what: string, usedMB: number, ceilingMB: number) {
    super(
      `${what} need more memory than Node was given: ${usedMB} MB of the ${ceilingMB} MB ceiling is in use. Run it again with ATTICUS_MAX_OLD_SPACE=${Math.max(4096, ceilingMB * 2)} (megabytes Node may use for the heap), or in parts, a repo at a time. Closing an IDE frees the memory this needs.`,
    );
    this.name = "NoRoomError";
    this.usedMB = usedMB;
    this.ceilingMB = ceilingMB;
  }
}

const MB = 1024 * 1024;
/** How much of the ceiling a read may take before it stops itself, leaving the rest to finish on. */
const SHARE = 0.8;

export interface RoomOptions {
  /** What the message calls the thing being read ("this repo's facts"). */
  what: string;
  /** The ceiling in bytes; the default is `ceilingOf()`. */
  ceilingBytes?: number;
  /** Calls between readings: `process.memoryUsage.rss()` is cheap, but not free. */
  every?: number;
  /** The memory in use, in bytes (tests pass their own). */
  used?: () => number;
}

/**
 * The ceiling in bytes: what V8 will give the heap, or what this machine can hand this process
 * (the memory that is free, plus what the process already holds), whichever is less.
 */
export function ceilingOf(env: NodeJS.ProcessEnv = process.env): number {
  const heap = getHeapStatistics().heap_size_limit;
  const asked = Number(env.ATTICUS_MAX_OLD_SPACE);
  // What a person asked for only counts once Node has it: `bin.ts` restarts for that.
  const limit = Number.isFinite(asked) && asked > 0 ? Math.min(heap, asked * MB) : heap;
  const free = freemem();
  // freemem() leaves out what this process holds, which it can still spend.
  return free > 0 ? Math.min(limit, free + process.memoryUsage.rss()) : limit;
}

/**
 * A guard to pass as `verifyFacts({ room })` and to the facts reader. It throws `NoRoomError`
 * once the process is past its share of the ceiling, so the command ends in a message of its own
 * rather than in the kernel's silence.
 */
export function roomGuard(o: RoomOptions): () => void {
  const ceiling = o.ceilingBytes ?? ceilingOf();
  const every = o.every ?? 32;
  // Resident memory: what the kernel kills on, and never less than the heap.
  const used = o.used ?? (() => process.memoryUsage.rss());
  const bar = ceiling * SHARE;
  let n = 0;
  return () => {
    if (n++ % every !== 0) return;
    const now = used();
    if (now <= bar) return;
    throw new NoRoomError(o.what, Math.round(now / MB), Math.max(1, Math.round(ceiling / MB)));
  };
}

/** The megabytes a `--max-old-space-size` among these arguments asks for, if any asks. */
function maxOldSpaceIn(args: readonly string[]): number | undefined {
  for (const a of args) {
    const m = /^--max[-_]old[-_]space[-_]size[= ](\d+)$/.exec(a.trim());
    if (m) return Number(m[1]);
  }
  return undefined;
}

/**
 * Whether Node should be started again with a bigger heap, and with what (ADR 0124 addendum
 * A-room). `ATTICUS_MAX_OLD_SPACE` is megabytes; it is honoured by a restart, as
 * `scripts/bundle/fetch-model.mjs` restarts for a proxy, because a running V8 can't raise the
 * heap it already made. It is the value the out-of-room message tells a person to set, so it has
 * to work wherever they set it: a `--max-old-space-size` already in effect, which an editor's or
 * a wrapper's launcher may have set low, is raised to it — never lowered to it.
 *
 * Undefined when the variable isn't set (so the ordinary run costs nothing), when it isn't a
 * sensible number of megabytes, when Node already has at least that much, or when this process is
 * itself the restart.
 */
export function reExecForMemory(
  env: NodeJS.ProcessEnv,
  execArgv: readonly string[],
): { maxOldSpaceMB: number } | undefined {
  if (env.ATTICUS_RESTARTED_FOR_MEMORY) return undefined;
  const mb = Number(env.ATTICUS_MAX_OLD_SPACE);
  if (!Number.isInteger(mb) || mb < 256 || mb > 1_048_576) return undefined;
  const already = [
    maxOldSpaceIn(execArgv),
    maxOldSpaceIn((env.NODE_OPTIONS ?? "").split(/\s+/)),
  ].filter((n): n is number => n !== undefined);
  if (already.length && Math.max(...already) >= mb) return undefined;
  return { maxOldSpaceMB: mb };
}

/**
 * The facts of `<repo>.jsonl`, read a line at a time (ADR 0124 addendum A-room). `parseFactsLines`
 * takes the whole file as one string and splits it into an array of every line, so a facts file
 * was held three times over — the text, the array of lines and the parsed facts — before a single
 * fact was checked. Here each line is parsed through the same `parseFactLine` and then dropped,
 * nothing but the facts and the bad lines is kept, and `room` is asked between lines, so a file
 * too big for this machine says so rather than being killed.
 *
 * Same facts and same issues as `parseFactsLines`, so nothing downstream changes.
 */
export async function streamFacts(
  file: string,
  room?: () => void,
): Promise<{ facts: Fact[]; bad: BadFactLine[] }> {
  const facts: Fact[] = [];
  const bad: BadFactLine[] = [];
  const seen = new Set<string>();
  const lines = createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let line = 0;
  try {
    for await (const raw of lines) {
      room?.();
      const r = parseFactLine(raw, ++line, seen);
      if (r.fact) facts.push(r.fact);
      else if (r.bad) bad.push(r.bad);
    }
  } finally {
    lines.close();
  }
  return { facts, bad };
}
