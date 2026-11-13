import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import type { AcpExec } from "@maycombhq/ai";
import { Api } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { acpStepRunner } from "../src/copilot-acp-steps.js";
import { mapAllCommand } from "../src/map-all.js";
import { main } from "../src/main.js";
import { uiCopilotRunRoutes, type MapAllStarter } from "../src/ui-api-copilot-runs.js";

const FIXTURES = join(__dirname, "..", "..", "..", "fixtures");
const MOCK = join(FIXTURES, "copilot-acp", "mock-agent.mjs");
const VERIFY = join(__dirname, "..", "..", "verify", "test", "fixtures");

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const write = (root: string, path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
function estate() {
  const root = mkdtempSync(join(tmpdir(), "atticus-stop-"));
  temps.push(root);
  cpSync(join(VERIFY, "metarepo", "org-pack"), join(root, "org-pack"), { recursive: true });
  write(
    root,
    "org-pack/runtime.yaml",
    stringify({
      schemaVersion: 3,
      assistants: { allowed: ["copilot"], default: "copilot" },
      modes: { allowed: ["hand-off", "copilot-acp"], default: "copilot-acp" },
      copilotAcp: { command: `"${process.execPath}" "${MOCK}"`, maxTurns: 100 },
    }),
  );
  const dir = join(root, "workspace", "forge-ledger");
  cpSync(join(VERIFY, "repo"), dir, { recursive: true });
  const git = (...a: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=T",
        "-c",
        "user.email=t@example.com",
        "-c",
        "init.defaultBranch=main",
        "-c",
        "commit.gpgsign=false",
        ...a,
      ],
      { cwd: dir, encoding: "utf8" },
    );
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "one");
  return root;
}
function scripted(root: string, script: unknown) {
  const file = join(root, ".acp-script.json");
  writeFileSync(file, JSON.stringify(script));
  const log = join(root, ".acp-log.jsonl");
  return {
    env: { MOCK_ACP_SCRIPT: file, MOCK_ACP_LOG: log },
    log: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l) as Record<string, unknown>)
        : [],
  };
}
const inProcess: AcpExec = async (argv, o) => {
  const out: string[] = [];
  const code = await main([...argv, "--root", o.cwd], {
    out: (l) => out.push(l),
    err: (l) => out.push(l),
  });
  return { exitCode: code, output: `${out.join("\n")}\n` };
};

/**
 * beta.28 field report: Stop on a Copilot run started from the app left it "running" for 50
 * minutes with no Copilot process left. End to end here: the app's route, `map --all`'s own code
 * and the stand-in agent (a real child process), stopped in each phase, or ending on its own.
 */
async function appRun(script: unknown) {
  const root = estate();
  const m = scripted(root, script);
  const start: MapAllStarter = async (o, io, deps) =>
    mapAllCommand(root, o, io, {
      ...deps,
      makeAcp: () => acpStepRunner(root, { exec: inProcess, env: m.env }),
    });
  const srv: RunningServer = await startServer({
    root,
    port: 0,
    extend: (r, ctx) =>
      uiCopilotRunRoutes(r, ctx, {
        start,
        flushMs: 1,
        assistantFiles: async () => ({ results: [] }),
      }),
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(srv.url + path, {
      method,
      headers: { "X-Atticus-Token": srv.token, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const current = async () =>
    Api.CopilotRunCurrent.parse((await call("GET", "/api/copilot-runs/current")).body).run!;
  const r = await call("POST", "/api/copilot-runs", { kind: "all", maxTokens: 100_000 });
  expect(r.status).toBe(202);
  const id = String(r.body.runId);
  return {
    log: m.log,
    current,
    stop: async () => (await call("POST", `/api/copilot-runs/${id}/stop`)).status,
    /** Waits until the agent's log says `ok`. */
    until: async (ok: (log: Record<string, unknown>[]) => boolean) => {
      for (let i = 0; i < 600 && !ok(m.log()); i++) await new Promise((x) => setTimeout(x, 25));
      expect(ok(m.log())).toBe(true);
    },
    /** Waits for the run to end; how long it took. */
    ended: async () => {
      const t0 = Date.now();
      for (let i = 0; i < 400 && (await current()).state === "running"; i++)
        await new Promise((x) => setTimeout(x, 50));
      return Date.now() - t0;
    },
    close: () => srv.close(),
  };
}

describe("Stop on a Copilot run from the app ends it within seconds (beta.28)", () => {
  it("before its session opens: no prompt is sent, and the run says stopped", async () => {
    const a = await appRun({ startMs: 30_000, sessions: [{ steps: [{ sleep: 30_000 }] }] });
    try {
      await a.until((l) => l.some((e) => e.event === "starting"));
      expect(await a.stop()).toBe(200);
      expect(await a.ended()).toBeLessThan(8_000);
      const run = await a.current();
      expect(run.state).toBe("stopped");
      expect(run.tabs[0]!.lines.at(-1)).toBe("Stopped. The next run carries on from here.");
      expect(a.log().some((e) => e.event === "prompt")).toBe(false);
    } finally {
      await a.close();
    }
  }, 60_000);

  it("during a prompt the agent doesn't answer: the run says stopped", async () => {
    const a = await appRun({ sessions: [{ steps: [{ tool: "Reading" }, { sleep: 30_000 }] }] });
    try {
      await a.until((l) => l.some((e) => e.event === "prompt"));
      expect(await a.stop()).toBe(200);
      expect(await a.ended()).toBeLessThan(10_000);
      expect((await a.current()).state).toBe("stopped");
      expect(a.log().filter((e) => e.event === "session").length).toBe(1);
    } finally {
      await a.close();
    }
  }, 60_000);

  it("Copilot ending on its own ends the run as failed, saying why, with no session after it", async () => {
    const a = await appRun({
      sessions: [{ steps: [{ tool: "Reading" }, { exit: 1 }] }, { steps: [{ say: "never" }] }],
    });
    try {
      expect(await a.ended()).toBeLessThan(8_000);
      const run = await a.current();
      expect(run.state).toBe("failed");
      expect(run.message).toMatch(
        /^The Copilot language server ended on its own during the session \(the Copilot language server ended \(1\)\)/,
      );
      expect(a.log().filter((e) => e.event === "session").length).toBe(1);
    } finally {
      await a.close();
    }
  }, 60_000);
});
