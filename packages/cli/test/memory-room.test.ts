import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFactsLines } from "@maycombhq/core";
import {
  ceilingOf,
  NoRoomError,
  reExecForMemory,
  roomGuard,
  streamFacts,
} from "../src/memory-room.js";
import { verifyCommand } from "../src/verify-commands.js";

/**
 * ADR 0124 addendum A-room. On a trial of a 4,900-file repo with 2,279 facts, `verify --write`
 * was killed with exit 137 and not one byte of stdout or stderr whenever the machine had under
 * about 2.6 GB free: the kernel's own SIGKILL, which no handler sees. So the command now watches
 * its own heap against a ceiling and stops itself with words a person can act on.
 *
 * The ceiling here is a small one, and the facts a synthetic Forge estate built from the
 * fixtures/verify-read service. Nothing needs 8 GB to prove.
 */

const READ = join(__dirname, "..", "..", "..", "fixtures", "verify-read");
const COMMIT = "4d1c0de";
const CTRL = "src/main/java/forge/limits/LimitController.java";

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};

/** The forge-limits fixture, its facts file grown to `n` entries of the one controller. */
function estate(n: number): { root: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), "atticus-room-"));
  cpSync(join(READ, "repo"), root, { recursive: true });
  mkdirSync(join(root, ".atticus", "org-pack"), { recursive: true });
  mkdirSync(join(root, ".atticus", "facts"), { recursive: true });
  const file = join(root, ".atticus", "facts", "forge-limits.jsonl");
  writeFileSync(file, factsText(n));
  return { root, file };
}

/**
 * `n` entry facts of the fixture's controller, each citing the `/tiers` line, each with an auth
 * no line is cited for. One real line, many facts: the point is the size of the facts file.
 */
function factsText(n: number): string {
  return (
    Array.from({ length: n }, (_, i) =>
      JSON.stringify({
        kind: "entry",
        id: `e-tier-${String(i).padStart(5, "0")}`,
        repo: "forge-limits",
        commit: COMMIT,
        component: "limits-api",
        entryType: "rest",
        method: "GET",
        path: "/limits/tiers",
        handler: `LimitController.tiers${i}`,
        auth: "oauth2",
        cite: {
          file: CTRL,
          line: 24,
          value: "/tiers",
          quote: '@GetMapping("/tiers")',
          with: [{ file: CTRL, line: 8, value: "/limits" }],
        },
      }),
    ).join("\n") + "\n"
  );
}

describe("roomGuard: the ceiling, and the words instead of the silence", () => {
  it("lets a read through while the heap is under its share of the ceiling", () => {
    const room = roomGuard({ what: "x's facts", ceilingBytes: 1_000_000, used: () => 0, every: 1 });
    for (let i = 0; i < 100; i++) expect(() => room()).not.toThrow();
  });

  it("throws words that name the ceiling, what to set and what else to do", () => {
    const room = roomGuard({
      what: "forge-limits's facts",
      ceilingBytes: 100 * 1024 * 1024,
      used: () => 95 * 1024 * 1024,
      every: 1,
    });
    let caught: unknown;
    try {
      room();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NoRoomError);
    const m = (caught as NoRoomError).message;
    expect(m).toContain("forge-limits's facts need more memory than Node was given");
    expect(m).toContain("95 MB of the 100 MB ceiling");
    expect(m).toMatch(/ATTICUS_MAX_OLD_SPACE=\d+/);
    expect(m).toMatch(/in parts/);
  });

  it("reads the memory only every so often, so the guard costs little", () => {
    let reads = 0;
    const room = roomGuard({
      what: "x",
      ceilingBytes: 1,
      used: () => {
        reads++;
        return 0;
      },
      every: 10,
    });
    for (let i = 0; i < 100; i++) room();
    expect(reads).toBe(10);
  });

  it("watches resident memory, which is what the kernel kills on", () => {
    // Left to itself the guard reads this process's own RSS, which is never below its heap.
    const room = roomGuard({ what: "x", ceilingBytes: 1, every: 1 });
    expect(() => room()).toThrow(NoRoomError);
  });

  it("takes a ceiling no higher than what V8 and the machine allow", () => {
    expect(ceilingOf({})).toBeGreaterThan(0);
    // A person asking for more than Node has doesn't get more: the restart is what raises it.
    expect(ceilingOf({ ATTICUS_MAX_OLD_SPACE: "999999999" })).toBe(ceilingOf({}));
    const small = ceilingOf({ ATTICUS_MAX_OLD_SPACE: "64" });
    expect(small).toBeLessThanOrEqual(64 * 1024 * 1024);
  });
});

describe("reExecForMemory: ATTICUS_MAX_OLD_SPACE is honoured by starting Node again", () => {
  it("asks for a restart with the megabytes a person set", () => {
    expect(reExecForMemory({ ATTICUS_MAX_OLD_SPACE: "4096" }, [])).toEqual({
      maxOldSpaceMB: 4096,
    });
  });

  it("does nothing when it is unset, or not a sensible number of megabytes", () => {
    expect(reExecForMemory({}, [])).toBeUndefined();
    expect(reExecForMemory({ ATTICUS_MAX_OLD_SPACE: "" }, [])).toBeUndefined();
    expect(reExecForMemory({ ATTICUS_MAX_OLD_SPACE: "lots" }, [])).toBeUndefined();
    expect(reExecForMemory({ ATTICUS_MAX_OLD_SPACE: "8" }, [])).toBeUndefined();
    expect(reExecForMemory({ ATTICUS_MAX_OLD_SPACE: "2000000" }, [])).toBeUndefined();
  });

  it("does nothing when Node already has at least that much", () => {
    expect(
      reExecForMemory({ ATTICUS_MAX_OLD_SPACE: "4096" }, ["--max-old-space-size=4096"]),
    ).toBeUndefined();
    expect(
      reExecForMemory({ ATTICUS_MAX_OLD_SPACE: "4096" }, ["--max-old-space-size=8192"]),
    ).toBeUndefined();
    expect(
      reExecForMemory(
        {
          ATTICUS_MAX_OLD_SPACE: "4096",
          NODE_OPTIONS: "--enable-source-maps --max-old-space-size=8192",
        },
        [],
      ),
    ).toBeUndefined();
  });

  // The message tells a person to set this variable, so it has to work wherever they set it: an
  // editor's or a wrapper's launcher may already have set a low --max-old-space-size.
  it("raises a heap a launcher set too low, and never lowers one", () => {
    expect(
      reExecForMemory({ ATTICUS_MAX_OLD_SPACE: "4096" }, ["--max-old-space-size=512"]),
    ).toEqual({ maxOldSpaceMB: 4096 });
    expect(
      reExecForMemory(
        { ATTICUS_MAX_OLD_SPACE: "4096", NODE_OPTIONS: "--max-old-space-size=512" },
        [],
      ),
    ).toEqual({ maxOldSpaceMB: 4096 });
  });

  it("never restarts twice", () => {
    expect(
      reExecForMemory({ ATTICUS_MAX_OLD_SPACE: "4096", ATTICUS_RESTARTED_FOR_MEMORY: "1" }, []),
    ).toBeUndefined();
  });
});

describe("streamFacts: a facts file read a line at a time", () => {
  it("gives the same facts and the same bad lines as reading the whole text", async () => {
    const { file } = estate(50);
    const text = readFileSync(file, "utf8");
    writeFileSync(file, text + "{not json}\n" + text.split("\n")[0] + "\n");
    const streamed = await streamFacts(file);
    const whole = parseFactsLines(readFileSync(file, "utf8"));
    expect(streamed.facts.map((f) => f.id)).toEqual(whole.facts.map((f) => f.id));
    expect(streamed.bad).toEqual(whole.bad);
    expect(streamed.bad.map((b) => b.issues[0]!.code)).toEqual(["not-json", "duplicate-id"]);
  });

  it("stops with the message when the facts don't fit, rather than reading on", async () => {
    const { file } = estate(2_300);
    const room = roomGuard({
      what: "forge-limits's facts",
      ceilingBytes: 1024,
      used: () => 4096,
      every: 1,
    });
    await expect(streamFacts(file, room)).rejects.toThrow(NoRoomError);
  });
});

describe("atticus verify: a read too big for the memory given says so, and doesn't die quietly", () => {
  it("prints the message and exits 2, with nothing half-written", async () => {
    const { root } = estate(2_300);
    const o = io();
    // A ceiling under what any Node process holds at rest: this read cannot fit in it.
    const code = await verifyCommand(
      root,
      "forge-limits",
      { commit: COMMIT, write: true, ceilingBytes: 64 * 1024 },
      o.io,
    );
    expect(code).toBe(2);
    // the point of the fix: words on stderr, not an empty exit 137
    expect(o.err.join("\n")).toContain("forge-limits's facts need more memory than Node was given");
    expect(o.err.join("\n")).toMatch(/ATTICUS_MAX_OLD_SPACE=\d+/);
    expect(o.err.join("\n")).toMatch(/or in parts/);
    expect(o.out).toEqual([]);
  });

  it("verifies 2,300 facts whole when there is room, within a ceiling a laptop has", async () => {
    const { root } = estate(2_300);
    const o = io();
    const code = await verifyCommand(
      root,
      "forge-limits",
      { commit: COMMIT, ceilingBytes: 3 * 1024 * 1024 * 1024 },
      o.io,
    );
    expect(code).toBe(0);
    expect(o.out[0]).toMatch(/2300 facts kept, 0 rejected/);
    // A-uncited, on every one of them: the claim is kept and the warning stands.
    expect(o.out.join("\n")).toMatch(/2300 entries' auth rests on no cited line/);
  });
});
