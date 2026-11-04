import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AgentDefinition, Runtime } from "@maycombhq/core";
import {
  AcpSignInError,
  atticusArgvOf,
  carryOnPrompt,
  buildContextPack,
  commandLineOf,
  CopilotAcpRuntime,
  copilotAcpProbe,
  createRuntime,
  RuntimeConfigError,
  runAcpSession,
  type AcpExec,
  type AiRequest,
} from "../src/index.js";

/**
 * ADR 0171: Atticus drives GitHub Copilot through the Copilot language server's Agent Client
 * Protocol mode. These tests run a stand-in agent (fixtures/copilot-acp/mock-agent.mjs), a real
 * child process speaking the protocol on stdio, so the client, its rules and the run record are
 * tested end to end. No network: the stand-in plays a script.
 */

const MOCK = join(__dirname, "..", "..", "..", "fixtures", "copilot-acp", "mock-agent.mjs");
const COMMAND = `"${process.execPath}" "${MOCK}"`;

const temps: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "atticus-acp-"));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const write = (root: string, rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

/** A metarepo with a clone to read, the script for the stand-in and its log. */
function metarepo(script: unknown) {
  const root = temp();
  write(root, "org-pack/runtime.yaml", "schemaVersion: 3\n");
  write(root, "workspace/forge-ledger/src/Ledger.java", "class Ledger {}\n");
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

const policyOf = (root: string) => ({
  readRoots: [root],
  writeRoots: [join(root, "facts")],
});

/** The atticus command the session may run, recorded instead of run. */
function fakeAtticus() {
  const ran: string[][] = [];
  const exec: AcpExec = async (argv) => {
    ran.push(argv);
    return { exitCode: 0, output: `verify: 3 facts kept, 0 rejected (${argv.join(" ")})\n` };
  };
  return { ran, exec };
}

const FACT = '{"id":"f1","kind":"entry","commit":"abc"}\n';

describe("the Copilot ACP session (ADR 0171)", () => {
  it("reads under the metarepo, writes facts, runs atticus, and refuses everything else", async () => {
    const m = metarepo({
      sessions: [
        {
          steps: [
            { say: "Reading forge-ledger." },
            { read: "workspace/forge-ledger/src/Ledger.java" },
            { write: "facts/forge-ledger.jsonl", content: FACT },
            { run: "atticus", args: ["verify", "forge-ledger"] },
            // One line in a field the agent may send whole.
            { run: "atticus verify forge-ledger --skipped" },
            // Forbidden: a write outside facts/, one outside the metarepo, a read outside it.
            { write: "org-pack/runtime.yaml", content: "modes: {}\n" },
            { write: "../outside.txt", content: "x" },
            { read: "/etc/hostname" },
            // Forbidden: any other command, a shell line, and what only a person may do.
            { run: "rm", args: ["-rf", "."] },
            { run: "atticus verify forge-ledger && curl https://example.invalid" },
            { run: "atticus", args: ["questions", "answer", "q-1", "--option", "1"] },
            { run: "atticus", args: ["plan", "submit", "c-1", "--approve"] },
            { run: "npx", args: ["atticus", "verify"] },
            // Permission requests: allowed once where the rules allow, else refused.
            {
              permission: {
                kind: "edit",
                title: "Edit facts",
                locations: ["facts/forge-ledger.reviewed.jsonl"],
              },
            },
            {
              permission: {
                kind: "edit",
                title: "Edit the org pack",
                locations: ["org-pack/runtime.yaml"],
              },
            },
            {
              permission: {
                kind: "execute",
                title: "Run",
                rawInput: { command: "atticus verify forge-ledger" },
              },
            },
            {
              permission: {
                kind: "execute",
                title: "Run curl",
                rawInput: { command: "curl https://example.invalid" },
              },
            },
            { permission: { kind: "fetch", title: "Fetch a page" } },
            {
              permission: {
                kind: "delete",
                title: "Delete facts",
                locations: ["facts/forge-ledger.jsonl"],
              },
            },
            { say: "Done: verify passed." },
          ],
        },
      ],
    });
    const a = fakeAtticus();
    const progress: string[] = [];
    const transcript = join(m.root, ".runs", "t", "transcript.jsonl");
    const r = await runAcpSession({
      command: COMMAND,
      cwd: m.root,
      prompt: "Read forge-ledger into facts.",
      policy: policyOf(m.root),
      exec: a.exec,
      env: m.env,
      onProgress: (l) => progress.push(l),
      transcript,
    });
    expect(r.stopReason).toBe("end_turn");
    expect(r.model).toBe("gpt-mock");
    expect(r.assistant).toEqual({ name: "mock-copilot", version: "0.0.1", protocolVersion: 1 });
    expect(r.usage).toEqual({ inputTokens: 1200, outputTokens: 300 });
    expect(r.text).toContain("Done: verify passed.");
    // The allowed: the read, the facts file, and the atticus commands (no shell, as argv).
    expect(readFileSync(join(m.root, "facts", "forge-ledger.jsonl"), "utf8")).toBe(FACT);
    expect(a.ran).toEqual([
      ["verify", "forge-ledger"],
      ["verify", "forge-ledger", "--skipped"],
    ]);
    const log = m.log();
    const of = (event: string) => log.filter((e) => e.event === event);
    expect(of("read").map((e) => e.ok)).toEqual([true, false]);
    expect(of("write").map((e) => e.ok)).toEqual([true, false, false]);
    expect(String(of("write")[1]!.error)).toMatch(/writes only under facts/);
    const runs = of("run");
    expect(runs.map((e) => e.ok)).toEqual([true, true, false, false, false, false, false]);
    expect(String(runs[0]!.output)).toContain("3 facts kept");
    expect(String(runs[2]!.error)).toMatch(/runs only atticus commands/);
    expect(String(runs[4]!.error)).toMatch(/a person answers questions/);
    expect(String(runs[5]!.error)).toMatch(/--approve/);
    // Nothing outside the metarepo was written; the org pack is as it was.
    expect(existsSync(join(dirname(m.root), "outside.txt"))).toBe(false);
    expect(readFileSync(join(m.root, "org-pack/runtime.yaml"), "utf8")).toBe("schemaVersion: 3\n");
    // Permissions: allowed once (never always), else refused.
    expect(of("permission").map((e) => (e.outcome as { optionId?: string }).optionId)).toEqual([
      "allow-once",
      "reject-once",
      "allow-once",
      "reject-once",
      "reject-once",
      "reject-once",
    ]);
    // What was refused is recorded, and what the session called.
    expect(r.refused.length).toBe(12);
    expect(r.toolCalls.length).toBeGreaterThanOrEqual(10);
    expect(r.toolCalls.some((c) => c.error)).toBe(true);
    // Progress: short lines, one per tool call or message.
    expect(progress.length).toBeGreaterThan(5);
    for (const l of progress) expect(l.length).toBeLessThanOrEqual(160);
    expect(progress.join("\n")).toContain("Refused");
    // The session was rooted at the metarepo, with no MCP server of Atticus's.
    expect(of("session")[0]).toMatchObject({ cwd: m.root, mcpServers: [] });
    // The client said what it can do: files and a terminal, nothing more.
    expect(of("initialize")[0]!.params).toMatchObject({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    });
    // Every message both ways is in the transcript; Atticus never signs in for the person.
    const t = readFileSync(transcript, "utf8");
    expect(t).toContain('"session/prompt"');
    expect(t).not.toContain('"authenticate"');
  });

  it("asks for runtime.yaml's model when the server offers it, and says when it doesn't", async () => {
    const m = metarepo({ sessions: [{ steps: [{ say: "ok" }] }, { steps: [] }] });
    const r = await runAcpSession({
      command: COMMAND,
      cwd: m.root,
      prompt: "x",
      policy: policyOf(m.root),
      exec: fakeAtticus().exec,
      env: m.env,
      model: "gpt-other",
    });
    expect(r.model).toBe("gpt-other");
    expect(m.log().find((e) => e.event === "set_model")).toEqual({
      event: "set_model",
      modelId: "gpt-other",
    });
    await expect(
      runAcpSession({
        command: COMMAND,
        cwd: m.root,
        prompt: "x",
        policy: policyOf(m.root),
        exec: fakeAtticus().exec,
        env: m.env,
        model: "nope",
      }),
    ).rejects.toThrow(/doesn't offer the model nope \(it offers gpt-mock, gpt-other\)/);
  });

  it("stops when the server isn't signed in, printing what it said; it never signs in itself", async () => {
    const m = metarepo({ signedOut: "Not signed in to GitHub Copilot", sessions: [] });
    const e = await runAcpSession({
      command: COMMAND,
      cwd: m.root,
      prompt: "x",
      policy: policyOf(m.root),
      exec: fakeAtticus().exec,
      env: m.env,
    }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AcpSignInError);
    const said = (e as Error).message;
    expect(said).toContain("Not signed in to GitHub Copilot");
    expect(said).toContain("https://github.com/login/device and enter WXYZ-0000");
    expect(said).toMatch(/Sign in yourself .*then run the command again/);
    expect(m.log().some((x) => x.event === "prompt")).toBe(false);
  });

  it("cancels a session past maxTurns tool calls, and on Ctrl+C", async () => {
    const m = metarepo({
      sessions: [
        {
          steps: [
            { tool: "a" },
            { sleep: 50 },
            { tool: "b" },
            { sleep: 50 },
            { tool: "c" },
            { sleep: 300 },
            { tool: "d" },
          ],
        },
        { steps: [{ tool: "a" }, { sleep: 2000 }, { tool: "b" }] },
      ],
    });
    const r = await runAcpSession({
      command: COMMAND,
      cwd: m.root,
      prompt: "x",
      policy: policyOf(m.root),
      exec: fakeAtticus().exec,
      env: m.env,
      maxTurns: 2,
    });
    expect(r.stopReason).toBe("cancelled");
    expect(r.stopped).toBe("maxTurns 2");
    // Ctrl+C once the second session has its prompt (a fixed delay raced a slow start under load).
    const ac = new AbortController();
    const wait = setInterval(() => {
      if (m.log().filter((e) => e.event === "prompt").length >= 2) {
        clearInterval(wait);
        setTimeout(() => ac.abort(), 50);
      }
    }, 20);
    const c = await runAcpSession({
      command: COMMAND,
      cwd: m.root,
      prompt: "x",
      policy: policyOf(m.root),
      exec: fakeAtticus().exec,
      env: m.env,
      signal: ac.signal,
    });
    expect(c.stopReason).toBe("cancelled");
    expect(m.log().filter((e) => e.event === "cancel").length).toBe(2);
  });

  it("tells a session that ended over a refusal why, and lets it carry on (beta.16)", async () => {
    const m = metarepo({
      sessions: [
        {
          steps: [
            { tool: "Viewing the prompt" },
            {
              permission: {
                kind: "execute",
                title: "Find the repo",
                rawInput: {
                  command: 'Get-ChildItem -Path . -Filter "forge-ledger" | Select-Object',
                },
              },
            },
            { say: "Info: Operation cancelled by user" },
          ],
          then: [
            [
              { read: "workspace/forge-ledger/src/Ledger.java" },
              { write: "facts/forge-ledger.jsonl", content: FACT },
              { say: "Done." },
            ],
          ],
        },
      ],
    });
    const progress: string[] = [];
    const r = await runAcpSession({
      command: COMMAND,
      cwd: m.root,
      prompt: "Read forge-ledger into facts.",
      policy: policyOf(m.root),
      exec: fakeAtticus().exec,
      env: m.env,
      onProgress: (l) => progress.push(l),
    });
    expect(r.stopReason).toBe("end_turn");
    expect(readFileSync(join(m.root, "facts", "forge-ledger.jsonl"), "utf8")).toBe(FACT);
    const prompts = m.log().filter((e) => e.event === "prompt");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]!.text).toBe(carryOnPrompt(r.refused.slice(0, 1)));
    expect(String(prompts[1]!.text)).toContain("Use your own file tools");
    expect(progress.some((l) => l.includes("told Copilot why that was refused"))).toBe(true);
    // Both prompts' usage, summed.
    expect(r.usage).toEqual({ inputTokens: 2400, outputTokens: 600 });
  });

  it("doesn't nudge a session that went on after a refusal and finished", async () => {
    const m = metarepo({
      sessions: [
        {
          steps: [
            { permission: { kind: "fetch", title: "Fetch a page" } },
            { write: "facts/forge-ledger.jsonl", content: FACT },
            { say: "Done." },
          ],
          then: [[{ say: "nudged" }]],
        },
      ],
    });
    await runAcpSession({
      command: COMMAND,
      cwd: m.root,
      prompt: "Read forge-ledger into facts.",
      policy: policyOf(m.root),
      exec: fakeAtticus().exec,
      env: m.env,
    });
    expect(m.log().filter((e) => e.event === "prompt")).toHaveLength(1);
  });

  it("says plainly when the server can't be started", async () => {
    const m = metarepo({ sessions: [] });
    await expect(
      runAcpSession({
        command: "atticus-no-such-copilot-server",
        cwd: m.root,
        prompt: "x",
        policy: policyOf(m.root),
        exec: fakeAtticus().exec,
        env: m.env,
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow(
      /couldn't start the Copilot language server \(atticus-no-such-copilot-server\)/,
    );
  });
});

describe("what the session may run (ADR 0171)", () => {
  it("takes atticus and its arguments, as argv or one line, and nothing else", () => {
    expect(atticusArgvOf("atticus", ["verify", "forge-ledger"])).toEqual({
      argv: ["verify", "forge-ledger"],
    });
    expect(atticusArgvOf("atticus map forge-ledger --estimate", [])).toEqual({
      argv: ["map", "forge-ledger", "--estimate"],
    });
    expect(atticusArgvOf('atticus repo describe r --drafted "A ledger." --cites a:1', [])).toEqual({
      argv: ["repo", "describe", "r", "--drafted", "A ledger.", "--cites", "a:1"],
    });
    expect(atticusArgvOf("atticus.cmd", ["next"])).toEqual({ argv: ["next"] });
    for (const [c, a] of [
      ["git", ["push"]],
      ["/tmp/atticus", ["verify"]],
      ["atticus verify x | tee y", []],
      ["atticus verify $(whoami)", []],
      ["atticus", ["questions", "answer", "q"]],
      ["atticus", ["plan", "submit", "c", "--approve"]],
      ["atticus", ["scan", "verify", "r", "--accept"]],
      ["atticus", ["questions", "answer", "q", "--accept-proposal"]],
      ["atticus", ["map", "--all"]],
    ] as const)
      expect(atticusArgvOf(c, [...a]).refused, `${c} ${a.join(" ")}`).toBeTruthy();
  });

  it("reads runtime.yaml's command as a program and its words, a quoted path kept whole", () => {
    expect(commandLineOf("npx --yes @github/copilot-language-server")).toEqual({
      command: "npx",
      args: ["--yes", "@github/copilot-language-server", "--acp"],
    });
    expect(commandLineOf('"C:\\Program Files\\copilot\\server.exe" --acp')).toEqual({
      command: "C:\\Program Files\\copilot\\server.exe",
      args: ["--acp"],
    });
  });
});

describe("atticus doctor's look at Copilot ACP (ADR 0171)", () => {
  it("finds the server and its version, and whether it is signed in, without a prompt", async () => {
    const m = metarepo({ sessions: [] });
    const ok = await copilotAcpProbe({ command: COMMAND, cwd: m.root, env: m.env });
    expect(ok).toMatchObject({ found: true, version: "mock-copilot 0.0.1", signedIn: true });
    expect(m.log().some((e) => e.event === "prompt")).toBe(false);
    const out = metarepo({ signedOut: "Not signed in to GitHub Copilot", sessions: [] });
    const no = await copilotAcpProbe({ command: COMMAND, cwd: out.root, env: out.env });
    expect(no.signedIn).toBe(false);
    expect(no.said).toContain("Not signed in to GitHub Copilot");
    const none = await copilotAcpProbe({ command: "atticus-no-such-copilot-server", cwd: m.root });
    expect(none.found).toBe(false);
  });
});

// ---------------------------------------------------------------- the runtime (C5)

const NOW = new Date("2026-11-03T06:00:00Z");
const agent = AgentDefinition.parse({
  schemaVersion: 1,
  id: "story-writer",
  role: "business-analyst",
  description: "Writes a change's stories.",
  inputs: ["brief"],
  outputArtifact: "stories",
  tokenBudget: 5000,
  allowedRuntimes: ["hand-off", "model"],
});

function request(): AiRequest {
  const pack = buildContextPack({
    change: "add-transfer-limit",
    agent: agent.id,
    budget: 5000,
    levels: ["public", "internal"],
    maxClassification: "internal",
    now: NOW,
    sources: [
      {
        id: "0",
        kind: "instruction",
        origin: "atticus/stories",
        text: "Write the stories.",
        classification: "public",
        trusted: true,
      },
    ],
  });
  return { change: "add-transfer-limit", agent, pack, outputPath: "stories.md" };
}

const runtimeYaml = (more: Record<string, unknown> = {}) =>
  Runtime.parse({
    schemaVersion: 3,
    assistants: { allowed: ["copilot"], default: "copilot" },
    modes: { allowed: ["hand-off", "copilot-acp"], default: "copilot-acp" },
    ...more,
  });

describe("the copilot-acp runtime (C5, ADR 0171)", () => {
  it("runs a step's hand-off prompt in a session, its result file the output, and records the run", async () => {
    const m = metarepo({
      sessions: [
        {
          steps: [
            { write: "openspec/changes/add-transfer-limit/stories.md", content: "# Stories\n" },
            // Its own result path only: the change's other files stay as they are.
            { write: "openspec/changes/add-transfer-limit/proposal.md", content: "x" },
          ],
        },
      ],
    });
    write(m.root, "openspec/changes/add-transfer-limit/proposal.md", "# Proposal\n");
    const rt = await createRuntime(
      { runtime: runtimeYaml({ copilotAcp: { command: COMMAND } }) },
      { root: m.root, now: () => NOW, copilotAcp: { env: m.env, exec: fakeAtticus().exec } },
    );
    expect(rt).toBeInstanceOf(CopilotAcpRuntime);
    expect(rt.kind).toBe("copilot-acp");
    const run = await rt.run((await rt.prepare(request())).runId);
    expect(run.errors).toEqual([]);
    expect(run.state).toBe("validated");
    expect(run.output).toBe("# Stories\n");
    expect(run.model).toBe("gpt-mock");
    expect(run.assistant).toMatchObject({ name: "mock-copilot", version: "0.0.1" });
    expect(
      readFileSync(join(m.root, "openspec/changes/add-transfer-limit/proposal.md"), "utf8"),
    ).toBe("# Proposal\n");
    // The prompt is the hand-off's: the result file to write, and the data rule.
    const prompt = m.log().find((e) => e.event === "prompt")!.text as string;
    expect(prompt).toContain("stories.md");
    const dir = join(m.root, ".runs", "add-transfer-limit", run.runId);
    expect(readFileSync(join(dir, "prompt.md"), "utf8")).toBe(prompt);
    expect(JSON.parse(readFileSync(join(dir, "run.json"), "utf8"))).toMatchObject({
      runtime: "copilot-acp",
      state: "validated",
      model: "gpt-mock",
      stepClass: "draft",
    });
    expect(existsSync(join(dir, "transcript.jsonl"))).toBe(true);
  });

  it("needs copilot among the allowed assistants, and runtime.yaml to allow the mode", async () => {
    await expect(
      createRuntime(
        {
          runtime: runtimeYaml({
            assistants: { allowed: ["claude-code"], default: "claude-code" },
          }),
        },
        { root: temp() },
      ),
    ).rejects.toThrow(/copilot-acp drives GitHub Copilot, which runtime.yaml doesn't list/);
    await expect(
      createRuntime(
        { runtime: runtimeYaml({ modes: { allowed: ["hand-off"], default: "hand-off" } }) },
        { root: temp(), mode: "copilot-acp" },
      ),
    ).rejects.toBeInstanceOf(RuntimeConfigError);
  });

  it("inside a session, the commands it runs hand off instead of starting another", async () => {
    const rt = await createRuntime(
      { runtime: runtimeYaml() },
      { root: temp(), env: { ATTICUS_ACP_SESSION: "1" } },
    );
    expect(rt.kind).toBe("hand-off");
  });
});
