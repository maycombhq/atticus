/**
 * The rows a section has read, by the node they are under (0.3.1). A tree view asks for its rows
 * and must be answered at once: until a part's first read ends it shows "Reading…" (get gives
 * undefined), and `done` is called when the read ends so the view can ask again. A refresh keeps
 * what was read on show while it is read again, so nothing flickers; clear forgets it all. A read
 * that ends after a newer one started is dropped. No `vscode` here, so it is tested outside it.
 */
export class Loads<T> {
  private gen = 0;
  private readonly entries = new Map<
    string,
    { gen: number; value?: T; has: boolean; pending?: Promise<T> }
  >();

  /** What to show now for key; starts a read when this refresh hasn't read it yet. */
  get(
    key: string,
    read: () => Promise<T>,
    done: (value: T) => void,
    fail: (e: unknown) => T,
  ): T | undefined {
    const e = this.entries.get(key);
    if (e?.gen === this.gen) return e.has ? e.value : undefined;
    // Not read since the last refresh: read it, showing what was read before until then.
    void this.start(key, read, done, fail);
    return e?.has ? e.value : undefined;
  }

  /** The value once this refresh's read of key ends. */
  wait(key: string, read: () => Promise<T>, fail: (e: unknown) => T): Promise<T> {
    const e = this.entries.get(key);
    if (e && e.gen === this.gen) return e.pending ?? Promise.resolve(e.value as T);
    return this.start(key, read, () => undefined, fail);
  }

  private start(
    key: string,
    read: () => Promise<T>,
    done: (value: T) => void,
    fail: (e: unknown) => T,
  ): Promise<T> {
    const before = this.entries.get(key);
    const entry: { gen: number; value?: T; has: boolean; pending?: Promise<T> } = {
      gen: this.gen,
      has: !!before?.has,
      ...(before?.has ? { value: before.value as T } : {}),
    };
    const p = read()
      .catch(fail)
      .then((v) => {
        if (this.entries.get(key) === entry) {
          entry.value = v;
          entry.has = true;
          delete entry.pending;
          done(v);
        }
        return v;
      });
    entry.pending = p;
    this.entries.set(key, entry);
    return p;
  }

  /** Read again on the next ask, showing what was read until then. */
  refresh() {
    this.gen++;
  }

  /** Forget everything: the next ask shows Reading… again. */
  clear() {
    this.gen++;
    this.entries.clear();
  }
}
