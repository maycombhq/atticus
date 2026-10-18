#!/usr/bin/env node
// The Atticus reference executor (ADR 0033): a tiny local step executor that speaks the C4
// executor protocol over all three transports. Tests use it; teams can copy it as a starting
// point. It pretends to raise a request: it never touches a network beyond 127.0.0.1 and
// never reads credentials.
//
//   node reference-executor.mjs --transport http    [--port 0] [--state file] [--behaviour b]
//   node reference-executor.mjs --transport command [--state file] [--behaviour b]
//   node reference-executor.mjs --transport mcp     [--state file] [--behaviour b] [--tools a,b]
//
// Behaviours: ok (default), fail, slow, needs-person, bad-output, env.
/* global setTimeout */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const transport = opt("transport", "command");
const behaviour = opt("behaviour", "ok");
const stateFile = opt("state", "");
const tools = opt("tools", "firewall-rule_submit-request").split(",").filter(Boolean);
const NAME = "reference";
const VERSION = "0.1.0";
const SECRET =
  /(token|password|passwd|secret|api[-_]?key|private[-_]?key|credential|cookie|session[-_]?id)/i;

function loadState() {
  if (!stateFile) return { used: [], runs: [] };
  try {
    return JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    return { used: [], runs: [] };
  }
}
function saveState(s) {
  if (stateFile) writeFileSync(stateFile, JSON.stringify(s, null, 2));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

/** Do one run: the same idempotency key always gives the same request number. */
async function perform(req, progress) {
  const state = loadState();
  state.runs.push({
    runId: req.runId,
    procedure: req.procedure,
    step: req.step,
    mode: req.mode,
    idempotencyKey: req.idempotencyKey,
    approvedBy: req.approval?.by ?? null,
  });
  saveState(state);
  progress("Opening the form");
  if (behaviour === "slow") await sleep(5000);
  progress("Filling in the fields");
  const n =
    1000 +
    (parseInt(createHash("sha256").update(req.idempotencyKey).digest("hex").slice(0, 6), 16) %
      9000);
  const base = { type: "result", runId: req.runId, startedAt: now(), finishedAt: now() };
  if (req.mode === "fill-only")
    return {
      ...base,
      status: "needs-person",
      outputs: {},
      message: "The form is filled in but not submitted; check it and submit it yourself.",
    };
  if (behaviour === "fail")
    return { ...base, status: "failed", outputs: {}, message: "The form rejected the request." };
  if (behaviour === "needs-person")
    return { ...base, status: "needs-person", outputs: {}, message: "A captcha needs a person." };
  state.used.push(req.idempotencyKey);
  saveState(state);
  const outputs =
    behaviour === "bad-output" ? { requestNumber: "not a number" } : { requestNumber: `SR-${n}` };
  if (behaviour === "env")
    outputs.leakedEnv = Object.keys(process.env).filter((k) => SECRET.test(k)).length;
  return {
    ...base,
    status: "done",
    outputs,
    evidence: [{ kind: "page", ref: `reference://requests/SR-${n}`, at: now() }],
  };
}

const pong = () => ({
  type: "pong",
  name: NAME,
  version: VERSION,
  procedures: [],
  stepKinds: ["submit-request"],
  fillOnly: true,
});
const checked = (key) => ({
  type: "checked",
  idempotencyKey: key,
  used: loadState().used.includes(key),
});

// ------------------------------------------------------------------ command
if (transport === "command") {
  const rl = createInterface({ input: process.stdin });
  rl.once("line", async (line) => {
    const msg = JSON.parse(line);
    const out = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
    if (msg.type === "ping") out(pong());
    else if (msg.type === "check") out(checked(msg.idempotencyKey));
    else if (msg.type === "run")
      out(await perform(msg, (message) => out({ type: "progress", runId: msg.runId, message })));
    rl.close();
  });
}

// ------------------------------------------------------------------ http
if (transport === "http") {
  const runs = new Map();
  const send = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/ping") return send(res, 200, pong());
      if (req.method === "GET" && url.pathname.startsWith("/idempotency/"))
        return send(
          res,
          200,
          checked(decodeURIComponent(url.pathname.slice("/idempotency/".length))),
        );
      if (req.method === "POST" && url.pathname === "/run") {
        const msg = JSON.parse(body);
        const entry = { progress: [], result: undefined };
        runs.set(msg.runId, entry);
        perform(msg, (message) =>
          entry.progress.push({ type: "progress", runId: msg.runId, message }),
        ).then((r) => (entry.result = r));
        return send(res, 202, { runId: msg.runId });
      }
      if (req.method === "GET" && url.pathname.startsWith("/runs/")) {
        const entry = runs.get(decodeURIComponent(url.pathname.slice("/runs/".length)));
        return entry ? send(res, 200, entry) : send(res, 404, { error: "no such run" });
      }
      send(res, 404, { error: "not found" });
    });
  });
  server.listen(Number(opt("port", "0")), "127.0.0.1", () => {
    process.stdout.write(`listening ${server.address().port}\n`);
  });
}

// ------------------------------------------------------------------ mcp (JSON-RPC 2.0 over stdio)
if (transport === "mcp") {
  const out = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
  const rl = createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const reply = (result) => out({ jsonrpc: "2.0", id: msg.id, result });
    const error = (code, message) => out({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
    if (msg.method === "initialize")
      return reply({
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: NAME, version: VERSION },
      });
    if (msg.method === "notifications/initialized") return;
    if (msg.method === "ping") return reply({});
    if (msg.method === "tools/list")
      return reply({
        tools: [
          ...tools.map((name) => ({
            name,
            description: "Raise the request (reference executor)",
            inputSchema: { type: "object" },
          })),
          {
            name: "atticus_check_idempotency",
            description: "Was this idempotency key used?",
            inputSchema: { type: "object", properties: { idempotencyKey: { type: "string" } } },
          },
        ],
      });
    if (msg.method === "tools/call") {
      const { name, arguments: input = {}, _meta = {} } = msg.params ?? {};
      if (name === "atticus_check_idempotency") {
        const used = loadState().used.includes(input.idempotencyKey);
        return reply({
          content: [{ type: "text", text: JSON.stringify({ outputs: { used } }) }],
          structuredContent: { status: "done", outputs: { used } },
        });
      }
      if (!tools.includes(name)) return error(-32602, `no tool ${name}`);
      const meta = _meta.atticus ?? {};
      const req = {
        ...meta,
        inputs: input,
        runId: meta.runId ?? "mcp-run",
        idempotencyKey: meta.idempotencyKey ?? "mcp-key-unknown",
        mode: meta.mode ?? "submit",
      };
      const r = await perform(req, (message) =>
        out({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: { progressToken: _meta.progressToken, progress: 1, total: 2, message },
        }),
      );
      return reply({
        content: [{ type: "text", text: JSON.stringify(r) }],
        structuredContent: {
          status: r.status,
          outputs: r.outputs,
          evidence: r.evidence ?? [],
          ...(r.message ? { message: r.message } : {}),
        },
        isError: r.status === "failed",
      });
    }
    if (msg.id !== undefined) error(-32601, `no method ${msg.method}`);
  });
}
