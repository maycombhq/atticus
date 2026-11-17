import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Cancelling long work (ADR 0119). A job the app started (a scan, an AI step) runs inside
 * `withSignal`; the work reads the signal where it can stop cleanly: the model runtime before and
 * during a model call, the scan between repos. Nothing is written after a stop: work checks
 * before it writes. Code that passes its own signal keeps it.
 */

const store = new AsyncLocalStorage<AbortSignal>();

export class CancelledError extends Error {
  constructor(message = "Cancelled: nothing more was done or written.") {
    super(message);
    this.name = "CancelledError";
  }
}

/** Run `fn` with `signal` as the signal of everything it starts. */
export function withSignal<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  return store.run(signal, fn);
}

/**
 * Beta.28.1 (the review of the jobs with Stop): the job's commit point. Work that has started
 * writing (a catalog being written, a pairing appended) says so with `commitCurrent()`: a Stop
 * after it is too late, and the job ends done, saying the Stop came after the write.
 */
const commits = new AsyncLocalStorage<() => void>();

/** Run `fn` with `commit` as what `commitCurrent()` inside it calls. */
export function withCommit<T>(commit: () => void, fn: () => Promise<T>): Promise<T> {
  return commits.run(commit, fn);
}

/**
 * Say the job this code runs in has started writing: Stop is no longer heard. True when a job
 * heard it (it says a late Stop itself); false outside one.
 */
export function commitCurrent(): boolean {
  const signal = store.getStore();
  if (signal) committed.add(signal);
  const c = commits.getStore();
  c?.();
  return !!c;
}

/**
 * Beta.28.4: work made of several writes one after another (an Apply over several repos) says
 * when one of them has ended, whole: `releaseCurrent()`. Stop is heard again from there, and a
 * Stop asked during that write is acted on now (the job's signal aborts), so the work stops
 * before its next write. Work that never says so is as before: past its commit, never stopped.
 */
const releases = new AsyncLocalStorage<() => void>();

/** Run `fn` with `release` as what `releaseCurrent()` inside it calls. */
export function withRelease<T>(release: () => void, fn: () => Promise<T>): Promise<T> {
  return releases.run(release, fn);
}

/**
 * Say the write this job started (`commitCurrent`) has ended and nothing is being written: only
 * between two whole writes, never inside one. True when a job heard it; false outside one.
 */
export function releaseCurrent(): boolean {
  const signal = store.getStore();
  if (signal) committed.delete(signal);
  const r = releases.getStore();
  r?.();
  return !!r;
}

/** The signal of the job this code runs in, if it runs in one. */
export function currentSignal(): AbortSignal | undefined {
  return store.getStore();
}

/** The signals whose work has said it is writing (`commitCurrent`). */
const committed = new WeakSet<AbortSignal>();

/**
 * Beta.28.3: the signal a long read may stop on part way (the hash of every file of the
 * catalog): the job's, until its work says it has started writing. From then there is none, so a
 * read that is part of a write is never cut short and nothing is left half written.
 */
export function stoppableSignal(): AbortSignal | undefined {
  const signal = store.getStore();
  return signal && !committed.has(signal) ? signal : undefined;
}

/** Stop here when the job was cancelled. */
export function throwIfCancelled(): void {
  if (currentSignal()?.aborted) throw new CancelledError();
}
