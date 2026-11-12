import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "./support/hooks.js";

/**
 * Beta.27 re-review: the shell's shared reads (sharedRead) joined a read that started before the
 * ask, so an answer could stay stale:
 *
 * A. a read of /api/trust under way, the page writes, and reads it again (readAnswerAgain): it
 *    took the read under way (from before the write), and the write's own file events were
 *    ignored as fresh, so the count stayed stale until some later change;
 * B. two bursts of file events in a row: the second's read joined the first's.
 *
 * Now an ask while a read is under way gets the one read queued after it; the fresh window runs
 * from when that read's answer came; and a burst heard in the window is read at its end, never
 * dropped (another process's change, a scan in a terminal writing facts/). Hooks runtime, no DOM,
 * no network.
 */

vi.mock("react", async () => {
  const R = await vi.importActual<object>("react");
  const { shim } = await import("./support/hooks.js");
  return { ...R, ...shim, default: { ...R, ...shim } };
});

/** What the server holds now, and each read: when it was asked and what it answered. */
let state = 0;
const reads: { at: number; answered?: number; release: () => void }[] = [];
type Burst = { type: string; path?: string }[];
const listeners = new Set<{ on: (events: Burst) => void }>();
const onFiles = (events: Burst = [{ type: "file.changed", path: "facts/forge-ledger.jsonl" }]) => {
  for (const l of listeners) l.on(events);
};
vi.mock("../src/api/client.js", async () => {
  const real = await vi.importActual<typeof import("../src/api/client.js")>("../src/api/client.js");
  const { shim } = await import("./support/hooks.js");
  return {
    ...real,
    // A read answers what the server holds when it is answered (released), as a real one does
    // once it has read the files.
    api: (path: string) => {
      void path;
      return new Promise((resolve) => {
        const r = {
          at: state,
          release: () => {
            r.answered = state;
            resolve({ repos: state });
          },
        } as (typeof reads)[number];
        reads.push(r);
      });
    },
    useFileChanges: (on: (events: Burst) => void) => {
      const r = shim.useRef<{ on: (events: Burst) => void } | undefined>(undefined);
      if (!r.current) {
        r.current = { on };
        listeners.add(r.current);
      }
      r.current.on = on;
    },
  };
});

const { noteChange } = await import("../src/api/client.js");
const { forgetExplorerAnswers, FRESH_MS, readAnswerAgain, sharedRead, useKnownAnswer } =
  await import("../src/app/shell/explorer-data.js");

const TRUST = "/api/trust?fresh-reads";
const tick = () => new Promise((r) => setTimeout(r, 0));
const releaseAll = async () => {
  for (let i = 0; i < 10; i++) {
    for (const r of reads) if (r.answered === undefined) r.release();
    await tick();
  }
};

beforeEach(() => {
  listeners.clear();
  forgetExplorerAnswers();
  reads.length = 0;
  state = 0;
});

describe("a read asked while one is under way", () => {
  it("A: read again after a write, it answers from after the write", async () => {
    state = 7;
    const r1 = sharedRead<{ repos: number }>(TRUST);
    await tick();
    expect(reads).toHaveLength(1);
    // The page writes (a repo added), then reads the path again while R1 is under way.
    state = 8;
    const again = readAnswerAgain(TRUST);
    await tick();
    // Not R1 joined: a read queued after it.
    reads[0]!.release();
    expect((await r1).repos).toBe(8);
    await tick();
    expect(reads).toHaveLength(2);
    reads[1]!.release();
    await again;
    expect(reads[1]!.answered).toBe(8);
  });

  it("asks in a row with nothing changed between share the read under way", async () => {
    state = 1;
    const first = sharedRead<{ repos: number }>(TRUST);
    await tick();
    const second = sharedRead<{ repos: number }>(TRUST);
    await tick();
    expect(reads).toHaveLength(1);
    reads[0]!.release();
    expect([(await first).repos, (await second).repos]).toEqual([1, 1]);
  });

  it("B: a second burst's read is a read after the first's, one for any number of asks", async () => {
    state = 1;
    const first = sharedRead<{ repos: number }>(TRUST);
    await tick();
    // A burst of file events heard (the page's live events say so).
    noteChange();
    state = 2;
    const second = [sharedRead<{ repos: number }>(TRUST), sharedRead<{ repos: number }>(TRUST)];
    await tick();
    expect(reads).toHaveLength(1);
    reads[0]!.release();
    await first;
    await tick();
    expect(reads).toHaveLength(2);
    state = 3;
    reads[1]!.release();
    expect((await Promise.all(second)).map((x) => x.repos)).toEqual([3, 3]);
  });
});

describe("a burst heard while the answer is fresh", () => {
  it("is read once the window ends, never dropped (another process's change)", async () => {
    state = 7;
    const Known = () => useKnownAnswer<{ repos: number }>(TRUST);
    const m = mount(Known, {});
    await new Promise((r) => setTimeout(r, 400));
    await releaseAll();
    m.render();
    expect((m.tree as { repos: number }).repos).toBe(7);
    const before = reads.length;
    // The page's own write and its read again; then a scan in a terminal writes facts/.
    state = 8;
    const again = readAnswerAgain(TRUST);
    await releaseAll();
    await again;
    state = 9;
    onFiles();
    onFiles();
    m.render();
    await tick();
    // Within the window: nothing read yet.
    expect(reads.length).toBe(before + 1);
    await new Promise((r) => setTimeout(r, FRESH_MS + 100));
    m.render();
    await releaseAll();
    m.render();
    // At its end, one read, of what the scan wrote.
    expect(reads.length).toBe(before + 2);
    expect((m.tree as { repos: number }).repos).toBe(9);
  });
});
