import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AcpServerGoneError,
  AcpSetupError,
  type AcpStartError,
  copilotAcpProbe,
  forgetAcpStarts,
  runAcpSession,
  serverWords,
  sessionOpenLimit,
  START_TIMEOUT_ENV,
  startTimeoutOf,
  type AcpServer,
  type AcpSpawner,
} from "../src/copilot-acp.js";

/**
 * ADR 0171 addendum (beta.28.5): a Copilot language server that won't start. A field run printed
 * a 60 s timeout and quoted only a Node warning. Here the stand-in (fixtures/copilot-acp/
 * mock-agent.mjs, a real child process) ends as it starts, stays silent, or warns and then works;
 * and a spawner in memory plays what only Windows prints. No network.
 */

const MOCK = join(__dirname, "..", "..", "..", "fixtures", "copilot-acp", "mock-agent.mjs");
const COMMAND = `"${process.execPath}" "${MOCK}"`;
const WARNING = /ExperimentalWarning|trace-warnings/;

// Each test starts node once or more and some wait out a limit: generous on a slow CI machine.
vi.setConfig({ testTimeout: 30_000 });

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
beforeEach(() => forgetAcpStarts());

function metarepo(script: unknown) {
  const root = mkdtempSync(join(tmpdir(), "atticus-acp-start-"));
  temps.push(root);
  mkdirSync(join(root, "facts"), { recursive: true });
  const scriptFile = join(root, ".script.json");
  writeFileSync(scriptFile, JSON.stringify(script));
  const logFile = join(root, ".mock-log.jsonl");
  return {
    root,
    env: { MOCK_ACP_SCRIPT: scriptFile, MOCK_ACP_LOG: logFile },
    log: () =>
      existsSync(logFile)
        ? readFileSync(logFile, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l) as Record<string, unknown>)
        : [],
  };
}

const session = (
  m: ReturnType<typeof metarepo>,
  more: Partial<Parameters<typeof runAcpSession>[0]> = {},
) =>
  runAcpSession({
    command: COMMAND,
    cwd: m.root,
    prompt: "x",
    policy: { readRoots: [m.root], writeRoots: [join(m.root, "facts")] },
    exec: async () => ({ exitCode: 0, output: "" }),
    env: m.env,
    ...more,
  });

/** The failure of a session that must fail, with how long it took. */
async function failure(p: Promise<unknown>): Promise<{ message: string; ms: number; e: unknown }> {
  const t = Date.now();
  try {
    await p;
  } catch (e) {
    return { message: (e as Error).message, ms: Date.now() - t, e };
  }
  throw new Error("the session didn't fail");
}

const starts = (m: ReturnType<typeof metarepo>) =>
  m.log().filter((e) => e.event === "start") as { argv: string[]; pid: number }[];

/** Whether a process is still there, asked for up to `ms`: true when it never went. */
async function alive(pid: number, ms = 6_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end;) {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

/** A server in memory: it prints `stderr` and ends, or never answers. */
function played(o: {
  stderr?: string;
  exit?: { code: number | null; signal: string | null };
  spawnError?: NodeJS.ErrnoException;
  /** Called when Atticus closes the server. */
  onClose?: () => void;
}): { spawn: AcpSpawner; seen: { command: string; args: string[] }[] } {
  const seen: { command: string; args: string[] }[] = [];
  const spawn: AcpSpawner = (s) => {
    seen.push({ command: s.command, args: s.args });
    const closes: ((why: string) => void)[] = [];
    let closed: string | undefined;
    const end = (why: string) => {
      closed = why;
      for (const f of closes) f(why);
    };
    const started = o.spawnError ? Promise.reject(o.spawnError) : Promise.resolve();
    started.catch(() => undefined);
    if (o.spawnError) setTimeout(() => end(o.spawnError!.message), 5);
    else if (o.exit) setTimeout(() => end(`ended (${o.exit!.code})`), 5);
    const server: AcpServer = {
      started,
      stderr: () => o.stderr ?? "",
      exited: () => (closed && o.exit ? o.exit : undefined),
      close: async () => o.onClose?.(),
      transport: {
        send: () => {},
        onLine: () => {},
        onClose: (f) => (closed ? f(closed) : closes.push(f)),
      },
    };
    return server;
  };
  return { spawn, seen };
}

describe("what the server printed, Node's warnings set aside", () => {
  it("keeps the server's own lines and drops warnings, with \\n or \\r\\n", () => {
    const text = [
      "(node:20064) ExperimentalWarning: SQLite is an experimental feature and might change at any time",
      "(Use `node --trace-warnings ...` to show where the warning was created)",
      "(node:20064) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.",
      "npm warn exec The following package was not found and will be installed: x",
      "error: required option '--stdio' not specified",
      "",
    ];
    for (const nl of ["\n", "\r\n"])
      expect(serverWords(text.join(nl))).toEqual({
        lines: ["error: required option '--stdio' not specified"],
        warnings: 4,
        npmWarning: "npm warn exec The following package was not found and will be installed: x",
      });
    expect(serverWords(text.slice(0, 2).join("\r\n"))).toEqual({ lines: [], warnings: 2 });
    expect(serverWords("")).toEqual({ lines: [], warnings: 0 });
  });
});

describe("a Copilot language server that ends as it starts", () => {
  it("is reported at once with its own words and the corrected command, never as a timeout", async () => {
    const m = metarepo({
      start: {
        warn: true,
        stderr: ["error: required option '--node-ipc' not specified"],
        exit: 1,
      },
      sessions: [],
    });
    const f = await failure(session(m));
    expect(f.e).toBeInstanceOf(AcpSetupError);
    expect(f.ms).toBeLessThan(10_000);
    expect(f.message).toContain(
      "it ended before it answered (exit code 1) and said: error: required option '--node-ipc' not specified.",
    );
    expect(f.message).toContain(
      `It asks for the option --node-ipc. Add it to copilotAcp.command in runtime.yaml (command: ${COMMAND} --node-ipc).`,
    );
    expect(f.message).not.toMatch(WARNING);
    expect(f.message).not.toMatch(/took over|--help/);
    expect(starts(m)).toHaveLength(1);
  });

  it("says it printed nothing but warnings when that is all there was", async () => {
    const m = metarepo({ start: { warn: true, exit: 1, crlf: true }, sessions: [] });
    const f = await failure(session(m));
    expect(f.message).toContain(
      "it ended before it answered (exit code 1) and printed nothing but warnings.",
    );
    expect(f.message).toContain("Check copilotAcp.command in runtime.yaml");
    expect(f.message).toContain("yourself to see what it does");
    expect(f.message).not.toMatch(WARNING);
    expect(f.message).not.toContain("--help");
  });

  it("says so when the program doesn't know --acp, and only then points at --help", async () => {
    const m = metarepo({
      start: { warn: true, stderr: ["error: unknown option '--acp'"], exit: 1 },
      sessions: [],
    });
    const f = await failure(session(m));
    expect(f.message).toContain("and said: error: unknown option '--acp'.");
    expect(f.message).toContain("doesn't know --acp");
    expect(f.message).toMatch(
      /Check copilotAcp\.command in runtime\.yaml, and that .* --help lists --acp/,
    );
    const other = metarepo({
      start: { stderr: ["error: unknown option '--fast'"], exit: 1 },
      sessions: [],
    });
    const g = await failure(session(other, { command: `${COMMAND} --fast` }));
    expect(g.message).toContain(
      `It doesn't know the option --fast. Take it out of copilotAcp.command in runtime.yaml (command: ${COMMAND}).`,
    );
    expect(g.message).not.toContain("--help");
  });

  it("says a program that isn't there isn't there (ENOENT, or cmd.exe's and a shell's words)", async () => {
    const m = metarepo({ sessions: [] });
    const f = await failure(session(m, { command: "atticus-no-such-copilot-server" }));
    expect(f.message).toContain(
      "Atticus couldn't start the Copilot language server (atticus-no-such-copilot-server): the program atticus-no-such-copilot-server wasn't found on this machine",
    );
    expect(f.message).toContain("Set copilotAcp.command in runtime.yaml to a program");
    expect(f.message).not.toContain("--help");
    // Windows: npx is npx.cmd, run through cmd.exe, which says so itself and exits 1.
    const win = played({
      stderr:
        "'npx' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n",
      exit: { code: 1, signal: null },
    });
    const w = await failure(
      session(m, { command: "npx --yes @github/copilot-language-server", spawn: win.spawn }),
    );
    expect(w.message).toContain("the program npx wasn't found on this machine");
    expect(w.message).toContain("npx comes with Node.js");
    const sh = played({
      stderr: "sh: 1: copilot-ls: not found\n",
      exit: { code: 127, signal: null },
    });
    const s = await failure(session(m, { command: "copilot-ls", spawn: sh.spawn }));
    expect(s.message).toContain("the program copilot-ls wasn't found on this machine");
  });

  it("names the signal that ended it, and npm's own error when npx couldn't fetch the package", async () => {
    const m = metarepo({ sessions: [] });
    const killed = played({ exit: { code: null, signal: "SIGKILL" } });
    const k = await failure(session(m, { spawn: killed.spawn }));
    expect(k.message).toContain(
      "it ended before it answered (ended by SIGKILL) and printed nothing.",
    );
    const npm = played({
      stderr: [
        "npm error code E407",
        "npm error 407 Proxy Authentication Required - GET https://registry.npmjs.org/@github%2fcopilot-language-server",
        "npm error A complete log of this run can be found in: C:\\Users\\dev\\npm-cache\\_logs\\x.log",
        "",
      ].join("\r\n"),
      exit: { code: 1, signal: null },
    });
    const n = await failure(
      session(m, { command: "npx --yes @github/copilot-language-server", spawn: npm.spawn }),
    );
    expect(n.message).toContain("and said: npm error code E407 npm error 407 Proxy Authentication");
    expect(n.message).toContain("npx couldn't fetch or run the package");
    expect(n.message).toContain("npm i -g @github/copilot-language-server");
    expect(n.message).toContain("command: copilot-language-server");
  });

  // Windows CI, beta.28.5: the mock can't close its own output there and stay (closing fd 1 in
  // Node leaves the pipe's handle open on Windows, so it went on answering). These two run where
  // the mock can do it; the client's code is the same on both.
  const closesOutput = process.platform === "win32" ? it.skip : it;

  closesOutput(
    "says when it closed its output but is still running, and ends it",
    async () => {
      const m = metarepo({ start: { mute: true }, sessions: [] });
      const f = await failure(session(m, { startTimeoutMs: 20_000 }));
      expect(f.ms).toBeLessThan(10_000);
      expect(f.message).toContain("it closed its output before it answered");
      // Review: it was left running. It is ended (stdin closed, then killed if it lingers).
      expect(await alive(starts(m)[0]!.pid)).toBe(false);
    },
    30_000,
  );

  closesOutput(
    "ends a server that closes its output mid-session, saying so",
    async () => {
      const m = metarepo({ sessions: [{ steps: [{ tool: "Reading" }, { mute: true }] }] });
      const f = await failure(session(m));
      expect(f.e).toBeInstanceOf(AcpServerGoneError);
      expect(f.message).toContain(
        "The Copilot language server closed its output during the session and is still running",
      );
      expect(await alive(starts(m)[0]!.pid)).toBe(false);
    },
    30_000,
  );

  it("blames the configured program only when it is the one not found", async () => {
    const m = metarepo({ sessions: [] });
    // npx ran; what it runs wasn't there. (A real cmd.exe says this in Windows' language: only
    // the English words are recognised, and any other reads as "ended … and said: …".)
    for (const stderr of [
      "sh: 1: copilot-language-server: not found\n",
      "'copilot-language-server' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n",
    ]) {
      const inner = played({
        stderr,
        exit: { code: stderr.startsWith("sh") ? 127 : 1, signal: null },
      });
      const f = await failure(
        session(m, { command: "npx --yes @github/copilot-language-server", spawn: inner.spawn }),
      );
      expect(f.message).not.toContain("the program npx wasn't found");
      expect(f.message).not.toContain("npx comes with Node.js");
      expect(f.message).toMatch(
        /it ended before it answered \(exit code \d+\) and said: .*copilot-language-server/,
      );
      expect((f.e as AcpStartError).start.kind).toBe("exited");
    }
    const own = played({
      stderr: "'npx.cmd' is not recognized as an internal or external command,\r\n",
      exit: { code: 1, signal: null },
    });
    const o = await failure(session(m, { command: "npx.cmd --yes x", spawn: own.spawn }));
    expect(o.message).toContain("the program npx.cmd wasn't found on this machine");
    expect((o.e as AcpStartError).start.kind).toBe("not-found");
  });

  it("quotes npm's last warning when warnings are all there is, never Node's", async () => {
    const m = metarepo({ sessions: [] });
    const stderr = [
      "(node:4242) ExperimentalWarning: SQLite is an experimental feature and might change at any time",
      "npm warn exec The following package was not found and will be installed: @github/copilot-language-server@1.400.0",
      "npm warn fetch GET https://registry.npmjs.org/@github%2fcopilot-language-server attempt 1 failed with ETIMEDOUT, retrying",
      "",
    ].join("\r\n");
    const npx = "npx --yes @github/copilot-language-server";
    const ended = played({ stderr, exit: { code: 1, signal: null } });
    const e = await failure(session(m, { command: npx, spawn: ended.spawn }));
    expect(e.message).toContain(
      "printed nothing but warnings; its last warning was: npm warn fetch GET https://registry.npmjs.org/@github%2fcopilot-language-server attempt 1 failed with ETIMEDOUT, retrying.",
    );
    const slow = played({ stderr });
    const t = await failure(session(m, { command: npx, spawn: slow.spawn, startTimeoutMs: 200 }));
    expect(t.message).toContain(
      "(it had printed nothing but warnings; its last warning was: npm warn fetch GET",
    );
    expect(e.message + t.message).not.toMatch(WARNING);
  });

  it("redacts what it quotes: a proxy's credentials and a token never reach the message", async () => {
    const m = metarepo({ sessions: [] });
    const npm = played({
      stderr: [
        "npm error code E407",
        "npm error 407 Proxy Authentication Required - GET http://svc-forge:Hunter2pass@proxy.forge.example:8080/x token=ghp_Abcdefghij0123456789Abcdefghij012345",
        "",
      ].join("\n"),
      exit: { code: 1, signal: null },
    });
    const f = await failure(
      session(m, { command: "npx --yes @github/copilot-language-server", spawn: npm.spawn }),
    );
    expect(f.message).toContain("npm error 407 Proxy Authentication Required");
    expect(f.message).toContain("http://***@proxy.forge.example:8080/x");
    expect(f.message).not.toMatch(/Hunter2pass|svc-forge|ghp_Abcdefghij/);
    expect(JSON.stringify((f.e as AcpStartError).start)).not.toMatch(/Hunter2pass|ghp_Abcdefghij/);
    const warned = played({
      stderr: "npm warn fetch GET http://svc-forge:Hunter2pass@proxy.forge.example:8080/x failed\n",
    });
    const t = await failure(session(m, { spawn: warned.spawn, startTimeoutMs: 200 }));
    expect(t.message).toContain("http://***@proxy.forge.example:8080/x");
    expect(t.message).not.toContain("Hunter2pass");
  });
});

describe("a Copilot language server that asks for --stdio", () => {
  it("is started again with it, once, saying so; later sessions start with it straight away", async () => {
    const m = metarepo({
      start: { warn: true, needs: "--stdio" },
      sessions: [{ steps: [{ say: "Done." }] }, { steps: [{ say: "Done." }] }],
    });
    const said: string[] = [];
    const r = await session(m, { onProgress: (l) => said.push(l) });
    expect(r.stopReason).toBe("end_turn");
    expect(said.filter((l) => l.includes("--stdio"))).toEqual([
      "The Copilot language server asked for --stdio; started again with it. Add --stdio to copilotAcp.command in runtime.yaml to skip this.",
    ]);
    expect(said.join("\n")).not.toMatch(WARNING);
    expect(starts(m).map((s) => s.argv.includes("--stdio"))).toEqual([false, true]);
    const again: string[] = [];
    await session(m, { onProgress: (l) => again.push(l) });
    expect(again.some((l) => l.includes("--stdio"))).toBe(false);
    expect(starts(m).map((s) => s.argv.includes("--stdio"))).toEqual([false, true, true]);
  });

  it("isn't started a third time when it ends the same way with --stdio", async () => {
    const m = metarepo({
      start: { stderr: ["error: required option '--stdio' not specified"], exit: 1 },
      sessions: [],
    });
    const f = await failure(session(m));
    expect(starts(m)).toHaveLength(2);
    expect(f.message).toContain(`(${COMMAND}, then with --stdio as it asked)`);
    expect(f.message).toContain("and said: error: required option '--stdio' not specified.");
    // Not learned: the next session asks the same way.
    await failure(session(m));
    expect(starts(m)).toHaveLength(4);
  });

  it("forgets --stdio when a start with it fails, says so, and starts as runtime.yaml has it", async () => {
    const m = metarepo({ start: { needs: "--stdio" }, sessions: [{ steps: [] }, { steps: [] }] });
    await session(m);
    // The server changed its mind (another version): it no longer takes --stdio.
    writeFileSync(
      m.env.MOCK_ACP_SCRIPT,
      JSON.stringify({ start: { refuses: "--stdio" }, sessions: [{ steps: [] }, { steps: [] }] }),
    );
    const said: string[] = [];
    const r = await session(m, { onProgress: (l) => said.push(l) });
    expect(r.stopReason).toBe("end_turn");
    expect(said).toContain(
      "The Copilot language server, started with the --stdio it asked for earlier, ended; started again as copilotAcp.command has it.",
    );
    expect(starts(m).map((s) => s.argv.includes("--stdio"))).toEqual([false, true, true, false]);
    // Forgotten: the next start is as runtime.yaml has it, at once.
    await session(m);
    expect(starts(m).at(-1)!.argv.includes("--stdio")).toBe(false);
    expect(starts(m)).toHaveLength(5);
  }, 30_000);

  it("remembers --stdio for one metarepo and command, not for another metarepo", async () => {
    const a = metarepo({ start: { needs: "--stdio" }, sessions: [{ steps: [] }, { steps: [] }] });
    await session(a);
    const b = metarepo({ sessions: [{ steps: [] }] });
    await session(b);
    expect(starts(b).map((s) => s.argv.includes("--stdio"))).toEqual([false]);
  }, 30_000);

  it("starts no second server when the person stopped it between the two starts", async () => {
    const m = metarepo({ sessions: [] });
    const stop = new AbortController();
    const asks = played({
      stderr: "error: required option '--stdio' not specified\n",
      exit: { code: 1, signal: null },
      onClose: () => stop.abort(),
    });
    const said: string[] = [];
    const r = await session(m, {
      spawn: asks.spawn,
      signal: stop.signal,
      onProgress: (l) => said.push(l),
    });
    expect(r.stopReason).toBe("cancelled");
    expect(asks.seen).toHaveLength(1);
    expect(said.some((l) => l.includes("started again"))).toBe(false);
  });

  it("is left alone when runtime.yaml's command already has --stdio", async () => {
    const m = metarepo({
      start: { stderr: ["error: required option '--stdio' not specified"], exit: 1 },
      sessions: [],
    });
    await failure(session(m, { command: `${COMMAND} --stdio` }));
    expect(starts(m)).toHaveLength(1);
  });
});

describe("a Copilot language server that is slow to start", () => {
  it("is given the start limit, then stopped with the limit named and both remedies", async () => {
    const m = metarepo({ start: { warn: true }, startMs: 60_000, sessions: [] });
    const f = await failure(session(m, { startTimeoutMs: 1_500 }));
    expect(f.ms).toBeGreaterThanOrEqual(1_400);
    expect(f.ms).toBeLessThan(15_000);
    expect(f.message).toContain(
      "it was still running after 1.5s, the limit for starting, and had not answered (it had printed nothing but warnings).",
    );
    expect(f.message).toContain("Atticus can't tell why from here");
    expect(f.message).toContain(START_TIMEOUT_ENV);
    expect(f.message).not.toMatch(WARNING);
    expect(f.message).not.toContain("--help");
    // Through npx: the download is named as one likely reason, and installing once as a remedy.
    const silent = played({});
    const n = await failure(
      session(m, {
        command: "npx --yes @github/copilot-language-server",
        spawn: silent.spawn,
        startTimeoutMs: 200,
      }),
    );
    expect(n.message).toContain("after 0.2s, the limit for starting, and had not answered.");
    expect(n.message).toMatch(
      /It may be npx fetching or checking the package on each start.*or a slow first start/,
    );
    expect(n.message).toContain(
      "install the server once (npm i -g @github/copilot-language-server) and set command: copilot-language-server under copilotAcp in runtime.yaml",
    );
    expect(n.message).toContain(`set the environment variable ${START_TIMEOUT_ENV}`);
    // Review: the field case was a timeout, where no retry with --stdio happens: it is said.
    expect(n.message).toContain(
      "If this server needs --stdio, add it to copilotAcp.command (command: npx --yes @github/copilot-language-server --stdio).",
    );
    expect(f.message).toContain(
      `If this server needs --stdio, add it to copilotAcp.command (command: ${COMMAND} --stdio).`,
    );
    const has = await failure(
      session(m, {
        command: "npx --yes @github/copilot-language-server --stdio",
        spawn: silent.spawn,
        startTimeoutMs: 200,
      }),
    );
    expect(has.message).not.toContain("If this server needs --stdio");
  }, 30_000);

  it("takes its start limit from the environment, 60 s without it, and refuses a value that isn't one", async () => {
    expect(START_TIMEOUT_ENV).toBe("ATTICUS_COPILOT_START_TIMEOUT_MS");
    expect(startTimeoutOf({})).toBe(60_000);
    expect(startTimeoutOf({ [START_TIMEOUT_ENV]: " 180000 " })).toBe(180_000);
    expect(startTimeoutOf({ [START_TIMEOUT_ENV]: "" })).toBe(60_000);
    for (const bad of ["soon", "999", "1800001", "1e5", "-5"])
      expect(() => startTimeoutOf({ [START_TIMEOUT_ENV]: bad }), bad).toThrow(
        /ATTICUS_COPILOT_START_TIMEOUT_MS is ".*": give it a whole number of milliseconds from 1000 to 1800000/,
      );
    const m = metarepo({ startMs: 60_000, sessions: [] });
    const f = await failure(session(m, { env: { ...m.env, [START_TIMEOUT_ENV]: "1000" } }));
    expect(f.ms).toBeLessThan(15_000);
    expect(f.message).toContain("after 1s, the limit for starting");
    const bad = await failure(session(m, { env: { ...m.env, [START_TIMEOUT_ENV]: "soon" } }));
    expect(bad.e).toBeInstanceOf(AcpSetupError);
    expect(bad.message).toContain('ATTICUS_COPILOT_START_TIMEOUT_MS is "soon"');
  }, 30_000);

  it("gives a new session the start limit, and never less than two minutes, in a run and in doctor", async () => {
    expect(sessionOpenLimit(60_000)).toBe(120_000);
    expect(sessionOpenLimit(1_000)).toBe(120_000);
    expect(sessionOpenLimit(300_000)).toBe(300_000);
    // Doctor gave a new session only the start limit: a slow one read as not signed in or out.
    const m = metarepo({ sessionMs: 2_500, sessions: [] });
    const p = await copilotAcpProbe({
      command: COMMAND,
      cwd: m.root,
      env: { ...m.env, [START_TIMEOUT_ENV]: "1500" },
    });
    expect(p).toMatchObject({ found: true, signedIn: true });
  }, 30_000);

  it("warnings and then an answer are no failure, and the warning is shown nowhere", async () => {
    const m = metarepo({
      start: { warn: true, crlf: true },
      startMs: 300,
      sessions: [{ steps: [{ say: "Done." }] }],
    });
    const said: string[] = [];
    const r = await session(m, { onProgress: (l) => said.push(l) });
    expect(r.stopReason).toBe("end_turn");
    expect(r.text).toBe("Done.");
    expect(said.join("\n")).not.toMatch(WARNING);
  });
});

describe("atticus doctor's look at a server that won't start", () => {
  const probe = (m: ReturnType<typeof metarepo>, more: object = {}) =>
    copilotAcpProbe({ command: COMMAND, cwd: m.root, env: m.env, ...more });

  it("gives the same words and advice as a run, at once", async () => {
    const m = metarepo({
      start: { warn: true, stderr: ["error: required option '--node-ipc' not specified"], exit: 1 },
      sessions: [],
    });
    const t = Date.now();
    const p = await probe(m);
    expect(Date.now() - t).toBeLessThan(10_000);
    expect(p).toMatchObject({ found: true, version: "mock-copilot 0.0.1" });
    expect(p.signedIn).toBeUndefined();
    expect(p.start?.problem).toBe(
      "it ended before it answered (exit code 1) and said: error: required option '--node-ipc' not specified",
    );
    expect(p.start?.advice).toBe(
      `It asks for the option --node-ipc. Add it to copilotAcp.command in runtime.yaml (command: ${COMMAND} --node-ipc).`,
    );
    const warn = await probe(metarepo({ start: { warn: true, exit: 1 }, sessions: [] }));
    expect(warn.start?.problem).toBe(
      "it ended before it answered (exit code 1) and printed nothing but warnings",
    );
    const acp = await probe(
      metarepo({ start: { stderr: ["error: unknown option '--acp'"], exit: 1 }, sessions: [] }),
    );
    expect(acp.start?.advice).toContain("--help lists --acp");
  }, 30_000);

  it("starts it again with --stdio when it asks, as a run does, and says so", async () => {
    const m = metarepo({ start: { needs: "--stdio" }, sessions: [] });
    const p = await probe(m);
    expect(p).toMatchObject({ found: true, signedIn: true });
    expect(p.note).toBe(
      "The Copilot language server asked for --stdio; started again with it. Add --stdio to copilotAcp.command in runtime.yaml to skip this.",
    );
    expect(starts(m).map((s) => s.argv.includes("--stdio"))).toEqual([false, true]);
  });

  it("stops at the start limit with the timeout's words, and says a missing program is missing", async () => {
    const m = metarepo({ start: { warn: true }, startMs: 60_000, sessions: [] });
    const p = await probe(m, { env: { ...m.env, [START_TIMEOUT_ENV]: "1000" } });
    expect(p.found).toBe(true);
    expect(p.start?.problem).toBe(
      "it was still running after 1s, the limit for starting, and had not answered (it had printed nothing but warnings)",
    );
    expect(p.start?.advice).toContain(START_TIMEOUT_ENV);
    const none = await copilotAcpProbe({ command: "atticus-no-such-copilot-server", cwd: m.root });
    expect(none.found).toBe(false);
    expect(none.start?.problem).toContain(
      "the program atticus-no-such-copilot-server wasn't found on this machine",
    );
    expect(none.start?.advice).toContain("Set copilotAcp.command in runtime.yaml to a program");
    expect(none.start?.kind).toBe("not-found");
  }, 30_000);
});
