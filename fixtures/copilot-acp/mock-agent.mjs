#!/usr/bin/env node
// A stand-in for the GitHub Copilot language server in its Agent Client Protocol mode (ADR 0171),
// for tests only: it speaks newline-delimited JSON-RPC 2.0 on stdin and stdout, as an ACP agent
// does, and plays a script instead of thinking. No network, ever.
//
//   node mock-agent.mjs --version          prints a version and exits
//   node mock-agent.mjs --acp              the agent; MOCK_ACP_SCRIPT names the script (JSON)
//
// The script: { "signedOut"?: "<what the server says>", "sessions": [ { "steps": [...] } ] }.
// Each process plays the next session of the list (counted in the log, MOCK_ACP_LOG, one JSON
// object a line), so a test can give each new session its own steps. A step is one of:
//   { "say": "text" }                                  an agent_message_chunk update
//   { "tool": "title", "kind"?: "read" }               a tool_call update, nothing asked
//   { "read": "<path>" }                               fs/read_text_file
//   { "write": "<path>", "content": "..." }            fs/write_text_file
//   { "append": "<path>", "content": "..." }           fs/read_text_file, then the old text + content
//   { "run": "<command>", "args"?: [...], "cwd"?: path } terminal/create, wait_for_exit, output, release
//   { "permission": { "kind", "title", "locations"?: [paths], "rawInput"? } }
//                                                      session/request_permission
//   { "sleep": <ms> }
//   { "stop": "<stopReason>" }                         ends the turn with that reason
// A session may have "then": [[steps], ...]: the steps of its second prompt, third, and so on, in
// the same session (a prompt past them plays none).
// A path may start with ${cwd} (the session's folder); a relative path is taken under it.
import { appendFileSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";

if (process.argv.includes("--version")) {
  process.stdout.write("mock-copilot 0.0.1\n");
  process.exit(0);
}
if (!process.argv.includes("--acp")) {
  process.stderr.write("mock-copilot: start me with --acp\n");
  process.exit(2);
}

const script = JSON.parse(readFileSync(process.env.MOCK_ACP_SCRIPT, "utf8"));
const LOG = process.env.MOCK_ACP_LOG;
const log = (o) => LOG && appendFileSync(LOG, `${JSON.stringify(o)}\n`);
const logged = () => {
  try {
    return readFileSync(LOG, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

let nextId = 1;
const waiting = new Map();
const send = (o) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...o })}\n`);
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });
const notify = (method, params) => send({ method, params });

let session;
let cwd = process.cwd();
let cancelled = false;
let model = "gpt-mock";
let promptsBefore = 0;

const pathOf = (p) => {
  const s = p.replaceAll("${cwd}", cwd);
  return isAbsolute(s) ? s : join(cwd, s);
};
const update = (u) => notify("session/update", { sessionId: session, update: u });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function play(steps) {
  let tool = 0;
  for (const s of steps) {
    if (cancelled) return "cancelled";
    if (s.say !== undefined) update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: s.say } });
    else if (s.tool !== undefined)
      update({ sessionUpdate: "tool_call", toolCallId: `t${++tool}`, title: s.tool, kind: s.kind ?? "other", status: "completed" });
    else if (s.read !== undefined) {
      update({ sessionUpdate: "tool_call", toolCallId: `t${++tool}`, title: `Read ${s.read}`, kind: "read", status: "in_progress" });
      const r = await ask("fs/read_text_file", { sessionId: session, path: pathOf(s.read) });
      log({ event: "read", path: s.read, ok: !r.error, error: r.error?.message, bytes: r.result?.content?.length });
    } else if (s.write !== undefined) {
      update({ sessionUpdate: "tool_call", toolCallId: `t${++tool}`, title: `Write ${s.write}`, kind: "edit", status: "in_progress" });
      const r = await ask("fs/write_text_file", { sessionId: session, path: pathOf(s.write), content: s.content });
      log({ event: "write", path: s.write, ok: !r.error, error: r.error?.message });
    } else if (s.append !== undefined) {
      update({ sessionUpdate: "tool_call", toolCallId: `t${++tool}`, title: `Edit ${s.append}`, kind: "edit", status: "in_progress" });
      const old = await ask("fs/read_text_file", { sessionId: session, path: pathOf(s.append) });
      const r = await ask("fs/write_text_file", {
        sessionId: session,
        path: pathOf(s.append),
        content: `${old.result?.content ?? ""}${s.content}`,
      });
      log({ event: "write", path: s.append, ok: !r.error, error: r.error?.message });
    } else if (s.run !== undefined) {
      update({ sessionUpdate: "tool_call", toolCallId: `t${++tool}`, title: `Run ${s.run} ${(s.args ?? []).join(" ")}`, kind: "execute", status: "in_progress" });
      const c = await ask("terminal/create", { sessionId: session, command: s.run, args: s.args ?? [], cwd: s.cwd ? pathOf(s.cwd) : cwd });
      if (c.error) {
        log({ event: "run", command: s.run, args: s.args ?? [], ok: false, error: c.error.message });
        continue;
      }
      const terminalId = c.result.terminalId;
      const w = await ask("terminal/wait_for_exit", { sessionId: session, terminalId });
      const o = await ask("terminal/output", { sessionId: session, terminalId });
      await ask("terminal/release", { sessionId: session, terminalId });
      log({ event: "run", command: s.run, args: s.args ?? [], ok: true, exitCode: w.result?.exitCode, output: o.result?.output });
    } else if (s.permission !== undefined) {
      const p = s.permission;
      const r = await ask("session/request_permission", {
        sessionId: session,
        toolCall: {
          toolCallId: `t${++tool}`,
          title: p.title ?? p.kind,
          kind: p.kind,
          status: "pending",
          ...(p.locations ? { locations: p.locations.map((l) => ({ path: pathOf(l) })) } : {}),
          ...(p.rawInput ? { rawInput: p.rawInput } : {}),
        },
        options: [
          { optionId: "allow-once", name: "Allow", kind: "allow_once" },
          { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      });
      log({ event: "permission", kind: p.kind, title: p.title, outcome: r.result?.outcome });
    } else if (s.sleep !== undefined) await sleep(s.sleep);
    else if (s.stop !== undefined) return s.stop;
  }
  return cancelled ? "cancelled" : "end_turn";
}

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  if (m.id !== undefined && m.method === undefined) {
    const r = waiting.get(m.id);
    waiting.delete(m.id);
    r?.(m);
    return;
  }
  const { id, method, params } = m;
  if (method === "initialize") {
    log({ event: "initialize", params, acpSession: process.env.ATTICUS_ACP_SESSION ?? null });
    send({
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false, promptCapabilities: { image: false } },
        authMethods: [{ id: "github", name: "GitHub", description: "Sign in to GitHub Copilot" }],
        agentInfo: { name: "mock-copilot", version: "0.0.1" },
      },
    });
  } else if (method === "session/new") {
    if (script.signedOut) {
      process.stderr.write("To sign in, open https://github.com/login/device and enter WXYZ-0000\n");
      send({ id, error: { code: -32000, message: script.signedOut } });
      return;
    }
    const n = logged().filter((e) => e.event === "session").length;
    cwd = params.cwd;
    session = `s-${n + 1}`;
    promptsBefore = logged().filter((e) => e.event === "prompt").length;
    log({ event: "session", n: n + 1, cwd: params.cwd, mcpServers: params.mcpServers });
    send({
      id,
      result: {
        sessionId: session,
        models: {
          currentModelId: model,
          availableModels: [
            { modelId: "gpt-mock", name: "GPT mock" },
            { modelId: "gpt-other", name: "Another" },
          ],
        },
      },
    });
  } else if (method === "session/set_model") {
    model = params.modelId;
    log({ event: "set_model", modelId: params.modelId });
    send({ id, result: {} });
  } else if (method === "session/prompt") {
    const n = logged().filter((e) => e.event === "session").length;
    const text = params.prompt.map((b) => b.text ?? "").join("");
    log({ event: "prompt", session: params.sessionId, text });
    const k = logged().filter((e) => e.event === "prompt").length - 1 - promptsBefore;
    const sess = script.sessions[n - 1];
    const steps = (k === 0 ? sess?.steps : sess?.then?.[k - 1]) ?? [];
    const stopReason = await play(steps);
    log({ event: "stop", stopReason });
    send({ id, result: { stopReason, usage: { inputTokens: 1200, outputTokens: 300 } } });
  } else if (method === "session/cancel") {
    cancelled = true;
    log({ event: "cancel" });
  } else if (id !== undefined) {
    send({ id, error: { code: -32601, message: `no method ${method}` } });
  }
});
rl.on("close", () => process.exit(0));
