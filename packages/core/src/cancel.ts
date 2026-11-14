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
  const c = commits.getStore();
  c?.();
  return !!c;
}

/** The signal of the job this code runs in, if it runs in one. */
export function currentSignal(): AbortSignal | undefined {
  return store.getStore();
}

/** Stop here when the job was cancelled. */
export function throwIfCancelled(): void {
  if (currentSignal()?.aborted) throw new CancelledError();
}
