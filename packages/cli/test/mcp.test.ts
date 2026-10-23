import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { handleMcp, MCP_TOOLS, serveMcp, type McpRun } from "../src/mcp.js";
import { main } from "../src/main.js";

/**
 * ADR 0104: `atticus mcp`, the MCP server the Claude Code plugin starts. Read-only tools over the
 * commands' own code, over stdio. It never writes: a person approves every write.
 */

const FORGE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/forge");

const fake =
  (calls: string[][]): McpRun =>
  async (argv) => {
    calls.push(argv);
    return { code: 0, out: `{"ran": ${JSON.stringify(argv.join(" "))}}`, err: "" };
  };

describe("atticus mcp (ADR 0104)", () => {
  it("answers the handshake with its tools capability and its version", async () => {
    const r = await handleMcp(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      fake([]),
      "1.2.3",
    );
    expect(r).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "atticus", version: "1.2.3" },
        instructions: expect.stringMatching(/read-only/),
      },
    });
    // A notification gets no answer.
    expect(
      await handleMcp({ jsonrpc: "2.0", method: "notifications/initialized" }, fake([]), "1"),
    ).toBeUndefined();
  });

  it("lists read-only tools, each with what it does and the arguments it takes", async () => {
    const r = (await handleMcp({ jsonrpc: "2.0", id: 2, method: "tools/list" }, fake([]), "1")) as {
      result: { tools: { name: string; description: string; inputSchema: { type: string } }[] };
    };
    const names = r.result.tools.map((t) => t.name);
    expect(names).toEqual(MCP_TOOLS.map((t) => t.name));
    expect(names).toEqual(
      expect.arrayContaining([
        "next_step",
        "catalog_query",
        "knowledge_items",
        "change_needs",
        "change_map",
        "change_estimate",
        "open_questions",
      ]),
    );
    for (const t of r.result.tools) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.inputSchema.type).toBe("object");
    }
  });

  it("runs a tool as its command, with --json, and gives back what it printed", async () => {
    const calls: string[][] = [];
    const r = await handleMcp(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "change_needs", arguments: { change: "add-transfer-limit" } },
      },
      fake(calls),
      "1",
    );
    expect(calls).toEqual([["needs", "--change", "add-transfer-limit", "--all", "--json"]]);
    expect(r).toMatchObject({
      id: 3,
      result: { content: [{ type: "text", text: expect.stringContaining("needs --change") }] },
    });
    expect((r as { result: { isError?: boolean } }).result.isError).toBeUndefined();
  });

  it("searches the index by words through atticus query --search (ADR 0107)", async () => {
    const calls: string[][] = [];
    const call = (args: Record<string, unknown>) =>
      handleMcp(
        {
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: { name: "search", arguments: args },
        },
        fake(calls),
        "1",
      );
    await call({ text: "fraud screen" });
    await call({ text: "firewall", kind: "ProcessDefinition,WikiSection" });
    expect(calls).toEqual([
      ["query", "fraud screen", "--search", "--json"],
      ["query", "firewall", "--search", "--kind", "ProcessDefinition,WikiSection", "--json"],
    ]);
  });

  it("reads what waits, the open needs and the model runs through their commands (ADR 0106)", async () => {
    const calls: string[][] = [];
    const call = (name: string, args: Record<string, unknown>) =>
      handleMcp(
        { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name, arguments: args } },
        fake(calls),
        "1",
      );
    await call("waiting_on_you", {});
    await call("waiting_on_you", { group: "kind", filter: "northwind pay" });
    await call("open_needs", {});
    await call("open_needs", { change: "add-transfer-limit" });
    await call("model_runs", { change: "knowledge-scan" });
    await call("model_run", { run: "run-20261023034002-0001" });
    expect(calls).toEqual([
      ["waiting", "--group", "change", "--json"],
      ["waiting", "--group", "kind", "--filter", "northwind pay", "--json"],
      ["needs", "--json"],
      ["needs", "--change", "add-transfer-limit", "--json"],
      ["runs", "--change", "knowledge-scan", "--json"],
      ["runs", "show", "run-20261023034002-0001", "--json"],
    ]);
    const bad = await call("waiting_on_you", { group: "repo" });
    expect(bad).toMatchObject({
      result: { isError: true, content: [{ text: "group is change or kind." }] },
    });
  });

  it("reads the prompt history through atticus history, read-only (ADR 0110)", async () => {
    const calls: string[][] = [];
    const call = (args: Record<string, unknown>) =>
      handleMcp(
        {
          jsonrpc: "2.0",
          id: 11,
          method: "tools/call",
          params: { name: "prompt_history", arguments: args },
        },
        fake(calls),
        "1",
      );
    await call({});
    await call({ change: "add-transfer-limit", filter: "northwind pay", limit: "5" });
    await call({ session: "5f1d7c0e" });
    expect(calls).toEqual([
      ["history", "--json"],
      [
        "history",
        "--change",
        "add-transfer-limit",
        "--filter",
        "northwind pay",
        "--limit",
        "5",
        "--json",
      ],
      ["history", "--session", "5f1d7c0e", "--json"],
    ]);
    const bad = await call({ session: "--surface" });
    expect(calls).toHaveLength(3);
    expect(bad).toMatchObject({ result: { isError: true } });
  });

  it("refuses a value that would be read as an option, and a tool it hasn't", async () => {
    const calls: string[][] = [];
    const bad = await handleMcp(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "change_status", arguments: { change: "--force" } },
      },
      fake(calls),
      "1",
    );
    expect(calls).toEqual([]);
    expect(bad).toMatchObject({
      result: {
        isError: true,
        content: [{ text: expect.stringMatching(/change can't start with "-"/) }],
      },
    });
    const none = await handleMcp(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "change_draft", arguments: {} },
      },
      fake(calls),
      "1",
    );
    expect(none).toMatchObject({
      error: { code: -32602, message: expect.stringMatching(/no tool change_draft/) },
    });
    const missing = await handleMcp(
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "catalog_query", arguments: {} },
      },
      fake(calls),
      "1",
    );
    expect(missing).toMatchObject({
      result: { isError: true, content: [{ text: "catalog_query needs query." }] },
    });
    expect(
      await handleMcp({ jsonrpc: "2.0", id: 7, method: "resources/list" }, fake(calls), "1"),
    ).toMatchObject({
      error: { code: -32601 },
    });
  });

  it("says when the command failed, with what it said", async () => {
    const r = await handleMcp(
      {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "open_questions", arguments: {} },
      },
      async () => ({ code: 2, out: "", err: "Not a metarepo: no org-pack/ here." }),
      "1",
    );
    expect(r).toMatchObject({
      result: { isError: true, content: [{ text: "Not a metarepo: no org-pack/ here." }] },
    });
  });

  it("serves one JSON message per line on stdin and stdout, and never writes anything else", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const lines: string[] = [];
    stdout
      .setEncoding("utf8")
      .on("data", (d: string) => lines.push(...d.split("\n").filter(Boolean)));
    const done = serveMcp(stdin, stdout, fake([]), "1");
    stdin.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    stdin.write("not json\n");
    stdin.end();
    await done;
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { jsonrpc: "2.0", id: 1, result: {} },
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "That line isn't JSON." } },
    ]);
  });

  it("runs the real command in a metarepo: the next step, as atticus next --json prints it", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "atticus-mcp-")), "meta");
    await cp(join(FORGE, "metarepo"), root, { recursive: true });
    const run: McpRun = async (argv) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await main(
        [...argv, "--root", root],
        { out: (l) => out.push(l), err: (l) => err.push(l) },
        { quiet: true },
      );
      return { code, out: out.join("\n"), err: err.join("\n") };
    };
    const r = (await handleMcp(
      { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "next_step", arguments: {} } },
      run,
      "1",
    )) as { result: { content: { text: string }[]; isError?: boolean } };
    expect(r.result.isError).toBeUndefined();
    expect(JSON.parse(r.result.content[0]!.text)).toHaveProperty("steps");
  }, 60_000);
});
